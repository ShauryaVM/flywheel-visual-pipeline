import type { ConceptGenerationOutput, VisualConcept } from '../schemas/concept.schema.js';
import type { VisualModality, PostClassification } from '../schemas/modality.schema.js';

export type { ConceptGenerationOutput, VisualConcept };
export type { VisualModality, PostClassification };

// ---------------------------------------------------------------------------
// Design system type (matches data/design-system.json shape directly)
// ---------------------------------------------------------------------------
export interface DesignSystemData {
  metadata: {
    source_url: string;
    crawled_at: string;
    pages_analyzed: string[];
  };
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

export interface PipelineResult {
  concept: ConceptGenerationOutput;
  selectedConcept: VisualConcept;
  html: string;
  htmlPath: string;
  pdfPath: string;
  pngPath: string;
  evalScore?: EvalScore;
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

export interface EvalScore {
  onBrand: number;
  legible: number;
  clearHierarchy: number;
  notGeneric: number;
  overall: number;
  critique: string;
  passesThreshold: boolean;
}
