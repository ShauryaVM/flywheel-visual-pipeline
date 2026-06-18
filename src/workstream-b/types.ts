import { z } from 'zod';

// ---------------------------------------------------------------------------
// Raw post shape from inspiration-posts-300.json
// ---------------------------------------------------------------------------
export const InspPostSchema = z.object({
  id: z.string(),
  platform: z.string().optional(),
  post_url: z.string().optional(),
  creator_name: z.string().nullable().optional(),
  creator_handle: z.string().nullable().optional(),
  content_text: z.string(),
  format: z.string().optional(),
  is_repost: z.boolean().optional(),
  hashtags: z.array(z.string()).optional(),
  mentions: z.array(z.string()).optional(),
  media: z
    .object({
      type: z.string().optional(),
      count: z.number().optional(),
      urls: z.array(z.string()).optional(),
      primary_image: z.string().nullable().optional(),
      url_expires: z.string().optional(),
    })
    .optional(),
  local_image: z.string().nullable().optional(),
  engagement: z
    .object({
      likes: z.number().default(0),
      comments: z.number().default(0),
      shares: z.number().default(0),
      reposts: z.number().default(0),
      replies: z.number().default(0),
      impressions: z.number().default(0),
      views: z.number().default(0),
      total_engagement: z.number().default(0),
      engagement_rate_pct: z.number().nullable().optional(),
    })
    .optional(),
  account_followers_count: z.number().nullable().optional(),
  posted_date: z.string().optional(),
  collected_at: z.string().optional(),
});
export type InspPost = z.infer<typeof InspPostSchema>;

// ---------------------------------------------------------------------------
// Phase 0: Signal-enriched post
// ---------------------------------------------------------------------------
export const SignalsSchema = z.object({
  word_count: z.number(),
  has_numbers: z.boolean(),
  has_list_structure: z.boolean(),
  has_questions: z.boolean(),
  mentions_person: z.boolean(),
  mentions_metric_or_stat: z.boolean(),
  has_url_links: z.boolean(),
  exclamation_density: z.number(),
  format: z.string(),
  engagement_tier: z.enum(['high', 'mid', 'low']),
  image_available: z.boolean(),
});
export type Signals = z.infer<typeof SignalsSchema>;

export interface EnrichedPost extends InspPost {
  signals: Signals;
}

// ---------------------------------------------------------------------------
// Phase 1: Exploration result per post
// ---------------------------------------------------------------------------
export const ExplorationResultSchema = z.object({
  post_id: z.string(),
  content_type: z.string(),
  visual_modality: z.string(),
  content_evidence: z.string(),
  visual_evidence: z.string(),
  correlation: z.string(),
});
export type ExplorationResult = z.infer<typeof ExplorationResultSchema>;

export const ExplorationBatchResponseSchema = z.object({
  results: z.array(ExplorationResultSchema),
});

// ---------------------------------------------------------------------------
// Phase 2: Schema types
// ---------------------------------------------------------------------------
export const ContentTypeDefSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  definition: z.string(),
  inclusion_criteria: z.array(z.string()),
  example_post_id: z.string(),
});
export type ContentTypeDef = z.infer<typeof ContentTypeDefSchema>;

export const VisualModalityDefSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  definition: z.string(),
  inclusion_criteria: z.array(z.string()),
  renderability_spec: z.string(),
  example_post_id: z.string(),
});
export type VisualModalityDef = z.infer<typeof VisualModalityDefSchema>;

export const DACTISchemaSchema = z.object({
  version: z.string(),
  generated_at: z.string(),
  content_types: z.array(ContentTypeDefSchema),
  visual_modalities: z.array(VisualModalityDefSchema),
});
export type DACTISchema = z.infer<typeof DACTISchemaSchema>;

// ---------------------------------------------------------------------------
// Phase 3: Refinement types
// ---------------------------------------------------------------------------
export const RefinementClassificationSchema = z.object({
  post_id: z.string(),
  content_type: z.string(),
  visual_modality: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  fits_cleanly: z.boolean(),
  issue: z.string().optional(),
});

export const SchemaModificationSchema = z.object({
  action: z.enum(['SPLIT', 'MERGE', 'ADD', 'REDEFINE']),
  target: z.string(),
  axis: z.enum(['content_type', 'visual_modality']),
  rationale: z.string(),
  proposed_change: z.string(),
});

export const RefinementResponseSchema = z.object({
  classifications: z.array(RefinementClassificationSchema),
  modifications: z.array(SchemaModificationSchema),
});

// ---------------------------------------------------------------------------
// Phase 4: Full classification result
// ---------------------------------------------------------------------------
export const PostLabelSchema = z.object({
  post_id: z.string(),
  content_type: z.string(),
  visual_modality: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  content_type_evidence: z.string(),
  visual_modality_evidence: z.string(),
  signals_used: z.array(z.string()),
});
export type PostLabel = z.infer<typeof PostLabelSchema>;

export const ClassificationBatchResponseSchema = z.object({
  classifications: z.array(PostLabelSchema),
});

// ---------------------------------------------------------------------------
// Phase 5: Decision rules
// ---------------------------------------------------------------------------
export const DecisionRuleSchema = z.object({
  condition: z.string(),
  visual_modality: z.string(),
  confidence: z.number(),
});

export const ContentTypeRulesSchema = z.object({
  content_type: z.string(),
  rules: z.array(DecisionRuleSchema),
});
export type ContentTypeRules = z.infer<typeof ContentTypeRulesSchema>;

export const DecisionRulesOutputSchema = z.object({
  generated_at: z.string(),
  rules: z.array(ContentTypeRulesSchema),
  validation: z.object({
    total_posts: z.number(),
    correctly_predicted: z.number(),
    accuracy_pct: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// Phase 6: Distribution summary
// ---------------------------------------------------------------------------
export const DistributionSummarySchema = z.object({
  generated_at: z.string(),
  total_posts: z.number(),
  content_type_counts: z.record(z.string(), z.number()),
  visual_modality_counts: z.record(z.string(), z.number()),
  cross_tabulation: z.array(
    z.object({
      content_type: z.string(),
      visual_modality: z.string(),
      count: z.number(),
    }),
  ),
  confidence_distribution: z.object({
    high: z.number(),
    medium: z.number(),
    low: z.number(),
  }),
  thin_category_warnings: z.array(
    z.object({
      axis: z.string(),
      category: z.string(),
      count: z.number(),
    }),
  ),
  coverage_report: z.array(
    z.object({
      content_type: z.string(),
      top_rules_coverage_pct: z.number(),
    }),
  ),
});
