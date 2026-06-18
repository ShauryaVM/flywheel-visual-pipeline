import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createStageLogger } from '../observability/logger.js';
import { InspPostSchema, type InspPost, type PostLabel } from './types.js';

const log = createStageLogger('workstream-b:analysis-engagement');

const OUTPUT_DIR = 'data/schema';
const POSTS_PATH = 'data/posts/inspiration-posts-300.json';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function main() {
  log.info('=== Analysis: Engagement Correlation ===');
  const startMs = Date.now();

  await mkdir(OUTPUT_DIR, { recursive: true });

  // Load labels
  const labelsRaw = await readFile(join(OUTPUT_DIR, 'posts-labeled.json'), 'utf-8');
  const allLabels: PostLabel[] = JSON.parse(labelsRaw);

  // Load original posts for engagement data
  const postsRaw = await readFile(POSTS_PATH, 'utf-8');
  const postsData = JSON.parse(postsRaw) as unknown[];
  const postsMap = new Map<string, InspPost>();
  for (const item of postsData) {
    const parsed = InspPostSchema.safeParse(item);
    if (parsed.success) postsMap.set(parsed.data.id, parsed.data);
  }

  // Group by content_type -> visual_modality -> engagements
  const groupedEngagement = new Map<string, Map<string, number[]>>();

  for (const label of allLabels) {
    const post = postsMap.get(label.post_id);
    const engagement = post?.engagement?.total_engagement ?? 0;

    if (!groupedEngagement.has(label.content_type)) {
      groupedEngagement.set(label.content_type, new Map());
    }
    const modalityMap = groupedEngagement.get(label.content_type)!;
    if (!modalityMap.has(label.visual_modality)) {
      modalityMap.set(label.visual_modality, []);
    }
    modalityMap.get(label.visual_modality)!.push(engagement);
  }

  // Build results
  const contentTypeResults: Array<{
    content_type: string;
    total_posts: number;
    modality_breakdown: Array<{
      visual_modality: string;
      count: number;
      median_engagement: number;
      mean_engagement: number;
      min_engagement: number;
      max_engagement: number;
    }>;
    insights: string[];
  }> = [];

  for (const [contentType, modalityMap] of groupedEngagement) {
    const breakdown: Array<{
      visual_modality: string;
      count: number;
      median_engagement: number;
      mean_engagement: number;
      min_engagement: number;
      max_engagement: number;
    }> = [];

    let totalPosts = 0;
    for (const [modality, engagements] of modalityMap) {
      totalPosts += engagements.length;
      const med = median(engagements);
      const mean = engagements.reduce((s, v) => s + v, 0) / engagements.length;
      breakdown.push({
        visual_modality: modality,
        count: engagements.length,
        median_engagement: Math.round(med),
        mean_engagement: Math.round(mean),
        min_engagement: Math.min(...engagements),
        max_engagement: Math.max(...engagements),
      });
    }

    breakdown.sort((a, b) => b.median_engagement - a.median_engagement);

    const insights: string[] = [];
    if (breakdown.length >= 2) {
      const top = breakdown[0];
      const bottom = breakdown[breakdown.length - 1];
      if (top.median_engagement > 0 && bottom.median_engagement > 0) {
        const ratio = top.median_engagement / bottom.median_engagement;
        if (ratio > 1.5) {
          insights.push(
            `${top.visual_modality} (median ${top.median_engagement}) outperforms ${bottom.visual_modality} (median ${bottom.median_engagement}) by ${ratio.toFixed(1)}x`,
          );
        }
      }
      if (top.median_engagement > bottom.median_engagement) {
        insights.push(
          `Top modality: ${top.visual_modality} with median engagement ${top.median_engagement} (n=${top.count})`,
        );
      }
    }

    contentTypeResults.push({
      content_type: contentType,
      total_posts: totalPosts,
      modality_breakdown: breakdown,
      insights,
    });
  }

  contentTypeResults.sort((a, b) => b.total_posts - a.total_posts);

  // Overall modality engagement
  const overallModalityEngagement = new Map<string, number[]>();
  for (const label of allLabels) {
    const post = postsMap.get(label.post_id);
    const engagement = post?.engagement?.total_engagement ?? 0;
    if (!overallModalityEngagement.has(label.visual_modality)) {
      overallModalityEngagement.set(label.visual_modality, []);
    }
    overallModalityEngagement.get(label.visual_modality)!.push(engagement);
  }

  const overallModality: Array<{
    visual_modality: string;
    count: number;
    median_engagement: number;
    mean_engagement: number;
  }> = [];
  for (const [modality, engagements] of overallModalityEngagement) {
    overallModality.push({
      visual_modality: modality,
      count: engagements.length,
      median_engagement: Math.round(median(engagements)),
      mean_engagement: Math.round(engagements.reduce((s, v) => s + v, 0) / engagements.length),
    });
  }
  overallModality.sort((a, b) => b.median_engagement - a.median_engagement);

  const results = {
    generated_at: new Date().toISOString(),
    total_posts_analyzed: allLabels.length,
    overall_modality_engagement: overallModality,
    per_content_type: contentTypeResults,
  };

  const outputPath = join(OUTPUT_DIR, 'engagement-correlation.json');
  await writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');

  log.info(
    {
      outputPath,
      contentTypes: contentTypeResults.length,
      topModality: overallModality[0]?.visual_modality,
      topMedian: overallModality[0]?.median_engagement,
    },
    'Engagement correlation analysis complete',
  );

  const durationMs = Date.now() - startMs;
  log.info({ durationMs }, 'Analysis complete');
}

main().catch((err) => {
  log.fatal(err, 'Engagement analysis script failed');
  process.exit(1);
});
