import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Flywheel production infographic tokens (from Flywheel-scraper Design/infographic-design-system.md) */
export const FLYWHEEL_INFOGRAPHIC_DEFAULTS = {
  creamGradient: 'linear-gradient(180deg, #faf9f6 0%, #f3f1ed 100%)',
  cardShadow: '0 8px 60px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.04)',
  glassCardBg: 'rgba(255, 255, 255, 0.55)',
  glassCardBorder: '1px solid rgba(0, 0, 0, 0.08)',
  glassCardShadow:
    '0 4px 16px rgba(0,0,0,0.04), inset 1px 1px 0px rgba(255, 252, 248, 0.25), inset -1px -1px 0px rgba(255, 250, 245, 0.08)',
  pillBg: 'linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.35) 100%)',
  pillBorder: '1px solid rgba(255, 255, 255, 0.5)',
  pillShadow:
    '0 2px 8px rgba(0,0,0,0.04), 0 0.5px 0px rgba(0,0,0,0.03), inset 0 1px 1px rgba(255,255,255,0.6)',
  sandDivider: 'linear-gradient(90deg, rgba(215,200,175,0.4) 0%, rgba(215,200,175,0.15) 100%)',
  summaryPillBg: 'linear-gradient(135deg, rgba(215,200,175,0.3) 0%, rgba(196,184,154,0.2) 100%)',
  summaryPillBorder: '1px solid rgba(215, 200, 175, 0.35)',
  headingColor: '#0d0d0d',
  subtitleColor: '#999999',
  bodyColor: '#444444',
  mutedColor: '#777777',
  sandAccent: '#d7c8af',
} as const;

export type FlywheelInfographicTokens = typeof FLYWHEEL_INFOGRAPHIC_DEFAULTS;

export function resolveFlywheelScraperPath(): string | null {
  const envPath = process.env.FLYWHEEL_SCRAPER_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const defaultPath = join(process.cwd(), '..', 'Flywheel-scraper');
  if (existsSync(defaultPath)) return defaultPath;

  return null;
}

/** Load Flywheel logo SVG from scraper repo if available. */
export async function loadFlywheelLogoSvg(): Promise<string> {
  const scraperPath = resolveFlywheelScraperPath();
  if (!scraperPath) return '';

  const logoPath = join(scraperPath, 'Design', 'website-components', 'flywheel-logo.svg');
  if (!existsSync(logoPath)) return '';

  try {
    return await readFile(logoPath, 'utf-8');
  } catch {
    return '';
  }
}

export function buildInfographicDesignTokens(logoSvgOverride?: string) {
  const t = FLYWHEEL_INFOGRAPHIC_DEFAULTS;
  return {
    ...t,
    flywheelLogoSvg: logoSvgOverride || '',
    faviconBase: 'https://www.google.com/s2/favicons?domain=',
  };
}
