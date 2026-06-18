import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { createStageLogger } from '../observability/logger.js';
import { runSignalEnrichment } from './signal-enrichment.js';
import { runPhase1 } from './phase1-exploration.js';
import { runPhase2 } from './phase2-synthesis.js';
import { runPhase3 } from './phase3-refinement.js';
import { runPhase4 } from './phase4-classification.js';
import { runPhase5 } from './phase5-rules.js';
import { runPhase6 } from './phase6-distribution.js';

const log = createStageLogger('workstream-b');

const POSTS_PATH = 'data/posts/inspiration-posts-300.json';
const OUTPUT_DIR = 'data/schema';

async function main() {
  log.info('=== Workstream B: DACTI Pipeline ===');
  const pipelineStart = Date.now();

  await mkdir(OUTPUT_DIR, { recursive: true });

  // Phase 0: Signal Enrichment
  let phaseStart = Date.now();
  log.info('--- Phase 0: Signal Enrichment ---');
  const enrichedPosts = await runSignalEnrichment(POSTS_PATH);
  log.info({ durationMs: Date.now() - phaseStart, posts: enrichedPosts.length }, 'Phase 0 done');

  // Phase 1: Dual-Axis Open Exploration
  phaseStart = Date.now();
  log.info('--- Phase 1: Dual-Axis Open Exploration ---');
  const { results: explorationResults, usedPostIds } = await runPhase1(enrichedPosts, OUTPUT_DIR);
  log.info({ durationMs: Date.now() - phaseStart, results: explorationResults.length }, 'Phase 1 done');

  // Phase 2: Schema Synthesis
  phaseStart = Date.now();
  log.info('--- Phase 2: Schema Synthesis ---');
  const schemaV0 = await runPhase2(explorationResults, OUTPUT_DIR);
  log.info({ durationMs: Date.now() - phaseStart }, 'Phase 2 done');

  // Phase 3: Iterative Refinement
  phaseStart = Date.now();
  log.info('--- Phase 3: Iterative Refinement ---');
  const { schema: finalSchema } = await runPhase3(enrichedPosts, schemaV0, usedPostIds, OUTPUT_DIR);
  log.info({ durationMs: Date.now() - phaseStart }, 'Phase 3 done');

  // Phase 4: Full Classification
  phaseStart = Date.now();
  log.info('--- Phase 4: Full Classification ---');
  const labels = await runPhase4(enrichedPosts, finalSchema, OUTPUT_DIR);
  log.info({ durationMs: Date.now() - phaseStart, classified: labels.length }, 'Phase 4 done');

  // Phase 5: Decision Rule Extraction
  phaseStart = Date.now();
  log.info('--- Phase 5: Decision Rule Extraction ---');
  const rules = await runPhase5(labels, enrichedPosts, finalSchema, OUTPUT_DIR);
  log.info({ durationMs: Date.now() - phaseStart }, 'Phase 5 done');

  // Phase 6: Distribution Analysis
  phaseStart = Date.now();
  log.info('--- Phase 6: Distribution Analysis ---');
  await runPhase6(labels, rules, OUTPUT_DIR);
  log.info({ durationMs: Date.now() - phaseStart }, 'Phase 6 done');

  const totalDuration = Date.now() - pipelineStart;
  log.info(
    { totalDurationMs: totalDuration, totalDurationMin: (totalDuration / 60000).toFixed(1) },
    '=== Workstream B Pipeline Complete ===',
  );
}

main().catch((err) => {
  log.fatal(err, 'Workstream B pipeline failed');
  process.exit(1);
});
