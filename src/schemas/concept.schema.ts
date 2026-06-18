import { z } from 'zod';
import { VisualModality } from './modality.schema.js';

// ---------------------------------------------------------------------------
// Template ID mapping from modality names to .hbs file names
// ---------------------------------------------------------------------------
export const MODALITY_TEMPLATE_MAP: Record<string, string> = {
  headline_subtext_card: 'headline-subtext-card',
  key_takeaway_card: 'key-takeaway-card',
  numbered_list_graphic: 'numbered-list-graphic',
  bold_statement_card: 'bold-statement-card',
  pull_quote_card: 'pull-quote-card',
  multi_stat_panel: 'multi-stat-panel',
  feature_list_graphic: 'feature-list-graphic',
  event_details_card: 'event-details-card',
  attribution_quote_card: 'attribution-quote-card',
  comparison_table: 'comparison-table',
  timeline_graphic: 'timeline-graphic',
  ranked_list_graphic: 'ranked-list-graphic',
  checklist_graphic: 'checklist-graphic',
  two_column_process_diagram: 'two-column-process-diagram',
};

// ---------------------------------------------------------------------------
// Visual concept: a single concept proposed by the LLM
// ---------------------------------------------------------------------------
export const VisualConcept = z.object({
  modality: VisualModality,
  headline: z.string().describe('Main text to display, under 10 words'),
  subtext: z.string().optional().describe('Supporting text, under 25 words'),
  data_points: z.array(z.string()).optional().describe('For stat panels, lists, etc.'),
  layout_description: z.string().describe('How elements are arranged'),
  color_usage: z.string().describe('Which design system colors to use'),
  reasoning: z.string().describe('Why this concept fits the post'),
});
export type VisualConcept = z.infer<typeof VisualConcept>;

// ---------------------------------------------------------------------------
// Stage 2 output: all concepts + the winner
// ---------------------------------------------------------------------------
export const ConceptGenerationOutput = z.object({
  concepts: z
    .array(VisualConcept)
    .min(2)
    .max(3)
    .describe('2-3 candidate concepts'),
  selected: z.number().int().min(0).describe('Index of best concept'),
  selection_reasoning: z.string().describe('Why this concept was picked'),
});
export type ConceptGenerationOutput = z.infer<typeof ConceptGenerationOutput>;
