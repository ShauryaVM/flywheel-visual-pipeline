import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeSignals } from '../src/stages/stage2-post-to-concept/signals.js';
import { evaluateRules } from '../src/stages/stage2-post-to-concept/rule-engine.js';
import { STRESS_TEST_CASES } from '../src/stress-test-suite.js';
import type { DecisionRulesData } from '../src/types/index.js';

const rulesPath = join(process.cwd(), 'data/schema/decision-rules.json');
const decisionRules = JSON.parse(readFileSync(rulesPath, 'utf-8')) as DecisionRulesData;

describe('Stress test signal routing', () => {
  const strictCases = STRESS_TEST_CASES.filter((c) => c.routing === 'strict');

  for (const testCase of strictCases) {
    it(`${testCase.id} routes toward ${testCase.expectedModality}`, () => {
      const signals = computeSignals(testCase.text);
      const candidates = evaluateRules(signals, decisionRules);
      const modalities = candidates.map((c) => c.modality);

      expect(
        modalities.includes(testCase.expectedModality),
        `Top candidates: ${modalities.join(', ')}. Signals: ${JSON.stringify(signals)}`,
      ).toBe(true);
    });
  }

  it('defines a stress case for every primary template', () => {
    const templates = new Set(STRESS_TEST_CASES.map((c) => c.expectedTemplate));
    const required = [
      'headline-subtext-card',
      'key-takeaway-card',
      'numbered-list-graphic',
      'bold-statement-card',
      'pull-quote-card',
      'quote-card',
      'infographic-stat-panel',
      'mafia-ecosystem',
      'feature-list-graphic',
      'stat-callout',
      'bar-chart',
      'line-sparkline',
      'pie-donut-chart',
    ];
    for (const template of required) {
      expect(templates.has(template), `Missing stress case for template ${template}`).toBe(true);
    }
  });
});
