import Anthropic from '@anthropic-ai/sdk';
import { readFile, access, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadConfig } from '../../config.js';
import { createStageLogger } from '../../observability/logger.js';
import type { PageScreenshot } from './crawler.js';
import type { DesignSystemOutput } from './extractor.js';
import { propagateAccentReplacement } from './extractor.js';
import type { DesignPortfolio } from '../../types/index.js';

const log = createStageLogger('stage1:token-audit');

export interface TokenAuditEntry {
  hex: string;
  role: string;
  visibility: 'visible_prominent' | 'visible_subtle' | 'not_visible' | 'uncertain';
  notes: string;
}

export interface TokenAuditResult {
  screenshotPaths: string[];
  tokensChecked: number;
  ghostTokens: TokenAuditEntry[];
  confirmedTokens: TokenAuditEntry[];
  entries: TokenAuditEntry[];
  summary: string;
}

export interface ScreenshotSource {
  label: string;
  base64: string;
  mediaType: 'image/png' | 'image/jpeg';
}

const TOKEN_AUDIT_SYSTEM =
  'You audit whether CSS-extracted brand colors actually appear in website screenshots. Return ONLY valid JSON.';

function normalizeHex(hex: string): string {
  const h = hex.trim().toLowerCase();
  if (h.length === 4 && h.startsWith('#')) {
    return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  return h;
}

function loadEnvFile(): void {
  try {
    const content = readFileSync(resolve('.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* no .env */
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function collectTokensFromDesignSystemOutput(
  ds: DesignSystemOutput,
): Array<{ hex: string; role: string }> {
  const tokens: Array<{ hex: string; role: string }> = [];

  for (const role of ['primary', 'secondary', 'accent', 'background', 'text'] as const) {
    const entry = ds.colors[role];
    if (entry?.hex) tokens.push({ hex: entry.hex.toLowerCase(), role });
  }

  for (const entry of ds.colors.palette ?? []) {
    if (!entry.hex) continue;
    const role = entry.name ?? entry.usage_context ?? 'palette';
    tokens.push({ hex: entry.hex.toLowerCase(), role });
  }

  const seen = new Set<string>();
  return tokens.filter((t) => {
    const key = `${t.hex}:${t.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectTokensFromDesignSystem(
  ds: Record<string, unknown>,
): Array<{ hex: string; role: string }> {
  const colors = ds.colors as DesignSystemOutput['colors'] | undefined;
  if (!colors) return [];

  const output: DesignSystemOutput = {
    metadata: { source_url: '', crawled_at: '', pages_analyzed: [] },
    colors,
    typography: { font_families: [], scale: {} },
    spacing: { unit: '4', scale: {} },
    borders: { radius: {}, widths: [], colors: [] },
    logo: { url: '' },
    components: { buttons: [], cards: [], badges: [], sections: [] },
    css_variables: {},
    raw_tokens: {},
  };
  return collectTokensFromDesignSystemOutput(output);
}

async function loadScreenshotSources(paths: string[]): Promise<ScreenshotSource[]> {
  const sources: ScreenshotSource[] = [];
  for (const path of paths) {
    if (!(await fileExists(path))) continue;
    const png = await readFile(path);
    sources.push({
      label: path,
      base64: png.toString('base64'),
      mediaType: 'image/png',
    });
  }
  return sources;
}

export function screenshotsFromCrawl(pages: PageScreenshot[]): ScreenshotSource[] {
  return pages
    .filter((s) => s.screenshotBase64.length > 0)
    .slice(0, 4)
    .map((s) => ({
      label: `${s.title} — ${s.url}`,
      base64: s.screenshotBase64,
      mediaType: 'image/jpeg' as const,
    }));
}

export async function auditExtractedTokensWithVision(
  sources: ScreenshotSource[],
  tokens: Array<{ hex: string; role: string }>,
  apiKey: string,
): Promise<TokenAuditResult> {
  if (sources.length === 0) {
    throw new Error('No screenshots provided for vision token audit');
  }

  const client = new Anthropic({ apiKey });
  const imageBlocks: Anthropic.Messages.ContentBlockParam[] = [];

  for (const source of sources) {
    imageBlocks.push({
      type: 'text',
      text: `[Screenshot: ${source.label}]`,
    });
    imageBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: source.mediaType,
        data: source.base64,
      },
    });
  }

  const tokenList = tokens.map((t) => `- ${t.hex} (${t.role})`).join('\n');

  imageBlocks.push({
    type: 'text',
    text: `These colors were extracted from CSS/design tokens during a website crawl:

${tokenList}

For EACH color above, inspect the screenshots and classify visibility:
- "visible_prominent": clearly visible as a meaningful brand/UI color (not a 1px artifact)
- "visible_subtle": present but tiny/incidental (small dot, hover state hint, etc.)
- "not_visible": does not appear anywhere in the rendered UI
- "uncertain": cannot determine

Return JSON:
{
  "entries": [
    { "hex": "#000000", "role": "primary", "visibility": "visible_prominent", "notes": "..." }
  ],
  "summary": "One paragraph on which extracted tokens are trustworthy vs ghost CSS variables"
}`,
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: TOKEN_AUDIT_SYSTEM,
    messages: [{ role: 'user', content: imageBlocks }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from token audit vision call');
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in token audit response');
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    entries: TokenAuditEntry[];
    summary: string;
  };

  const entries = parsed.entries.map((e) => ({
    ...e,
    hex: e.hex.toLowerCase(),
  }));

  const ghostTokens = entries.filter((e) => e.visibility === 'not_visible');
  const confirmedTokens = entries.filter(
    (e) => e.visibility === 'visible_prominent' || e.visibility === 'visible_subtle',
  );

  return {
    screenshotPaths: sources.map((s) => s.label),
    tokensChecked: tokens.length,
    ghostTokens,
    confirmedTokens,
    entries,
    summary: parsed.summary,
  };
}

function pickAccentReplacement(
  audit: TokenAuditResult,
  ds: DesignSystemOutput,
): string {
  const preferredRoles = ['card-warm', 'secondary', 'nav-link', 'primary'];
  for (const role of preferredRoles) {
    const match = audit.confirmedTokens.find(
      (t) => t.role === role && t.visibility !== 'not_visible',
    );
    if (match) return normalizeHex(match.hex);
  }
  return normalizeHex(ds.colors.secondary?.hex ?? ds.colors.primary.hex);
}

export function applyGhostTokensFromAudit(
  ds: DesignSystemOutput,
  portfolio: DesignPortfolio | undefined,
  audit: TokenAuditResult,
): void {
  const ghostHexes = new Set(
    audit.ghostTokens.map((t) => normalizeHex(t.hex)),
  );

  const accentHex = normalizeHex(ds.colors.accent.hex);
  const accentIsGhost =
    ghostHexes.has(accentHex) ||
    audit.ghostTokens.some(
      (t) =>
        (t.role === 'accent' || t.role === 'accent-yellow') &&
        t.visibility === 'not_visible',
    );

  if (accentIsGhost) {
    const replacement = pickAccentReplacement(audit, ds);
    log.info(
      { removed: accentHex, replacement },
      'Replacing ghost accent color flagged by vision token audit',
    );
    ds.colors.accent = {
      hex: replacement,
      usage: `Vision-validated accent (CSS accent ${accentHex} not visible in crawled screenshots)`,
    };
    propagateAccentReplacement(ds, portfolio, accentHex, replacement);
  }

  ds.colors.palette = (ds.colors.palette ?? []).filter((entry) => {
    const hex = normalizeHex(entry.hex);
    return !ghostHexes.has(hex);
  });
}

export async function runVisionTokenAudit(
  designSystem: DesignSystemOutput,
  screenshots: PageScreenshot[],
  portfolio: DesignPortfolio | undefined,
  apiKey: string,
): Promise<TokenAuditResult | null> {
  const sources = screenshotsFromCrawl(screenshots);
  if (sources.length === 0) {
    log.warn('No crawl screenshots available — skipping vision token audit');
    return null;
  }

  const tokens = collectTokensFromDesignSystemOutput(designSystem);
  log.info({ tokenCount: tokens.length, screenshotCount: sources.length }, 'Running vision token audit');

  const audit = await auditExtractedTokensWithVision(sources, tokens, apiKey);
  applyGhostTokensFromAudit(designSystem, portfolio, audit);

  if (audit.ghostTokens.length > 0) {
    log.warn(
      {
        ghostCount: audit.ghostTokens.length,
        ghosts: audit.ghostTokens.map((t) => `${t.hex} (${t.role})`),
      },
      'Ghost CSS tokens removed after vision audit',
    );
  }

  return audit;
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();

  const designSystemPath = process.argv[2] ?? 'data/design-system.json';
  const screenshotArg = process.argv[3];

  const ds = JSON.parse(await readFile(designSystemPath, 'utf-8')) as Record<string, unknown>;
  const metadata = ds.metadata as { source_url?: string } | undefined;
  const sourceUrl = metadata?.source_url ?? config.targetUrl;

  let hostname: string;
  try {
    hostname = new URL(sourceUrl).hostname.replace(/^www\./, '');
  } catch {
    hostname = 'flywheelos.com';
  }

  const defaultScreenshot = join('data', 'reference-screenshots', `${hostname}.png`);
  const screenshotPaths = screenshotArg
    ? [screenshotArg]
    : [defaultScreenshot, join('data', 'reference-brand-screenshot.png')];

  const tokens = collectTokensFromDesignSystem(ds);
  log.info({ designSystemPath, screenshotPaths, tokenCount: tokens.length }, 'Starting vision token audit');

  const fileSources = await loadScreenshotSources(screenshotPaths);
  const result = await auditExtractedTokensWithVision(
    fileSources,
    tokens,
    config.anthropicApiKey,
  );

  console.log('\n=== Vision Token Audit ===\n');
  console.log(`Design system: ${designSystemPath}`);
  console.log(`Screenshots: ${result.screenshotPaths.join(', ')}`);
  console.log(`Tokens checked: ${result.tokensChecked}\n`);

  console.log('Ghost tokens (not visible in screenshots):');
  if (result.ghostTokens.length === 0) {
    console.log('  (none)');
  } else {
    for (const t of result.ghostTokens) {
      console.log(`  ${t.hex} [${t.role}] — ${t.notes}`);
    }
  }

  console.log('\nConfirmed tokens:');
  for (const t of result.confirmedTokens) {
    console.log(`  ${t.hex} [${t.role}] — ${t.visibility}: ${t.notes}`);
  }

  console.log(`\nSummary:\n${result.summary}\n`);
}

const entryFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryFile.endsWith('audit-tokens-vision.ts')) {
  main().catch((err) => {
    log.fatal(err, 'Token audit failed');
    process.exit(1);
  });
}
