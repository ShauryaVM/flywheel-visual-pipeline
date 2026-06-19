import type { ConceptGenerationOutput, VisualConcept } from '../schemas/concept.schema.js';
import type { VisualModality, PostClassification } from '../schemas/modality.schema.js';

export type { ConceptGenerationOutput, VisualConcept };
export type { VisualModality, PostClassification };

// ---------------------------------------------------------------------------
// Design system type (matches data/design-system.json shape directly)
// ---------------------------------------------------------------------------
export interface BrandIdentity {
  name: string;
  url: string;
  tagline: string;
  logo_text: string;
  description: string;
  decorative_pattern_svg: string;
}

export interface DesignSystemData {
  metadata: {
    source_url: string;
    crawled_at: string;
    pages_analyzed: string[];
  };
  brand_identity?: BrandIdentity;
  colors: {
    primary: { hex: string; usage: string };
    secondary: { hex: string; usage: string };
    accent: { hex: string; usage: string };
    background: { hex: string; usage: string };
    text: { hex: string; usage: string };
    palette: Array<{ hex: string; name: string; usage_context: string }>;
  };
  typography: {
    font_families: Array<{
      family: string;
      weights: string[];
      source: string;
    }>;
    scale: Record<
      string,
      {
        font_family: string;
        font_size: string;
        font_weight: string;
        line_height: string;
        letter_spacing?: string;
        color: string;
      }
    >;
  };
  spacing: {
    unit: string;
    scale: Record<string, string>;
  };
  borders: {
    radius: Record<string, string>;
    widths: string[];
    colors: string[];
  };
  logo: {
    url: string;
    svg_data: string;
    dimensions: { width: number; height: number };
  };
  components: Record<string, unknown>;
  css_variables: Record<string, string>;
  raw_tokens: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Decision rules type (matches data/schema/decision-rules.json)
// ---------------------------------------------------------------------------
export interface DecisionRule {
  condition: string;
  visual_modality: string;
  confidence: number;
}

export interface ContentTypeRules {
  content_type: string;
  rules: DecisionRule[];
}

export interface DecisionRulesData {
  generated_at: string;
  rules: ContentTypeRules[];
  validation: {
    total_posts: number;
    correctly_predicted: number;
    accuracy_pct: number;
  };
}

// ---------------------------------------------------------------------------
// Schema V1 type
// ---------------------------------------------------------------------------
export interface SchemaV1 {
  version: string;
  generated_at: string;
  content_types: Array<{
    name: string;
    display_name: string;
    definition: string;
    inclusion_criteria: string[];
    example_post_id: string;
  }>;
  visual_modalities: Array<{
    name: string;
    display_name: string;
    definition: string;
    inclusion_criteria: string[];
    renderability_spec: string;
    example_post_id: string;
  }>;
}

// ---------------------------------------------------------------------------
// Pipeline I/O types
// ---------------------------------------------------------------------------

export interface PipelineInput {
  postText: string;
  postId?: string;
  outputDir?: string;
}

export interface FeedbackAttempt {
  attempt: number;
  scores: EvalScore;
  critique: string;
  conceptChanges?: string;
}

export interface FeedbackLog {
  postId: string;
  attempts: FeedbackAttempt[];
  finalResult: 'pass' | 'fail_after_retries';
  improvement: {
    originalComposite: number;
    finalComposite: number;
    delta: number;
    axesImproved: string[];
  };
}

export interface PipelineResult {
  concept: ConceptGenerationOutput;
  selectedConcept: VisualConcept;
  html: string;
  htmlPath: string;
  pdfPath: string;
  pngPath: string;
  evalScore?: EvalScore;
  feedbackLog?: FeedbackLog;
  regenerated?: boolean;
}

export interface Stage1Result {
  designSystem: unknown;
  rawCss: string;
}

export interface Stage3Result {
  html: string;
  htmlPath: string;
  pdfPath: string;
  pngPath: string;
}

export interface RawPost {
  id: string;
  text: string;
  author?: string;
  date?: string;
  engagement?: {
    likes?: number;
    comments?: number;
    reposts?: number;
  };
}

export interface VisionAbsoluteScore {
  layout: number;
  legibility: number;
  polish: number;
}

export interface VisionComparativeScore {
  colorMatch: number;
  typographyMatch: number;
  aestheticMatch: number;
}

export interface EvalScore {
  // Text-structural scores (from HTML source analysis)
  onBrand: number;
  legible: number;
  clearHierarchy: number;
  notGeneric: number;
  overall: number;
  critique: string;
  passesThreshold: boolean;

  // Vision-based scores (from rendered PNG analysis)
  visionAbsolute?: VisionAbsoluteScore;
  visionComparative?: VisionComparativeScore;
  visionCritique?: string;

  // Weighted composite of text (30%) + absolute vision (35%) + comparative vision (35%)
  compositeScore?: number;
}
