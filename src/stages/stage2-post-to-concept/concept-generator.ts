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

  const llmStart = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const llmLatency = Date.now() - llmStart;

  log.info({ model: 'claude-sonnet-4-6', latencyMs: llmLatency }, 'LLM call');

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
      selectionReasoning: validated.selection_reasoning,
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

  const dsAny = designSystem as unknown as Record<string, unknown>;
  const portfolio = dsAny.design_portfolio as Record<string, unknown> | undefined;
  const brandIdentity = dsAny.brand_identity as
    | { name?: string; url?: string; tagline?: string; logo_text?: string; description?: string }
    | undefined;

  const brandName = brandIdentity?.name || 'the brand';
  const brandUrl = brandIdentity?.url || '';
  const brandDescription = brandIdentity?.description || '';

  const tone = (portfolio?.tone as Record<string, unknown>)?.description as string
    || 'Editorial, premium, restrained, intellectual.';
  const toneAnalogies = ((portfolio?.tone as Record<string, unknown>)?.analogies as string[])
    || [];

  const compositionRules = (portfolio?.composition_rules as string[]) || [];
  const prohibitions = (portfolio?.prohibitions as string[]) || [];

  const visualDensity = portfolio?.visual_density as Record<string, unknown> | undefined;
  const densityConstraints = (visualDensity?.constraints as string[]) || [];

  const motifs = portfolio?.motifs as Record<string, Record<string, unknown>> | undefined;
  const motifDescriptions = motifs
    ? Object.entries(motifs).map(([key, val]) => `- **${key.replace(/_/g, ' ')}:** ${val.description || ''}`)
    : [];

  const layoutPatterns = portfolio?.layout_patterns as Record<string, Record<string, unknown>> | undefined;
  const layoutDescriptions = layoutPatterns
    ? Object.entries(layoutPatterns).map(([key, val]) => `- **${key.replace(/_/g, ' ')}:** ${val.description || ''}`)
    : [];

  const typographySection = buildTypographySection(designSystem);

  return `You are a senior visual content designer creating LinkedIn post graphics for ${brandName}${brandUrl ? ` (${brandUrl})` : ''}. You propose 2-3 visual concepts as structured JSON.
${brandDescription ? `\nBrand: ${brandDescription}\n` : ''}
## Design Philosophy

${portfolio?.philosophy ?? `${brandName}'s visual identity values clarity, precision, and restraint.`}

${tone ? `Tone: ${tone}` : ''}
${toneAnalogies.length > 0 ? `Think: ${toneAnalogies.join(', ')}.` : ''}

## Composition Rules (CRITICAL)

${compositionRules.length > 0
  ? compositionRules.map((r, i) => `${i + 1}. ${r}`).join('\n')
  : `1. 60%+ negative space. The canvas must breathe.
2. Maximum 3 focal elements per graphic.
3. Generous gaps between content blocks.
4. Maintain padding from all canvas edges.`}

## Visual Density

${visualDensity?.description || 'Keep layouts sparse and purposeful.'}
${densityConstraints.length > 0 ? densityConstraints.map((c) => `- ${c}`).join('\n') : ''}

## Signature Motifs

${motifDescriptions.length > 0 ? motifDescriptions.join('\n') : '- Brand-appropriate decorative elements at low opacity as background texture.'}

## Design System Tokens

Colors:
- Primary/text: ${designSystem.colors.primary.hex}
- Secondary: ${designSystem.colors.secondary.hex}
- Accent: ${designSystem.colors.accent.hex} — for accent bars, borders, box-shadows ONLY
- Background: ${designSystem.colors.background.hex}
- Text: ${designSystem.colors.text.hex}

${typographySection}

Layout (1200x630px canvas):
- Generous padding: 48-80px
- Border-radius from design system

## PROHIBITIONS

${prohibitions.length > 0
  ? prohibitions.map((p) => `- ${p}`).join('\n')
  : `- NO gradients on text.
- NO busy or cluttered layouts.
- NO dark/black backgrounds for full cards.`}

## Candidate Visual Modalities (Preferred)

${JSON.stringify(candidateModalities, null, 2)}

## All Available Modalities

You may also use these modalities if they are a better fit for the content:
- headline_subtext_card: Simple headline with supporting text
- key_takeaway_card: Single key insight or lesson in a card
- numbered_list_graphic: Ordered list of items (best for how-to, steps, rankings)
- bold_statement_card: Centered bold statement for punchy quotes or declarations
- pull_quote_card: Quote with attribution in a card container
- quote_card: Clean centered quote without card container
- multi_stat_panel: Multiple statistics displayed in tiles
- feature_list_graphic: Bullet-point feature/benefit list
- stat_callout: Single hero statistic with supporting context
- attribution_quote_card: Quote with speaker attribution

IMPORTANT: Choose the modality that genuinely fits the content best. If the post contains a quote, use quote_card or attribution_quote_card. If it highlights a single hero statistic, use stat_callout. If it makes a bold declaration, use bold_statement_card. Do NOT default to multi_stat_panel or numbered_list_graphic unless the content truly warrants multiple stats or an ordered list.

## Layout Patterns to Reference

${layoutDescriptions.length > 0 ? layoutDescriptions.join('\n') : `- **Left-anchored hero:** Heading left-aligned, right side for decorative elements or empty space.
- **Centered statement:** Single bold statement centered, optional brand watermark behind at low opacity.
- **Structured data:** Left heading, right data grid or vertical list.
- **Stacked list:** Heading at top, vertically stacked items with consistent spacing.`}

## CRITICAL CONSTRAINTS

1. Do NOT use em dashes in ANY form: no \u2014, no \u2013, no &mdash;, no &ndash;, no "--". Replace with commas, periods, colons, or two short sentences.
2. Headlines MUST be under 10 words: punchy, direct, no filler.
3. **Headline formatting (MANDATORY):** Use sentence case only. Capitalize the first word and proper nouns only, never title case. End statements with a period. Examples: "The volume gap is 1,000%." / "Seven free Google AI courses with certificates." / "900 stars in 48 hours." Never: "The Volume Gap Is 1,000%" or "7 Free Google AI Courses". Spell out numbers under 10 at the start of a headline.
4. Subtext MUST be under 25 words, also sentence case with a period.
5. Data points must be real facts/numbers from the post, never invented.
6. For numbered_list_graphic: data_points should be concise items (under 12 words each). Limit to 7 items max.
7. For multi_stat_panel: data_points should use "VALUE | LABEL" format (e.g. "900+ | GitHub Stars").
8. For feature_list_graphic: data_points should be short feature descriptions (under 10 words each).
9. The accent color (${designSystem.colors.accent.hex}) is for thin accent bars, borders, and shadows ONLY. Never as text color or large fill.
10. ALL concepts must use light backgrounds. No dark/black backgrounds.
11. Design with editorial restraint: every element must earn its place on the canvas.

## Output Format

Return a single JSON object (no markdown fences, no extra text):

{
  "concepts": [
    {
      "modality": "<from candidate modalities>",
      "headline": "<main text, under 10 words, sentence case, end with period>",
      "subtext": "<supporting text, under 25 words>",
      "data_points": ["<stat or list item>", "..."],
      "layout_description": "<how elements are arranged, referencing layout patterns>",
      "color_usage": "<specific design system colors>",
      "reasoning": "<why this concept fits the brand aesthetic>"
    }
  ],
  "selected": <index of best concept, 0-based>,
  "selection_reasoning": "<why this one best embodies the brand's visual identity>"
}

Generate exactly 2-3 concepts using different modalities. Select the single best one.`;
}

function buildTypographySection(designSystem: DesignSystemData): string {
  const fonts = designSystem.typography?.font_families || [];
  const primaryFont = fonts[0]?.family || 'system default';
  const monoFont = fonts.find((f) => f.family.toLowerCase().includes('mono'))?.family;

  const lines = [`Typography:`];
  lines.push(`- Primary: ${primaryFont} (${fonts[0]?.weights?.join(', ') || '400'})`);
  if (monoFont) {
    lines.push(`- Mono: ${monoFont} — for stats, data, technical labels`);
  }

  const scale = designSystem.typography?.scale;
  if (scale?.h1) {
    lines.push(`- Headlines: ${scale.h1.font_size}, weight ${scale.h1.font_weight}`);
  }
  if (scale?.body) {
    lines.push(`- Body: ${scale.body.font_size}, weight ${scale.body.font_weight}`);
  }

  return lines.join('\n');
}

function buildUserPrompt(postText: string): string {
  return `Generate visual concepts for this LinkedIn post:

---
${postText}
---

Return only the JSON object. No markdown code fences. No additional commentary.`;
}
