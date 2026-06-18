import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createStageLogger } from '../observability/logger.js';
import { loadConfig } from '../config.js';
import { InspPostSchema, type InspPost, type PostLabel, type DACTISchema } from './types.js';
import { batchArray, callClaude, extractJson, formatPostForPrompt, sleep } from './utils.js';
import { type EnrichedPost, type Signals } from './types.js';

const log = createStageLogger('workstream-b:validation-inter-rater');

const OUTPUT_DIR = 'data/schema';
const POSTS_PATH = 'data/posts/inspiration-posts-300.json';
const SAMPLE_SIZE = 50;

function computeSignals(post: InspPost, p33: number, p66: number): Signals {
  const text = post.content_text ?? '';
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const totalEng = post.engagement?.total_engagement ?? 0;
  let engagementTier: 'high' | 'mid' | 'low';
  if (totalEng >= p66) engagementTier = 'high';
  else if (totalEng >= p33) engagementTier = 'mid';
  else engagementTier = 'low';
  const exclamationCount = (text.match(/!/g) || []).length;
  return {
    word_count: wordCount,
    has_numbers: /\d|%|\$/.test(text),
    has_list_structure: /(?:^|\n)\s*(?:\d+[\.\)]\s|[-*]\s|[a-z]\)\s)/m.test(text),
    has_questions: text.includes('?'),
    mentions_person: /@\w/.test(text) || (post.mentions != null && post.mentions.length > 0),
    mentions_metric_or_stat: /\d+%|\$\d|\d+k\b|\d+x\b|\d+ times|grew by|increased|decreased/i.test(text),
    has_url_links: /https?:\/\//.test(text),
    exclamation_density: wordCount > 0 ? exclamationCount / wordCount : 0,
    format: post.format ?? post.media?.type ?? 'unknown',
    engagement_tier: engagementTier,
    image_available: post.local_image != null && post.local_image !== '',
  };
}

function shuffleWithSeed<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function computeCohensKappa(
  rater1: string[],
  rater2: string[],
): { kappa: number; observed_agreement: number; expected_agreement: number; matrix: Record<string, Record<string, number>> } {
  const n = rater1.length;
  if (n === 0) return { kappa: 0, observed_agreement: 0, expected_agreement: 0, matrix: {} };

  const allCategories = [...new Set([...rater1, ...rater2])].sort();

  // Build confusion matrix
  const matrix: Record<string, Record<string, number>> = {};
  for (const cat of allCategories) {
    matrix[cat] = {};
    for (const cat2 of allCategories) {
      matrix[cat][cat2] = 0;
    }
  }
  for (let i = 0; i < n; i++) {
    matrix[rater1[i]][rater2[i]] = (matrix[rater1[i]][rater2[i]] ?? 0) + 1;
  }

  // Observed agreement
  let agreements = 0;
  for (let i = 0; i < n; i++) {
    if (rater1[i] === rater2[i]) agreements++;
  }
  const po = agreements / n;

  // Expected agreement by chance
  let pe = 0;
  for (const cat of allCategories) {
    const r1Count = rater1.filter((v) => v === cat).length;
    const r2Count = rater2.filter((v) => v === cat).length;
    pe += (r1Count / n) * (r2Count / n);
  }

  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);

  return { kappa, observed_agreement: po, expected_agreement: pe, matrix };
}

async function main() {
  log.info('=== Validation: Inter-Rater Reliability (Cohen\'s Kappa) ===');
  const startMs = Date.now();

  await mkdir(OUTPUT_DIR, { recursive: true });

  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  // Load updated labels (rater 1 = Sonnet's labels)
  const labelsRaw = await readFile(join(OUTPUT_DIR, 'posts-labeled.json'), 'utf-8');
  const allLabels: PostLabel[] = JSON.parse(labelsRaw);

  // Load schema
  const schemaRaw = await readFile(join(OUTPUT_DIR, 'schema-v1.json'), 'utf-8');
  const schema: DACTISchema = JSON.parse(schemaRaw);
  const schemaText = JSON.stringify(schema, null, 2);

  // Load original posts
  const postsRaw = await readFile(POSTS_PATH, 'utf-8');
  const postsData = JSON.parse(postsRaw) as unknown[];
  const posts: InspPost[] = [];
  for (const item of postsData) {
    const parsed = InspPostSchema.safeParse(item);
    if (parsed.success) posts.push(parsed.data);
  }
  const postsMap = new Map<string, InspPost>();
  for (const p of posts) postsMap.set(p.id, p);

  // Compute engagement tiers
  const engagements = posts.map((p) => p.engagement?.total_engagement ?? 0).sort((a, b) => a - b);
  const p33 = engagements[Math.floor(engagements.length * 0.33)] ?? 0;
  const p66 = engagements[Math.floor(engagements.length * 0.66)] ?? 0;

  // Random sample of 50 posts
  const shuffled = shuffleWithSeed(allLabels);
  const sample = shuffled.slice(0, SAMPLE_SIZE);
  log.info({ sampleSize: sample.length }, 'Selected random sample');

  // Build enriched posts for the sample
  const sampleEnriched: EnrichedPost[] = sample.map((label) => {
    const post = postsMap.get(label.post_id)!;
    return { ...post, signals: computeSignals(post, p33, p66) };
  });

  const contentTypeNames = schema.content_types.map((ct) => ct.name);
  const modalityNames = schema.visual_modalities.map((vm) => vm.name);

  const ClassificationResponse = z.object({
    classifications: z.array(
      z.object({
        post_id: z.string(),
        content_type: z.string(),
        visual_modality: z.string(),
        confidence: z.enum(['high', 'medium', 'low']),
        content_type_evidence: z.string(),
        visual_modality_evidence: z.string(),
      }),
    ),
  });

  // Rater 2: Claude Opus classifies the same 50 posts
  const batches = batchArray(sampleEnriched, 10);
  const opusLabels = new Map<string, { content_type: string; visual_modality: string }>();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log.info({ batch: i + 1, total: batches.length, size: batch.length }, 'Opus classifying batch');

    const postTexts = batch.map((p, idx) => formatPostForPrompt(p, idx)).join('\n\n---\n\n');

    const systemPrompt = `You are classifying LinkedIn posts using a fixed taxonomy schema. You will be given the schema and a batch of posts. For each post, provide a classification.

Respond with a JSON object containing a "classifications" array. Each element must have:
- "post_id": string
- "content_type": string (MUST be one of the schema's content type names)
- "visual_modality": string (MUST be one of the schema's visual modality names)
- "confidence": "high" | "medium" | "low"
- "content_type_evidence": 1-2 sentences explaining why
- "visual_modality_evidence": 1-2 sentences explaining why

Do not use em dashes in any text. Use only values from the provided schema enums.

Valid content types: ${contentTypeNames.join(', ')}
Valid visual modalities: ${modalityNames.join(', ')}`;

    const userContent = `## Taxonomy Schema\n\n${schemaText}\n\n## Posts to Classify\n\n${postTexts}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await callClaude(client, {
          system: systemPrompt,
          userContent,
          model: 'claude-opus-4-6',
          label: `inter-rater-opus-batch-${i + 1}`,
          maxTokens: 8192,
        });

        const jsonStr = extractJson(response.text);
        const parsed = ClassificationResponse.parse(JSON.parse(jsonStr));

        for (const c of parsed.classifications) {
          opusLabels.set(c.post_id, {
            content_type: c.content_type,
            visual_modality: c.visual_modality,
          });
        }
        break;
      } catch (err) {
        log.warn(
          { attempt, batch: i + 1, err: err instanceof Error ? err.message : String(err) },
          'Opus batch failed',
        );
        await sleep(5000);
      }
    }

    if (i < batches.length - 1) await sleep(3000);
  }

  log.info({ opusClassified: opusLabels.size }, 'Opus classification complete');

  // Build rater arrays for posts where both raters have labels
  const sonnetContentTypes: string[] = [];
  const opusContentTypes: string[] = [];
  const sonnetModalities: string[] = [];
  const opusModalities: string[] = [];
  const disagreements: Array<{
    post_id: string;
    sonnet_content_type: string;
    opus_content_type: string;
    sonnet_visual_modality: string;
    opus_visual_modality: string;
  }> = [];

  for (const label of sample) {
    const opusLabel = opusLabels.get(label.post_id);
    if (!opusLabel) continue;

    sonnetContentTypes.push(label.content_type);
    opusContentTypes.push(opusLabel.content_type);
    sonnetModalities.push(label.visual_modality);
    opusModalities.push(opusLabel.visual_modality);

    if (label.content_type !== opusLabel.content_type || label.visual_modality !== opusLabel.visual_modality) {
      disagreements.push({
        post_id: label.post_id,
        sonnet_content_type: label.content_type,
        opus_content_type: opusLabel.content_type,
        sonnet_visual_modality: label.visual_modality,
        opus_visual_modality: opusLabel.visual_modality,
      });
    }
  }

  // Compute Cohen's kappa
  const contentKappa = computeCohensKappa(sonnetContentTypes, opusContentTypes);
  const modalityKappa = computeCohensKappa(sonnetModalities, opusModalities);

  const results = {
    generated_at: new Date().toISOString(),
    sample_size: sonnetContentTypes.length,
    rater_1_model: 'claude-sonnet-4-6',
    rater_2_model: 'claude-opus-4-6',
    content_type_agreement: {
      cohens_kappa: Math.round(contentKappa.kappa * 1000) / 1000,
      observed_agreement: Math.round(contentKappa.observed_agreement * 1000) / 1000,
      expected_agreement: Math.round(contentKappa.expected_agreement * 1000) / 1000,
      confusion_matrix: contentKappa.matrix,
    },
    visual_modality_agreement: {
      cohens_kappa: Math.round(modalityKappa.kappa * 1000) / 1000,
      observed_agreement: Math.round(modalityKappa.observed_agreement * 1000) / 1000,
      expected_agreement: Math.round(modalityKappa.expected_agreement * 1000) / 1000,
      confusion_matrix: modalityKappa.matrix,
    },
    disagreements,
    interpretation: interpretKappa(contentKappa.kappa, modalityKappa.kappa),
  };

  const outputPath = join(OUTPUT_DIR, 'inter-rater-reliability.json');
  await writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');

  log.info(
    {
      contentKappa: results.content_type_agreement.cohens_kappa,
      modalityKappa: results.visual_modality_agreement.cohens_kappa,
      disagreementCount: disagreements.length,
      sampleSize: results.sample_size,
    },
    'Inter-rater reliability analysis complete',
  );

  const durationMs = Date.now() - startMs;
  log.info({ durationMs, durationMin: (durationMs / 60000).toFixed(1) }, 'Validation complete');
}

function interpretKappa(contentK: number, modalityK: number): string {
  function label(k: number): string {
    if (k < 0) return 'less than chance agreement';
    if (k < 0.21) return 'slight agreement';
    if (k < 0.41) return 'fair agreement';
    if (k < 0.61) return 'moderate agreement';
    if (k < 0.81) return 'substantial agreement';
    return 'almost perfect agreement';
  }
  return `Content type: kappa=${contentK.toFixed(3)} (${label(contentK)}). Visual modality: kappa=${modalityK.toFixed(3)} (${label(modalityK)}).`;
}

main().catch((err) => {
  log.fatal(err, 'Inter-rater reliability script failed');
  process.exit(1);
});
