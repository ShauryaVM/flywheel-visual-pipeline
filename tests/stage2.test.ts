import { describe, it, expect } from 'vitest';
import {
  VisualConcept,
  ConceptGenerationOutput,
  SelectionRule,
} from '../src/schemas/concept.schema.js';

describe('Stage 2: Concept Schema', () => {
  const validConcept = {
    id: 'concept-1',
    title: 'Bold Quote Card',
    modality: 'quote-card' as const,
    templateId: 'quote-card',
    layout: [
      { type: 'pull-quote' as const, content: 'Great products are built on consistency.', position: 'center' as const, emphasis: 'primary' as const },
      { type: 'footer-bar' as const, content: 'flywheelos.com', position: 'bottom' as const },
    ],
    colorOverrides: [],
    aspectRatio: '1:1' as const,
    reasoning: 'The post centers on a single key insight, best captured as a bold quote card.',
  };

  it('validates a well-formed visual concept', () => {
    const result = VisualConcept.safeParse(validConcept);
    expect(result.success).toBe(true);
  });

  it('requires at least one layout element', () => {
    const noLayout = { ...validConcept, layout: [] };
    const result = VisualConcept.safeParse(noLayout);
    expect(result.success).toBe(false);
  });

  it('validates a selection rule', () => {
    const rule = {
      selectedConceptId: 'concept-1',
      rule: 'best-brand-alignment' as const,
      explanation: 'This concept best matches the brand palette and typography.',
    };

    const result = SelectionRule.safeParse(rule);
    expect(result.success).toBe(true);
  });

  it('validates a full concept generation output', () => {
    const output = {
      postText: 'Great products are built on consistency.',
      generatedAt: new Date().toISOString(),
      concepts: [
        validConcept,
        { ...validConcept, id: 'concept-2', title: 'Stat Callout', modality: 'single-stat-callout' as const, templateId: 'stat-callout' },
      ],
      selection: {
        selectedConceptId: 'concept-1',
        rule: 'best-brand-alignment' as const,
        explanation: 'Best fit for the brand.',
      },
      selectedConcept: validConcept,
    };

    const result = ConceptGenerationOutput.safeParse(output);
    expect(result.success).toBe(true);
  });
});
