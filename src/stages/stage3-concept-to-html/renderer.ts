import Handlebars from 'handlebars';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VisualConcept } from '../../schemas/concept.schema.js';
import { MODALITY_TEMPLATE_MAP } from '../../schemas/concept.schema.js';
import { createStageLogger } from '../../observability/logger.js';

const log = createStageLogger('stage3:renderer');
const __dirname = dirname(fileURLToPath(import.meta.url));

const templateCache = new Map<string, HandlebarsTemplateDelegate>();

// Fallback template map: if a modality doesn't have its own template,
// use the closest match.
const FALLBACK_TEMPLATE: Record<string, string> = {
  attribution_quote_card: 'pull-quote-card',
  event_details_card: 'headline-subtext-card',
  comparison_table: 'numbered-list-graphic',
  timeline_graphic: 'numbered-list-graphic',
  ranked_list_graphic: 'numbered-list-graphic',
  checklist_graphic: 'feature-list-graphic',
  two_column_process_diagram: 'feature-list-graphic',
};

// Register Handlebars helpers
Handlebars.registerHelper('addOne', (index: number) => index + 1);

Handlebars.registerHelper('contains', (str: string, search: string) => {
  if (typeof str !== 'string') return false;
  return str.includes(search);
});

Handlebars.registerHelper('statValue', (str: string) => {
  if (typeof str !== 'string') return str;
  const parts = str.split('|');
  return parts[0]?.trim() ?? str;
});

Handlebars.registerHelper('statLabel', (str: string) => {
  if (typeof str !== 'string') return '';
  const parts = str.split('|');
  return parts[1]?.trim() ?? '';
});

async function loadTemplate(
  templateId: string,
): Promise<HandlebarsTemplateDelegate> {
  const cached = templateCache.get(templateId);
  if (cached) return cached;

  const templatePath = join(__dirname, 'templates', `${templateId}.hbs`);
  const source = await readFile(templatePath, 'utf-8');
  const compiled = Handlebars.compile(source);
  templateCache.set(templateId, compiled);

  log.debug({ templateId, templatePath }, 'Template loaded');
  return compiled;
}

function resolveTemplateId(modality: string): string {
  const directTemplate = MODALITY_TEMPLATE_MAP[modality];
  if (directTemplate) return directTemplate;
  return FALLBACK_TEMPLATE[modality] ?? 'headline-subtext-card';
}

/**
 * Render a visual concept to a self-contained HTML string.
 */
export async function renderConceptToHtml(
  concept: VisualConcept,
): Promise<string> {
  const templateId = resolveTemplateId(concept.modality);
  log.info({ modality: concept.modality, templateId }, 'Rendering concept to HTML');

  let template: HandlebarsTemplateDelegate;
  try {
    template = await loadTemplate(templateId);
  } catch (err) {
    log.warn(
      { templateId, err },
      'Template not found, falling back to headline-subtext-card',
    );
    template = await loadTemplate('headline-subtext-card');
  }

  const data = {
    headline: concept.headline,
    subtext: concept.subtext ?? '',
    data_points: concept.data_points ?? [],
    modality: concept.modality,
    layout_description: concept.layout_description,
    color_usage: concept.color_usage,
  };

  return template(data);
}
