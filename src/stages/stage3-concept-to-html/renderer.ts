import Handlebars from 'handlebars';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VisualConcept } from '../../schemas/concept.schema.js';
import type { LayoutProtocol, ChartDataItem } from '../../schemas/concept.schema.js';
import { MODALITY_TEMPLATE_MAP } from '../../schemas/concept.schema.js';
import { createStageLogger } from '../../observability/logger.js';
import type { DesignSystemData, DesignPortfolio, BrandAssets } from '../../types/index.js';
import { buildInfographicDesignTokens } from '../../utils/infographic-tokens.js';

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

/** Clear the in-memory design system cache (called when the brand URL changes). */
export function clearRendererDesignSystemCache(): void {
  cachedDesignSystem = null;
}

// ---------------------------------------------------------------------------
// Color utilities – derive all visual tokens from design system hex values
// ---------------------------------------------------------------------------
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');
}

function mixColors(hex1: string, hex2: string, weight: number): string {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  return rgbToHex(
    c1.r * weight + c2.r * (1 - weight),
    c1.g * weight + c2.g * (1 - weight),
    c1.b * weight + c2.b * (1 - weight),
  );
}

function toRgbString(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `${r}, ${g}, ${b}`;
}

// ---------------------------------------------------------------------------
// SVG sanitization – prevent rendering artifacts from DOM-extracted SVGs
// ---------------------------------------------------------------------------

/**
 * Sanitize an SVG string to prevent visual artifacts:
 * - Cap stroke-width to maxStroke (default 2px)
 * - Cap opacity of individual elements to maxOpacity (default 0.25)
 * - Remove elements that are solid-filled rectangles covering > areaThreshold of the canvas
 * - Return empty string if SVG contains suspicious elements (video, iframe, external images)
 */
function sanitizeSvg(
  svg: string,
  options: { maxStroke?: number; maxOpacity?: number; areaThreshold?: number } = {},
): string {
  if (!svg || svg.trim().length === 0) return '';

  const { maxStroke = 2, maxOpacity = 0.25, areaThreshold = 0.10 } = options;

  // Reject SVGs with suspicious embedded elements
  if (/<(video|iframe)\b/i.test(svg)) {
    log.warn('SVG contains <video> or <iframe> — rejecting');
    return '';
  }
  if (/<image\b[^>]*href\s*=\s*["']https?:\/\//i.test(svg)) {
    log.warn('SVG contains <image> with external URL — rejecting');
    return '';
  }

  // Parse viewBox dimensions (default 1200x630 for our canvas)
  let canvasWidth = 1200;
  let canvasHeight = 630;
  const viewBoxMatch = svg.match(/viewBox\s*=\s*["'][\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)["']/);
  if (viewBoxMatch) {
    canvasWidth = parseFloat(viewBoxMatch[1]!);
    canvasHeight = parseFloat(viewBoxMatch[2]!);
  } else {
    const widthMatch = svg.match(/width\s*=\s*["']([\d.]+)/);
    const heightMatch = svg.match(/height\s*=\s*["']([\d.]+)/);
    if (widthMatch) canvasWidth = parseFloat(widthMatch[1]!);
    if (heightMatch) canvasHeight = parseFloat(heightMatch[1]!);
  }
  const canvasArea = canvasWidth * canvasHeight;

  // Cap stroke-width values
  svg = svg.replace(/stroke-width\s*=\s*["']([\d.]+)["']/g, (_match, val) => {
    const num = parseFloat(val);
    return `stroke-width="${Math.min(num, maxStroke)}"`;
  });
  svg = svg.replace(/stroke-width\s*:\s*([\d.]+)(px)?/g, (_match, val, unit) => {
    const num = parseFloat(val);
    return `stroke-width: ${Math.min(num, maxStroke)}${unit || ''}`;
  });

  // Cap opacity values on individual elements
  svg = svg.replace(/opacity\s*=\s*["']([\d.]+)["']/g, (_match, val) => {
    const num = parseFloat(val);
    return `opacity="${Math.min(num, maxOpacity)}"`;
  });
  svg = svg.replace(/opacity\s*:\s*([\d.]+)/g, (_match, val) => {
    const num = parseFloat(val);
    return `opacity: ${Math.min(num, maxOpacity)}`;
  });

  // Remove large solid rectangles that cover > areaThreshold of the canvas
  svg = svg.replace(/<rect\b([^>]*)\/?>(\s*<\/rect>)?/gi, (fullMatch, attrs: string) => {
    const wMatch = attrs.match(/width\s*=\s*["']([\d.]+)/);
    const hMatch = attrs.match(/height\s*=\s*["']([\d.]+)/);
    if (!wMatch || !hMatch) return fullMatch;

    const w = parseFloat(wMatch[1]!);
    const h = parseFloat(hMatch[1]!);
    const rectArea = w * h;

    if (rectArea / canvasArea > areaThreshold) {
      // Check if it has a solid fill (not 'none' or very transparent)
      const fillMatch = attrs.match(/fill\s*=\s*["']([^"']+)["']/);
      const opacityMatch = attrs.match(/opacity\s*=\s*["']([\d.]+)["']/);
      const fillOpacity = opacityMatch ? parseFloat(opacityMatch[1]!) : 1;

      const fill = fillMatch?.[1] || '';
      const isTransparent = fill === 'none' || fill === 'transparent' ||
        fill.includes('rgba') && parseFloat(fill.split(',')[3] || '1') < 0.1;

      if (!isTransparent && fillOpacity > 0.1) {
        log.debug({ width: w, height: h, areaRatio: (rectArea / canvasArea).toFixed(2) },
          'Removing oversized solid rect from SVG');
        return '';
      }
    }
    return fullMatch;
  });

  // Remove large paths that look like video player triangles (play buttons)
  // Detect polygon/path elements that form a simple triangle with solid fill
  svg = svg.replace(/<polygon\b([^>]*)\/?>(\s*<\/polygon>)?/gi, (fullMatch, attrs: string) => {
    const pointsMatch = attrs.match(/points\s*=\s*["']([^"']+)["']/);
    if (!pointsMatch) return fullMatch;
    const points = pointsMatch[1]!.trim().split(/[\s,]+/).map(Number);
    // A triangle has exactly 6 coordinates (3 points x 2)
    if (points.length === 6) {
      const xs = [points[0]!, points[2]!, points[4]!];
      const ys = [points[1]!, points[3]!, points[5]!];
      const triWidth = Math.max(...xs) - Math.min(...xs);
      const triHeight = Math.max(...ys) - Math.min(...ys);
      const triArea = (triWidth * triHeight) / 2;
      if (triArea / canvasArea > 0.02) {
        log.debug('Removing large triangle (possible play button) from SVG');
        return '';
      }
    }
    return fullMatch;
  });

  return svg;
}

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

function parsePillString(str: string): { index: string; name: string; stat: string; domain: string } {
  if (typeof str !== 'string') {
    return { index: '', name: String(str), stat: '', domain: '' };
  }
  let s = str.trim();
  let index = '';
  const indexMatch = s.match(/^(\d+)\s*[\/\.]\s*/);
  if (indexMatch) {
    index = indexMatch[1]!;
    s = s.slice(indexMatch[0].length).trim();
  }
  const parts = s.split('|').map((p) => p.trim());
  const name = parts[0] ?? s;
  const stat = parts[1] ?? '';
  let domain = parts[2] ?? '';
  if (!domain && stat && /^[\w.-]+\.\w{2,}$/i.test(stat)) {
    domain = stat;
    return { index, name, stat: '', domain };
  }
  return { index, name, stat, domain };
}

Handlebars.registerHelper('pillIndex', (str: string) => parsePillString(str).index);
Handlebars.registerHelper('pillName', (str: string) => parsePillString(str).name);
Handlebars.registerHelper('pillStat', (str: string) => parsePillString(str).stat);
Handlebars.registerHelper('pillDomain', (str: string) => parsePillString(str).domain);
Handlebars.registerHelper('faviconUrl', (domain: string) => {
  if (typeof domain !== 'string' || !domain.trim()) return '';
  const clean = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(clean)}&sz=128`;
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

  const brandAssets = ds.brand_assets;

  const brandName = brandIdentity?.name || logoFull?.header?.wordmark || extractNameFromUrl(ds.metadata.source_url || '');
  const brandUrl = brandIdentity?.url || ds.metadata.source_url?.replace(/^https?:\/\//, '').replace(/\/$/, '') || '';

  // Prefer real logo SVG from DOM extraction over Claude-generated
  const realLogoSvg = brandAssets?.logo?.svg;
  const logoSvg = realLogoSvg || ds.logo?.svg_data || logoFull?.header?.svg_icon || '';

  const rawDecorativePatternSvg = brandIdentity?.decorative_pattern_svg || '';
  const decorativePatternSvg = sanitizeSvg(rawDecorativePatternSvg, { maxStroke: 2, maxOpacity: 0.20, areaThreshold: 0.08 });

  const primary = ds.colors.primary.hex;
  const secondary = ds.colors.secondary.hex;
  const accent = ds.colors.accent.hex;
  const bg = ds.colors.background.hex;
  const text = ds.colors.text.hex;

  const surface = mixColors(bg, '#ffffff', 0.5);

  const portfolio = ds.design_portfolio as DesignPortfolio | undefined;

  const animationsCss = buildAnimationsCss(brandAssets);
  const rawAnimationHintsSvg = buildAnimationHintsSvg(brandAssets, primary, accent, bg);
  const animationHintsSvg = sanitizeSvg(rawAnimationHintsSvg, { maxStroke: 2, maxOpacity: 0.25, areaThreshold: 0.10 });

  return {
    primary,
    secondary,
    accent,
    background: bg,
    text,
    surface,
    cardBg: mixColors(bg, '#ffffff', 0.3),
    warmShadow: accent,
    border: mixColors(text, bg, 0.15),

    primaryRgb: toRgbString(primary),
    accentRgb: toRgbString(accent),
    backgroundRgb: toRgbString(bg),
    surfaceRgb: toRgbString(surface),
    textRgb: toRgbString(text),

    textPrimary: text,
    textSecondary: mixColors(text, bg, 0.85),
    textTertiary: mixColors(text, bg, 0.75),
    textSubtle: mixColors(text, bg, 0.65),
    textMuted: mixColors(text, bg, 0.55),
    textFaint: mixColors(text, bg, 0.40),
    textDisabled: mixColors(text, bg, 0.30),

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
    animationsCss,
    animationHintsSvg,

    backgroundStyle: resolveBackgroundStyle(portfolio, brandAssets, bg),
    heroTreatment: portfolio?.hero_treatment || `background: ${surface}`,
    cardStyle: portfolio?.card_style || `background: ${mixColors(bg, '#ffffff', 0.3)}; border: 1px solid rgba(${toRgbString(text)}, 0.08); border-radius: 12px`,
    accentTreatment: portfolio?.accent_treatment || `border-left: 3px solid ${accent}; padding-left: 12px`,
    spacingDensity: portfolio?.spacing_density || 'balanced',
    visualMotifs: portfolio?.visual_motifs || [],
    illustrationStyle: portfolio?.illustration_style || '',
    compositionRules: portfolio?.composition_rules || [],
    signatureElements: portfolio?.signature_elements || [],
  };
}

/**
 * Build CSS keyframe blocks from extracted brand animations.
 * These are injected into the HTML <style> for web-use fidelity.
 */
function buildAnimationsCss(brandAssets: BrandAssets | undefined): string {
  if (!brandAssets?.animations || brandAssets.animations.length === 0) return '';

  const keyframeBlocks = brandAssets.animations
    .filter((a) => a.keyframes)
    .map((a) => a.keyframes);

  if (keyframeBlocks.length === 0) return '';

  log.info({ count: keyframeBlocks.length }, 'Injecting CSS animations into HTML');
  return `\n    /* Brand animations extracted from DOM */\n    ${keyframeBlocks.join('\n    ')}`;
}

/**
 * Build a static SVG layer that visually represents CSS animation effects.
 * Since PNGs are static screenshots, animations (float, pulse, lineReveal, etc.)
 * are invisible. This generates ghost/trail/multi-state elements that suggest motion.
 */
function buildAnimationHintsSvg(
  brandAssets: BrandAssets | undefined,
  primaryColor: string,
  accentColor: string,
  bgColor: string,
): string {
  if (!brandAssets?.animations || brandAssets.animations.length === 0) return '';

  const elements: string[] = [];
  const defs: string[] = [];
  let defIdCounter = 0;

  const primaryRgb = hexToRgb(primaryColor);
  const accentRgb = hexToRgb(accentColor);

  for (const anim of brandAssets.animations) {
    const name = anim.name.toLowerCase();
    const keyframes = (anim.keyframes || '').toLowerCase();

    if (isFloatAnimation(name, keyframes)) {
      const filterId = `motionBlur${defIdCounter++}`;
      defs.push(`<filter id="${filterId}"><feGaussianBlur in="SourceGraphic" stdDeviation="0 3"/></filter>`);
      for (let i = 0; i < 5; i++) {
        const cx = 100 + Math.round(Math.random() * 1000);
        const baseY = 80 + Math.round(Math.random() * 470);
        const r = 3 + Math.round(Math.random() * 8);
        for (let ghost = 0; ghost < 3; ghost++) {
          const yOffset = (ghost - 1) * (8 + Math.round(Math.random() * 12));
          const opacity = ghost === 1 ? 0.12 : 0.04 + Math.random() * 0.04;
          const color = ghost === 1 ? primaryColor : accentColor;
          elements.push(
            `<circle cx="${cx}" cy="${baseY + yOffset}" r="${r}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`,
          );
        }
      }
    }

    if (isPulseAnimation(name, keyframes)) {
      for (let i = 0; i < 4; i++) {
        const cx = 150 + Math.round(Math.random() * 900);
        const cy = 100 + Math.round(Math.random() * 430);
        const baseR = 4 + Math.round(Math.random() * 6);
        elements.push(
          `<circle cx="${cx}" cy="${cy}" r="${baseR}" fill="${primaryColor}" opacity="0.15"/>`,
        );
        elements.push(
          `<circle cx="${cx}" cy="${cy}" r="${Math.round(baseR * 1.6)}" fill="none" stroke="${primaryColor}" stroke-width="1" opacity="0.08"/>`,
        );
        elements.push(
          `<circle cx="${cx}" cy="${cy}" r="${Math.round(baseR * 2.4)}" fill="none" stroke="${accentColor}" stroke-width="0.5" opacity="0.04"/>`,
        );
      }
    }

    if (isRevealAnimation(name, keyframes)) {
      for (let i = 0; i < 6; i++) {
        const x1 = 60 + Math.round(Math.random() * 400);
        const y = 50 + Math.round(Math.random() * 530);
        const length = 80 + Math.round(Math.random() * 200);
        const opacity = 0.06 + Math.random() * 0.08;
        elements.push(
          `<line x1="${x1}" y1="${y}" x2="${x1 + length}" y2="${y}" stroke="${primaryColor}" stroke-width="${(0.8 + Math.random()).toFixed(1)}" opacity="${opacity.toFixed(2)}"/>`,
        );
      }
    }

    if (isRotateAnimation(name, keyframes)) {
      for (let i = 0; i < 3; i++) {
        const cx = 200 + Math.round(Math.random() * 800);
        const cy = 150 + Math.round(Math.random() * 330);
        const r = 15 + Math.round(Math.random() * 25);
        for (let arc = 0; arc < 3; arc++) {
          const rotation = arc * 30;
          const opacity = 0.04 + arc * 0.02;
          elements.push(
            `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accentColor}" stroke-width="0.8" stroke-dasharray="12 ${Math.round(r * 4)}" opacity="${opacity.toFixed(2)}" transform="rotate(${rotation} ${cx} ${cy})"/>`,
          );
        }
      }
    }
  }

  if (elements.length === 0) return '';

  log.info({ hintElements: elements.length }, 'Generated static animation hints SVG');
  const defsBlock = defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '';
  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;pointer-events:none;z-index:1;">${defsBlock}${elements.join('')}</svg>`;
}

function isFloatAnimation(name: string, keyframes: string): boolean {
  return name.includes('float') || name.includes('hover') || name.includes('bob') ||
    (keyframes.includes('translatey') && !keyframes.includes('translatex'));
}

function isPulseAnimation(name: string, keyframes: string): boolean {
  return name.includes('pulse') || name.includes('throb') || name.includes('ping') ||
    (keyframes.includes('scale') && keyframes.includes('opacity'));
}

function isRevealAnimation(name: string, keyframes: string): boolean {
  return name.includes('reveal') || name.includes('draw') || name.includes('wipe') ||
    name.includes('linegrow') || (keyframes.includes('width') && keyframes.includes('0'));
}

function isRotateAnimation(name: string, keyframes: string): boolean {
  return name.includes('rotate') || name.includes('spin') || name.includes('orbit') ||
    keyframes.includes('rotate(');
}

function resolveBackgroundStyle(
  portfolio: DesignPortfolio | undefined,
  brandAssets: BrandAssets | undefined,
  fallbackBg: string,
): string {
  // If real gradients were extracted from the DOM, prefer the hero/section gradient
  if (brandAssets?.gradients && brandAssets.gradients.length > 0) {
    const heroGrad = brandAssets.gradients.find(
      (g) => g.context.toLowerCase().includes('hero') || g.context.toLowerCase().includes('section'),
    );
    const bestGrad = heroGrad ?? brandAssets.gradients[0]!;
    return bestGrad.css;
  }

  return portfolio?.background_style || fallbackBg;
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
function buildChartColors(ds: ReturnType<typeof buildDesignTokens>): string[] {
  return [ds.primary, ds.accent, ds.textSubtle, ds.textFaint, ds.textSecondary, ds.textDisabled];
}

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
  const chartColors = buildChartColors(ds);

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
      color: chartColors[i % chartColors.length] ?? ds.textMuted,
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
    if (spec.alignment === 'start') {
      rules.push(`.content, .text-side { align-items: flex-start; text-align: left; }`);
    } else if (spec.alignment === 'end') {
      rules.push(`.content, .text-side { align-items: flex-end; text-align: right; }`);
    }
  }
  if (spec.padding_distribution) {
    const pd = spec.padding_distribution;
    const padStr = [pd.top ?? '48px', pd.right ?? '64px', pd.bottom ?? '48px', pd.left ?? '64px'].join(' ');
    rules.push(`.content, .text-side { padding: ${padStr}; }`);
  }
  if (spec.headline_position) {
    const pos = spec.headline_position.toLowerCase();
    if (pos.includes('left')) {
      rules.push(`.headline, .statement, .quote-text, h1 { text-align: left; }`);
    } else if (pos.includes('right')) {
      rules.push(`.headline, .statement, .quote-text, h1 { text-align: right; }`);
    }
  }
  if (spec.accent_placement) {
    const placement = spec.accent_placement.toLowerCase();
    if (placement.includes('top')) {
      rules.push(`.warm-bar { height: 4px; background: linear-gradient(90deg, currentColor 0%, transparent 60%); }`);
    } else if (placement.includes('bottom')) {
      rules.push(`.warm-border { height: 3px; background: currentColor; }`);
    }
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
  const baseDs = buildDesignTokens(designSystem);
  const ds = {
    ...baseDs,
    infographic: buildInfographicDesignTokens({
      primary: baseDs.primary,
      accent: baseDs.accent,
      background: baseDs.background,
      text: baseDs.textPrimary,
      textMuted: baseDs.textMuted,
      textSubtle: baseDs.textSubtle,
      surface: baseDs.surface,
      backgroundStyle: baseDs.backgroundStyle,
    }),
  };

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
