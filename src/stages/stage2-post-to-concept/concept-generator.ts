import Anthropic from '@anthropic-ai/sdk';
import { ConceptGenerationOutput } from '../../schemas/concept.schema.js';
import type { VisualConcept } from '../../schemas/concept.schema.js';
import type { DesignSystemData, SchemaV1 } from '../../types/index.js';
import type { CandidateModality } from './rule-engine.js';
import { loadConfig } from '../../config.js';
import { createStageLogger } from '../../observability/logger.js';

const log = createStageLogger('stage2:concept-generator');

export async function generateConcepts(
  postText: string,
  designSystem: DesignSystemData,
  schema: SchemaV1,
  candidates: CandidateModality[],
): Promise<{ concepts: VisualConcept[]; selected: number; selection_reasoning: string }> {
  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  log.info(
    { postLength: postText.length, candidates: candidates.map((c) => c.modality) },
    'Generating visual concepts',
  );

  const systemPrompt = buildSystemPrompt(designSystem, schema, candidates);
  const userPrompt = buildUserPrompt(postText);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from LLM');
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in LLM response: ${textBlock.text.substring(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  const validated = ConceptGenerationOutput.parse(parsed);

  log.info(
    {
      conceptCount: validated.concepts.length,
      selectedModality: validated.concepts[validated.selected]?.modality,
    },
    'Concepts generated and validated',
  );

  return validated;
}

function buildSystemPrompt(
  designSystem: DesignSystemData,
  schema: SchemaV1,
  candidates: CandidateModality[],
): string {
  const candidateModalities = candidates.map((c) => {
    const modalityDef = schema.visual_modalities.find((m) => m.name === c.modality);
    return {
      modality: c.modality,
      confidence: c.confidence,
      display_name: modalityDef?.display_name ?? c.modality,
      definition: modalityDef?.definition ?? '',
      renderability_spec: modalityDef?.renderability_spec ?? '',
    };
  });

  return `You are a senior visual content designer for Flywheel, a B2B SaaS company. Given a LinkedIn post and brand design system, you propose 2-3 visual concepts as structured JSON.

## Brand Design System (Key Tokens)

Colors:
- Primary text: ${designSystem.colors.primary.hex} (black)
- Secondary text: ${designSystem.colors.secondary.hex}
- Accent (electric chartreuse): ${designSystem.colors.accent.hex}
- Background (warm off-white): #faf9f6, #f0efe9
- Dark backgrounds for impact: #111111, #1a1a1a
- Warm border/shadow: #d7c8af
- Muted text grays: #555, #666, #888

Typography:
- Heading font: Inter, weights 500-700
- Body font: Inter, weight 400
- Mono font: DM Mono
- Large headlines: 48-72px on a 1200px canvas
- Body text: 16-20px
- Letter spacing: tight (-0.025em to -0.04em) for headlines

Spacing:
- Border radius: 6px (primary), 8px (cards)
- Generous padding: 48-80px on cards
- Canvas size: 1200x630px (LinkedIn image)

## Candidate Visual Modalities

These modalities were selected by signal analysis as the best fits:

${JSON.stringify(candidateModalities, null, 2)}

## CRITICAL CONSTRAINTS

1. Do NOT use em dashes (--) or (\\u2014) ANYWHERE in any text content. Use commas, periods, or colons instead.
2. Headlines MUST be under 10 words.
3. Subtext MUST be under 25 words.
4. Data points must be real numbers/facts from the post, never invented.
5. The visual must work at 1200x630px (LinkedIn image dimensions, landscape).
6. Use the chartreuse accent (#e6ff00) strategically as highlight/accent, NOT as a background.
7. All text must be concise and punchy. No filler words.

## Output Format

Return a single JSON object (no markdown fences, no extra text):

{
  "concepts": [
    {
      "modality": "<from candidate modalities>",
      "headline": "<main text, under 10 words>",
      "subtext": "<supporting text, under 25 words>",
      "data_points": ["<stat or list item>", "..."],
      "layout_description": "<how elements are arranged>",
      "color_usage": "<which design system colors to use>",
      "reasoning": "<why this concept fits>"
    }
  ],
  "selected": <index of best concept, 0-based>,
  "selection_reasoning": "<why this one was picked>"
}

Generate exactly 2-3 concepts using different modalities from the candidates. Then select the single best one.`;
}

function buildUserPrompt(postText: string): string {
  return `Generate visual concepts for this LinkedIn post:

---
${postText}
---

Return only the JSON object. No markdown code fences. No additional commentary.`;
}
