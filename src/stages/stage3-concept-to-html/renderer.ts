import Handlebars from 'handlebars';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VisualConcept } from '../../schemas/concept.schema.js';
import type { LayoutProtocol, ChartDataItem } from '../../schemas/concept.schema.js';
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

// ---------------------------------------------------------------------------
// Chart data processing helpers
// ---------------------------------------------------------------------------
const CHART_COLORS = [
  '#111111', '#d7c8af', '#555555', '#888888', '#333333', '#aaaaaa',
];

function processBarChartData(chartData: ChartDataItem[]) {
  const maxVal = Math.max(...chartData.map((d) => d.value), 1);
  return chartData.map((d) => ({
    label: d.label,
    value: d.value,
    percent: Math.round((d.value / maxVal) * 100),
    displayValue: formatChartValue(d.value),
  }));
}

function processSparklineData(chartData: ChartDataItem[]) {
  if (chartData.length === 0) return { path: '', fillPath: '', points: [] };

  const maxVal = Math.max(...chartData.map((d) => d.value), 1);
  const minVal = Math.min(...chartData.map((d) => d.value), 0);
  const range = maxVal - minVal || 1;
  const padding = 40;
  const width = 1000;
  const height = 200;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;

  const points = chartData.map((d, i) => ({
    x: padding + (chartData.length > 1 ? (i / (chartData.length - 1)) * usableWidth : usableWidth / 2),
    y: padding + usableHeight - ((d.value - minVal) / range) * usableHeight,
  }));

  const pathSegments = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  const path = pathSegments.join(' ');

  const fillPath = path +
    ` L ${points[points.length - 1]!.x.toFixed(1)} ${height} L ${points[0]!.x.toFixed(1)} ${height} Z`;

  return { path, fillPath, points };
}

function processDonutData(chartData: ChartDataItem[], ds: ReturnType<typeof buildDesignTokens>) {
  const total = chartData.reduce((sum, d) => sum + d.value, 0) || 1;
  const circumference = 2 * Math.PI * 70;
  let accumulatedOffset = 0;

  const segments = chartData.map((d, i) => {
    const fraction = d.value / total;
    const dashLength = fraction * circumference;
    const gapLength = circumference - dashLength;
    const dashOffset = -accumulatedOffset;
    accumulatedOffset += dashLength;

    return {
      label: d.label,
      value: d.value,
      displayValue: formatChartValue(d.value),
      color: i === 0 ? ds.primary : (CHART_COLORS[i % CHART_COLORS.length] ?? ds.textMuted),
      dashArray: `${dashLength.toFixed(2)} ${gapLength.toFixed(2)}`,
      dashOffset: dashOffset.toFixed(2),
    };
  });

  return { segments, total: formatChartValue(total) };
}

function formatChartValue(val: number): string {
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(1)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return val.toString();
}

// ---------------------------------------------------------------------------
// Layout spec CSS application
// ---------------------------------------------------------------------------
function buildLayoutSpecCss(spec: NonNullable<VisualConcept['layout_spec']>): string {
  const rules: string[] = [];

  if (spec.flex_direction) {
    rules.push(`.content, .text-side { flex-direction: ${spec.flex_direction}; }`);
  }
  if (spec.alignment) {
    const cssAlign = spec.alignment === 'space-between' ? 'space-between' :
      spec.alignment === 'start' ? 'flex-start' :
      spec.alignment === 'end' ? 'flex-end' : 'center';
    rules.push(`.content, .text-side { justify-content: ${cssAlign}; }`);
  }
  if (spec.padding_distribution) {
    const pd = spec.padding_distribution;
    const padStr = [pd.top ?? '48px', pd.right ?? '64px', pd.bottom ?? '48px', pd.left ?? '64px'].join(' ');
    rules.push(`.content, .text-side { padding: ${padStr}; }`);
  }

  return rules.length > 0 ? `\n/* layout_spec overrides */\n${rules.join('\n')}` : '';
}

// ---------------------------------------------------------------------------
// Graphist-inspired: Layout Protocol renderer
// ---------------------------------------------------------------------------
function renderLayoutProtocol(
  protocol: LayoutProtocol,
  ds: ReturnType<typeof buildDesignTokens>,
  fontCss: string,
): string {
  const { canvas, elements } = protocol;

  const elementHtml = elements.map((el) => {
    const style: string[] = [
      'position: absolute',
      `left: ${el.position.x}`,
      `top: ${el.position.y}`,
      `width: ${el.size.width}`,
      `height: ${el.size.height}`,
    ];

    if (el.zIndex !== undefined) style.push(`z-index: ${el.zIndex}`);

    if (el.style) {
      if (el.style.fontSize) style.push(`font-size: ${el.style.fontSize}`);
      if (el.style.fontWeight) style.push(`font-weight: ${el.style.fontWeight}`);
      if (el.style.color) style.push(`color: ${el.style.color}`);
      if (el.style.opacity !== undefined) style.push(`opacity: ${el.style.opacity}`);
      if (el.style.fontFamily) style.push(`font-family: ${el.style.fontFamily}`);
      if (el.style.textTransform) style.push(`text-transform: ${el.style.textTransform}`);
      if (el.style.letterSpacing) style.push(`letter-spacing: ${el.style.letterSpacing}`);
      if (el.style.lineHeight) style.push(`line-height: ${el.style.lineHeight}`);
      if (el.style.textAlign) style.push(`text-align: ${el.style.textAlign}`);
      if (el.style.background) style.push(`background: ${el.style.background}`);
    }

    const tag = el.type === 'headline' ? 'h1' :
      el.type === 'decorative' || el.type === 'accent' ? 'div' : 'div';

    const escapedContent = el.type === 'decorative' || el.type === 'accent' || el.type === 'logo'
      ? el.content
      : escapeHtml(el.content);

    return `    <${tag} style="${style.join('; ')};">${escapedContent}</${tag}>`;
  }).join('\n');

  const bgColor = resolveColor(canvas.background, ds);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    ${fontCss}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${canvas.width}px;
      height: ${canvas.height}px;
      font-family: ${ds.fontFamily};
      overflow: hidden;
    }
    .canvas {
      width: ${canvas.width}px;
      height: ${canvas.height}px;
      position: relative;
      background: ${bgColor};
    }
  </style>
</head>
<body>
  <div class="canvas">
${elementHtml}
  </div>
</body>
</html>`;
}

function resolveColor(color: string, ds: ReturnType<typeof buildDesignTokens>): string {
  const tokenMap: Record<string, string> = {
    primary: ds.primary,
    secondary: ds.secondary,
    accent: ds.accent,
    background: ds.background,
    text: ds.text,
    surface: ds.surface,
  };
  return tokenMap[color] ?? color;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a visual concept to a self-contained HTML string.
 * Supports three rendering paths:
 * 1. Layout Protocol (Graphist): absolute-positioned elements from JSON
 * 2. Chart templates (ChartGalaxy): bar, sparkline, donut with processed data
 * 3. Standard Handlebars templates with optional layout_spec overrides
 */
export async function renderConceptToHtml(
  concept: VisualConcept,
  designSystemPath?: string,
): Promise<string> {
  const [designSystem, fontCss] = await Promise.all([
    loadDesignSystem(designSystemPath),
    loadFontCss(),
  ]);
  const ds = buildDesignTokens(designSystem);

  // Path 1: Graphist layout protocol
  if (concept.layout_protocol) {
    log.info({ modality: concept.modality }, 'Rendering via layout protocol');
    return renderLayoutProtocol(concept.layout_protocol, ds, fontCss);
  }

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

  // Path 2 & 3: build template data with chart processing and layout_spec
  const chartData = concept.chart_data ?? [];
  const isChartModality = ['bar_chart', 'line_sparkline', 'pie_donut_chart'].includes(concept.modality);

  let processedChartData: ReturnType<typeof processBarChartData> = [];
  let sparklineData = { path: '', fillPath: '', points: [] as { x: number; y: number }[] };
  let donutData = { segments: [] as ReturnType<typeof processDonutData>['segments'], total: '0' };

  if (isChartModality && chartData.length > 0) {
    if (concept.modality === 'bar_chart') {
      processedChartData = processBarChartData(chartData);
    } else if (concept.modality === 'line_sparkline') {
      sparklineData = processSparklineData(chartData);
    } else if (concept.modality === 'pie_donut_chart') {
      donutData = processDonutData(chartData, ds);
    }
  }

  const data = {
    headline: concept.headline,
    subtext: concept.subtext ?? '',
    data_points: concept.data_points ?? [],
    chart_data: isChartModality ? processedChartData.length > 0 ? processedChartData : chartData : [],
    sparkline_path: sparklineData.path,
    sparkline_fill_path: sparklineData.fillPath,
    sparkline_points: sparklineData.points,
    donut_segments: donutData.segments,
    donut_total: donutData.total,
    modality: concept.modality,
    layout_description: concept.layout_description,
    color_usage: concept.color_usage,
    ds,
  };

  let rawHtml = template(data);

  // Apply layout_spec CSS overrides if present
  if (concept.layout_spec) {
    const specCss = buildLayoutSpecCss(concept.layout_spec);
    if (specCss) {
      rawHtml = rawHtml.replace('</style>', `${specCss}\n  </style>`);
    }
  }

  return injectFontsIntoHtml(rawHtml, fontCss);
}
