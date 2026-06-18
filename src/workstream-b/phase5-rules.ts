import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStageLogger } from '../observability/logger.js';
import { loadConfig } from '../config.js';
import {
  DecisionRulesOutputSchema,
  DACTISchemaSchema,
  PostLabelSchema,
  type DACTISchema,
  type PostLabel,
  type EnrichedPost,
  type ContentTypeRules,
} from './types.js';
import { callClaude, extractJson, sleep } from './utils.js';
import { PHASE5_SYSTEM, buildPhase5UserContent } from './prompts.js';
import { runSignalEnrichment } from './signal-enrichment.js';

const log = createStageLogger('workstream-b:phase5');

/**
 * Phase 5: Decision Rule Extraction.
 * Build cross-tabulation, extract explicit rules mapping content types to visual modalities.
 */
export async function runPhase5(
  labels: PostLabel[],
  enrichedPosts: EnrichedPost[],
  schema: DACTISchema,
  outputDir: string,
): Promise<ContentTypeRules[]> {
  log.info({ labelCount: labels.length }, 'Phase 5: Decision Rule Extraction');

  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  // Build cross-tabulation
  const crossTab = buildCrossTabulation(labels, schema);
  const crossTabText = formatCrossTab(crossTab, schema);

  const schemaText = JSON.stringify(schema, null, 2);
  const signalsText = [
    'word_count (number), has_numbers (boolean), has_list_structure (boolean),',
    'has_questions (boolean), mentions_person (boolean), mentions_metric_or_stat (boolean),',
    'has_url_links (boolean), exclamation_density (number 0-1),',
    'format ("image" | "carousel" | "video" | "article"),',
    'engagement_tier ("high" | "mid" | "low"), image_available (boolean)',
  ].join('\n');

  const userContent = buildPhase5UserContent(schemaText, crossTabText, signalsText);

  let rules: ContentTypeRules[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await callClaude(client, {
        system: PHASE5_SYSTEM,
        userContent,
        label: 'phase5-rules',
        maxTokens: 8192,
      });

      const jsonStr = extractJson(response.text);
      const parsed = JSON.parse(jsonStr) as { rules: ContentTypeRules[] };
      rules = parsed.rules;
      break;
    } catch (err) {
      log.warn({ attempt, err: err instanceof Error ? err.message : String(err) }, 'Rule extraction failed');
      if (attempt === 1) throw err;
      await sleep(3000);
    }
  }

  // Validate rules against labeled data
  const postMap = new Map(enrichedPosts.map((p) => [p.id, p]));
  let correctPredictions = 0;
  let totalPredictions = 0;

  for (const label of labels) {
    const post = postMap.get(label.post_id);
    if (!post) continue;

    const ctRules = rules.find((r) => r.content_type === label.content_type);
    if (!ctRules) continue;

    totalPredictions++;
    for (const rule of ctRules.rules) {
      if (evaluateCondition(rule.condition, post.signals)) {
        if (rule.visual_modality === label.visual_modality) {
          correctPredictions++;
        }
        break; // First matching rule wins
      }
    }
  }

  const accuracyPct = totalPredictions > 0
    ? Math.round((correctPredictions / totalPredictions) * 10000) / 100
    : 0;

  log.info(
    { correctPredictions, totalPredictions, accuracyPct },
    'Rule validation complete',
  );

  const output = DecisionRulesOutputSchema.parse({
    generated_at: new Date().toISOString(),
    rules,
    validation: {
      total_posts: totalPredictions,
      correctly_predicted: correctPredictions,
      accuracy_pct: accuracyPct,
    },
  });

  const outputPath = join(outputDir, 'decision-rules.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  log.info({ outputPath }, 'Phase 5 complete');

  return rules;
}

function buildCrossTabulation(
  labels: PostLabel[],
  schema: DACTISchema,
): Map<string, Map<string, number>> {
  const tab = new Map<string, Map<string, number>>();

  for (const ct of schema.content_types) {
    tab.set(ct.name, new Map());
  }

  for (const label of labels) {
    const row = tab.get(label.content_type);
    if (row) {
      row.set(label.visual_modality, (row.get(label.visual_modality) ?? 0) + 1);
    }
  }

  return tab;
}

function formatCrossTab(
  tab: Map<string, Map<string, number>>,
  schema: DACTISchema,
): string {
  const modalityNames = schema.visual_modalities.map((vm) => vm.name);
  const lines: string[] = [];

  const header = ['content_type', ...modalityNames].join(' | ');
  lines.push(header);
  lines.push(header.replace(/[^|]/g, '-'));

  for (const [ct, row] of tab) {
    const cells = modalityNames.map((m) => String(row.get(m) ?? 0));
    lines.push([ct, ...cells].join(' | '));
  }

  return lines.join('\n');
}

/**
 * Evaluate a simple boolean condition string against post signals.
 * Handles: &&, ||, !, and signal names.
 */
// Standalone runner: read from files and run Phase 5 only
async function main() {
  const POSTS_PATH = 'data/posts/inspiration-posts-300.json';
  const SCHEMA_PATH = 'data/schema/schema-v1.json';
  const LABELS_PATH = 'data/schema/posts-labeled.json';
  const OUTPUT_DIR = 'data/schema';

  log.info('Phase 5 standalone run');

  const enrichedPosts = await runSignalEnrichment(POSTS_PATH);

  const schemaRaw = await readFile(SCHEMA_PATH, 'utf-8');
  const schema = DACTISchemaSchema.parse(JSON.parse(schemaRaw));

  const labelsRaw = await readFile(LABELS_PATH, 'utf-8');
  const labelsArr = JSON.parse(labelsRaw) as unknown[];
  const labels: PostLabel[] = labelsArr.map((l) => PostLabelSchema.parse(l));

  log.info(
    { labels: labels.length, enrichedPosts: enrichedPosts.length, modalities: schema.visual_modalities.length },
    'Data loaded',
  );

  await runPhase5(labels, enrichedPosts, schema, OUTPUT_DIR);
  log.info('Phase 5 standalone complete');
}

const isMainModule = process.argv[1]?.replace(/\\/g, '/').includes('phase5-rules');
if (isMainModule) {
  main().catch((err) => {
    log.fatal(err, 'Phase 5 standalone failed');
    process.exit(1);
  });
}

function evaluateCondition(
  condition: string,
  signals: Record<string, unknown>,
): boolean {
  if (condition.trim() === 'true') return true;
  if (condition.trim() === 'false') return false;

  try {
    // Safe evaluation: only allow known signal names and boolean operators
    const safeCondition = condition
      .replace(/\bword_count\b/g, String(signals.word_count ?? 0))
      .replace(/\bhas_numbers\b/g, String(signals.has_numbers ?? false))
      .replace(/\bhas_list_structure\b/g, String(signals.has_list_structure ?? false))
      .replace(/\bhas_questions\b/g, String(signals.has_questions ?? false))
      .replace(/\bmentions_person\b/g, String(signals.mentions_person ?? false))
      .replace(/\bmentions_metric_or_stat\b/g, String(signals.mentions_metric_or_stat ?? false))
      .replace(/\bhas_url_links\b/g, String(signals.has_url_links ?? false))
      .replace(/\bexclamation_density\b/g, String(signals.exclamation_density ?? 0))
      .replace(/\bimage_available\b/g, String(signals.image_available ?? false))
      .replace(/\bengagement_tier\b/g, `"${signals.engagement_tier ?? 'low'}"`)
      .replace(/\bformat\b/g, `"${signals.format ?? 'unknown'}"`);

    // Only allow safe characters
    if (/[^a-zA-Z0-9_\s&|!=<>()."'\-,]/.test(safeCondition)) {
      return false;
    }

    // eslint-disable-next-line no-eval
    return Boolean(eval(safeCondition));
  } catch {
    return false;
  }
}
