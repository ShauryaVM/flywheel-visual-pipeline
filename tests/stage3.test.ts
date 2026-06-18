import { describe, it, expect } from 'vitest';
import { renderConceptToHtml } from '../src/stages/stage3-concept-to-html/renderer.js';
import type { VisualConcept } from '../src/schemas/concept.schema.js';
import type { DesignSystem } from '../src/schemas/design-system.schema.js';

describe('Stage 3: Rendering', () => {
  const mockDesignSystem: DesignSystem = {
    version: '1.0.0',
    sourceUrl: 'https://flywheelos.com',
    crawledAt: new Date().toISOString(),
    colors: {
      primary: '#2563eb',
      background: '#ffffff',
      surface: '#f8fafc',
      text: '#1e293b',
      textSecondary: '#64748b',
      allExtracted: [],
    },
    typography: {
      headingFont: { family: 'Inter', weights: ['700'], source: 'google-fonts' },
      bodyFont: { family: 'Inter', weights: ['400'], source: 'google-fonts' },
      baseSizePx: 16,
      lineHeight: 1.5,
    },
    spacing: { unit: 4, borderRadiusPx: 12 },
    components: [],
    rawCssVariables: [],
  };

  const mockConcept: VisualConcept = {
    id: 'concept-test',
    title: 'Test Quote Card',
    modality: 'quote-card',
    templateId: 'quote-card',
    layout: [
      { type: 'pull-quote', content: 'Consistency compounds.', position: 'center', emphasis: 'primary' },
      { type: 'headline', content: 'On Building', position: 'bottom' },
    ],
    colorOverrides: [],
    aspectRatio: '1:1',
    reasoning: 'Test rendering',
  };

  it('renders a quote-card template to HTML', async () => {
    const html = await renderConceptToHtml({
      concept: mockConcept,
      designSystem: mockDesignSystem,
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Consistency compounds.');
    expect(html).toContain('#2563eb');
    expect(html).toContain('Inter');
  });

  it('renders a stat-callout template to HTML', async () => {
    const statConcept: VisualConcept = {
      ...mockConcept,
      id: 'concept-stat',
      templateId: 'stat-callout',
      modality: 'single-stat-callout',
      layout: [
        { type: 'statistic', content: '47%', position: 'center', emphasis: 'primary' },
        { type: 'headline', content: 'Faster Delivery', position: 'center' },
        { type: 'body-text', content: 'Teams using visual pipelines ship nearly half again as fast.', position: 'bottom' },
      ],
    };

    const html = await renderConceptToHtml({
      concept: statConcept,
      designSystem: mockDesignSystem,
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('47%');
    expect(html).toContain('Faster Delivery');
  });
});
