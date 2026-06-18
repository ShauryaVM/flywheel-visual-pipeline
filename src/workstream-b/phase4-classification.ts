import Anthropic from '@anthropic-ai/sdk';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createStageLogger } from '../observability/logger.js';
import { loadConfig } from '../config.js';
import { type EnrichedPost, type DACTISchema, type PostLabel } from './types.js';
import {
  batchArray,
  callClaude,
  extractJson,
  formatPostForPrompt,
  sleep,
} from './utils.js';
import { PHASE4_SYSTEM, buildPhase4UserContent } from './prompts.js';

const log = createStageLogger('workstream-b:phase4');

/**
 * Phase 4: Full Classification.
 * Classify all 300 posts using the final schema.
 */
export async function runPhase4(
  enrichedPosts: EnrichedPost[],
  schema: DACTISchema,
  outputDir: string,
): Promise<PostLabel[]> {
  log.info({ postCount: enrichedPosts.length }, 'Phase 4: Full Classification');

  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const contentTypeNames = schema.content_types.map((ct) => ct.name);
  const modalityNames = schema.visual_modalities.map((vm) => vm.name);

  // Build dynamic Zod schema that validates against the actual enum values
  const PostLabelDynamic = z.object({
    post_id: z.string(),
    content_type: z.string().refine(
      (v) => contentTypeNames.includes(v),
      { message: `Must be one of: ${contentTypeNames.join(', ')}` },
    ),
    visual_modality: z.string().refine(
      (v) => modalityNames.includes(v),
      { message: `Must be one of: ${modalityNames.join(', ')}` },
    ),
    confidence: z.enum(['high', 'medium', 'low']),
    content_type_evidence: z.string(),
    visual_modality_evidence: z.string(),
    signals_used: z.array(z.string()),
  });

  const BatchResponse = z.object({
    classifications: z.array(PostLabelDynamic),
  });

  const schemaText = JSON.stringify(schema, null, 2);
  const batches = batchArray(enrichedPosts, 15);
  const allLabels: PostLabel[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log.info({ batch: i + 1, total: batches.length, batchSize: batch.length }, 'Classifying batch');

    const postTexts = batch.map((p, idx) => formatPostForPrompt(p, idx)).join('\n\n---\n\n');
    const userContent = buildPhase4UserContent(schemaText, postTexts);

    let labels: PostLabel[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await callClaude(client, {
          system: PHASE4_SYSTEM,
          userContent,
          label: `phase4-batch-${i + 1}`,
          maxTokens: 8192,
        });

        const jsonStr = extractJson(response.text);
        const parsed = BatchResponse.parse(JSON.parse(jsonStr));
        labels = parsed.classifications;
        break;
      } catch (err) {
        log.warn(
          { attempt, batch: i + 1, err: err instanceof Error ? err.message : String(err) },
          'Classification batch failed',
        );
        if (attempt === 1) {
          log.error({ batch: i + 1 }, 'Batch failed after retries, creating fallback labels');
          labels = batch.map((p) => ({
            post_id: p.id,
            content_type: contentTypeNames[0],
            visual_modality: modalityNames[0],
            confidence: 'low' as const,
            content_type_evidence: 'Fallback classification - batch parsing failed',
            visual_modality_evidence: 'Fallback classification - batch parsing failed',
            signals_used: [],
          }));
        }
        await sleep(3000);
      }
    }

    if (labels) {
      allLabels.push(...labels);
    }

    if (i < batches.length - 1) {
      await sleep(1500);
    }
  }

  const outputPath = join(outputDir, 'posts-labeled.json');
  await writeFile(outputPath, JSON.stringify(allLabels, null, 2), 'utf-8');
  log.info({ outputPath, labelCount: allLabels.length }, 'Phase 4 complete');

  return allLabels;
}
