import Anthropic from '@anthropic-ai/sdk';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStageLogger } from '../observability/logger.js';
import { loadConfig } from '../config.js';
import {
  RefinementResponseSchema,
  DACTISchemaSchema,
  type EnrichedPost,
  type DACTISchema,
} from './types.js';
import {
  stratifiedSample,
  callClaude,
  extractJson,
  formatPostForPrompt,
  sleep,
} from './utils.js';
import {
  PHASE3_SYSTEM,
  PHASE3_APPLY_MODS_SYSTEM,
  buildPhase3UserContent,
} from './prompts.js';

const log = createStageLogger('workstream-b:phase3');

/**
 * Phase 3: Iterative Refinement.
 * Classify new posts with the schema, identify gaps, refine.
 */
export async function runPhase3(
  enrichedPosts: EnrichedPost[],
  currentSchema: DACTISchema,
  usedPostIds: Set<string>,
  outputDir: string,
): Promise<{ schema: DACTISchema; usedPostIds: Set<string> }> {
  log.info('Phase 3: Iterative Refinement');

  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  let schema = currentSchema;
  const allUsedIds = new Set(usedPostIds);
  let round = 0;
  const maxRounds = 2;

  while (round < maxRounds) {
    round++;
    log.info({ round }, 'Refinement round');

    const sample = stratifiedSample(enrichedPosts, 30, allUsedIds);
    if (sample.length < 10) {
      log.warn({ available: sample.length }, 'Not enough new posts for refinement, stopping');
      break;
    }

    for (const p of sample) allUsedIds.add(p.id);

    const postTexts = sample.map((p, i) => formatPostForPrompt(p, i)).join('\n\n---\n\n');
    const schemaText = JSON.stringify(schema, null, 2);
    const userContent = buildPhase3UserContent(schemaText, postTexts);

    let highConfCount = 0;
    let totalClassified = 0;

    try {
      const response = await callClaude(client, {
        system: PHASE3_SYSTEM,
        userContent,
        label: `phase3-round-${round}`,
        maxTokens: 8192,
      });

      const jsonStr = extractJson(response.text);
      const parsed = RefinementResponseSchema.parse(JSON.parse(jsonStr));

      totalClassified = parsed.classifications.length;
      highConfCount = parsed.classifications.filter((c) => c.confidence === 'high').length;

      const highConfPct = totalClassified > 0 ? (highConfCount / totalClassified) * 100 : 0;
      log.info(
        {
          classified: totalClassified,
          highConf: highConfCount,
          highConfPct: highConfPct.toFixed(1),
          modifications: parsed.modifications.length,
        },
        'Refinement round results',
      );

      // Apply modifications that have strong support
      const modCounts = new Map<string, number>();
      for (const mod of parsed.modifications) {
        const key = `${mod.action}::${mod.target}::${mod.axis}`;
        modCounts.set(key, (modCounts.get(key) ?? 0) + 1);
      }

      const significantMods = parsed.modifications.filter((mod) => {
        const key = `${mod.action}::${mod.target}::${mod.axis}`;
        return (modCounts.get(key) ?? 0) >= 1; // Lower threshold since each mod appears once
      });

      if (significantMods.length > 0) {
        log.info({ modCount: significantMods.length }, 'Applying schema modifications');
        schema = await applyModifications(client, schema, significantMods);
      }

      const versionName = `schema-v${round}`;
      schema = { ...schema, version: `v${round}`, generated_at: new Date().toISOString() };
      const outputPath = join(outputDir, `${versionName}.json`);
      await writeFile(outputPath, JSON.stringify(schema, null, 2), 'utf-8');
      log.info({ outputPath, version: versionName }, 'Refined schema saved');

      // Check convergence
      if (highConfPct > 85) {
        log.info({ highConfPct: highConfPct.toFixed(1) }, 'Convergence reached, stopping refinement');
        break;
      }
    } catch (err) {
      log.error({ round, err: err instanceof Error ? err.message : String(err) }, 'Refinement round failed');
    }

    if (round < maxRounds) await sleep(2000);
  }

  return { schema, usedPostIds: allUsedIds };
}

async function applyModifications(
  client: Anthropic,
  schema: DACTISchema,
  modifications: Array<{ action: string; target: string; axis: string; rationale: string; proposed_change: string }>,
): Promise<DACTISchema> {
  const schemaText = JSON.stringify(schema, null, 2);
  const modsText = JSON.stringify(modifications, null, 2);

  const response = await callClaude(client, {
    system: PHASE3_APPLY_MODS_SYSTEM,
    userContent: `## Current Schema\n\n${schemaText}\n\n## Proposed Modifications\n\n${modsText}`,
    label: 'phase3-apply-mods',
    maxTokens: 8192,
  });

  const jsonStr = extractJson(response.text);
  const raw = JSON.parse(jsonStr) as Record<string, unknown>;
  raw.version = schema.version;
  raw.generated_at = new Date().toISOString();

  return DACTISchemaSchema.parse(raw);
}
