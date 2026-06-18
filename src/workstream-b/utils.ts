import Anthropic from '@anthropic-ai/sdk';
import { createStageLogger } from '../observability/logger.js';
import type { EnrichedPost } from './types.js';

const log = createStageLogger('workstream-b:utils');

/**
 * Split an array into batches of the given size.
 */
export function batchArray<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/**
 * Take a stratified sample of enriched posts.
 * Balances across format types and engagement tiers, capping at 1 post per creator.
 */
export function stratifiedSample(
  posts: EnrichedPost[],
  targetCount: number,
  excludeIds: Set<string> = new Set(),
): EnrichedPost[] {
  const eligible = posts.filter((p) => !excludeIds.has(p.id));

  const byCreator = new Map<string, EnrichedPost[]>();
  for (const p of eligible) {
    const key = p.creator_name ?? p.creator_handle ?? p.id ?? 'unknown';
    if (!byCreator.has(key)) byCreator.set(key, []);
    byCreator.get(key)!.push(p);
  }

  // One post per creator (pick the one with highest engagement)
  const deduped: EnrichedPost[] = [];
  for (const creatorPosts of byCreator.values()) {
    creatorPosts.sort(
      (a, b) => (b.engagement?.total_engagement ?? 0) - (a.engagement?.total_engagement ?? 0),
    );
    deduped.push(creatorPosts[0]);
  }

  // Bucket by format x engagement_tier
  const buckets = new Map<string, EnrichedPost[]>();
  for (const p of deduped) {
    const key = `${p.signals.format}::${p.signals.engagement_tier}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(p);
  }

  // Shuffle each bucket
  for (const bucket of buckets.values()) {
    shuffleArray(bucket);
  }

  // Round-robin pick from buckets
  const result: EnrichedPost[] = [];
  const bucketEntries = Array.from(buckets.entries());
  let round = 0;
  while (result.length < targetCount && bucketEntries.some(([, b]) => b.length > round)) {
    for (const [, bucket] of bucketEntries) {
      if (round < bucket.length && result.length < targetCount) {
        result.push(bucket[round]);
      }
    }
    round++;
  }

  return result;
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Call Claude with retry/rate-limit handling.
 * Returns the raw text response.
 */
export async function callClaude(
  client: Anthropic,
  opts: {
    system: string;
    userContent: string;
    model?: string;
    maxTokens?: number;
    label: string;
  },
): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const model = opts.model ?? 'claude-sonnet-4-6';
  const maxTokens = opts.maxTokens ?? 8192;
  const startMs = Date.now();

  const approxInputTokens = Math.ceil((opts.system.length + opts.userContent.length) / 4);
  log.info({ label: opts.label, model, approxInputTokens }, 'Calling Claude');

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: opts.system,
    messages: [{ role: 'user', content: opts.userContent }],
  });

  const latencyMs = Date.now() - startMs;
  const inputTokens = response.usage?.input_tokens ?? approxInputTokens;
  const outputTokens = response.usage?.output_tokens ?? 0;

  log.info(
    { label: opts.label, inputTokens, outputTokens, latencyMs, model },
    'Claude response received',
  );

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error(`No text response from Claude for: ${opts.label}`);
  }

  return { text: textBlock.text, inputTokens, outputTokens, latencyMs };
}

/**
 * Extract JSON from a Claude response that may contain markdown fences or extra text.
 */
export function extractJson(text: string): string {
  // Try to find JSON in code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find a JSON object or array
  const objMatch = text.match(/(\{[\s\S]*\})/);
  if (objMatch) return objMatch[1].trim();

  const arrMatch = text.match(/(\[[\s\S]*\])/);
  if (arrMatch) return arrMatch[1].trim();

  return text.trim();
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a post's text and signals for inclusion in an LLM prompt.
 */
export function formatPostForPrompt(post: EnrichedPost, index?: number): string {
  const prefix = index !== undefined ? `### Post ${index + 1}` : '### Post';
  const lines = [
    `${prefix} (ID: ${post.id})`,
    `**Creator**: ${post.creator_name ?? 'Unknown'}`,
    `**Format**: ${post.signals.format}`,
    `**Engagement Tier**: ${post.signals.engagement_tier}`,
    `**Signals**: word_count=${post.signals.word_count}, has_numbers=${post.signals.has_numbers}, has_list_structure=${post.signals.has_list_structure}, has_questions=${post.signals.has_questions}, mentions_person=${post.signals.mentions_person}, mentions_metric_or_stat=${post.signals.mentions_metric_or_stat}, has_url_links=${post.signals.has_url_links}, exclamation_density=${post.signals.exclamation_density.toFixed(3)}`,
    `**Text**:`,
    post.content_text.slice(0, 1500),
  ];
  if (post.content_text.length > 1500) lines.push('...(truncated)');
  return lines.join('\n');
}
