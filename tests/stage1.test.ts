import { describe, it, expect } from 'vitest';
import { DesignSystem, ColorPalette, Typography } from '../src/schemas/design-system.schema.js';
import {
  validateAccentWithVision,
  propagateAccentReplacement,
  buildVisionCssContext,
  isAccentCssVariableKey,
  type DesignSystemOutput,
} from '../src/stages/stage1-design-system/extractor.js';
import type { RawCrawlData } from '../src/stages/stage1-design-system/crawler.js';
import type { DesignPortfolio } from '../src/types/index.js';

const DEAD_ACCENT = '#aabb00';
const RENDERED_ACCENT = '#ff3366';

function makeDesignSystem(overrides?: Partial<DesignSystemOutput>): DesignSystemOutput {
  return {
    metadata: {
      source_url: 'https://example.com',
      crawled_at: new Date().toISOString(),
      pages_analyzed: ['https://example.com'],
    },
    colors: {
      primary: { hex: '#2244aa', usage: 'primary' },
      secondary: { hex: '#666677', usage: 'secondary' },
      accent: { hex: DEAD_ACCENT, usage: 'accent' },
      background: { hex: '#ffffff', usage: 'background' },
      text: { hex: '#111111', usage: 'text' },
      palette: [
        { hex: DEAD_ACCENT, name: 'accent', usage_context: 'accent highlights' },
        { hex: RENDERED_ACCENT, name: 'highlight', usage_context: 'CTA buttons' },
      ],
    },
    typography: { font_families: [], scale: {} },
    spacing: { unit: '4px', scale: {} },
    borders: { radius: {}, widths: [], colors: [] },
    logo: { url: '' },
    components: { buttons: [], cards: [], badges: [], sections: [] },
    css_variables: {
      '--color-accent': DEAD_ACCENT,
      '--color-primary': '#2244aa',
    },
    raw_tokens: { accent: DEAD_ACCENT, nested: { brandAccent: DEAD_ACCENT } },
    ...overrides,
  };
}

function makeCrawlData(allColors: string[]): RawCrawlData {
  return {
    pages: [],
    screenshots: [],
    cssVariables: {
      '--color-accent': DEAD_ACCENT,
      '--color-primary': '#2244aa',
    },
    logoCandidates: [],
    allColors,
    brandAssets: {
      logo: null,
      decorativeSvgs: [],
      animations: [],
      gradients: [],
    },
    totalTimeMs: 0,
  };
}

function makePortfolio(): DesignPortfolio {
  return {
    background_style: 'background: #ffffff',
    hero_treatment: 'background: linear-gradient(180deg, #2244aa 0%, transparent 100%)',
    card_style: 'border: 1px solid #cccccc',
    accent_treatment: `border-left: 3px solid ${DEAD_ACCENT}`,
    spacing_density: 'balanced',
    visual_motifs: ['subtle pattern'],
    illustration_style: 'Minimal lines',
    composition_rules: ['Centered layout'],
    signature_elements: [`Warm accent bar using ${DEAD_ACCENT} on cool palette`],
  };
}

describe('Stage 1: Design System Schema', () => {
  it('validates a well-formed design system', () => {
    const valid = {
      version: '1.0.0',
      sourceUrl: 'https://flywheelos.com',
      crawledAt: new Date().toISOString(),
      colors: {
        primary: '#2563eb',
        background: '#ffffff',
        text: '#1a1a1a',
        allExtracted: [{ name: 'primary', hex: '#2563eb' }],
      },
      typography: {
        headingFont: { family: 'Inter', weights: ['700'], source: 'google-fonts' },
        bodyFont: { family: 'Inter', weights: ['400'], source: 'google-fonts' },
        baseSizePx: 16,
        lineHeight: 1.5,
      },
      spacing: { unit: 4, borderRadiusPx: 8 },
    };

    const result = DesignSystem.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects invalid hex colors', () => {
    const invalid = {
      primary: 'not-a-color',
      background: '#fff',
      text: '#000',
      allExtracted: [],
    };

    const result = ColorPalette.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('requires heading and body fonts', () => {
    const missingBody = {
      headingFont: { family: 'Inter', weights: ['700'], source: 'google-fonts' },
      baseSizePx: 16,
      lineHeight: 1.5,
    };

    const result = Typography.safeParse(missingBody);
    expect(result.success).toBe(false);
  });
});

describe('Stage 1: accent color validation', () => {
  it('replaces CSS accent hex not present in rendered allColors', () => {
    const result = makeDesignSystem();
    const rawData = makeCrawlData([
      'rgb(255, 51, 102)',
      'rgb(34, 68, 170)',
      'rgb(255, 255, 255)',
      'rgb(17, 17, 17)',
    ]);

    validateAccentWithVision(result, undefined, rawData);

    expect(result.colors.accent.hex.toLowerCase()).toBe(RENDERED_ACCENT);
  });

  it('does not treat portfolio text echo as proof when allColors omits accent', () => {
    const result = makeDesignSystem();
    const portfolio = makePortfolio();
    const rawData = makeCrawlData(['rgb(255, 51, 102)', 'rgb(255, 255, 255)', 'rgb(17, 17, 17)']);

    validateAccentWithVision(result, portfolio, rawData);

    expect(result.colors.accent.hex.toLowerCase()).toBe(RENDERED_ACCENT);
    expect(portfolio.signature_elements[0]).not.toContain(DEAD_ACCENT);
    expect(portfolio.signature_elements[0]).toContain(RENDERED_ACCENT);
  });

  it('propagates accent replacement to css_variables, palette, and raw_tokens', () => {
    const result = makeDesignSystem();
    const portfolio = makePortfolio();

    propagateAccentReplacement(result, portfolio, DEAD_ACCENT, RENDERED_ACCENT);

    expect(result.colors.palette.find((c) => c.name === 'accent')?.hex.toLowerCase()).toBe(
      RENDERED_ACCENT,
    );
    expect(result.css_variables['--color-accent'].toLowerCase()).toBe(RENDERED_ACCENT);
    expect(result.raw_tokens.accent).toBe(RENDERED_ACCENT);
    expect((result.raw_tokens.nested as { brandAccent: string }).brandAccent).toBe(RENDERED_ACCENT);
    expect(portfolio.accent_treatment).toContain(RENDERED_ACCENT);
    expect(portfolio.accent_treatment).not.toContain(DEAD_ACCENT);
  });

  it('excludes accent-related CSS variables from vision prompt context', () => {
    expect(isAccentCssVariableKey('--color-accent')).toBe(true);
    expect(isAccentCssVariableKey('--accent-primary')).toBe(true);
    expect(isAccentCssVariableKey('--color-primary')).toBe(false);

    const context = buildVisionCssContext({
      '--color-accent': DEAD_ACCENT,
      '--color-primary': '#2244aa',
      '--bg-surface': '#ffffff',
    });

    expect(context).toContain('--color-primary');
    expect(context).toContain('--bg-surface');
    expect(context).not.toContain('--color-accent');
    expect(context).not.toContain(DEAD_ACCENT);
  });
});
