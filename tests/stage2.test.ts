import { describe, it, expect } from 'vitest';
import {
  VisualConcept,
  ConceptGenerationOutput,
} from '../src/schemas/concept.schema.js';

describe('Stage 2: Concept Schema', () => {
  const validConcept = {
    modality: 'quote_card' as const,
    headline: 'Consistency compounds.',
    subtext: 'Great products are built over time, not overnight.',
    data_points: [],
    layout_description: 'Centered quote with attribution bar at the bottom',
    color_usage: 'Primary background with white text, accent on the attribution',
    reasoning: 'The post centers on a single key insight, best captured as a bold quote card.',
  };

  it('validates a well-formed visual concept', () => {
    const result = VisualConcept.safeParse(validConcept);
    expect(result.success).toBe(true);
  });

  it('rejects a concept missing required fields', () => {
    const missingHeadline = {
      modality: 'quote_card',
      layout_description: 'Centered layout',
      color_usage: 'Primary palette',
      reasoning: 'Test',
    };
    const result = VisualConcept.safeParse(missingHeadline);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown modality', () => {
    const badModality = { ...validConcept, modality: 'unknown_modality' };
    const result = VisualConcept.safeParse(badModality);
    expect(result.success).toBe(false);
  });

  it('accepts a concept without optional fields', () => {
    const minimal = {
      modality: 'bold_statement_card' as const,
      headline: 'Ship faster.',
      layout_description: 'Full-bleed centered text',
      color_usage: 'Dark background, white headline',
      reasoning: 'Short, punchy post works best as a bold statement.',
    };
    const result = VisualConcept.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('validates a full concept generation output', () => {
    const output = {
      concepts: [
        validConcept,
        {
          ...validConcept,
          modality: 'stat_callout' as const,
          headline: '47% faster',
          data_points: ['47% | Faster delivery', '3x | More output'],
          layout_description: 'Large stat with supporting label below',
          color_usage: 'Accent color on the stat number, neutral text',
          reasoning: 'The post mentions a specific metric that works well as a stat callout.',
        },
      ],
      selected: 0,
      selection_reasoning: 'The quote card best captures the reflective tone of the post.',
    };

    const result = ConceptGenerationOutput.safeParse(output);
    expect(result.success).toBe(true);
  });

  it('rejects a concept generation output with fewer than 2 concepts', () => {
    const output = {
      concepts: [validConcept],
      selected: 0,
      selection_reasoning: 'Only one concept.',
    };

    const result = ConceptGenerationOutput.safeParse(output);
    expect(result.success).toBe(false);
  });

  it('rejects a concept generation output missing selection_reasoning', () => {
    const output = {
      concepts: [validConcept, { ...validConcept, modality: 'bold_statement_card' as const }],
      selected: 0,
    };

    const result = ConceptGenerationOutput.safeParse(output);
    expect(result.success).toBe(false);
  });
});
