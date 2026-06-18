import 'dotenv/config';
import { runStage2 } from './stages/stage2-post-to-concept/index.js';
import { runStage3 } from './stages/stage3-concept-to-html/index.js';
import { createStageLogger } from './observability/logger.js';
import type { PipelineInput, PipelineResult } from './types/index.js';

const log = createStageLogger('pipeline');

/**
 * Run the visual pipeline: Post -> Concept -> HTML -> PDF + PNG.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { postText, postId, outputDir = 'data/outputs' } = input;

  log.info({ postId, outputDir }, 'Starting pipeline');

  // Stage 2: Generate visual concepts from post
  const conceptOutput = await runStage2(postText, { postId, outputDir });
  const selectedConcept = conceptOutput.concepts[conceptOutput.selected]!;
  log.info(
    { modality: selectedConcept.modality, headline: selectedConcept.headline },
    'Stage 2 complete: concept selected',
  );

  // Stage 3: Render concept to HTML, export PDF + PNG
  const stage3 = await runStage3({
    concept: selectedConcept,
    postId,
    outputDir,
  });
  log.info('Stage 3 complete: visual exported');

  return {
    concept: conceptOutput,
    selectedConcept,
    html: stage3.html,
    pdfPath: stage3.pdfPath,
    pngPath: stage3.pngPath,
  };
}
