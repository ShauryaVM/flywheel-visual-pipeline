import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { judgeVisual } from './judge.js';
import { createStageLogger } from '../../observability/logger.js';
import type { EvalScore } from '../../types/index.js';

const log = createStageLogger('stage4');

export interface EvalInput {
  htmlPath: string;
  postText: string;
  designSystemSummary: string;
  outputDir?: string;
}

/**
 * Stage 4 (stretch): Evaluate a rendered visual and optionally trigger regeneration.
 *
 * If the score is below threshold, returns the critique for use in a retry loop.
 */
export async function runStage4(input: EvalInput): Promise<EvalScore> {
  const { htmlPath, postText, designSystemSummary, outputDir = 'data/outputs' } = input;

  log.info({ htmlPath }, 'Input');

  const stageStart = Date.now();
  const html = await readFile(htmlPath, 'utf-8');
  const score = await judgeVisual(html, postText, designSystemSummary);
  const latencyMs = Date.now() - stageStart;

  log.info(
    { overall: score.overall, onBrand: score.onBrand, legible: score.legible, clearHierarchy: score.clearHierarchy, notGeneric: score.notGeneric },
    'Output',
  );
  log.info({ latencyMs }, 'Complete');

  await mkdir(outputDir, { recursive: true });
  const scorePath = join(outputDir, 'eval_score.json');
  await writeFile(scorePath, JSON.stringify(score, null, 2), 'utf-8');
  log.info({ scorePath, passes: score.passesThreshold }, 'Eval score written');

  if (!score.passesThreshold) {
    log.warn(
      { overall: score.overall, critique: score.critique },
      'Visual below quality threshold; regeneration recommended',
    );
  }

  return score;
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runStage4({
    htmlPath: process.argv[2] ?? 'data/outputs/visual-concept-1.html',
    postText: 'Sample post text',
    designSystemSummary: 'Brand uses blue primary, Inter font, 8px radius',
  }).catch((err) => {
    log.fatal(err, 'Stage 4 failed');
    process.exit(1);
  });
}
