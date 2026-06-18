import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createStageLogger } from '../observability/logger.js';
import type { PostLabel } from './types.js';

const log = createStageLogger('workstream-b:validation-held-out');

const OUTPUT_DIR = 'data/schema';

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function main() {
  log.info('=== Validation: Held-Out Test ===');
  const startMs = Date.now();

  await mkdir(OUTPUT_DIR, { recursive: true });

  // Load updated labels
  const labelsRaw = await readFile(join(OUTPUT_DIR, 'posts-labeled.json'), 'utf-8');
  const allLabels: PostLabel[] = JSON.parse(labelsRaw);
  log.info({ totalLabels: allLabels.length }, 'Loaded labels');

  // Randomly split: 50 test, rest training
  const shuffled = shuffleArray(allLabels);
  const testSet = shuffled.slice(0, 50);
  const trainSet = shuffled.slice(50);

  log.info({ testSize: testSet.length, trainSize: trainSet.length }, 'Split into train/test');

  // Derive decision rules from training set:
  // For each content_type, find the most common visual_modality
  const contentTypeModalityMap = new Map<string, Map<string, number>>();
  for (const label of trainSet) {
    if (!contentTypeModalityMap.has(label.content_type)) {
      contentTypeModalityMap.set(label.content_type, new Map());
    }
    const modalityMap = contentTypeModalityMap.get(label.content_type)!;
    modalityMap.set(label.visual_modality, (modalityMap.get(label.visual_modality) ?? 0) + 1);
  }

  const rules: Record<string, { predicted_modality: string; training_count: number; total_for_type: number }> = {};
  for (const [contentType, modalityMap] of contentTypeModalityMap) {
    let bestModality = '';
    let bestCount = 0;
    let total = 0;
    for (const [modality, count] of modalityMap) {
      total += count;
      if (count > bestCount) {
        bestCount = count;
        bestModality = modality;
      }
    }
    rules[contentType] = {
      predicted_modality: bestModality,
      training_count: bestCount,
      total_for_type: total,
    };
  }

  log.info({ ruleCount: Object.keys(rules).length }, 'Decision rules derived');

  // Apply rules to test set
  let correct = 0;
  let total = 0;
  const predictions: Array<{
    post_id: string;
    content_type: string;
    actual_modality: string;
    predicted_modality: string;
    correct: boolean;
  }> = [];

  for (const label of testSet) {
    const rule = rules[label.content_type];
    const predicted = rule?.predicted_modality ?? 'unknown';
    const isCorrect = predicted === label.visual_modality;
    if (isCorrect) correct++;
    total++;

    predictions.push({
      post_id: label.post_id,
      content_type: label.content_type,
      actual_modality: label.visual_modality,
      predicted_modality: predicted,
      correct: isCorrect,
    });
  }

  const accuracy = total > 0 ? correct / total : 0;

  // Per-content-type accuracy
  const perTypeAccuracy: Record<string, { correct: number; total: number; accuracy_pct: number }> = {};
  for (const pred of predictions) {
    if (!perTypeAccuracy[pred.content_type]) {
      perTypeAccuracy[pred.content_type] = { correct: 0, total: 0, accuracy_pct: 0 };
    }
    perTypeAccuracy[pred.content_type].total++;
    if (pred.correct) perTypeAccuracy[pred.content_type].correct++;
  }
  for (const entry of Object.values(perTypeAccuracy)) {
    entry.accuracy_pct = Math.round((entry.correct / entry.total) * 10000) / 100;
  }

  const results = {
    generated_at: new Date().toISOString(),
    test_set_size: testSet.length,
    training_set_size: trainSet.length,
    overall_accuracy_pct: Math.round(accuracy * 10000) / 100,
    correct_predictions: correct,
    total_predictions: total,
    decision_rules: rules,
    per_content_type_accuracy: perTypeAccuracy,
    predictions,
    interpretation: accuracy >= 0.7
      ? `Strong baseline accuracy (${(accuracy * 100).toFixed(1)}%): the most-common-modality rule captures the dominant pattern well.`
      : accuracy >= 0.5
        ? `Moderate baseline accuracy (${(accuracy * 100).toFixed(1)}%): the taxonomy has meaningful variety within content types.`
        : `Low baseline accuracy (${(accuracy * 100).toFixed(1)}%): visual modality choices are diverse within content types, suggesting the mapping is not deterministic.`,
  };

  const outputPath = join(OUTPUT_DIR, 'held-out-validation.json');
  await writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');

  log.info(
    {
      overallAccuracy: results.overall_accuracy_pct + '%',
      correct,
      total,
      outputPath,
    },
    'Held-out validation complete',
  );

  const durationMs = Date.now() - startMs;
  log.info({ durationMs }, 'Validation complete');
}

main().catch((err) => {
  log.fatal(err, 'Held-out validation script failed');
  process.exit(1);
});
