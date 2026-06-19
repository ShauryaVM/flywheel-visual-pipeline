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
  quote_card: 'quote-card',
  multi_stat_panel: 'multi-stat-panel',
  feature_list_graphic: 'feature-list-graphic',
  stat_callout: 'stat-callout',
  event_details_card: 'event-details-card',
  attribution_quote_card: 'attribution-quote-card',
  comparison_table: 'comparison-table',
  timeline_graphic: 'timeline-graphic',
  ranked_list_graphic: 'ranked-list-graphic',
  checklist_graphic: 'checklist-graphic',
  two_column_process_diagram: 'two-column-process-diagram',
  bar_chart: 'bar-chart',
  line_sparkline: 'line-sparkline',
  pie_donut_chart: 'pie-donut-chart',
};

// ---------------------------------------------------------------------------
// Chart data item for chart-type modalities
// ---------------------------------------------------------------------------
export const ChartDataItem = z.object({
  label: z.string(),
  value: z.number(),
});
export type ChartDataItem = z.infer<typeof ChartDataItem>;

// ---------------------------------------------------------------------------
// Layout specification (InfoDesignLM-inspired)
// ---------------------------------------------------------------------------
export const LayoutSpec = z.object({
  headline_position: z.string().optional().describe('e.g. "top-left at 10% from top"'),
  stat_position: z.string().optional().describe('e.g. "center-right at 60% from left"'),
  accent_placement: z.string().optional().describe('e.g. "left edge vertical bar"'),
  whitespace_distribution: z.string().optional().describe('e.g. "60% right, 20% top, 20% bottom"'),
  emphasis_area: z.string().optional().describe('Where the visual weight should concentrate'),
  flex_direction: z.enum(['row', 'column', 'row-reverse', 'column-reverse']).optional(),
  alignment: z.enum(['start', 'center', 'end', 'space-between']).optional(),
  padding_distribution: z.object({
    top: z.string().optional(),
    right: z.string().optional(),
    bottom: z.string().optional(),
    left: z.string().optional(),
  }).optional(),
}).describe('Spatial layout specification for varied compositions');
export type LayoutSpec = z.infer<typeof LayoutSpec>;

// ---------------------------------------------------------------------------
// Layout protocol element (Graphist-inspired JSON layout)
// ---------------------------------------------------------------------------
export const LayoutElement = z.object({
  type: z.enum(['headline', 'subtext', 'stat', 'chart', 'accent', 'logo', 'watermark', 'decorative']),
  content: z.string(),
  position: z.object({ x: z.string(), y: z.string() }),
  size: z.object({ width: z.string(), height: z.string() }),
  style: z.object({
    fontSize: z.string().optional(),
    fontWeight: z.string().optional(),
    color: z.string().optional(),
    opacity: z.number().optional(),
    fontFamily: z.string().optional(),
    textTransform: z.string().optional(),
    letterSpacing: z.string().optional(),
    lineHeight: z.string().optional(),
    textAlign: z.string().optional(),
    background: z.string().optional(),
  }).optional(),
  zIndex: z.number().optional(),
});
export type LayoutElement = z.infer<typeof LayoutElement>;

export const LayoutProtocol = z.object({
  canvas: z.object({
    width: z.number(),
    height: z.number(),
    background: z.string(),
  }),
  elements: z.array(LayoutElement),
});
export type LayoutProtocol = z.infer<typeof LayoutProtocol>;

// ---------------------------------------------------------------------------
// Visual concept: a single concept proposed by the LLM
// ---------------------------------------------------------------------------
export const VisualConcept = z.object({
  modality: VisualModality,
  headline: z.string().describe('Main text to display, under 10 words'),
  subtext: z.string().optional().describe('Supporting text, under 25 words'),
  data_points: z.array(z.string()).optional().describe('For stat panels, lists, etc.'),
  chart_data: z.array(ChartDataItem).optional().describe('Structured data for chart modalities'),
  layout_description: z.string().describe('How elements are arranged'),
  layout_spec: LayoutSpec.optional().describe('Richer spatial layout guidance'),
  layout_protocol: LayoutProtocol.optional().describe('Full JSON layout protocol for universal rendering'),
  color_usage: z.string().describe('Which design system colors to use'),
  reasoning: z.string().describe('Why this concept fits the post'),
  visualization_goals: z.array(z.string()).optional().describe('Key narratives extracted from LIDA goal enumeration'),
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
