import Handlebars from 'handlebars';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VisualConcept } from '../../schemas/concept.schema.js';
import { MODALITY_TEMPLATE_MAP } from '../../schemas/concept.schema.js';
import { createStageLogger } from '../../observability/logger.js';
import type { DesignSystemData } from '../../types/index.js';

const log = createStageLogger('stage3:renderer');
const __dirname = dirname(fileURLToPath(import.meta.url));

let fontCssCache: string | null = null;

async function loadFontCss(): Promise<string> {
  if (fontCssCache) return fontCssCache;

  const fontsDir = join(__dirname, 'fonts');
  const [interBuf, monoBuf] = await Promise.all([
    readFile(join(fontsDir, 'inter-latin.woff2')),
    readFile(join(fontsDir, 'dm-mono-latin.woff2')),
  ]);

  const interB64 = interBuf.toString('base64');
  const monoB64 = monoBuf.toString('base64');

  fontCssCache = `
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url(data:font/woff2;base64,${interB64}) format('woff2');
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 500;
      font-display: swap;
      src: url(data:font/woff2;base64,${interB64}) format('woff2');
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 600;
      font-display: swap;
      src: url(data:font/woff2;base64,${interB64}) format('woff2');
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 700;
      font-display: swap;
      src: url(data:font/woff2;base64,${interB64}) format('woff2');
    }
    @font-face {
      font-family: 'DM Mono';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url(data:font/woff2;base64,${monoB64}) format('woff2');
    }
  `;

  log.info('Base64 font CSS loaded and cached');
  return fontCssCache;
}

function injectFontsIntoHtml(html: string, fontCss: string): string {
  html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/g, '');
  html = html.replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/g, '');
  html = html.replace('<style>', `<style>${fontCss}`);
  return html;
}

const templateCache = new Map<string, HandlebarsTemplateDelegate>();
let cachedDesignSystem: DesignSystemData | null = null;

const FALLBACK_TEMPLATE: Record<string, string> = {
  attribution_quote_card: 'pull-quote-card',
  event_details_card: 'headline-subtext-card',
  comparison_table: 'numbered-list-graphic',
  timeline_graphic: 'numbered-list-graphic',
  ranked_list_graphic: 'numbered-list-graphic',
  checklist_graphic: 'feature-list-graphic',
  two_column_process_diagram: 'feature-list-graphic',
};

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

Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);

Handlebars.registerHelper('gt', (a: number, b: number) => a > b);

Handlebars.registerHelper('truncate', (str: string, len: number) => {
  if (typeof str !== 'string') return str;
  return str.length > len ? str.slice(0, len) + '...' : str;
});

async function loadDesignSystem(
  dsPath = 'data/design-system.json',
): Promise<DesignSystemData> {
  if (cachedDesignSystem) return cachedDesignSystem;
  const raw = await readFile(dsPath, 'utf-8');
  cachedDesignSystem = JSON.parse(raw) as DesignSystemData;
  return cachedDesignSystem;
}

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
 * Build a flat design-tokens object for template consumption.
 * Includes brand identity fields so templates can be fully dynamic.
 */
function buildDesignTokens(ds: DesignSystemData) {
  const brandIdentity = ds.brand_identity;

  const dsAny = ds as unknown as Record<string, unknown>;
  const logoFull = dsAny.logo as
    | { svg_data?: string; header?: { svg_icon?: string; wordmark?: string } }
    | undefined;

  const brandName = brandIdentity?.name || logoFull?.header?.wordmark || extractNameFromUrl(ds.metadata.source_url || '');
  const brandUrl = brandIdentity?.url || ds.metadata.source_url?.replace(/^https?:\/\//, '').replace(/\/$/, '') || '';
  const logoSvg = ds.logo?.svg_data || logoFull?.header?.svg_icon || '';
  const decorativePatternSvg = brandIdentity?.decorative_pattern_svg || '';

  return {
    primary: ds.colors.primary.hex,
    secondary: ds.colors.secondary.hex,
    accent: ds.colors.accent.hex,
    background: ds.colors.background.hex,
    text: ds.colors.text.hex,
    surface: '#faf9f6',
    cardBg: '#f0efe9',
    warmShadow: '#d7c8af',
    border: '#e5e5e5',
    textPrimary: '#111111',
    textSecondary: '#333333',
    textTertiary: '#444444',
    textSubtle: '#555555',
    textMuted: '#666666',
    textFaint: '#888888',
    textDisabled: '#aaaaaa',
    fontFamily: ds.css_variables?.['--default-font-family'] ??
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    monoFamily: ds.css_variables?.['--default-mono-font-family'] ??
      "'DM Mono', Monaco, Consolas, monospace",
    radiusNone: ds.borders.radius.none,
    radiusSm: ds.borders.radius.sm,
    radiusMd: ds.borders.radius.md,
    radiusLg: ds.borders.radius.lg,
    brandName,
    brandUrl,
    logoSvg,
    logoText: brandIdentity?.logo_text || brandName.toUpperCase(),
    decorativePatternSvg,
  };
}

function extractNameFromUrl(url: string): string {
  const hostname = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const parts = hostname.split('.');
  const name = parts[0] === 'www' ? (parts[1] || 'Brand') : (parts[0] || 'Brand');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Render a visual concept to a self-contained HTML string.
 * Injects design system tokens as `ds` in template context.
 */
export async function renderConceptToHtml(
  concept: VisualConcept,
  designSystemPath?: string,
): Promise<string> {
  const templateId = resolveTemplateId(concept.modality);
  log.info({ modality: concept.modality, templateId }, 'Rendering concept to HTML');

  const [designSystem, fontCss] = await Promise.all([
    loadDesignSystem(designSystemPath),
    loadFontCss(),
  ]);
  const ds = buildDesignTokens(designSystem);

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
    ds,
  };

  const rawHtml = template(data);
  return injectFontsIntoHtml(rawHtml, fontCss);
}
