import 'dotenv/config';
import { runPipeline } from './index.js';
import { createStageLogger } from './observability/logger.js';

const log = createStageLogger('demo');

const DEMO_POSTS = [
  {
    id: 'demo-headline-subtext',
    expectedModality: 'headline_subtext_card',
    text: `BREAKING: Anthropic is opening an office in Milan as it continues to double down on Europe!

Europe is Anthropic's fastest growing region with revenue up 9x YoY, while Milan is the centre of Italian tech.

Anthropic now has hubs in London, Dublin, Zurich, Paris, Munich and Milan.

It's pushing more and more into Europe as its relationship with the US continues to sour.

Dario Amodei will actually be in Turin later this year as one of the headline speakers for Wave by Vento, which should be fun.

Great stuff for Italy!`,
  },
  {
    id: 'demo-bold-statement',
    expectedModality: 'bold_statement_card',
    text: `I paid $1,500 to learn how to be exceptional.

It can be summed up in 4 words:

Being exceptional equals volume.

Two years ago, I paid $1,500 for a coaching session with someone who'd built one of the biggest audiences in my niche.

Which felt insane. I almost didn't book it.

The first thing they did was open a spreadsheet.

500 posts. Every metric tracked. Every topic color-coded.

That's when I understood: the gap between average and exceptional isn't just 10% more effort.

It's more like 1,000%.

Average people wait for 1 good idea. Exceptional ship 1 bad idea to learn from it.
Average people quit after 3 failures. Exceptional improve through 300 failures.

After that call, I started tracking everything.

My businesses now do over $1m a year.
The gap between average and exceptional is always about volume.`,
  },
  {
    id: 'demo-multi-stat',
    expectedModality: 'multi_stat_panel',
    text: `In 48 hours since Mike (mikeoss.com), the open source Harvey / Legora, was launched, it has been starred 900+ times and forked 200+ times.

I have gotten messages from people who are downloading Mike and running local versions to securely handle their legal workflows. It reminds me a little of OpenClaw.

Some have already built extensions on top of it, like linking Mike to the courtlistener API for US case law.

Excited to see what happens with Mike.`,
  },
  {
    id: 'demo-numbered-list',
    expectedModality: 'numbered_list_graphic',
    text: `Google is offering free AI courses with certificates.

Here are 7 courses you can take:

1. AI Fundamentals: Understand core AI concepts and build a foundation for professional AI use.

2. AI for Brainstorming: Use AI as a creative tool to evaluate and prioritize ideas.

3. AI for Research: Use Gemini and NotebookLM to research faster and summarize sources.

4. AI for Writing: Turn messy meeting notes into clear summaries with Gemini.

5. AI for Content Creation: Generate high-quality images and videos using Gemini.

6. AI for Data Analysis: Track metrics, clean messy data, and measure performance.

7. AI for App Building: Build a working web app using AI, no code needed.`,
  },
  {
    id: 'demo-feature-list',
    expectedModality: 'feature_list_graphic',
    text: `Essential books for product builders

I've put together a collection of my all-time favorite books, organized by their jobs-to-be-done. When your manager tells you to work on a particular development area, these are the books to read.

To keep this list extremely high signal-to-noise, I forced myself to pick only three books per category, and only books I've completed.

The collection includes both classics and under-the-radar gems. I very much like Marc Andreeson's take that you should mostly read books that are over 10 years old, because those are the books that have stood the test of time.

There are so many great titles that I didn't include here, either because I haven't had a chance to read them or they just didn't make the cut.

What book did I miss that legitimately made you a better builder or leader?`,
  },
];

async function main() {
  log.info(`Running demo with ${DEMO_POSTS.length} posts`);

  const results = [];

  for (const post of DEMO_POSTS) {
    log.info(
      { id: post.id, expected: post.expectedModality },
      `Processing: ${post.id}`,
    );

    try {
      const result = await runPipeline({
        postText: post.text,
        postId: post.id,
        outputDir: 'data/outputs',
      });

      results.push({
        postId: post.id,
        expectedModality: post.expectedModality,
        selectedModality: result.selectedConcept.modality,
        headline: result.selectedConcept.headline,
        pngPath: result.pngPath,
        pdfPath: result.pdfPath,
        success: true,
      });

      log.info(
        {
          postId: post.id,
          modality: result.selectedConcept.modality,
          headline: result.selectedConcept.headline,
          png: result.pngPath,
        },
        'Post processed successfully',
      );
    } catch (err) {
      log.error({ err, postId: post.id }, 'Failed to process post');
      results.push({
        postId: post.id,
        expectedModality: post.expectedModality,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log('\n========== DEMO RESULTS ==========\n');
  for (const r of results) {
    if (r.success) {
      console.log(`[OK] ${r.postId}`);
      console.log(`     Modality: ${r.selectedModality}`);
      console.log(`     Headline: ${r.headline}`);
      console.log(`     PNG: ${r.pngPath}`);
      console.log('');
    } else {
      console.log(`[FAIL] ${r.postId}`);
      console.log(`       Error: ${'error' in r ? r.error : 'unknown'}`);
      console.log('');
    }
  }

  const successes = results.filter((r) => r.success).length;
  console.log(`${successes}/${results.length} posts processed successfully.`);
}

main().catch((err) => {
  log.fatal(err, 'Demo failed');
  process.exit(1);
});
