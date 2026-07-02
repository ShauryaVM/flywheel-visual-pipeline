import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { computeSignals } from './signals.js';
import { evaluateRules } from './rule-engine.js';
import { generateConcepts, enumerateVisualizationGoals, type ConceptGeneratorOptions } from './concept-generator.js';
import { createStageLogger } from '../../observability/logger.js';
import type {
  DesignSystemData,
  SchemaV1,
  DecisionRulesData,
} from '../../types/index.js';
import type { ConceptGenerationOutput } from '../../schemas/concept.schema.js';

const log = createStageLogger('stage2');

export interface Stage2Input {
  postText: string;
  postId?: string;
  designSystemPath?: string;
  schemaPath?: string;
  decisionRulesPath?: string;
  outputDir?: string;
  feedback?: ConceptGeneratorOptions['feedback'];
  forceModality?: string;
}

export async function runStage2(
  postText: string,
  opts: Partial<Stage2Input> = {},
): Promise<ConceptGenerationOutput> {
  const {
    postId,
    designSystemPath = 'data/design-system.json',
    schemaPath = 'data/schema/schema-v1.json',
    decisionRulesPath = 'data/schema/decision-rules.json',
    outputDir = 'data/outputs',
    feedback,
    forceModality,
  } = opts;

  log.info(
    { postText: postText.substring(0, 100), postId },
    'Input',
  );

  const [dsRaw, schemaRaw, rulesRaw] = await Promise.all([
    readFile(designSystemPath, 'utf-8'),
    readFile(schemaPath, 'utf-8'),
    readFile(decisionRulesPath, 'utf-8'),
  ]);

  const designSystem: DesignSystemData = JSON.parse(dsRaw);
  const schema: SchemaV1 = JSON.parse(schemaRaw);
  const decisionRules: DecisionRulesData = JSON.parse(rulesRaw);

  const signals = computeSignals(postText);
  log.info({ signals }, 'Phase 0 signals computed');

  const candidates = evaluateRules(signals, decisionRules);
  log.info(
    { candidates: candidates.map((c) => `${c.modality}(${c.confidence})`) },
    'Candidate modalities from rules',
  );

  // LIDA-inspired: enumerate visualization goals before concept generation
  const visualizationGoals = await enumerateVisualizationGoals(postText, signals);
  log.info({ goals: visualizationGoals }, 'Visualization goals enumerated');

  const result = await generateConcepts(postText, designSystem, schema, candidates, {
    visualizationGoals,
    feedback,
    forceModality,
  });

  const selectedConcept = result.concepts[result.selected];
  log.info(
    {
      concepts: result.concepts.length,
      selected: selectedConcept?.modality,
      headline: selectedConcept?.headline,
    },
    'Output',
  );

  const subDir = postId ? join(outputDir, postId) : outputDir;
  await mkdir(subDir, { recursive: true });
  const outPath = join(subDir, 'concept_output.json');
  await writeFile(outPath, JSON.stringify(result, null, 2), 'utf-8');
  log.info({ outPath, selectedModality: selectedConcept?.modality }, 'Concept output written');

  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const samplePost =
    process.argv[2] ?? 'Building great products requires consistency and deep focus.';
  runStage2(samplePost).catch((err) => {
    log.fatal(err, 'Stage 2 failed');
    process.exit(1);
  });
}
