import Anthropic from '@anthropic-ai/sdk';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createStageLogger } from '../observability/logger.js';
import { loadConfig } from '../config.js';
import { ExplorationBatchResponseSchema, type EnrichedPost, type ExplorationResult } from './types.js';
import { batchArray, stratifiedSample, callClaude, extractJson, formatPostForPrompt, sleep } from './utils.js';
import { PHASE1_SYSTEM, buildPhase1UserContent } from './prompts.js';

const log = createStageLogger('workstream-b:phase1');

/**
 * Phase 1: Dual-Axis Open Exploration.
 * Sample ~40 posts, have Claude explore content types and visual modalities freely.
 */
export async function runPhase1(
  enrichedPosts: EnrichedPost[],
  outputDir: string,
): Promise<{ results: ExplorationResult[]; usedPostIds: Set<string> }> {
  log.info('Phase 1: Dual-Axis Open Exploration');

  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const sample = stratifiedSample(enrichedPosts, 40);
  log.info({ sampleSize: sample.length }, 'Stratified sample selected');

  const batches = batchArray(sample, 8);
  const allResults: ExplorationResult[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log.info({ batch: i + 1, total: batches.length, batchSize: batch.length }, 'Processing batch');

    const postTexts = batch.map((p, idx) => formatPostForPrompt(p, idx)).join('\n\n---\n\n');
    const userContent = buildPhase1UserContent(postTexts);

    let results: ExplorationResult[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await callClaude(client, {
          system: PHASE1_SYSTEM,
          userContent,
          label: `phase1-batch-${i + 1}`,
          maxTokens: 4096,
        });

        const jsonStr = extractJson(response.text);
        const parsed = ExplorationBatchResponseSchema.parse(JSON.parse(jsonStr));
        results = parsed.results;
        break;
      } catch (err) {
        log.warn({ attempt, err: err instanceof Error ? err.message : String(err) }, 'Batch parse failed, retrying');
        if (attempt === 1) {
          log.error({ batch: i + 1 }, 'Batch failed after retries, skipping');
        }
        await sleep(2000);
      }
    }

    if (results) {
      allResults.push(...results);
    }

    if (i < batches.length - 1) {
      await sleep(1500);
    }
  }

  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'phase1-exploration-results.json');
  await writeFile(outputPath, JSON.stringify(allResults, null, 2), 'utf-8');
  log.info({ outputPath, resultCount: allResults.length }, 'Phase 1 results saved');

  const usedPostIds = new Set(sample.map((p) => p.id));
  return { results: allResults, usedPostIds };
}
