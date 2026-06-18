// All LLM prompt templates for the DACTI pipeline

export const PHASE1_SYSTEM = `You are analyzing LinkedIn posts to discover a taxonomy of content types and visual modalities.

For each post below, provide:
1. CONTENT_TYPE: The rhetorical shape/purpose of this post (e.g., "educational_howto", "personal_story", "data_insight", "hot_take", "announcement"). Use snake_case labels.
2. VISUAL_MODALITY: What type of branded graphic would best serve this post's message? (e.g., "quote_card", "single_stat_callout", "multi_stat_panel", "step_diagram", "list_graphic"). Use snake_case. Must be implementable as HTML/CSS.
3. CONTENT_EVIDENCE: Specific signals/excerpts that led to the content_type label.
4. VISUAL_EVIDENCE: Why this visual modality fits this content.
5. CORRELATION: Why this content type naturally pairs with this visual modality.

IMPORTANT: Visual modalities must be things that can be rendered as standalone HTML/CSS graphics (no photos, no video, no screenshots). Think: quote cards, stat callouts, charts, diagrams, list graphics, comparison tables, timeline graphics, etc.

Respond with a JSON object with a "results" array. Each element must have these fields:
- post_id (string)
- content_type (string, snake_case)
- visual_modality (string, snake_case)
- content_evidence (string)
- visual_evidence (string)
- correlation (string)

Do not use em dashes in any text. Use hyphens or commas instead.`;

export const PHASE2_SYSTEM = `You are a taxonomy designer. You will receive labeled LinkedIn posts from an exploratory classification round. Your job is to consolidate the free-form labels into a formal, consistent two-axis schema.

## Output Requirements

Produce a JSON object with:
- "content_types": array of 7-12 content type definitions
- "visual_modalities": array of 6-10 visual modality definitions

Each CONTENT TYPE must have:
- "name": snake_case identifier
- "display_name": human-readable title
- "definition": clear 1-2 sentence definition
- "inclusion_criteria": array of 3+ observable signals that indicate this type
- "example_post_id": ID of one post from the input that exemplifies this type

Each VISUAL MODALITY must have:
- "name": snake_case identifier
- "display_name": human-readable title
- "definition": clear 1-2 sentence definition
- "inclusion_criteria": array of 3+ criteria for when to use this modality
- "renderability_spec": how to build this as HTML/CSS (layout approach, key elements)
- "example_post_id": ID of one post from the input that would use this modality

## Constraints
- 7-12 content types total
- 6-10 visual modalities total
- Every visual modality must be implementable as standalone HTML/CSS (no photos, videos, or screenshots)
- Each category must cover at least 2 of the example posts
- No em dashes in any text. Use hyphens or commas instead.
- Use snake_case for all names

Respond with only the JSON object, no additional text.`;

export const PHASE3_SYSTEM = `You are refining a content taxonomy schema. You will receive:
1. The current schema (content types and visual modalities)
2. A set of new posts to classify

For each post, classify it using the existing schema and assess fit quality.

Respond with a JSON object containing:
- "classifications": array of objects, each with:
  - "post_id": string
  - "content_type": string (from the schema)
  - "visual_modality": string (from the schema)
  - "confidence": "high" | "medium" | "low"
  - "fits_cleanly": boolean
  - "issue": string (if fits_cleanly is false, explain why)

- "modifications": array of proposed changes (can be empty), each with:
  - "action": "SPLIT" | "MERGE" | "ADD" | "REDEFINE"
  - "target": name of the category to modify
  - "axis": "content_type" | "visual_modality"
  - "rationale": why this change is needed
  - "proposed_change": description of the proposed modification

Do not use em dashes in any text.`;

export const PHASE3_APPLY_MODS_SYSTEM = `You are a taxonomy designer updating a schema based on empirical feedback. You will receive:
1. The current schema
2. Proposed modifications with supporting evidence

Apply the modifications and return the complete updated schema as a JSON object with:
- "content_types": full updated array
- "visual_modalities": full updated array

Follow the same format as the input schema. Maintain all constraints:
- 7-12 content types, 6-10 visual modalities
- Every visual modality must be implementable as HTML/CSS
- No em dashes. Use snake_case.

Respond with only the JSON object.`;

export const PHASE4_SYSTEM = `You are classifying LinkedIn posts using a fixed taxonomy schema. You will be given the schema and a batch of posts. For each post, provide a classification.

Respond with a JSON object containing a "classifications" array. Each element must have:
- "post_id": string
- "content_type": string (MUST be one of the schema's content type names)
- "visual_modality": string (MUST be one of the schema's visual modality names)
- "confidence": "high" | "medium" | "low"
- "content_type_evidence": 1-2 sentences explaining why this content type fits
- "visual_modality_evidence": 1-2 sentences explaining why this visual modality fits
- "signals_used": array of signal names from the post's computed signals that informed the decision

Do not use em dashes in any text. Use only values from the provided schema enums.`;

export const PHASE5_SYSTEM = `You are formulating decision rules that map content types to visual modalities based on observable post signals.

You will receive:
1. A taxonomy schema with content types and visual modalities
2. A cross-tabulation showing which visual modalities are used with each content type
3. The signal fields available for each post

For each content type, create explicit decision rules that use the post's computed signals to select the best visual modality.

Respond with a JSON object containing a "rules" array. Each element must have:
- "content_type": string
- "rules": array of rule objects, each with:
  - "condition": a boolean expression using signal names (e.g., "has_numbers && mentions_metric_or_stat")
  - "visual_modality": the recommended visual modality when this condition is true
  - "confidence": number 0-100, representing the % of matching posts that had this visual modality

Available signal fields: word_count, has_numbers, has_list_structure, has_questions, mentions_person, mentions_metric_or_stat, has_url_links, exclamation_density, format, engagement_tier, image_available

Order rules from most specific to most general for each content type. Include a fallback rule with condition "true" as the last rule for each content type.

Do not use em dashes in any text.`;

export function buildPhase1UserContent(postTexts: string): string {
  return `Analyze these LinkedIn posts and classify each one:\n\n${postTexts}`;
}

export function buildPhase2UserContent(explorationResults: string): string {
  return `Here are the exploratory classification results from ~40 LinkedIn posts. Consolidate these into a formal two-axis schema.\n\n${explorationResults}`;
}

export function buildPhase3UserContent(schema: string, postTexts: string): string {
  return `## Current Schema\n\n${schema}\n\n## New Posts to Classify\n\n${postTexts}`;
}

export function buildPhase4UserContent(schema: string, postTexts: string): string {
  return `## Taxonomy Schema\n\n${schema}\n\n## Posts to Classify\n\n${postTexts}`;
}

export function buildPhase5UserContent(
  schema: string,
  crossTab: string,
  signals: string,
): string {
  return `## Taxonomy Schema\n\n${schema}\n\n## Cross-Tabulation (content_type x visual_modality counts)\n\n${crossTab}\n\n## Available Signals\n\n${signals}`;
}
