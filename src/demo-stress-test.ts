import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runPipeline } from './index.js';
import { STRESS_TEST_CASES } from './stress-test-suite.js';
import { computeSignals } from './stages/stage2-post-to-concept/signals.js';
import { evaluateRules } from './stages/stage2-post-to-concept/rule-engine.js';
import { MODALITY_TEMPLATE_MAP } from './schemas/concept.schema.js';
import { createStageLogger } from './observability/logger.js';
import type { DecisionRulesData } from './types/index.js';

const log = createStageLogger('demo:stress');

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'max-cases': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

function printHelp(): void {
  console.log(`
Visual modality stress test

Runs ${STRESS_TEST_CASES.length} posts across different startup URLs.
Each case forces a distinct visual modality so you can inspect every template.

Usage:
  npm run demo:stress
  npm run demo:stress -- --dry-run
  npm run demo:stress -- --max-cases 3

Options:
  --dry-run     Print routing matrix only (no API calls, no crawls)
  --max-cases   Limit how many full pipeline runs to execute
  --help        Show this help
`);
}

async function main(): Promise<void> {
  if (values.help) {
    printHelp();
    return;
  }

  const rules = JSON.parse(
    readFileSync(join(process.cwd(), 'data/schema/decision-rules.json'), 'utf-8'),
  ) as DecisionRulesData;

  const maxCases = values['max-cases'] ? parseInt(String(values['max-cases']), 10) : STRESS_TEST_CASES.length;
  const cases = STRESS_TEST_CASES.slice(0, maxCases);

  console.log('\n========== STRESS TEST ROUTING MATRIX ==========\n');
  console.log('id | startup | expected | template | rule hit | url');
  console.log('---|---------|----------|----------|----------|----');

  for (const testCase of cases) {
    const signals = computeSignals(testCase.text);
    const candidates = evaluateRules(signals, rules);
    const ruleHit = candidates.some((c) => c.modality === testCase.expectedModality) ? 'yes' : 'force';
    const template = MODALITY_TEMPLATE_MAP[testCase.expectedModality] ?? testCase.expectedTemplate;
    console.log(
      `${testCase.id} | ${testCase.startup} | ${testCase.expectedModality} | ${template} | ${ruleHit} | ${testCase.targetUrl}`,
    );
  }

  if (values['dry-run']) {
    console.log(`\nDry run complete. ${cases.length} cases listed. Remove --dry-run to generate visuals.\n`);
    return;
  }

  console.log('\n========== GENERATING VISUALS ==========\n');

  const results: Array<{
    id: string;
    startup: string;
    expectedModality: string;
    actualModality?: string;
    targetUrl: string;
    pngPath?: string;
    success: boolean;
    error?: string;
  }> = [];

  for (const testCase of cases) {
    log.info(
      { id: testCase.id, startup: testCase.startup, modality: testCase.expectedModality },
      'Running stress case',
    );

    try {
      const result = await runPipeline({
        postText: testCase.text,
        targetUrl: testCase.targetUrl,
        postId: testCase.id,
        outputDir: 'data/outputs',
        forceModality: testCase.expectedModality,
      });

      const actual = result.selectedConcept.modality;
      const ok = actual === testCase.expectedModality;
      results.push({
        id: testCase.id,
        startup: testCase.startup,
        expectedModality: testCase.expectedModality,
        actualModality: actual,
        targetUrl: testCase.targetUrl,
        pngPath: result.pngPath,
        success: ok,
      });

      console.log(
        `${ok ? '[OK]' : '[MISMATCH]'} ${testCase.id} (${testCase.startup}) → ${actual} | ${result.pngPath}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        id: testCase.id,
        startup: testCase.startup,
        expectedModality: testCase.expectedModality,
        targetUrl: testCase.targetUrl,
        success: false,
        error: message,
      });
      console.log(`[FAIL] ${testCase.id} (${testCase.startup}): ${message}`);
    }
  }

  const passed = results.filter((r) => r.success).length;
  const templates = new Set(
    results.filter((r) => r.actualModality).map((r) => MODALITY_TEMPLATE_MAP[r.actualModality!] ?? r.actualModality),
  );

  console.log('\n========== SUMMARY ==========\n');
  console.log(`${passed}/${results.length} cases produced the expected modality.`);
  console.log(`Distinct templates rendered: ${templates.size}`);
  console.log([...templates].join(', '));
  console.log('\nOutputs: data/outputs/stress-*\n');
}

main().catch((err) => {
  log.fatal(err, 'Stress test failed');
  process.exit(1);
});
