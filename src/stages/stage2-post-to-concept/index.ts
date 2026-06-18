import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { computeSignals } from './signals.js';
import { evaluateRules } from './rule-engine.js';
import { generateConcepts } from './concept-generator.js';
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
  } = opts;

  log.info({ postId, postLength: postText.length }, 'Stage 2: Post to Concept');

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

  const result = await generateConcepts(postText, designSystem, schema, candidates);

  const subDir = postId ? join(outputDir, postId) : outputDir;
  await mkdir(subDir, { recursive: true });
  const outPath = join(subDir, 'concept_output.json');
  await writeFile(outPath, JSON.stringify(result, null, 2), 'utf-8');
  log.info({ outPath, selectedModality: result.concepts[result.selected]?.modality }, 'Concept output written');

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
