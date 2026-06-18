import { readFile } from 'node:fs/promises';
import { createStageLogger } from '../observability/logger.js';
import { InspPostSchema, type InspPost, type EnrichedPost, type Signals } from './types.js';

const log = createStageLogger('workstream-b:signal-enrichment');

/**
 * Phase 0: Load posts and compute pure-computation signals for each.
 */
export async function runSignalEnrichment(postsPath: string): Promise<EnrichedPost[]> {
  log.info({ postsPath }, 'Phase 0: Signal Enrichment - loading posts');

  const raw = await readFile(postsPath, 'utf-8');
  const data = JSON.parse(raw) as unknown[];

  const posts: InspPost[] = [];
  for (const item of data) {
    const parsed = InspPostSchema.safeParse(item);
    if (parsed.success) {
      posts.push(parsed.data);
    } else {
      log.warn({ errors: parsed.error.issues.slice(0, 3) }, 'Skipping invalid post');
    }
  }

  log.info({ validPosts: posts.length, total: data.length }, 'Posts loaded');

  const engagements = posts
    .map((p) => p.engagement?.total_engagement ?? 0)
    .sort((a, b) => a - b);

  const p33 = engagements[Math.floor(engagements.length * 0.33)] ?? 0;
  const p66 = engagements[Math.floor(engagements.length * 0.66)] ?? 0;

  const enriched: EnrichedPost[] = posts.map((post) => ({
    ...post,
    signals: computeSignals(post, p33, p66),
  }));

  log.info({ enrichedCount: enriched.length }, 'Phase 0 complete');
  return enriched;
}

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
    mentions_person:
      /@\w/.test(text) || (post.mentions != null && post.mentions.length > 0),
    mentions_metric_or_stat:
      /\d+%|\$\d|\d+k\b|\d+x\b|\d+ times|grew by|increased|decreased/i.test(text),
    has_url_links: /https?:\/\//.test(text),
    exclamation_density: wordCount > 0 ? exclamationCount / wordCount : 0,
    format: post.format ?? post.media?.type ?? 'unknown',
    engagement_tier: engagementTier,
    image_available: post.local_image != null && post.local_image !== '',
  };
}
