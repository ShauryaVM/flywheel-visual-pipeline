import 'dotenv/config';
import { runPipelineWithFeedback } from './index.js';
import { createStageLogger } from './observability/logger.js';

const log = createStageLogger('demo:flywheel-formats');

/**
 * Demo posts matching Flywheel production LinkedIn formats.
 * Reference: docs/flywheel-design-audit.md
 */
const FLYWHEEL_FORMAT_POSTS = [
  {
    id: 'demo-flywheel-stats',
    expectedModality: 'multi_stat_panel',
    text: `You can get millions of impressions and generate zero pipeline.

Or you can get fewer impressions and build a real GTM engine.

Here is what we see across B2B teams running founder-led content:

1/ 1B+ people use LinkedIn, but only 1-2% post regularly.

2/ Personal profiles get 2.75x more impressions than company pages.

3/ Founder posts with a clear personal brand outperform random posts by 5-10x on engagement.

4/ Teams that ship weekly for 6 months move from the bottom 90% to the top 10% of creators on the platform.

5/ The trust layer that converts impressions into pipeline is built through consistent, authentic insight.

Impressions are vanity. Pipeline is the point.`,
  },
  {
    id: 'demo-flywheel-mafias',
    expectedModality: 'mafia_ecosystem_graphic',
    text: `The UK is the capital of European AI.

UK AI companies raised $5.8B in Q1 2026 alone. Third in the world after the US and China.

Here are 8 top UK AI companies that are winning right now:

1/ ElevenLabs - $11B valuation, $330M ARR. Voice AI leader.
2/ Wayve - $8.6B valuation. Autonomous driving with neural nets.
3/ Synthesia - $4B valuation. AI video avatars for enterprise.
4/ Isomorphic Labs - Spun out of DeepMind. AI drug discovery.
5/ Ineffable Intelligence - $5.1B valuation. Superintelligence beyond LLMs.
6/ PolyAI - $200M+ raised. Enterprise voice AI from Cambridge.
7/ Granola - $1.5B valuation. AI meeting notetaker, under a year to unicorn.
8/ Olix Computing - $1B+ valuation. Photonic AI chips, founded 2024.

Concentrated talent is how mafias form.

Who else belongs on this list?`,
  },
];

async function main() {
  log.info(`Running Flywheel format demo with ${FLYWHEEL_FORMAT_POSTS.length} posts`);

  for (const post of FLYWHEEL_FORMAT_POSTS) {
    log.info({ id: post.id, expected: post.expectedModality }, `Processing: ${post.id}`);

    try {
      const result = await runPipelineWithFeedback({
        postText: post.text,
        postId: post.id,
        outputDir: 'data/outputs',
        maxRetries: 1,
      });

      console.log(`\n[OK] ${post.id}`);
      console.log(`  Expected: ${post.expectedModality}`);
      console.log(`  Selected: ${result.selectedConcept.modality}`);
      console.log(`  Headline: ${result.selectedConcept.headline}`);
      console.log(`  PNG: ${result.pngPath}`);
      if (result.evalScore?.compositeScore != null) {
        console.log(`  Eval: ${result.evalScore.compositeScore.toFixed(1)}/10`);
      }
    } catch (err) {
      log.error({ err, postId: post.id }, 'Failed to process post');
      console.log(`\n[FAIL] ${post.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  log.fatal(err, 'Flywheel format demo failed');
  process.exit(1);
});
