import { describe, it, expect } from 'vitest';
import { renderConceptToHtml } from '../src/stages/stage3-concept-to-html/renderer.js';
import type { VisualConcept } from '../src/schemas/concept.schema.js';

describe('Stage 3: Rendering', () => {
  const mockConcept: VisualConcept = {
    modality: 'pull_quote_card',
    headline: 'Consistency compounds.',
    subtext: 'Great products are built on repeatable processes.',
    data_points: [],
    layout_description: 'Centered pull quote with subtle background, attribution below',
    color_usage: 'Primary color for the quote mark, neutral background, dark text',
    reasoning: 'Test rendering of a pull-quote card',
  };

  it('renders a pull-quote-card template to HTML', async () => {
    const html = await renderConceptToHtml(mockConcept);

    expect(html).toContain('Consistency compounds.');
    expect(html).toContain('Inter');
  });

  it('renders a stat-callout template to HTML', async () => {
    const statConcept: VisualConcept = {
      modality: 'stat_callout',
      headline: '47%',
      subtext: 'Faster Delivery',
      data_points: ['47% | Speed increase'],
      layout_description: 'Large stat number centered with label below',
      color_usage: 'Accent color on the number, neutral supporting text',
      reasoning: 'Post mentions a specific metric that works as a stat callout.',
    };

    const html = await renderConceptToHtml(statConcept);

    expect(html).toContain('47%');
  });

  it('renders flywheel-stat-panel template', async () => {
    const concept: VisualConcept = {
      modality: 'multi_stat_panel',
      headline: 'Impressions are vanity.',
      subtext: 'Pipeline is the point.',
      data_points: ['2.75x | Personal vs company impressions', '1-2% | Regular posters on LinkedIn'],
      layout_description: 'Glass stat cards on cream gradient',
      color_usage: 'Flywheel infographic tokens',
      reasoning: 'Multiple metrics from the post.',
    };

    const html = await renderConceptToHtml(concept);

    expect(html).toContain('Impressions are vanity.');
    expect(html).toContain('faf9f6');
  });

  it('renders mafia-ecosystem template', async () => {
    const concept: VisualConcept = {
      modality: 'mafia_ecosystem_graphic',
      headline: 'The UK AI mafia.',
      subtext: '$5.8B raised in Q1 2026 alone.',
      data_points: [
        '1/ ElevenLabs | $11B valuation | elevenlabs.io',
        '2/ Wayve | $8.6B valuation | wayve.ai',
      ],
      layout_description: 'Grid of glass company pills',
      color_usage: 'Flywheel infographic tokens',
      reasoning: 'Ecosystem list post.',
    };

    const html = await renderConceptToHtml(concept);

    expect(html).toContain('ElevenLabs');
    expect(html).toContain('favicons');
  });

  it('falls back to headline-subtext-card for unknown modalities', async () => {
    const concept: VisualConcept = {
      modality: 'headline_subtext_card',
      headline: 'Fallback Test',
      subtext: 'This should use the default template',
      layout_description: 'Simple headline with supporting subtext',
      color_usage: 'Brand primary, neutral background',
      reasoning: 'Testing fallback behavior',
    };

    const html = await renderConceptToHtml(concept);

    expect(html).toContain('Fallback Test');
  });
});
