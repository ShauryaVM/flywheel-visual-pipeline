import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runStage2 } from '../stage2-post-to-concept/index.js';
import { runStage3 } from '../stage3-concept-to-html/index.js';
import { runStage4 } from './index.js';
import { createStageLogger } from '../../observability/logger.js';
import { loadDesignSystemSummary } from '../../utils/design-system-summary.js';
import { classifyCritique, generateRenderingOverrides, applyRenderingOverrides } from '../../utils/rendering-overrides.js';
import type { EvalScore, FeedbackLog, FeedbackAttempt, PipelineResult } from '../../types/index.js';

const log = createStageLogger('feedback-loop');

const EVAL_THRESHOLD = 7.0;

export interface FeedbackLoopInput {
  postText: string;
  targetUrl: string;
  postId?: string;
  outputDir?: string;
  maxRetries?: number;
}

export interface FeedbackLoopResult extends PipelineResult {
  feedbackLog?: FeedbackLog;
  regenerated: boolean;
}

function getEffectiveScore(evalScore: EvalScore): number {
  return evalScore.compositeScore ?? evalScore.overall;
}

function combinedCritique(evalScore: EvalScore): string {
  const parts: string[] = [];
  if (evalScore.critique) parts.push(evalScore.critique);
  if (evalScore.visionCritique) parts.push(evalScore.visionCritique);
  return parts.join(' ');
}

function computeAxesImproved(original: EvalScore, final: EvalScore): string[] {
  const axes: string[] = [];
  if (final.onBrand > original.onBrand) axes.push('onBrand');
  if (final.legible > original.legible) axes.push('legible');
  if (final.clearHierarchy > original.clearHierarchy) axes.push('clearHierarchy');
  if (final.notGeneric > original.notGeneric) axes.push('notGeneric');
  if (final.visionAbsolute && original.visionAbsolute) {
    if (final.visionAbsolute.layout > original.visionAbsolute.layout) axes.push('vision:layout');
    if (final.visionAbsolute.legibility > original.visionAbsolute.legibility) axes.push('vision:legibility');
    if (final.visionAbsolute.polish > original.visionAbsolute.polish) axes.push('vision:polish');
  }
  if (final.visionComparative && original.visionComparative) {
    if (final.visionComparative.colorMatch > original.visionComparative.colorMatch) axes.push('vision:colorMatch');
    if (final.visionComparative.typographyMatch > original.visionComparative.typographyMatch) axes.push('vision:typographyMatch');
    if (final.visionComparative.aestheticMatch > original.visionComparative.aestheticMatch) axes.push('vision:aestheticMatch');
  }
  return axes;
}

/**
 * Run the visual pipeline with a feedback loop: if the initial evaluation
 * fails the threshold, regenerate using the critique and re-evaluate.
 * Returns the best result across all attempts.
 */
export async function runWithFeedback(input: FeedbackLoopInput): Promise<FeedbackLoopResult> {
  const { postText, targetUrl, postId = 'default', outputDir = 'data/outputs', maxRetries = 1 } = input;

  const subDir = postId ? `${outputDir}/${postId}` : outputDir;
  const attempts: FeedbackAttempt[] = [];

  log.info({ postId, maxRetries }, 'Starting feedback loop');

  const designSystemSummary = await loadDesignSystemSummary();

  // --- Attempt 1: initial generation ---
  const stage2Start = Date.now();
  const conceptOutput = await runStage2(postText, { postId, outputDir });
  const selectedConcept = conceptOutput.concepts[conceptOutput.selected]!;
  log.info(
    { modality: selectedConcept.modality, headline: selectedConcept.headline, latencyMs: Date.now() - stage2Start },
    'Initial concept generated',
  );

  const stage3 = await runStage3({ concept: selectedConcept, postId, outputDir });

  let evalScore: EvalScore;
  try {
    evalScore = await runStage4({
      htmlPath: stage3.htmlPath,
      postText,
      designSystemSummary,
      targetUrl,
      pngPath: stage3.pngPath,
      outputDir: subDir,
    });
  } catch (err) {
    log.error({ err }, 'Initial evaluation failed');
    return {
      concept: conceptOutput,
      selectedConcept,
      html: stage3.html,
      htmlPath: stage3.htmlPath,
      pdfPath: stage3.pdfPath,
      pngPath: stage3.pngPath,
      evalScore: undefined,
      regenerated: false,
    };
  }

  const initialCritique = combinedCritique(evalScore);
  attempts.push({
    attempt: 1,
    scores: evalScore,
    critique: initialCritique,
  });

  const initialScore = getEffectiveScore(evalScore);
  log.info({ score: initialScore, passes: evalScore.passesThreshold }, 'Initial evaluation complete');

  if (evalScore.passesThreshold) {
    log.info({ postId, score: initialScore }, 'Visual passes threshold on first attempt');
    return {
      concept: conceptOutput,
      selectedConcept,
      html: stage3.html,
      htmlPath: stage3.htmlPath,
      pdfPath: stage3.pdfPath,
      pngPath: stage3.pngPath,
      evalScore,
      regenerated: false,
    };
  }

  // --- Retry loop ---
  let bestResult = {
    concept: conceptOutput,
    selectedConcept,
    html: stage3.html,
    htmlPath: stage3.htmlPath,
    pdfPath: stage3.pdfPath,
    pngPath: stage3.pngPath,
    evalScore,
  };
  let bestScore = initialScore;

  for (let retry = 0; retry < maxRetries; retry++) {
    const attemptNum = retry + 2;
    log.warn(
      { attempt: attemptNum, previousScore: bestScore, critique: initialCritique },
      `Regenerating due to: ${initialCritique.substring(0, 120)}`,
    );

    // Classify critique to determine strategy
    const classification = classifyCritique(initialCritique);
    const renderingOverrides = generateRenderingOverrides(initialCritique);

    log.info(
      {
        isRenderingOnly: classification.isRenderingOnly,
        isConceptOnly: classification.isConceptOnly,
        isBoth: classification.isBoth,
        renderingIssues: classification.renderingIssues,
        conceptIssues: classification.conceptIssues,
        hasOverrides: !!renderingOverrides,
      },
      'Critique classified',
    );

    const previousScores: Record<string, number> = {
      onBrand: evalScore.onBrand,
      legible: evalScore.legible,
      clearHierarchy: evalScore.clearHierarchy,
      notGeneric: evalScore.notGeneric,
    };
    if (evalScore.visionAbsolute) {
      previousScores.visionLayout = evalScore.visionAbsolute.layout;
      previousScores.visionLegibility = evalScore.visionAbsolute.legibility;
      previousScores.visionPolish = evalScore.visionAbsolute.polish;
    }
    if (evalScore.compositeScore != null) {
      previousScores.compositeScore = evalScore.compositeScore;
    }

    let retrySelectedConcept = selectedConcept;
    let retryConceptOutput = conceptOutput;
    let conceptChanges = 'Rendering overrides only (no concept change)';

    // If concept issues: regenerate the concept
    if (!classification.isRenderingOnly) {
      retryConceptOutput = await runStage2(postText, {
        postId: `${postId}-retry${attemptNum}`,
        outputDir,
        feedback: {
          previousScores,
          critique: initialCritique,
          previousConcept: selectedConcept.headline,
        },
      });

      retrySelectedConcept = retryConceptOutput.concepts[retryConceptOutput.selected]!;
      conceptChanges = `Modality: ${selectedConcept.modality} → ${retrySelectedConcept.modality}; Headline: "${selectedConcept.headline}" → "${retrySelectedConcept.headline}"`;
      log.info({ conceptChanges }, 'Regenerated concept');
    }

    const retryPostId = `${postId}-retry${attemptNum}`;
    const retryStage3 = await runStage3({
      concept: retrySelectedConcept,
      postId: retryPostId,
      outputDir,
      renderingOverrides: renderingOverrides ?? undefined,
    });

    const retrySubDir = `${outputDir}/${retryPostId}`;
    let retryEvalScore: EvalScore;
    try {
      retryEvalScore = await runStage4({
        htmlPath: retryStage3.htmlPath,
        postText,
        designSystemSummary,
        targetUrl,
        pngPath: retryStage3.pngPath,
        outputDir: retrySubDir,
      });
    } catch (err) {
      log.error({ err, attempt: attemptNum }, 'Retry evaluation failed');
      attempts.push({
        attempt: attemptNum,
        scores: evalScore,
        critique: 'Evaluation failed on retry',
        conceptChanges,
      });
      continue;
    }

    const retryScore = getEffectiveScore(retryEvalScore);
    const retryCritique = combinedCritique(retryEvalScore);

    attempts.push({
      attempt: attemptNum,
      scores: retryEvalScore,
      critique: retryCritique,
      conceptChanges,
    });

    log.info(
      {
        attempt: attemptNum,
        originalScore: initialScore,
        retryScore,
        delta: retryScore - initialScore,
        passes: retryEvalScore.passesThreshold,
        strategy: classification.isRenderingOnly ? 'rendering-overrides' : classification.isBoth ? 'concept+rendering' : 'concept-only',
      },
      'Retry evaluation complete',
    );

    if (retryScore > bestScore) {
      bestScore = retryScore;
      bestResult = {
        concept: retryConceptOutput,
        selectedConcept: retrySelectedConcept,
        html: retryStage3.html,
        htmlPath: retryStage3.htmlPath,
        pdfPath: retryStage3.pdfPath,
        pngPath: retryStage3.pngPath,
        evalScore: retryEvalScore,
      };
    }

    if (retryEvalScore.passesThreshold) {
      log.info({ postId, score: retryScore, attempt: attemptNum }, 'Visual passes threshold after regeneration');
      break;
    }
  }

  // --- Build feedback log ---
  const originalEval = attempts[0]!.scores;
  const finalEval = bestResult.evalScore;
  const originalComposite = getEffectiveScore(originalEval);
  const finalComposite = getEffectiveScore(finalEval);

  const feedbackLog: FeedbackLog = {
    postId,
    attempts,
    finalResult: bestResult.evalScore.passesThreshold ? 'pass' : 'fail_after_retries',
    improvement: {
      originalComposite,
      finalComposite,
      delta: Math.round((finalComposite - originalComposite) * 100) / 100,
      axesImproved: computeAxesImproved(originalEval, finalEval),
    },
  };

  // Write feedback log
  await mkdir(subDir, { recursive: true });
  const logPath = join(subDir, 'eval_feedback_log.json');
  await writeFile(logPath, JSON.stringify(feedbackLog, null, 2), 'utf-8');
  log.info({ logPath, finalResult: feedbackLog.finalResult, delta: feedbackLog.improvement.delta }, 'Feedback log written');

  return {
    ...bestResult,
    feedbackLog,
    regenerated: true,
  };
}
