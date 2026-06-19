import { z } from 'zod';

// ---------------------------------------------------------------------------
// Content type: the rhetorical shape of a post
// ---------------------------------------------------------------------------
export const ContentType = z.enum([
  'career_personal_milestone',
  'company_milestone_announcement',
  'retrospective_lessons',
  'personal_narrative_reflection',
  'opinion_hot_take',
  'educational_explainer',
  'data_research_insight',
  'product_feature_pitch',
  'partnership_announcement',
  'event_promotion_announcement',
  'in_progress_event_update',
  'event_community_recap',
  'industry_news_commentary',
  'link_share_minimal_commentary',
  'narrative_scenario_case_study',
  'recruitment_job_posting',
]);
export type ContentType = z.infer<typeof ContentType>;

// ---------------------------------------------------------------------------
// Visual modality: the 14 modalities from Workstream B schema-v1
// ---------------------------------------------------------------------------
export const VisualModality = z.enum([
  'headline_subtext_card',
  'key_takeaway_card',
  'numbered_list_graphic',
  'bold_statement_card',
  'pull_quote_card',
  'quote_card',
  'multi_stat_panel',
  'feature_list_graphic',
  'stat_callout',
  'event_details_card',
  'attribution_quote_card',
  'comparison_table',
  'timeline_graphic',
  'ranked_list_graphic',
  'checklist_graphic',
  'two_column_process_diagram',
]);
export type VisualModality = z.infer<typeof VisualModality>;

// ---------------------------------------------------------------------------
// Post classification: one post mapped to its axes
// ---------------------------------------------------------------------------
export const PostClassification = z.object({
  postId: z.string().describe('Unique identifier for the post'),
  contentType: ContentType,
  visualModality: VisualModality,
  confidence: z.number().min(0).max(1).describe('Model confidence in classification'),
  rationale: z.string().optional().describe('Brief explanation of classification decision'),
});
export type PostClassification = z.infer<typeof PostClassification>;

// ---------------------------------------------------------------------------
// Distribution entry: how often a (contentType, modality) pair appears
// ---------------------------------------------------------------------------
export const DistributionEntry = z.object({
  contentType: ContentType,
  visualModality: VisualModality,
  count: z.number().int().min(0),
  percentage: z.number().min(0).max(100),
});
export type DistributionEntry = z.infer<typeof DistributionEntry>;

// ---------------------------------------------------------------------------
// Full schema output: the deliverable from Workstream B
// ---------------------------------------------------------------------------
export const ModalitySchemaOutput = z.object({
  version: z.string().default('1.0.0'),
  generatedAt: z.string().datetime(),
  totalPostsAnalyzed: z.number().int().positive(),
  contentTypes: z.array(
    z.object({
      type: ContentType,
      description: z.string(),
      exampleSignals: z.array(z.string()).min(1),
    }),
  ),
  visualModalities: z.array(
    z.object({
      modality: VisualModality,
      description: z.string(),
      bestPairedWith: z.array(ContentType).min(1),
    }),
  ),
  distribution: z.array(DistributionEntry),
  topCombinations: z
    .array(
      z.object({
        contentType: ContentType,
        visualModality: VisualModality,
        count: z.number().int().min(0),
        rank: z.number().int().positive(),
      }),
    )
    .min(1)
    .describe('Top N most frequent pairings'),
});
export type ModalitySchemaOutput = z.infer<typeof ModalitySchemaOutput>;
