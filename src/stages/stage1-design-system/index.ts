import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { crawlSite } from './crawler.js';
import { analyzeDesignSystem } from './extractor.js';
import type { DesignSystemOutput } from './extractor.js';
import { DesignSystem } from '../../schemas/design-system.schema.js';
import { createStageLogger } from '../../observability/logger.js';
import { loadConfig } from '../../config.js';
import type { Stage1Result } from '../../types/index.js';

const log = createStageLogger('stage1');

// ---------------------------------------------------------------------------
// Load .env if present (no external dependency needed)
// ---------------------------------------------------------------------------

function loadEnvFile(): void {
  try {
    const envPath = resolve('.env');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    /* .env file not found — rely on environment */
  }
}

// ---------------------------------------------------------------------------
// Main stage orchestrator
// ---------------------------------------------------------------------------

export async function runStage1(targetUrl?: string): Promise<Stage1Result> {
  loadEnvFile();

  const config = loadConfig();
  const url = targetUrl ?? config.targetUrl;
  const startTime = Date.now();

  log.info({ url }, 'Stage 1: Website → Design System');

  // ------------------------------------------------------------------
  // Phase 1 — Crawl the site
  // ------------------------------------------------------------------
  log.info('Phase 1: Crawling website with Playwright…');
  const rawCrawlData = await crawlSite(url);

  await mkdir('data', { recursive: true });
  const rawPath = join('data', 'design-system-raw.json');
  await writeFile(rawPath, JSON.stringify(rawCrawlData, null, 2), 'utf-8');
  log.info({ rawPath, sizeKB: Math.round(JSON.stringify(rawCrawlData).length / 1024) }, 'Raw crawl data saved');

  // ------------------------------------------------------------------
  // Phase 2 — Analyze with Claude
  // ------------------------------------------------------------------
  log.info('Phase 2: Analyzing crawl data…');
  const designSystem = await analyzeDesignSystem(rawCrawlData, config.anthropicApiKey);

  const richPath = join('data', 'design-system.json');
  await writeFile(richPath, JSON.stringify(designSystem, null, 2), 'utf-8');
  log.info({ richPath }, 'Rich design system JSON saved');

  // ------------------------------------------------------------------
  // Phase 3 — Produce Zod-compatible version for downstream stages
  // ------------------------------------------------------------------
  log.info('Phase 3: Producing Zod-compatible schema for downstream stages…');
  const zodCompatible = toZodCompatible(designSystem, url);

  let validated: DesignSystem;
  try {
    validated = DesignSystem.parse(zodCompatible);
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'Zod validation failed, writing unvalidated');
    validated = zodCompatible as unknown as DesignSystem;
  }

  await mkdir(join('data', 'schema'), { recursive: true });
  const zodPath = join('data', 'schema', 'design_system.json');
  await writeFile(zodPath, JSON.stringify(validated, null, 2), 'utf-8');
  log.info({ zodPath }, 'Zod-compatible design system saved');

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  const totalMs = Date.now() - startTime;
  log.info(
    {
      totalMs,
      pagesAnalyzed: rawCrawlData.pages.length,
      cssVariables: Object.keys(rawCrawlData.cssVariables).length,
      uniqueColors: rawCrawlData.allColors.length,
      logos: rawCrawlData.logoCandidates.length,
      fontFamilies: designSystem.typography?.font_families?.length ?? 0,
      paletteColors: designSystem.colors?.palette?.length ?? 0,
    },
    'Stage 1 complete',
  );

  return {
    designSystem: validated,
    rawCss: JSON.stringify(rawCrawlData.cssVariables),
  };
}

// ---------------------------------------------------------------------------
// Convert rich Claude output → existing Zod schema shape
// ---------------------------------------------------------------------------

function toZodCompatible(ds: DesignSystemOutput, sourceUrl: string): Record<string, unknown> {
  const colors = ds.colors ?? ({} as DesignSystemOutput['colors']);
  const typo = ds.typography ?? ({} as DesignSystemOutput['typography']);
  const fonts = typo.font_families ?? [];
  const headingFont = fonts[0] ?? { family: 'system-ui', weights: ['400', '700'], source: 'unknown' };
  const bodyFont = fonts[1] ?? fonts[0] ?? { family: 'system-ui', weights: ['400'], source: 'unknown' };

  const allExtracted = (colors.palette ?? []).map((c) => ({
    name: c.name ?? c.usage_context ?? 'color',
    hex: c.hex,
    usage: c.usage_context,
  }));

  const scale = typo.scale
    ? Object.entries(typo.scale).map(([level, d]) => ({
        level,
        sizePx: parseInt(d.font_size, 10) || 16,
        weight: normalizeWeight(d.font_weight),
        lineHeight: parseFloat(d.line_height) || undefined,
      }))
    : undefined;

  const borderRadius = parseInt(ds.borders?.radius?.md ?? '8', 10) || 8;

  const logo = ds.logo?.url || ds.logo?.svg_data
    ? {
        url: ds.logo.url || undefined,
        format: inferLogoFormat(ds.logo),
        widthPx: ds.logo.dimensions?.width,
        heightPx: ds.logo.dimensions?.height,
        base64: ds.logo.svg_data
          ? Buffer.from(ds.logo.svg_data).toString('base64')
          : undefined,
      }
    : undefined;

  const components = flattenComponents(ds.components);

  const rawCssVariables = Object.entries(ds.css_variables ?? {}).map(
    ([property, value]) => ({ property, value, selector: ':root' }),
  );

  return {
    version: '1.0.0',
    sourceUrl,
    crawledAt: ds.metadata?.crawled_at ?? new Date().toISOString(),
    colors: {
      primary: colors.primary?.hex ?? '#000000',
      secondary: colors.secondary?.hex,
      accent: colors.accent?.hex,
      background: colors.background?.hex ?? '#ffffff',
      text: colors.text?.hex ?? '#1a1a1a',
      allExtracted,
    },
    typography: {
      headingFont: {
        family: headingFont.family,
        weights: ensureWeightArray(headingFont.weights),
        source: headingFont.source ?? 'unknown',
      },
      bodyFont: {
        family: bodyFont.family,
        weights: ensureWeightArray(bodyFont.weights),
        source: bodyFont.source ?? 'unknown',
      },
      baseSizePx: 16,
      lineHeight: 1.5,
      scale,
    },
    spacing: {
      unit: parseInt(ds.spacing?.unit ?? '4', 10) || 4,
      borderRadiusPx: borderRadius,
    },
    logo,
    components,
    rawCssVariables,
  };
}

function normalizeWeight(w: string): string {
  const num = parseInt(w, 10);
  if (num >= 100 && num <= 900 && num % 100 === 0) return String(num);
  const map: Record<string, string> = {
    thin: '100', hairline: '100',
    extralight: '200', ultralight: '200',
    light: '300',
    normal: '400', regular: '400',
    medium: '500',
    semibold: '600', demibold: '600',
    bold: '700',
    extrabold: '800', ultrabold: '800',
    black: '900', heavy: '900',
  };
  return map[w.toLowerCase().replace(/[\s-]/g, '')] ?? '400';
}

function ensureWeightArray(weights: string[] | undefined): string[] {
  if (!weights || weights.length === 0) return ['400'];
  return weights.map(normalizeWeight);
}

function inferLogoFormat(logo: { url?: string; svg_data?: string }): string {
  if (logo.svg_data) return 'svg';
  const u = (logo.url ?? '').toLowerCase();
  if (u.endsWith('.svg')) return 'svg';
  if (u.endsWith('.png')) return 'png';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'jpg';
  if (u.endsWith('.webp')) return 'webp';
  return 'unknown';
}

function flattenComponents(
  comps: DesignSystemOutput['components'] | undefined,
): Array<{ name: string; cssClasses?: string[]; notes?: string }> {
  if (!comps) return [];
  const result: Array<{ name: string; cssClasses?: string[]; notes?: string }> = [];
  for (const [type, variants] of Object.entries(comps)) {
    if (!Array.isArray(variants)) continue;
    for (const v of variants) {
      const styleSummary = Object.entries(v.styles ?? {})
        .map(([k, val]) => `${k}: ${val}`)
        .join('; ');
      result.push({
        name: `${type}-${v.variant}`,
        notes: styleSummary || undefined,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Direct execution entry point
// ---------------------------------------------------------------------------

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? resolve(process.argv[1]) : '';

if (currentFile === entryFile) {
  runStage1().catch((err) => {
    log.fatal(err, 'Stage 1 failed');
    process.exit(1);
  });
}
