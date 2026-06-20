import { renderConceptToHtml } from './renderer.js';
import { exportVisual } from './exporter.js';
import { createStageLogger } from '../../observability/logger.js';
import { applyRenderingOverrides } from '../../utils/rendering-overrides.js';
import type { RenderingOverrides } from '../../utils/rendering-overrides.js';
import type { VisualConcept } from '../../schemas/concept.schema.js';
import type { Stage3Result } from '../../types/index.js';

const log = createStageLogger('stage3');

export interface Stage3Input {
  concept: VisualConcept;
  postId?: string;
  outputDir?: string;
  renderingOverrides?: RenderingOverrides;
}

/**
 * Stage 3: Render a selected concept to HTML and export as PDF + PNG.
 */
export async function runStage3(input: Stage3Input): Promise<Stage3Result> {
  const {
    concept,
    postId = 'default',
    outputDir = 'data/outputs',
    renderingOverrides,
  } = input;

  log.info({ modality: concept.modality, headline: concept.headline }, 'Input');

  const stageStart = Date.now();

  let html = await renderConceptToHtml(concept);

  // Apply rendering overrides from feedback critique if present
  if (renderingOverrides) {
    log.info({ rules: renderingOverrides.appliedRules }, 'Applying rendering overrides');
    html = applyRenderingOverrides(html, renderingOverrides);
  }

  const subDir = postId ? `${outputDir}/${postId}` : outputDir;

  const exportResult = await exportVisual({
    html,
    outputDir: subDir,
    fileBaseName: `visual-${concept.modality}`,
  });

  const latencyMs = Date.now() - stageStart;

  log.info(
    { htmlPath: exportResult.htmlPath, pdfPath: exportResult.pdfPath, pngPath: exportResult.pngPath },
    'Output',
  );
  log.info({ latencyMs }, 'Complete');

  return {
    html,
    htmlPath: exportResult.htmlPath,
    pdfPath: exportResult.pdfPath,
    pngPath: exportResult.pngPath,
  };
}
