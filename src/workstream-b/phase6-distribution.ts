import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStageLogger } from '../observability/logger.js';
import {
  DistributionSummarySchema,
  ContentTypeRulesSchema,
  PostLabelSchema,
  type PostLabel,
  type ContentTypeRules,
} from './types.js';

const log = createStageLogger('workstream-b:phase6');

/**
 * Phase 6: Distribution Analysis.
 * Compute summaries, heatmap data, coverage reports.
 */
export async function runPhase6(
  labels: PostLabel[],
  rules: ContentTypeRules[],
  outputDir: string,
): Promise<void> {
  log.info({ labelCount: labels.length }, 'Phase 6: Distribution Analysis');

  // Content type counts
  const contentTypeCounts: Record<string, number> = {};
  for (const l of labels) {
    contentTypeCounts[l.content_type] = (contentTypeCounts[l.content_type] ?? 0) + 1;
  }

  // Visual modality counts
  const visualModalityCounts: Record<string, number> = {};
  for (const l of labels) {
    visualModalityCounts[l.visual_modality] = (visualModalityCounts[l.visual_modality] ?? 0) + 1;
  }

  // Cross-tabulation
  const crossTabMap = new Map<string, number>();
  for (const l of labels) {
    const key = `${l.content_type}::${l.visual_modality}`;
    crossTabMap.set(key, (crossTabMap.get(key) ?? 0) + 1);
  }
  const crossTabulation = Array.from(crossTabMap.entries()).map(([key, count]) => {
    const [content_type, visual_modality] = key.split('::');
    return { content_type, visual_modality, count };
  });

  // Confidence distribution
  const confidenceDist = { high: 0, medium: 0, low: 0 };
  for (const l of labels) {
    confidenceDist[l.confidence]++;
  }

  // Thin category warnings (< 5 posts)
  const thinWarnings: Array<{ axis: string; category: string; count: number }> = [];
  for (const [cat, count] of Object.entries(contentTypeCounts)) {
    if (count < 5) thinWarnings.push({ axis: 'content_type', category: cat, count });
  }
  for (const [cat, count] of Object.entries(visualModalityCounts)) {
    if (count < 5) thinWarnings.push({ axis: 'visual_modality', category: cat, count });
  }

  // Coverage report: % of posts handled by top-3 rules per content_type
  const coverageReport: Array<{ content_type: string; top_rules_coverage_pct: number }> = [];
  for (const ctRules of rules) {
    const ctLabels = labels.filter((l) => l.content_type === ctRules.content_type);
    if (ctLabels.length === 0) {
      coverageReport.push({ content_type: ctRules.content_type, top_rules_coverage_pct: 0 });
      continue;
    }

    // Top 3 modalities by rule confidence
    const topModalities = ctRules.rules
      .slice(0, 3)
      .map((r) => r.visual_modality);

    const covered = ctLabels.filter((l) => topModalities.includes(l.visual_modality)).length;
    const pct = Math.round((covered / ctLabels.length) * 10000) / 100;
    coverageReport.push({ content_type: ctRules.content_type, top_rules_coverage_pct: pct });
  }

  const summary = DistributionSummarySchema.parse({
    generated_at: new Date().toISOString(),
    total_posts: labels.length,
    content_type_counts: contentTypeCounts,
    visual_modality_counts: visualModalityCounts,
    cross_tabulation: crossTabulation,
    confidence_distribution: confidenceDist,
    thin_category_warnings: thinWarnings,
    coverage_report: coverageReport,
  });

  const outputPath = join(outputDir, 'distribution-summary.json');
  await writeFile(outputPath, JSON.stringify(summary, null, 2), 'utf-8');

  log.info(
    {
      outputPath,
      totalPosts: summary.total_posts,
      contentTypes: Object.keys(contentTypeCounts).length,
      visualModalities: Object.keys(visualModalityCounts).length,
      highConfPct: labels.length > 0
        ? ((confidenceDist.high / labels.length) * 100).toFixed(1) + '%'
        : '0%',
      thinWarnings: thinWarnings.length,
    },
    'Phase 6 complete',
  );
}

async function main() {
  const LABELS_PATH = 'data/schema/posts-labeled.json';
  const RULES_PATH = 'data/schema/decision-rules.json';
  const OUTPUT_DIR = 'data/schema';

  log.info('Phase 6 standalone run');

  const labelsRaw = await readFile(LABELS_PATH, 'utf-8');
  const labelsArr = JSON.parse(labelsRaw) as unknown[];
  const labels: PostLabel[] = labelsArr.map((l) => PostLabelSchema.parse(l));

  const rulesRaw = await readFile(RULES_PATH, 'utf-8');
  const rulesData = JSON.parse(rulesRaw) as { rules: unknown[] };
  const rules: ContentTypeRules[] = rulesData.rules.map((r) => ContentTypeRulesSchema.parse(r));

  log.info({ labels: labels.length, rules: rules.length }, 'Data loaded');

  await runPhase6(labels, rules, OUTPUT_DIR);
  log.info('Phase 6 standalone complete');
}

const isMainModule = process.argv[1]?.replace(/\\/g, '/').includes('phase6-distribution');
if (isMainModule) {
  main().catch((err) => {
    log.fatal(err, 'Phase 6 standalone failed');
    process.exit(1);
  });
}
