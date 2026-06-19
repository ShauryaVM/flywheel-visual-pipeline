import 'dotenv/config';
import { runStage2 } from './stages/stage2-post-to-concept/index.js';
import { runStage3 } from './stages/stage3-concept-to-html/index.js';
import { runStage4 } from './stages/stage4-eval/index.js';
import { runWithFeedback } from './stages/stage4-eval/feedback-loop.js';
import { createStageLogger } from './observability/logger.js';
import { loadDesignSystemSummary } from './utils/design-system-summary.js';
import type { PipelineInput, PipelineResult } from './types/index.js';

export { runWithFeedback } from './stages/stage4-eval/feedback-loop.js';
export type { FeedbackLoopInput, FeedbackLoopResult } from './stages/stage4-eval/feedback-loop.js';

const log = createStageLogger('pipeline');

const EVAL_THRESHOLD = 7.0;

/**
 * Run the visual pipeline: Post -> Concept -> HTML -> PDF + PNG -> Eval.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { postText, postId, outputDir = 'data/outputs' } = input;

  const pipelineStart = Date.now();
  log.info({ postId, outputDir }, 'Starting pipeline');

  // Stage 2: Generate visual concepts from post
  const stage2Start = Date.now();
  const conceptOutput = await runStage2(postText, { postId, outputDir });
  const stage2Latency = Date.now() - stage2Start;
  const selectedConcept = conceptOutput.concepts[conceptOutput.selected]!;
  log.info(
    { modality: selectedConcept.modality, headline: selectedConcept.headline, latencyMs: stage2Latency },
    'Stage 2 complete: concept selected',
  );

  // Stage 3: Render concept to HTML, export PDF + PNG
  const stage3Start = Date.now();
  const stage3 = await runStage3({
    concept: selectedConcept,
    postId,
    outputDir,
  });
  const stage3Latency = Date.now() - stage3Start;
  log.info({ latencyMs: stage3Latency }, 'Stage 3 complete: visual exported');

  // Stage 4: Evaluate the rendered visual
  const subDir = postId ? `${outputDir}/${postId}` : outputDir;
  const designSystemSummary = await loadDesignSystemSummary();

  let evalScore;
  const stage4Start = Date.now();
  try {
    evalScore = await runStage4({
      htmlPath: stage3.htmlPath,
      postText,
      designSystemSummary,
      pngPath: stage3.pngPath,
      outputDir: subDir,
    });
    const stage4Latency = Date.now() - stage4Start;

    const effectiveScore = evalScore.compositeScore ?? evalScore.overall;

    log.info(
      {
        overall: evalScore.overall,
        compositeScore: evalScore.compositeScore,
        onBrand: evalScore.onBrand,
        legible: evalScore.legible,
        clearHierarchy: evalScore.clearHierarchy,
        notGeneric: evalScore.notGeneric,
        visionAbsolute: evalScore.visionAbsolute,
        visionComparative: evalScore.visionComparative,
        passes: evalScore.passesThreshold,
        latencyMs: stage4Latency,
      },
      'Stage 4 complete: eval scored',
    );

    if (effectiveScore < EVAL_THRESHOLD) {
      log.warn(
        { score: effectiveScore, critique: evalScore.critique, visionCritique: evalScore.visionCritique },
        `Visual scored ${effectiveScore.toFixed(1)} (below threshold ${EVAL_THRESHOLD}). Regeneration recommended.`,
      );
    }
  } catch (err) {
    log.error({ err }, 'Stage 4 eval failed (non-blocking)');
  }

  const totalLatencyMs = Date.now() - pipelineStart;
  log.info(
    { totalLatencyMs, postId, evalScore: evalScore?.overall },
    'Pipeline complete',
  );

  return {
    concept: conceptOutput,
    selectedConcept,
    html: stage3.html,
    htmlPath: stage3.htmlPath,
    pdfPath: stage3.pdfPath,
    pngPath: stage3.pngPath,
    evalScore,
  };
}

/**
 * Run the pipeline with an automatic feedback loop: if the visual fails
 * evaluation, regenerate using the critique and pick the best result.
 */
export async function runPipelineWithFeedback(
  input: PipelineInput & { maxRetries?: number },
): Promise<PipelineResult> {
  const { postText, postId, outputDir = 'data/outputs', maxRetries = 1 } = input;
  return runWithFeedback({ postText, postId, outputDir, maxRetries });
}
