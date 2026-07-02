/**
 * Infographic-style layout tokens derived from the crawled brand design system.
 * Used by stat-panel and mafia-ecosystem templates (glass cards, pills, etc.).
 */

export interface BrandTokenInput {
  primary: string;
  accent: string;
  background: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  surface: string;
  backgroundStyle: string;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

export function buildInfographicDesignTokens(brand: BrandTokenInput) {
  const accentRgb = hexToRgb(brand.accent);
  const { r, g, b } = accentRgb;

  return {
    creamGradient:
      brand.backgroundStyle ||
      `linear-gradient(180deg, ${brand.background} 0%, ${brand.surface} 100%)`,
    cardShadow: '0 8px 60px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.04)',
    glassCardBg: 'rgba(255, 255, 255, 0.55)',
    glassCardBorder: '1px solid rgba(0, 0, 0, 0.08)',
    glassCardShadow:
      '0 4px 16px rgba(0,0,0,0.04), inset 1px 1px 0px rgba(255, 252, 248, 0.25), inset -1px -1px 0px rgba(255, 250, 245, 0.08)',
    pillBg: 'linear-gradient(135deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.35) 100%)',
    pillBorder: '1px solid rgba(255, 255, 255, 0.5)',
    pillShadow:
      '0 2px 8px rgba(0,0,0,0.04), 0 0.5px 0px rgba(0,0,0,0.03), inset 0 1px 1px rgba(255,255,255,0.6)',
    sandDivider: `linear-gradient(90deg, rgba(${r},${g},${b},0.4) 0%, rgba(${r},${g},${b},0.15) 100%)`,
    summaryPillBg: `linear-gradient(135deg, rgba(${r},${g},${b},0.3) 0%, rgba(${r},${g},${b},0.15) 100%)`,
    summaryPillBorder: `1px solid rgba(${r}, ${g}, ${b}, 0.35)`,
    headingColor: brand.text,
    subtitleColor: brand.textMuted,
    bodyColor: brand.textSubtle,
    mutedColor: brand.textMuted,
    sandAccent: brand.accent,
    faviconBase: 'https://www.google.com/s2/favicons?domain=',
  };
}
