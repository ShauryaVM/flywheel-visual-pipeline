import Anthropic from '@anthropic-ai/sdk';
import { createStageLogger } from '../../observability/logger.js';
import type { RawCrawlData, ElementStyleData } from './crawler.js';

const log = createStageLogger('stage1:extractor');

// ---------------------------------------------------------------------------
// Output type matching the target design system JSON structure
// ---------------------------------------------------------------------------

export interface BrandIdentity {
  name: string;
  url: string;
  tagline: string;
  logo_text: string;
  description: string;
  decorative_pattern_svg: string;
}

export interface DesignSystemOutput {
  metadata: {
    source_url: string;
    crawled_at: string;
    pages_analyzed: string[];
  };
  brand_identity?: BrandIdentity;
  colors: {
    primary: { hex: string; usage: string };
    secondary: { hex: string; usage: string };
    accent: { hex: string; usage: string };
    background: { hex: string; usage: string };
    text: { hex: string; usage: string };
    palette: Array<{ hex: string; name?: string; usage_context: string }>;
  };
  typography: {
    font_families: Array<{ family: string; weights: string[]; source: string }>;
    scale: Record<
      string,
      {
        font_family: string;
        font_size: string;
        font_weight: string;
        line_height: string;
        color: string;
      }
    >;
  };
  spacing: {
    unit: string;
    scale: Record<string, string>;
  };
  borders: {
    radius: Record<string, string>;
    widths: string[];
    colors: string[];
  };
  logo: {
    url: string;
    svg_data?: string;
    dimensions?: { width: number; height: number };
  };
  components: {
    buttons: Array<{ variant: string; styles: Record<string, string> }>;
    cards: Array<{ variant: string; styles: Record<string, string> }>;
    badges: Array<{ variant: string; styles: Record<string, string> }>;
    sections: Array<{ variant: string; styles: Record<string, string> }>;
  };
  css_variables: Record<string, string>;
  raw_tokens: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API — try Claude first, fall back to local heuristics
// ---------------------------------------------------------------------------

export async function analyzeDesignSystem(
  rawData: RawCrawlData,
  apiKey: string,
): Promise<DesignSystemOutput> {
  let result: DesignSystemOutput;
  try {
    result = await analyzeWithClaude(rawData, apiKey);
  } catch (err) {
    log.warn(
      { error: (err as Error).message },
      'Claude analysis failed, falling back to local heuristic analysis',
    );
    result = analyzeLocally(rawData);
  }

  if (!result.brand_identity) {
    try {
      result.brand_identity = await extractBrandIdentity(rawData, result, apiKey);
      log.info({ brandName: result.brand_identity.name }, 'Brand identity extracted');
    } catch (err) {
      log.warn(
        { error: (err as Error).message },
        'Brand identity extraction failed, using fallback',
      );
      result.brand_identity = buildFallbackBrandIdentity(rawData, result);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Brand identity extraction — uses Claude to infer brand name, tagline, etc.
// ---------------------------------------------------------------------------

async function extractBrandIdentity(
  rawData: RawCrawlData,
  designSystem: DesignSystemOutput,
  apiKey: string,
): Promise<BrandIdentity> {
  const client = new Anthropic({ apiKey });

  const siteUrl = designSystem.metadata.source_url || rawData.pages[0]?.url || '';
  const pageTitles = rawData.pages.map((p) => p.title).filter(Boolean);
  const logoText = rawData.logoCandidates
    .filter((l) => l.source.includes('text-logo'))
    .map((l) => l.alt)
    .filter(Boolean);
  const headings = rawData.pages
    .flatMap((p) => p.elements.filter((e) => e.selector === 'h1' || e.selector === 'h2'))
    .map((e) => e.textPreview)
    .filter(Boolean)
    .slice(0, 10);

  const prompt = `Analyze this website data and produce a brand identity JSON object.

Website URL: ${siteUrl}
Page titles: ${JSON.stringify(pageTitles)}
Logo text found: ${JSON.stringify(logoText)}
Key headings: ${JSON.stringify(headings)}
Logo SVG available: ${!!designSystem.logo.svg_data}
Primary color: ${designSystem.colors.primary.hex}
Accent color: ${designSystem.colors.accent.hex}

Additionally, generate a decorative SVG pattern (1200x630px) that matches this brand's visual language. The pattern should be subtle (low opacity elements) suitable as a background texture for social media graphics. Consider the site's aesthetic:
- If the site uses circular/dot elements, generate scattered circles
- If geometric, use geometric shapes
- If minimal, use very sparse subtle dots
- Always keep elements at opacity 0.04-0.20 so they never compete with content

Return ONLY a JSON object with these fields:
{
  "name": "Company Name",
  "url": "domain.com (no protocol)",
  "tagline": "Their main tagline or value proposition",
  "logo_text": "BRAND NAME (uppercase version for watermarks)",
  "description": "1-2 sentence description of what the company does and its brand personality",
  "decorative_pattern_svg": "<svg width=\\"1200\\" height=\\"630\\" xmlns=\\"http://www.w3.org/2000/svg\\">...pattern elements...</svg>"
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
    system: 'You are a brand analyst. Return only valid JSON, no markdown fences or explanation.',
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response for brand identity');
  }

  let jsonStr = textBlock.text.trim();
  const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch?.[1]) jsonStr = fenceMatch[1];

  return JSON.parse(jsonStr) as BrandIdentity;
}

function buildFallbackBrandIdentity(
  rawData: RawCrawlData,
  designSystem: DesignSystemOutput,
): BrandIdentity {
  const siteUrl = designSystem.metadata.source_url || rawData.pages[0]?.url || '';
  const hostname = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const textLogo = rawData.logoCandidates.find((l) => l.source.includes('text-logo'));
  const name = textLogo?.alt || hostname.split('.')[0] || 'Brand';
  const capitalName = name.charAt(0).toUpperCase() + name.slice(1);

  return {
    name: capitalName,
    url: hostname,
    tagline: '',
    logo_text: capitalName.toUpperCase(),
    description: `${capitalName} — brand visual identity extracted from ${hostname}.`,
    decorative_pattern_svg: generateFallbackPatternSvg(),
  };
}

function generateFallbackPatternSvg(): string {
  const circles: string[] = [];
  const rng = (min: number, max: number) => Math.floor(Math.random() * (max - min)) + min;
  for (let i = 0; i < 40; i++) {
    const cx = rng(40, 1160);
    const cy = rng(30, 600);
    const r = rng(2, 12);
    const opacity = (rng(5, 18) / 100).toFixed(2);
    circles.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000000" opacity="${opacity}"/>`);
  }
  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">${circles.join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// Claude-powered analysis
// ---------------------------------------------------------------------------

async function analyzeWithClaude(
  rawData: RawCrawlData,
  apiKey: string,
): Promise<DesignSystemOutput> {
  log.info('Sending raw crawl data to Claude for design system analysis');

  const client = new Anthropic({ apiKey });
  const prompt = buildAnalysisPrompt(rawData);

  log.debug({ promptLength: prompt.length }, 'Analysis prompt built');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
    system: SYSTEM_PROMPT,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }

  let jsonStr = textBlock.text.trim();

  const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1];
  }

  try {
    const result = JSON.parse(jsonStr) as DesignSystemOutput;
    log.info(
      {
        colorCount: result.colors?.palette?.length ?? 0,
        fontCount: result.typography?.font_families?.length ?? 0,
      },
      'Claude analysis complete',
    );
    return result;
  } catch (err) {
    log.error(
      { responsePreview: jsonStr.slice(0, 500), error: (err as Error).message },
      'Failed to parse Claude response as JSON',
    );
    throw new Error(
      `Failed to parse design system from Claude response: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Local heuristic analysis (fallback when Claude unavailable)
// ---------------------------------------------------------------------------

function analyzeLocally(data: RawCrawlData): DesignSystemOutput {
  log.info('Running local heuristic design system analysis');

  const allElements = data.pages.flatMap((p) => p.elements);

  const colors = extractColorsLocally(data, allElements);
  const typography = extractTypographyLocally(data, allElements);
  const spacing = extractSpacingLocally(allElements);
  const borders = extractBordersLocally(data, allElements);
  const logo = extractLogoLocally(data);
  const components = extractComponentsLocally(allElements);

  return {
    metadata: {
      source_url: data.pages[0]?.url ?? '',
      crawled_at: new Date().toISOString(),
      pages_analyzed: data.pages.map((p) => p.url),
    },
    colors,
    typography,
    spacing,
    borders,
    logo,
    components,
    css_variables: data.cssVariables,
    raw_tokens: { analysis_method: 'local-heuristic' },
  };
}

// -- Color extraction -------------------------------------------------------

function rgbToHex(rgb: string): string | null {
  const match = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!match) return null;
  const [, r, g, b] = match;
  const toHex = (n: string) => parseInt(n!, 10).toString(16).padStart(2, '0');
  return `#${toHex(r!)}${toHex(g!)}${toHex(b!)}`;
}

function normalizeHex(hex: string): string {
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
}

function isNearWhite(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r > 240 && g > 240 && b > 240;
}

function isNearBlack(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r < 30 && g < 30 && b < 30;
}

function isGrayish(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min < 30;
}

function colorLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function extractColorsLocally(
  data: RawCrawlData,
  allElements: ElementStyleData[],
): DesignSystemOutput['colors'] {
  // Convert all found colors to hex
  const hexColors = new Map<string, number>();
  for (const rgb of data.allColors) {
    const hex = rgbToHex(rgb);
    if (hex) {
      hexColors.set(normalizeHex(hex), (hexColors.get(normalizeHex(hex)) ?? 0) + 1);
    }
  }

  // Also extract from CSS variables
  for (const [, val] of Object.entries(data.cssVariables)) {
    const hex = rgbToHex(val) ?? (val.match(/^#[0-9a-fA-F]{3,8}$/) ? normalizeHex(val) : null);
    if (hex) {
      const norm = normalizeHex(hex);
      hexColors.set(norm, (hexColors.get(norm) ?? 0) + 1);
    }
  }

  const sorted = [...hexColors.entries()].sort((a, b) => b[1] - a[1]);

  // Use semantic CSS variable names for role assignment (highest priority)
  const semanticColors = extractSemanticColorsFromVars(data.cssVariables);

  // Body element analysis
  const bodyElement = allElements.find((e) => e.selector === 'body');
  const textFromBody = bodyElement?.styles.color ? rgbToHex(bodyElement.styles.color) : null;

  // Button analysis
  const buttonElements = allElements.filter((e) =>
    e.selector === 'button' || e.selector === 'btn-class' || e.selector === 'button-link',
  );
  const primaryFromButtons = buttonElements
    .map((b) => rgbToHex(b.styles['background-color'] ?? ''))
    .find((hex) => hex && !isNearWhite(hex) && !isNearBlack(hex) && !isGrayish(hex));

  const chromatic = sorted.filter(([hex]) => !isNearWhite(hex) && !isNearBlack(hex) && !isGrayish(hex));

  // Assign roles with semantic CSS vars taking priority
  const bgColor = semanticColors.background ?? semanticColors.surface ?? sorted.find(([hex]) => isNearWhite(hex))?.[0] ?? '#ffffff';
  const textColor = semanticColors.textPrimary ?? (textFromBody ? normalizeHex(textFromBody) : null) ?? sorted.find(([hex]) => colorLuminance(hex) < 80)?.[0] ?? '#1a1a1a';
  const primaryColor = semanticColors.accent ?? primaryFromButtons ?? chromatic[0]?.[0] ?? '#3b82f6';
  const secondaryColor = semanticColors.textSecondary ?? chromatic.find(([hex]) => hex !== primaryColor)?.[0] ?? '#6366f1';
  const accentColor = semanticColors.accent ?? chromatic.find(([hex]) => hex !== primaryColor && hex !== secondaryColor)?.[0] ?? '#f59e0b';

  // Build palette with semantic names from CSS vars
  const namedColors = buildNamedPalette(data.cssVariables, sorted);

  return {
    primary: { hex: normalizeHex(primaryColor), usage: semanticColors.accent ? 'Accent/brand color used for highlights and CTAs' : 'Primary brand / CTA color' },
    secondary: { hex: normalizeHex(secondaryColor), usage: 'Secondary text and supporting elements' },
    accent: { hex: normalizeHex(accentColor), usage: 'Accent / highlight color' },
    background: { hex: normalizeHex(bgColor), usage: 'Page background' },
    text: { hex: normalizeHex(textColor), usage: 'Primary body text color' },
    palette: namedColors,
  };
}

function extractSemanticColorsFromVars(
  vars: Record<string, string>,
): Record<string, string | null> {
  const result: Record<string, string | null> = {
    textPrimary: null, textSecondary: null, accent: null,
    background: null, surface: null, border: null,
  };

  for (const [name, val] of Object.entries(vars)) {
    const lower = name.toLowerCase();
    const hex = val.match(/^#[0-9a-fA-F]{3,8}$/) ? normalizeHex(val) : null;
    if (!hex) continue;

    if (lower === '--color-text-primary' || lower === '--foreground') {
      result.textPrimary = hex;
    } else if (lower === '--color-text-secondary') {
      result.textSecondary = hex;
    } else if (lower === '--color-accent' || lower === '--color-yellow') {
      result.accent = hex;
    } else if (lower === '--color-surface' || lower === '--color-sand-50') {
      result.surface = hex;
    } else if (lower === '--color-border') {
      result.border = hex;
    }
  }

  return result;
}

function buildNamedPalette(
  vars: Record<string, string>,
  sorted: Array<[string, number]>,
): Array<{ hex: string; name?: string; usage_context: string }> {
  const palette: Array<{ hex: string; name?: string; usage_context: string }> = [];
  const seen = new Set<string>();

  // Named colors from CSS variables
  const semanticVars = Object.entries(vars).filter(([name]) => {
    const l = name.toLowerCase();
    return (l.startsWith('--color-') && !l.includes('oklch') && !l.includes('rgb'));
  });

  for (const [name, val] of semanticVars) {
    const hex = val.match(/^#[0-9a-fA-F]{3,8}$/) ? normalizeHex(val) : null;
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    const cleanName = name.replace(/^--color-/, '').replace(/-/g, ' ');
    palette.push({ hex, name: cleanName, usage_context: `CSS var ${name}` });
  }

  // Fill with remaining frequency-sorted colors
  for (const [hex, count] of sorted) {
    if (seen.has(hex)) continue;
    seen.add(hex);
    const freq = count > 5 ? 'frequently used' : count > 2 ? 'moderately used' : 'rarely used';
    palette.push({ hex, usage_context: freq });
    if (palette.length >= 35) break;
  }

  return palette;
}

// -- Typography extraction --------------------------------------------------

function extractTypographyLocally(
  data: RawCrawlData,
  allElements: ElementStyleData[],
): DesignSystemOutput['typography'] {
  // Collect font families
  const fontCounts = new Map<string, Set<string>>();
  for (const el of allElements) {
    const rawFamily = el.styles['font-family'];
    if (!rawFamily) continue;
    const primary = rawFamily.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
    if (!primary || primary === 'inherit' || primary === 'initial') continue;
    if (!fontCounts.has(primary)) fontCounts.set(primary, new Set());
    const weight = el.styles['font-weight'] ?? '400';
    fontCounts.get(primary)!.add(weight);
  }

  // Also check CSS vars for font family references
  for (const [name, val] of Object.entries(data.cssVariables)) {
    if (name.toLowerCase().includes('font') && val.includes(',')) {
      const primary = val.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
      if (primary && !fontCounts.has(primary)) fontCounts.set(primary, new Set(['400']));
    }
  }

  const fontFamilies = [...fontCounts.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .map(([family, weights]) => ({
      family,
      weights: [...weights].sort(),
      source: inferFontSource(family),
    }));

  // Build type scale from actual element styles
  const scaleSelectors = ['h1', 'h2', 'h3', 'h4', 'body', 'small', 'caption'] as const;
  const scale: DesignSystemOutput['typography']['scale'] = {};

  for (const sel of scaleSelectors) {
    const target = sel === 'body' ? 'p' : sel;
    const el = allElements.find((e) => e.selector === target || e.selector === sel);
    if (el) {
      scale[sel] = {
        font_family: el.styles['font-family']?.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? fontFamilies[0]?.family ?? 'system-ui',
        font_size: el.styles['font-size'] ?? '16px',
        font_weight: el.styles['font-weight'] ?? '400',
        line_height: el.styles['line-height'] ?? '1.5',
        color: rgbToHex(el.styles.color ?? '') ?? '#1a1a1a',
      };
    }
  }

  // Ensure body exists
  if (!scale.body) {
    const bodyEl = allElements.find((e) => e.selector === 'body');
    scale.body = {
      font_family: fontFamilies[0]?.family ?? 'system-ui',
      font_size: bodyEl?.styles['font-size'] ?? '16px',
      font_weight: bodyEl?.styles['font-weight'] ?? '400',
      line_height: bodyEl?.styles['line-height'] ?? '1.5',
      color: bodyEl?.styles.color ? (rgbToHex(bodyEl.styles.color) ?? '#1a1a1a') : '#1a1a1a',
    };
  }

  return { font_families: fontFamilies, scale };
}

function inferFontSource(family: string): string {
  const lower = family.toLowerCase();
  const systemFonts = [
    'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui',
    'roboto', 'helvetica', 'arial', 'sans-serif', 'serif', 'monospace',
    'courier', 'times', 'georgia', 'verdana', 'tahoma', 'trebuchet',
  ];
  if (systemFonts.some((s) => lower.includes(s))) return 'system';
  return 'self-hosted';
}

// -- Spacing extraction -----------------------------------------------------

function extractSpacingLocally(
  allElements: ElementStyleData[],
): DesignSystemOutput['spacing'] {
  const spacingValues = new Set<number>();

  for (const el of allElements) {
    for (const prop of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left',
                         'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap']) {
      const val = el.styles[prop];
      if (val) {
        const px = parseInt(val, 10);
        if (!isNaN(px) && px > 0 && px < 200) spacingValues.add(px);
      }
    }
  }

  const sorted = [...spacingValues].sort((a, b) => a - b);

  // Infer base unit as GCD-ish of common values
  const commonValues = sorted.filter((v) => v >= 4 && v <= 48);
  const baseUnit = commonValues.length > 0
    ? (commonValues.find((v) => v === 4 || v === 8) ?? commonValues[0] ?? 8)
    : 8;

  return {
    unit: `${baseUnit}px`,
    scale: {
      xs: `${Math.max(baseUnit / 2, 2)}px`,
      sm: `${baseUnit}px`,
      md: `${baseUnit * 2}px`,
      lg: `${baseUnit * 3}px`,
      xl: `${baseUnit * 4}px`,
      xxl: `${baseUnit * 6}px`,
    },
  };
}

// -- Border extraction ------------------------------------------------------

function extractBordersLocally(
  data: RawCrawlData,
  allElements: ElementStyleData[],
): DesignSystemOutput['borders'] {
  const radii = new Set<string>();
  const widths = new Set<string>();
  const borderColors = new Set<string>();

  for (const el of allElements) {
    const r = el.styles['border-radius'] ?? el.styles['border-top-left-radius'];
    if (r && r !== '0px') radii.add(r);

    const w = el.styles['border-width'];
    if (w && w !== '0px') widths.add(w);

    const c = el.styles['border-color'];
    if (c && c !== 'rgba(0, 0, 0, 0)') {
      const hex = rgbToHex(c);
      if (hex) borderColors.add(hex);
    }
  }

  // Also from CSS vars
  for (const [name, val] of Object.entries(data.cssVariables)) {
    if (name.toLowerCase().includes('radius')) {
      radii.add(val);
    }
  }

  const sortedRadii = [...radii].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  return {
    radius: {
      sm: sortedRadii[0] ?? '4px',
      md: sortedRadii[Math.floor(sortedRadii.length / 2)] ?? '8px',
      lg: sortedRadii[sortedRadii.length - 1] ?? '16px',
      full: '9999px',
    },
    widths: [...widths],
    colors: [...borderColors],
  };
}

// -- Logo extraction --------------------------------------------------------

function extractLogoLocally(data: RawCrawlData): DesignSystemOutput['logo'] {
  if (data.logoCandidates.length === 0) {
    return { url: '', dimensions: { width: 0, height: 0 } };
  }

  // Prefer: text-logo > inline SVG from header > img from header > other
  const textLogo = data.logoCandidates.find((l) => l.source.includes('text-logo'));
  const svgLogo = data.logoCandidates.find((l) => l.source.includes('inline-svg') && l.svgData);
  const headerImg = data.logoCandidates.find((l) => l.source.includes('header'));
  const best = textLogo ?? svgLogo ?? headerImg ?? data.logoCandidates[0]!;

  return {
    url: best.url,
    svg_data: best.svgData,
    dimensions: best.width && best.height
      ? { width: best.width, height: best.height }
      : undefined,
  };
}

// -- Component extraction ---------------------------------------------------

function extractComponentsLocally(
  allElements: ElementStyleData[],
): DesignSystemOutput['components'] {
  const buttons: DesignSystemOutput['components']['buttons'] = [];
  const cards: DesignSystemOutput['components']['cards'] = [];
  const badges: DesignSystemOutput['components']['badges'] = [];
  const sections: DesignSystemOutput['components']['sections'] = [];

  // Buttons
  const buttonEls = allElements.filter(
    (e) => e.selector === 'button' || e.selector === 'btn-class' || e.selector === 'button-link',
  );
  const seenButtonStyles = new Set<string>();
  for (const el of buttonEls) {
    const bg = el.styles['background-color'] ?? '';
    const key = `${bg}|${el.styles.color ?? ''}|${el.styles['border-radius'] ?? ''}`;
    if (seenButtonStyles.has(key)) continue;
    seenButtonStyles.add(key);

    const bgHex = rgbToHex(bg);
    const variant = bgHex && !isNearWhite(bgHex) && !isGrayish(bgHex)
      ? 'primary'
      : bgHex && isNearWhite(bgHex)
        ? 'ghost'
        : 'secondary';

    buttons.push({
      variant: buttons.some((b) => b.variant === variant) ? `${variant}-alt` : variant,
      styles: pickRelevantStyles(el.styles, ['background-color', 'color', 'border-radius', 'padding-top', 'padding-right', 'font-weight', 'font-size', 'border-width', 'border-color']),
    });
  }

  // Cards
  const cardEls = allElements.filter((e) => e.selector === 'card');
  const seenCardStyles = new Set<string>();
  for (const el of cardEls) {
    const key = `${el.styles['background-color'] ?? ''}|${el.styles['border-radius'] ?? ''}|${el.styles['box-shadow'] ?? ''}`;
    if (seenCardStyles.has(key)) continue;
    seenCardStyles.add(key);

    cards.push({
      variant: cards.length === 0 ? 'default' : `variant-${cards.length + 1}`,
      styles: pickRelevantStyles(el.styles, ['background-color', 'border-radius', 'padding-top', 'padding-right', 'box-shadow', 'border-width', 'border-color']),
    });
  }

  // Badges
  const badgeEls = allElements.filter((e) => e.selector === 'badge');
  for (const el of badgeEls.slice(0, 3)) {
    badges.push({
      variant: badges.length === 0 ? 'default' : `variant-${badges.length + 1}`,
      styles: pickRelevantStyles(el.styles, ['background-color', 'color', 'border-radius', 'padding-top', 'padding-right', 'font-size', 'font-weight']),
    });
  }

  // Sections
  const sectionEls = allElements.filter(
    (e) => e.selector === 'section' || e.selector === 'hero' || e.selector === 'cta',
  );
  const seenSectionBg = new Set<string>();
  for (const el of sectionEls) {
    const bg = el.styles['background-color'] ?? '';
    if (seenSectionBg.has(bg)) continue;
    seenSectionBg.add(bg);

    const variant = el.selector === 'hero'
      ? 'hero'
      : el.selector === 'cta'
        ? 'cta'
        : sections.length === 0
          ? 'default'
          : `variant-${sections.length + 1}`;

    sections.push({
      variant,
      styles: pickRelevantStyles(el.styles, ['background-color', 'padding-top', 'padding-bottom', 'color']),
    });
  }

  return { buttons, cards, badges, sections };
}

function pickRelevantStyles(
  styles: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const val = styles[key];
    if (val && val !== '0px' && val !== 'none' && val !== 'normal' && val !== 'auto' && val !== 'rgba(0, 0, 0, 0)') {
      // Convert rgb to hex for color properties
      if (key.includes('color')) {
        const hex = rgbToHex(val);
        if (hex) {
          result[key] = hex;
          continue;
        }
      }
      result[key] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Claude prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a design system analyst. You analyze raw CSS and DOM data extracted from websites and produce structured design system JSON.

Your output must be a single valid JSON object — no markdown fences, no explanation text before or after, just pure JSON.

Guidelines:
- Convert ALL rgb/rgba color values to 6-digit hex (e.g., rgb(26, 26, 46) → #1a1a2e)
- For rgba with alpha < 1, still convert to hex of the RGB portion and note the alpha in usage_context
- Identify semantic color roles: primary (brand/CTA), secondary, accent, background, text
- Use the actual font families loaded, not generic fallbacks like "sans-serif"
- Map font sizes to a semantic scale (h1 through caption)
- Find the base spacing unit (common GCD of padding/margin values)
- Build spacing scale from actual values observed
- For components, extract the key visual properties that define each variant
- If a value can't be determined, make your best inference from available data
- Include ALL meaningfully distinct colors in the palette array (skip near-duplicates)`;

function buildAnalysisPrompt(data: RawCrawlData): string {
  const sections: string[] = [];

  // Pages crawled
  const pagesSection = data.pages
    .map(
      (p) =>
        `  - ${p.url} (title: "${p.title}", ${p.elements.length} elements inspected, ${p.timeTakenMs}ms)`,
    )
    .join('\n');
  sections.push(`## Pages Crawled\n${pagesSection}`);

  // CSS Custom Properties
  const cssVarEntries = Object.entries(data.cssVariables);
  if (cssVarEntries.length > 0) {
    const cssVarsText = cssVarEntries
      .slice(0, 200)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');
    sections.push(
      `## CSS Custom Properties (${cssVarEntries.length} total)\n${cssVarsText}`,
    );
  } else {
    sections.push('## CSS Custom Properties\n(none found)');
  }

  // Element computed styles — deduplicated by selector
  const elementsBySelector = new Map<
    string,
    Array<{ styles: Record<string, string>; text: string; classes: string }>
  >();
  for (const page of data.pages) {
    for (const el of page.elements) {
      if (!elementsBySelector.has(el.selector)) {
        elementsBySelector.set(el.selector, []);
      }
      elementsBySelector.get(el.selector)!.push({
        styles: el.styles,
        text: el.textPreview,
        classes: el.classes,
      });
    }
  }

  let elementSection = '';
  for (const [selector, elements] of elementsBySelector) {
    elementSection += `\n### ${selector} (${elements.length} instances)\n`;
    const shown = new Set<string>();
    for (const el of elements.slice(0, 3)) {
      const styleKey = Object.entries(el.styles)
        .filter(([, v]) => v && v !== 'normal' && v !== 'none' && v !== '0px')
        .map(([k, v]) => `${k}:${v}`)
        .join('|');
      if (shown.has(styleKey)) continue;
      shown.add(styleKey);

      if (el.text) elementSection += `  text: "${el.text.slice(0, 80)}"\n`;
      if (el.classes) elementSection += `  classes: "${el.classes.slice(0, 120)}"\n`;
      for (const [prop, val] of Object.entries(el.styles)) {
        if (val && val !== 'normal' && val !== 'none' && val !== '0px' && val !== 'auto') {
          elementSection += `    ${prop}: ${val}\n`;
        }
      }
      elementSection += '\n';
    }
  }
  sections.push(`## Element Computed Styles${elementSection}`);

  // All colors
  if (data.allColors.length > 0) {
    const colorsText = data.allColors.slice(0, 120).join('\n  ');
    sections.push(
      `## All Colors Found (${data.allColors.length} unique, showing first 120)\n  ${colorsText}`,
    );
  }

  // Logos
  if (data.logoCandidates.length > 0) {
    const logosText = data.logoCandidates
      .map(
        (l) =>
          `  - ${l.url || '(inline SVG)'}, source: ${l.source}` +
          (l.width ? `, ${l.width}x${l.height}` : '') +
          (l.alt ? `, alt: "${l.alt}"` : '') +
          (l.svgData ? `\n    SVG preview: ${l.svgData.slice(0, 300)}...` : ''),
      )
      .join('\n');
    sections.push(`## Logo Candidates\n${logosText}`);
  }

  const outputSchema = `## Required Output JSON Structure

{
  "metadata": {
    "source_url": "the base URL",
    "crawled_at": "${new Date().toISOString()}",
    "pages_analyzed": ["list of page URLs"]
  },
  "colors": {
    "primary": { "hex": "#xxxxxx", "usage": "description of where this is the primary/brand color" },
    "secondary": { "hex": "#xxxxxx", "usage": "description" },
    "accent": { "hex": "#xxxxxx", "usage": "description" },
    "background": { "hex": "#xxxxxx", "usage": "main page background" },
    "text": { "hex": "#xxxxxx", "usage": "body text color" },
    "palette": [
      { "hex": "#xxxxxx", "name": "semantic-name", "usage_context": "where/how this color is used" }
    ]
  },
  "typography": {
    "font_families": [
      { "family": "Actual Font Name", "weights": ["400", "600", "700"], "source": "google-fonts|adobe-fonts|self-hosted|system" }
    ],
    "scale": {
      "h1": { "font_family": "...", "font_size": "48px", "font_weight": "700", "line_height": "1.2", "color": "#..." },
      "h2": { "font_family": "...", "font_size": "36px", "font_weight": "700", "line_height": "1.3", "color": "#..." },
      "h3": { "font_family": "...", "font_size": "24px", "font_weight": "600", "line_height": "1.4", "color": "#..." },
      "body": { "font_family": "...", "font_size": "16px", "font_weight": "400", "line_height": "1.5", "color": "#..." },
      "small": { "font_family": "...", "font_size": "14px", "font_weight": "400", "line_height": "1.5", "color": "#..." },
      "caption": { "font_family": "...", "font_size": "12px", "font_weight": "400", "line_height": "1.4", "color": "#..." }
    }
  },
  "spacing": {
    "unit": "8px",
    "scale": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "32px", "xxl": "48px" }
  },
  "borders": {
    "radius": { "sm": "4px", "md": "8px", "lg": "16px", "full": "9999px" },
    "widths": ["1px", "2px"],
    "colors": ["#xxxxxx"]
  },
  "logo": {
    "url": "full URL to best logo image or empty string if SVG only",
    "svg_data": "raw SVG markup if available, otherwise omit",
    "dimensions": { "width": 120, "height": 40 }
  },
  "components": {
    "buttons": [{ "variant": "primary", "styles": { "background-color": "#...", "color": "#...", "border-radius": "...", "padding": "...", "font-weight": "..." } }],
    "cards": [{ "variant": "default", "styles": { "background-color": "#...", "border-radius": "...", "padding": "...", "box-shadow": "..." } }],
    "badges": [{ "variant": "default", "styles": { "background-color": "#...", "color": "#...", "border-radius": "...", "padding": "...", "font-size": "..." } }],
    "sections": [{ "variant": "hero", "styles": { "background-color": "#...", "padding": "...", "text-align": "..." } }]
  },
  "css_variables": { "--var-name": "value" },
  "raw_tokens": {}
}`;

  sections.push(outputSchema);

  return (
    'Analyze the following raw design data extracted from a website and produce a structured design system JSON.\n\n' +
    sections.join('\n\n')
  );
}
