import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createStageLogger } from '../observability/logger.js';
import { loadConfig } from '../config.js';
import { InspPostSchema, type InspPost, type PostLabel, type DACTISchema } from './types.js';
import { batchArray, callClaude, extractJson, sleep } from './utils.js';

const log = createStageLogger('workstream-b:refinement-split-quote-card');

const OUTPUT_DIR = 'data/schema';
const POSTS_PATH = 'data/posts/inspiration-posts-300.json';

const QUOTE_CARD_SUB_TYPES = [
  'pull_quote_card',
  'headline_subtext_card',
  'attribution_quote_card',
  'bold_statement_card',
  'key_takeaway_card',
  'quote_card',
] as const;

const SUB_TYPE_DEFINITIONS: Record<string, { display_name: string; definition: string; inclusion_criteria: string[]; renderability_spec: string }> = {
  pull_quote_card: {
    display_name: 'Pull Quote Card',
    definition: 'A card featuring a single powerful sentence or short statement with large typographic emphasis. Used for one-liner hot takes, bold declarations, and punchy standalone messages.',
    inclusion_criteria: [
      'Post centers on a single memorable sentence or phrase',
      'No attribution to a specific named person is present',
      'Content is a hot take, bold declaration, or punchy one-liner',
      'Minimal supporting context - the statement stands alone',
    ],
    renderability_spec: 'Centered flex container with the statement in bold display font at 28-40px. No attribution line. Background uses a solid brand color or gradient. Optional large decorative quotation marks. Max width 600px with generous padding.',
  },
  headline_subtext_card: {
    display_name: 'Headline + Subtext Card',
    definition: 'A card with a prominent title or headline followed by 1-2 supporting context lines below. Used for announcements, news summaries, and key takeaways that need brief elaboration.',
    inclusion_criteria: [
      'Post has a clear headline or title-worthy statement',
      'One or two supporting lines provide context or elaboration',
      'Content is an announcement, news summary, or key takeaway',
      'The structure is hierarchical: primary message + secondary context',
    ],
    renderability_spec: 'Vertical flex container. Headline in bold 24-32px at top. Subtext in regular 14-16px below with muted color. Optional category label or date badge above headline. Thin accent line separating headline from subtext. Max width 600px.',
  },
  attribution_quote_card: {
    display_name: 'Attribution Quote Card',
    definition: 'A quote or statement explicitly attributed to a specific person with their name and optionally their role or organization. Used for testimonials, lessons from named individuals, and "someone said X" patterns.',
    inclusion_criteria: [
      'Post contains a quote or statement attributed to a named person',
      'Attribution includes at least a name, often with role or company',
      'The quoted person may or may not be the post author',
      'Content is a testimonial, lesson, or notable statement from a specific individual',
    ],
    renderability_spec: 'Centered flex container with large blockquote in serif or bold font at 24-36px. Attribution line below with name in bold and role in muted smaller type. Large decorative quotation mark in accent color. Optional avatar placeholder circle. Max width 600px.',
  },
  bold_statement_card: {
    display_name: 'Bold Statement Card',
    definition: 'A centered, minimal card with strong typographic treatment and no attribution. Used for opinions, provocative claims, motivational statements, and declarations where the message itself is the focus.',
    inclusion_criteria: [
      'Post is centered on a strong opinion, provocative claim, or motivational statement',
      'No specific person is quoted or attributed',
      'The message is designed for impact and shareability',
      'Minimal or no supporting context beyond the core statement',
    ],
    renderability_spec: 'Full-width centered card with statement in bold uppercase or display font at 32-48px. Minimal decoration. High contrast background. No attribution line. Optional brand mark or icon. Max width 600px with large vertical padding.',
  },
  key_takeaway_card: {
    display_name: 'Key Takeaway Card',
    definition: 'A card presenting a distilled insight or lesson with brief supporting context. Used for summaries of longer narratives, extracted wisdom, and condensed learnings that benefit from a small explanatory note.',
    inclusion_criteria: [
      'Post contains a distilled insight, lesson, or key point',
      'Brief supporting context or explanation accompanies the main takeaway',
      'Content is a summary, extracted wisdom, or condensed learning',
      'The takeaway is positioned as a practical or actionable insight',
    ],
    renderability_spec: 'Card with a "KEY TAKEAWAY" or "INSIGHT" label badge at top. Main insight in bold 20-28px. Supporting context in regular 14px below with a subtle background tint. Left accent border in brand color. Max width 600px.',
  },
};

const SYSTEM_PROMPT = `You are re-classifying LinkedIn posts that were previously labeled as "quote_card" visual modality into more specific sub-types.

For each post, assign ONE of these specific visual modality sub-types:

1. **pull_quote_card** - Single powerful sentence or short statement, large typographic emphasis. For one-liner hot takes, bold declarations. No attribution to a specific person.

2. **headline_subtext_card** - Title/headline + 1-2 supporting context lines below. For announcements, news summaries, key takeaways that need brief elaboration.

3. **attribution_quote_card** - A quote/statement attributed to a specific person (with name/role). For testimonials, lessons learned, "someone said X."

4. **bold_statement_card** - Centered, minimal, strong typographic treatment with no attribution. For opinions, provocative claims, motivational statements. The message itself is the entire focus.

5. **key_takeaway_card** - A distilled insight or lesson with a brief supporting context. For summaries of longer narratives, extracted wisdom.

6. **quote_card** - Keep this ONLY if the post truly does not fit any of the above sub-types. This should be rare.

For each post, provide:
- "post_id": the post's ID
- "visual_modality": one of the sub-type names above
- "evidence": 1-2 sentences explaining why this specific sub-type fits better than the others

Respond with a JSON object: { "classifications": [...] }

Do not use em dashes in any text.`;

const SubClassificationSchema = z.object({
  post_id: z.string(),
  visual_modality: z.enum(QUOTE_CARD_SUB_TYPES),
  evidence: z.string(),
});

const BatchResponseSchema = z.object({
  classifications: z.array(SubClassificationSchema),
});

async function main() {
  log.info('=== Refinement: Split quote_card into sub-types ===');
  const startMs = Date.now();

  await mkdir(OUTPUT_DIR, { recursive: true });

  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  // Load current labels
  const labelsRaw = await readFile(join(OUTPUT_DIR, 'posts-labeled.json'), 'utf-8');
  const allLabels: PostLabel[] = JSON.parse(labelsRaw);
  log.info({ totalLabels: allLabels.length }, 'Loaded labels');

  // Load original posts for text context
  const postsRaw = await readFile(POSTS_PATH, 'utf-8');
  const postsData = JSON.parse(postsRaw) as unknown[];
  const postsMap = new Map<string, InspPost>();
  for (const item of postsData) {
    const parsed = InspPostSchema.safeParse(item);
    if (parsed.success) postsMap.set(parsed.data.id, parsed.data);
  }
  log.info({ postsLoaded: postsMap.size }, 'Loaded original posts');

  // Filter quote_card posts
  const quoteCardLabels = allLabels.filter((l) => l.visual_modality === 'quote_card');
  log.info({ quoteCardCount: quoteCardLabels.length }, 'Found quote_card posts to reclassify');

  // Batch and classify
  const batches = batchArray(quoteCardLabels, 20);
  const reclassified = new Map<string, { visual_modality: string; evidence: string }>();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log.info({ batch: i + 1, total: batches.length, size: batch.length }, 'Processing batch');

    const postTexts = batch
      .map((label, idx) => {
        const post = postsMap.get(label.post_id);
        const text = post?.content_text?.slice(0, 1200) ?? '[text unavailable]';
        const creator = post?.creator_name ?? 'Unknown';
        return [
          `### Post ${idx + 1} (ID: ${label.post_id})`,
          `**Creator**: ${creator}`,
          `**Content Type**: ${label.content_type}`,
          `**Original Evidence**: ${label.visual_modality_evidence}`,
          `**Text**:`,
          text,
          text.length >= 1200 ? '...(truncated)' : '',
        ].join('\n');
      })
      .join('\n\n---\n\n');

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await callClaude(client, {
          system: SYSTEM_PROMPT,
          userContent: `Reclassify these ${batch.length} posts into specific quote_card sub-types:\n\n${postTexts}`,
          model: 'claude-sonnet-4-6',
          label: `refinement-split-batch-${i + 1}`,
          maxTokens: 4096,
        });

        const jsonStr = extractJson(response.text);
        const parsed = BatchResponseSchema.parse(JSON.parse(jsonStr));

        for (const c of parsed.classifications) {
          reclassified.set(c.post_id, {
            visual_modality: c.visual_modality,
            evidence: c.evidence,
          });
        }
        break;
      } catch (err) {
        log.warn(
          { attempt, batch: i + 1, err: err instanceof Error ? err.message : String(err) },
          'Batch failed, retrying',
        );
        if (attempt === 1) {
          log.error({ batch: i + 1 }, 'Batch failed after retries, keeping original labels');
        }
        await sleep(3000);
      }
    }

    if (i < batches.length - 1) await sleep(2000);
  }

  log.info({ reclassifiedCount: reclassified.size }, 'Reclassification complete');

  // Update labels
  const updatedLabels = allLabels.map((label) => {
    const update = reclassified.get(label.post_id);
    if (update) {
      return {
        ...label,
        visual_modality: update.visual_modality,
        visual_modality_evidence: update.evidence,
      };
    }
    return label;
  });

  await writeFile(join(OUTPUT_DIR, 'posts-labeled.json'), JSON.stringify(updatedLabels, null, 2), 'utf-8');
  log.info('Updated posts-labeled.json');

  // Update schema to include new modality definitions
  const schemaRaw = await readFile(join(OUTPUT_DIR, 'schema-v1.json'), 'utf-8');
  const schema: DACTISchema = JSON.parse(schemaRaw);

  // Remove the old quote_card modality and add the new sub-types
  const oldQuoteCard = schema.visual_modalities.find((m) => m.name === 'quote_card');
  schema.visual_modalities = schema.visual_modalities.filter((m) => m.name !== 'quote_card');

  for (const [name, def] of Object.entries(SUB_TYPE_DEFINITIONS)) {
    schema.visual_modalities.push({
      name,
      display_name: def.display_name,
      definition: def.definition,
      inclusion_criteria: def.inclusion_criteria,
      renderability_spec: def.renderability_spec,
      example_post_id: oldQuoteCard?.example_post_id ?? '',
    });
  }

  // Keep quote_card in schema as a fallback
  if (oldQuoteCard) {
    schema.visual_modalities.push({
      ...oldQuoteCard,
      definition: oldQuoteCard.definition + ' Use only when none of the more specific quote sub-types apply.',
    });
  }

  schema.generated_at = new Date().toISOString();
  await writeFile(join(OUTPUT_DIR, 'schema-v1.json'), JSON.stringify(schema, null, 2), 'utf-8');
  log.info('Updated schema-v1.json with new modality definitions');

  // Re-run distribution analysis (Phase 6 inline)
  const contentTypeCounts: Record<string, number> = {};
  const visualModalityCounts: Record<string, number> = {};
  const crossTabMap = new Map<string, number>();
  const confidenceDist = { high: 0, medium: 0, low: 0 };

  for (const l of updatedLabels) {
    contentTypeCounts[l.content_type] = (contentTypeCounts[l.content_type] ?? 0) + 1;
    visualModalityCounts[l.visual_modality] = (visualModalityCounts[l.visual_modality] ?? 0) + 1;
    confidenceDist[l.confidence]++;
    const key = `${l.content_type}::${l.visual_modality}`;
    crossTabMap.set(key, (crossTabMap.get(key) ?? 0) + 1);
  }

  const crossTabulation = Array.from(crossTabMap.entries()).map(([key, count]) => {
    const [content_type, visual_modality] = key.split('::');
    return { content_type, visual_modality, count };
  });

  const thinWarnings: Array<{ axis: string; category: string; count: number }> = [];
  for (const [cat, count] of Object.entries(contentTypeCounts)) {
    if (count < 5) thinWarnings.push({ axis: 'content_type', category: cat, count });
  }
  for (const [cat, count] of Object.entries(visualModalityCounts)) {
    if (count < 5) thinWarnings.push({ axis: 'visual_modality', category: cat, count });
  }

  const distributionSummary = {
    generated_at: new Date().toISOString(),
    total_posts: updatedLabels.length,
    content_type_counts: contentTypeCounts,
    visual_modality_counts: visualModalityCounts,
    cross_tabulation: crossTabulation,
    confidence_distribution: confidenceDist,
    thin_category_warnings: thinWarnings,
    coverage_report: [],
  };

  await writeFile(
    join(OUTPUT_DIR, 'distribution-summary.json'),
    JSON.stringify(distributionSummary, null, 2),
    'utf-8',
  );
  log.info('Updated distribution-summary.json');

  // Log the new distribution
  log.info({ visual_modality_counts: visualModalityCounts }, 'New visual modality distribution');

  const durationMs = Date.now() - startMs;
  log.info({ durationMs, durationMin: (durationMs / 60000).toFixed(1) }, 'Refinement complete');
}

main().catch((err) => {
  log.fatal(err, 'Refinement script failed');
  process.exit(1);
});
