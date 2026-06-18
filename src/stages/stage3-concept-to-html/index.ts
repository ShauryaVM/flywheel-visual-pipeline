import { renderConceptToHtml } from './renderer.js';
import { exportVisual } from './exporter.js';
import { createStageLogger } from '../../observability/logger.js';
import type { VisualConcept } from '../../schemas/concept.schema.js';
import type { Stage3Result } from '../../types/index.js';

const log = createStageLogger('stage3');

export interface Stage3Input {
  concept: VisualConcept;
  postId?: string;
  outputDir?: string;
}

/**
 * Stage 3: Render a selected concept to HTML and export as PDF + PNG.
 */
export async function runStage3(input: Stage3Input): Promise<Stage3Result> {
  const {
    concept,
    postId = 'default',
    outputDir = 'data/outputs',
  } = input;

  log.info({ modality: concept.modality, postId }, 'Stage 3: Concept to HTML');

  const html = await renderConceptToHtml(concept);

  const subDir = postId ? `${outputDir}/${postId}` : outputDir;

  const exportResult = await exportVisual({
    html,
    outputDir: subDir,
    fileBaseName: `visual-${concept.modality}`,
  });

  log.info(
    { modality: concept.modality, ...exportResult },
    'Stage 3 complete',
  );

  return {
    html,
    pdfPath: exportResult.pdfPath,
    pngPath: exportResult.pngPath,
  };
}
