import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../../config.js';
import { createStageLogger } from '../../observability/logger.js';
import { traceGeneration } from '../../observability/tracer.js';
import type { EvalScore } from '../../types/index.js';

const log = createStageLogger('stage4:judge');

const SCORE_THRESHOLD = 7.0;

/**
 * Use an LLM to judge the quality of a rendered visual.
 *
 * Scores on four dimensions (1-10 each):
 *   - On-brand: Does it match the design system?
 *   - Legible: Is text readable and well-sized?
 *   - Clear hierarchy: Is visual hierarchy obvious?
 *   - Not generic: Does it feel custom, not templated?
 */
export async function judgeVisual(
  html: string,
  postText: string,
  designSystemSummary: string,
): Promise<EvalScore> {
  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const trace = traceGeneration('visual-evaluation');

  log.info('Evaluating visual quality');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          `## Original Post\n${postText}`,
          `## Design System Summary\n${designSystemSummary}`,
          `## Rendered HTML\n\`\`\`html\n${html}\n\`\`\``,
          '',
          'Score this visual. Return JSON with: onBrand, legible, clearHierarchy, notGeneric (each 1-10), critique (string).',
        ].join('\n\n'),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from judge LLM');
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in judge response');
  }

  const raw = JSON.parse(jsonMatch[0]) as {
    onBrand: number;
    legible: number;
    clearHierarchy: number;
    notGeneric: number;
    critique: string;
  };

  const overall = (raw.onBrand + raw.legible + raw.clearHierarchy + raw.notGeneric) / 4;

  const score: EvalScore = {
    onBrand: raw.onBrand,
    legible: raw.legible,
    clearHierarchy: raw.clearHierarchy,
    notGeneric: raw.notGeneric,
    overall,
    critique: raw.critique,
    passesThreshold: overall >= SCORE_THRESHOLD,
  };

  trace.end();
  log.info(
    { overall: score.overall, passes: score.passesThreshold },
    'Evaluation complete',
  );

  return score;
}

const JUDGE_SYSTEM_PROMPT = `You are a visual design quality judge. You evaluate LinkedIn-style visual content cards.

Score each dimension from 1 (worst) to 10 (best):
- onBrand: Does the visual match the brand's design system (colors, fonts, spacing)?
- legible: Is all text readable with appropriate sizing and contrast?
- clearHierarchy: Is there a clear visual hierarchy guiding the reader's eye?
- notGeneric: Does it feel custom and branded, not like a generic template?

Return a JSON object with those four numeric scores and a "critique" string with specific, actionable feedback.`;
