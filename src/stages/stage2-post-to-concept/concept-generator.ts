import Anthropic from '@anthropic-ai/sdk';
import { ConceptGenerationOutput } from '../../schemas/concept.schema.js';
import type { VisualConcept } from '../../schemas/concept.schema.js';
import type { DesignSystemData, SchemaV1 } from '../../types/index.js';
import type { CandidateModality } from './rule-engine.js';
import type { PostSignals } from './signals.js';
import { loadConfig } from '../../config.js';
import { createStageLogger } from '../../observability/logger.js';

const log = createStageLogger('stage2:concept-generator');

// ---------------------------------------------------------------------------
// LIDA-inspired: enumerate visualization goals before concept generation
// ---------------------------------------------------------------------------
export async function enumerateVisualizationGoals(
  postText: string,
  signals: PostSignals,
): Promise<string[]> {
  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const signalSummary = [
    `Word count: ${signals.word_count}`,
    signals.has_numbers ? 'Contains numbers/data' : 'No numeric data',
    signals.has_list_structure ? 'Has list structure' : 'No list structure',
    signals.mentions_metric_or_stat ? 'Mentions metrics/stats' : 'No metrics',
    signals.mentions_person ? 'Mentions people' : 'No people mentioned',
  ].join(', ');

  const goalStart = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `You are an analytical assistant that extracts visualization goals from social media posts. Given a post, identify the 3-4 most impactful data points, narratives, or key messages that could be visually represented. Each goal should be a concise statement of WHAT to show visually. Return only a JSON array of strings.`,
    messages: [{
      role: 'user',
      content: `Analyze this LinkedIn post and extract 3-4 visualization goals (key narratives or data points worth highlighting visually).

Post signals: ${signalSummary}

Post:
---
${postText}
---

Return a JSON array of 3-4 strings, each describing one visualization goal. No markdown fences.`,
    }],
  });
  const goalLatency = Date.now() - goalStart;

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    log.warn('No text in goal enumeration response, skipping');
    return [];
  }

  try {
    const arrMatch = textBlock.text.match(/\[[\s\S]*\]/);
    if (!arrMatch) {
      log.warn('No JSON array found in goal response');
      return [];
    }
    const goals = JSON.parse(arrMatch[0]) as string[];
    log.info({ goalCount: goals.length, latencyMs: goalLatency }, 'Visualization goals enumerated');
    return goals;
  } catch {
    log.warn('Failed to parse goal enumeration response');
    return [];
  }
}

export interface ConceptGeneratorOptions {
  visualizationGoals?: string[];
  forceModality?: string;
  feedback?: {
    previousScores: Record<string, number>;
    critique: string;
    previousConcept?: string;
  };
}

export async function generateConcepts(
  postText: string,
  designSystem: DesignSystemData,
  schema: SchemaV1,
  candidates: CandidateModality[],
  options?: ConceptGeneratorOptions,
): Promise<{ concepts: VisualConcept[]; selected: number; selection_reasoning: string }> {
  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  log.info(
    { postLength: postText.length, candidates: candidates.map((c) => c.modality) },
    'Generating visual concepts',
  );

  const systemPrompt = buildSystemPrompt(designSystem, schema, candidates, options?.forceModality);
  const userPrompt = buildUserPrompt(postText, options?.visualizationGoals, options?.feedback);

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

  if (options?.visualizationGoals?.length) {
    for (const concept of validated.concepts) {
      concept.visualization_goals = options.visualizationGoals;
    }
  }

  if (options?.forceModality) {
    let idx = validated.concepts.findIndex((c) => c.modality === options.forceModality);
    if (idx < 0) {
      validated.concepts[0]!.modality = options.forceModality as VisualConcept['modality'];
      idx = 0;
    }
    validated.selected = idx;
    validated.selection_reasoning = `Stress test: forced modality ${options.forceModality}`;
    log.info({ forceModality: options.forceModality, selected: idx }, 'Modality forced for stress test');
  }

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
  forceModality?: string,
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
${forceModality ? `\n## STRESS TEST MODE\nThe selected concept MUST use modality "${forceModality}". At least one concept must use this modality and it must be the selected index.\n` : ''}

## All Available Modalities (fallback only)

You may use these modalities ONLY IF none of the candidates above fit the content. Strongly prefer the candidate modalities listed above:
- headline_subtext_card: Simple headline with supporting text
- key_takeaway_card: Single key insight or lesson in a card
- numbered_list_graphic: Ordered list of items (best for how-to, steps, rankings)
- bold_statement_card: Centered bold statement for punchy quotes or declarations
- pull_quote_card: Quote with attribution in a card container
- quote_card: Clean centered quote without card container
- multi_stat_panel: Multiple statistics in glass infographic cards (VALUE | LABEL format)
- mafia_ecosystem_graphic: Grid of company pills with favicons for ecosystem/mafia list posts
- feature_list_graphic: Bullet-point feature/benefit list
- stat_callout: Single hero statistic with supporting context
- attribution_quote_card: Quote with speaker attribution
- bar_chart: Horizontal/vertical bar chart for comparing values (use when post compares 2-5 quantities)
- line_sparkline: Trend line chart for data over time (use when post describes growth, trends, changes)
- pie_donut_chart: Pie/donut chart for proportional data (use when post describes shares, percentages, distributions)

IMPORTANT MODALITY SELECTION RULES (follow strictly):
- If the post contains QUANTITATIVE COMPARISONS (X vs Y, A is better than B by N%), use bar_chart.
- If the post mentions GROWTH/TRENDS over time, use line_sparkline.
- If the post describes PROPORTIONS/SHARES/DISTRIBUTIONS, use pie_donut_chart.
- If the post is an ECOSYSTEM/MAFIA list (numbered companies with funding stats), use mafia_ecosystem_graphic.
- If the post contains 3+ distinct metrics/statistics, use multi_stat_panel.
- If the post highlights ONE hero statistic with context, use stat_callout.
- If the post is a NUMBERED LIST of tips/lessons/steps, use numbered_list_graphic.
- If the post is a FEATURE LIST or benefits, use feature_list_graphic.
- If the post is a STRONG OPINION or hot take (short, punchy), use bold_statement_card.
- If the post quotes someone with attribution, use attribution_quote_card or pull_quote_card.
- If the post is a simple headline + context, use headline_subtext_card.
Do NOT default to bold_statement_card or headline_subtext_card when a more specific modality fits. Prefer chart modalities for data-heavy posts. Each concept in your output MUST use a DIFFERENT modality.

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
8. For mafia_ecosystem_graphic: data_points use "Company | stat | domain.com" (optional leading "N/" index). Limit to 8 items max for the canvas.
9. For feature_list_graphic: data_points should be short feature descriptions (under 10 words each).
10. The accent color (${designSystem.colors.accent.hex}) is for thin accent bars, borders, and shadows ONLY. Never as text color or large fill.
11. ALL concepts must use light backgrounds. No dark/black backgrounds.
12. Design with editorial restraint: every element must earn its place on the canvas.

## Chart Modalities (ONLY for data-heavy posts)

ONLY use chart modalities (bar_chart, line_sparkline, pie_donut_chart) when the post contains ACTUAL NUMERIC DATA with specific values to chart. Do NOT fabricate data for opinion posts or abstract statements. If a post says "distribution problem" as a metaphor (not actual data distribution), do NOT use pie_donut_chart. Chart modalities require real, chartable numbers from the post. When used, include a "chart_data" array with {label, value} objects.

## Layout Specification (optional, encouraged for varied compositions)

For any concept, you may include a "layout_spec" object to guide spatial arrangement:
- headline_position: where the headline sits (e.g. "top-left at 15% from top")
- stat_position: where key stats appear (e.g. "center-right at 60% from left")
- accent_placement: decorative accent placement (e.g. "left edge vertical bar")
- whitespace_distribution: how space is allocated (e.g. "60% right, 20% top, 20% bottom")
- emphasis_area: where visual weight concentrates
- flex_direction: "row" | "column" | "row-reverse" | "column-reverse"
- alignment: "start" | "center" | "end" | "space-between"
- padding_distribution: {top, right, bottom, left} as CSS values

## Layout Protocol (optional, for custom compositions)

For highly custom layouts that don't fit standard templates, include "layout_protocol" with:
- canvas: {width: 1200, height: 630, background: "<color>"}
- elements: array of {type, content, position: {x, y}, size: {width, height}, style?: {...}, zIndex?}
  Element types: headline, subtext, stat, chart, accent, logo, watermark, decorative

When layout_protocol is present, the renderer uses absolute CSS positioning instead of templates.

## Output Format

Return a single JSON object (no markdown fences, no extra text):

{
  "concepts": [
    {
      "modality": "<from candidate modalities>",
      "headline": "<main text, under 10 words, sentence case, end with period>",
      "subtext": "<supporting text, under 25 words>",
      "data_points": ["<stat or list item>", "..."],
      "chart_data": [{"label": "<category>", "value": <number>}],
      "layout_description": "<how elements are arranged, referencing layout patterns>",
      "layout_spec": { ... },
      "color_usage": "<specific design system colors>",
      "reasoning": "<why this concept fits the brand aesthetic>"
    }
  ],
  "selected": <index of best concept, 0-based>,
  "selection_reasoning": "<why this one best embodies the brand's visual identity>"
}

Notes:
- "chart_data" is required for bar_chart, line_sparkline, and pie_donut_chart modalities only.
- "layout_spec" is optional but encouraged for varied compositions.
- "layout_protocol" is optional, only for truly custom layouts.
- Generate exactly 2-3 concepts using different modalities. Select the single best one.`;
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

function buildUserPrompt(postText: string, visualizationGoals?: string[], feedback?: ConceptGeneratorOptions['feedback']): string {
  let prompt = `Generate visual concepts for this LinkedIn post:

---
${postText}
---`;

  if (feedback) {
    const scoreStr = Object.entries(feedback.previousScores)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    prompt += `

## REGENERATION CONTEXT (CRITICAL — address these issues)

The previous visual scored poorly and needs improvement.
Previous scores: ${scoreStr}
Critique: ${feedback.critique}
${feedback.previousConcept ? `Previous concept headline: "${feedback.previousConcept}"` : ''}

Generate an IMPROVED concept that specifically addresses the critique above. Focus on fixing the weakest scoring dimensions while maintaining the strongest ones.`;
  }

  if (visualizationGoals?.length) {
    prompt += `

## Pre-analyzed Visualization Goals

The following key narratives/data points have been identified as most impactful for visual representation:
${visualizationGoals.map((g, i) => `${i + 1}. ${g}`).join('\n')}

Use these goals to inform your concept generation. Ensure your data_points and chart_data align with these identified narratives.`;
  }

  prompt += `

Return only the JSON object. No markdown code fences. No additional commentary.`;

  return prompt;
}
