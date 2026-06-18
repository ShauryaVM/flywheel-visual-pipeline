import Anthropic from '@anthropic-ai/sdk';
import { PostClassification, ContentType, VisualModality } from '../schemas/modality.schema.js';
import { loadConfig } from '../config.js';
import { createStageLogger } from '../observability/logger.js';
import type { RawPost } from '../types/index.js';

const log = createStageLogger('workstream-b:classifier');

/**
 * Classify a single post along both axes: content type and visual modality.
 */
export async function classifyPost(post: RawPost): Promise<PostClassification> {
  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  log.debug({ postId: post.id }, 'Classifying post');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: CLASSIFIER_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Post ID: ${post.id}\n\n${post.text}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from classifier');
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in classifier response');
  }

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  return PostClassification.parse({ ...parsed, postId: post.id });
}

/**
 * Classify a batch of posts with concurrency control.
 */
export async function classifyBatch(
  posts: RawPost[],
  concurrency: number = 5,
): Promise<PostClassification[]> {
  log.info({ totalPosts: posts.length, concurrency }, 'Starting batch classification');

  const results: PostClassification[] = [];
  const queue = [...posts];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const post = queue.shift()!;
      try {
        const classification = await classifyPost(post);
        results.push(classification);
      } catch (err) {
        log.error({ postId: post.id, err }, 'Failed to classify post');
      }
    }
  });

  await Promise.all(workers);
  log.info({ classified: results.length, total: posts.length }, 'Batch classification complete');

  return results;
}

const contentTypes = ContentType.options.join(', ');
const visualModalities = VisualModality.options.join(', ');

const CLASSIFIER_PROMPT = `You classify LinkedIn-style posts along two axes.

## Content Type (rhetorical shape)
Options: ${contentTypes}

## Visual Modality (best visual form)
Options: ${visualModalities}

Return a JSON object with:
- contentType: one of the content type options
- visualModality: one of the visual modality options
- confidence: number between 0 and 1
- rationale: brief explanation`;
