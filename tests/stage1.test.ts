import { describe, it, expect } from 'vitest';
import { DesignSystem, ColorPalette, Typography } from '../src/schemas/design-system.schema.js';

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
