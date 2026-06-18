import Anthropic from '@anthropic-ai/sdk';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStageLogger } from '../observability/logger.js';
import { loadConfig } from '../config.js';
import { DACTISchemaSchema, type ExplorationResult, type DACTISchema } from './types.js';
import { callClaude, extractJson, sleep } from './utils.js';
import { PHASE2_SYSTEM, buildPhase2UserContent } from './prompts.js';

const log = createStageLogger('workstream-b:phase2');

/**
 * Phase 2: Schema Synthesis.
 * Consolidate free-form Phase 1 labels into a formal two-axis schema.
 */
export async function runPhase2(
  explorationResults: ExplorationResult[],
  outputDir: string,
): Promise<DACTISchema> {
  log.info({ resultCount: explorationResults.length }, 'Phase 2: Schema Synthesis');

  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const resultsText = JSON.stringify(explorationResults, null, 2);
  const userContent = buildPhase2UserContent(resultsText);

  let schema: DACTISchema | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await callClaude(client, {
        system: PHASE2_SYSTEM,
        userContent,
        label: 'phase2-synthesis',
        maxTokens: 8192,
      });

      const jsonStr = extractJson(response.text);
      const raw = JSON.parse(jsonStr) as Record<string, unknown>;

      // Add metadata
      raw.version = 'v0';
      raw.generated_at = new Date().toISOString();

      schema = DACTISchemaSchema.parse(raw);
      break;
    } catch (err) {
      log.warn({ attempt, err: err instanceof Error ? err.message : String(err) }, 'Synthesis parse failed, retrying');
      if (attempt === 1) throw err;
      await sleep(2000);
    }
  }

  if (!schema) throw new Error('Phase 2 failed to produce schema');

  log.info(
    {
      contentTypes: schema.content_types.length,
      visualModalities: schema.visual_modalities.length,
    },
    'Schema synthesized',
  );

  const outputPath = join(outputDir, 'schema-v0.json');
  await writeFile(outputPath, JSON.stringify(schema, null, 2), 'utf-8');
  log.info({ outputPath }, 'schema-v0 saved');

  return schema;
}
