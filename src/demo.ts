import 'dotenv/config';
import { runPipelineWithFeedback } from './index.js';
import { createStageLogger } from './observability/logger.js';
import { parseTargetUrlFromArgv } from './utils/target-url.js';
import type { FeedbackLog } from './types/index.js';

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
  {
    id: 'demo-quote-card',
    expectedModality: 'quote_card',
    text: `"The best founders I know don't have better ideas. They have better feedback loops."

This quote from a partner at Sequoia changed how I think about startups.

Most people optimize for the quality of their initial idea. But the best builders optimize for how quickly they can learn what's wrong with their current idea.

Speed of iteration > quality of initial hypothesis.

Every time.`,
  },
  {
    id: 'demo-pull-quote',
    expectedModality: 'attribution_quote_card',
    text: `Naval Ravikant once said: "Read what you love until you love to read."

I hated reading until I was 27. Forced myself through business books I thought I "should" read.

Then I gave myself permission to read fiction, history, weird niche stuff.

Now I read 50+ books a year. The habit stuck because I stopped optimizing for "useful" and started optimizing for curiosity.

The meta-lesson: the best habit is the one you actually enjoy enough to sustain.`,
  },
  {
    id: 'demo-key-takeaway',
    expectedModality: 'key_takeaway_card',
    text: `After analyzing 10,000 LinkedIn posts, here's the single biggest takeaway:

The posts that get the most engagement aren't the ones with the best insights. They're the ones with the clearest structure.

People scroll fast. If your post looks like a wall of text, it's invisible.

But if it has clear visual breaks, a hook in the first line, and a pattern the eye can follow? It gets read.

Structure beats substance on social media. Every single time.`,
  },
  {
    id: 'demo-stat-callout',
    expectedModality: 'stat_callout',
    text: `73% of remote workers say they're more productive at home.

But here's what the data actually shows:

A Stanford study tracked 16,000 workers over 9 months. Remote workers were 13% more productive. But hybrid workers were 24% more productive than fully remote ones.

The sweet spot isn't "always remote" or "always office." It's intentional flexibility.

Companies forcing 5 days in office are ignoring the data. Companies going fully remote are also ignoring the data.

The answer is in the middle.`,
  },
  {
    id: 'demo-stat-callout-2',
    expectedModality: 'stat_callout',
    text: `$4.2 billion in venture capital was invested in AI infrastructure companies in Q1 2025 alone.

That's more than all of 2022 combined.

The infrastructure layer is where the real money is flowing. Not consumer apps, not chatbots — but the picks and shovels: vector databases, inference optimization, training compute, and model evaluation tools.

If you're building in AI, follow the infrastructure money. That's where the next decade of platform companies will emerge.`,
  },
];

async function main() {
  const targetUrl = parseTargetUrlFromArgv();
  const maxPosts = parseInt(process.env.DEMO_MAX_POSTS ?? '0', 10) || DEMO_POSTS.length;
  const posts = DEMO_POSTS.slice(0, maxPosts);
  log.info({ targetUrl, postCount: posts.length }, 'Running demo');

  const results = [];

  for (const post of posts) {
    log.info(
      { id: post.id, expected: post.expectedModality },
      `Processing: ${post.id}`,
    );

    try {
      const result = await runPipelineWithFeedback({
        postText: post.text,
        targetUrl,
        postId: post.id,
        outputDir: 'data/outputs',
        maxRetries: 1,
      });

      results.push({
        postId: post.id,
        expectedModality: post.expectedModality,
        selectedModality: result.selectedConcept.modality,
        headline: result.selectedConcept.headline,
        pngPath: result.pngPath,
        pdfPath: result.pdfPath,
        evalScore: result.evalScore
          ? {
              overall: result.evalScore.overall,
              compositeScore: result.evalScore.compositeScore,
              passes: result.evalScore.passesThreshold,
            }
          : undefined,
        regenerated: result.regenerated ?? false,
        feedbackLog: result.feedbackLog,
        success: true,
      });

      log.info(
        {
          postId: post.id,
          modality: result.selectedConcept.modality,
          headline: result.selectedConcept.headline,
          png: result.pngPath,
          regenerated: result.regenerated ?? false,
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
  const regeneratedPosts: Array<{ postId: string; feedbackLog: FeedbackLog }> = [];

  for (const r of results) {
    if (r.success) {
      const regeneratedTag = r.regenerated ? ' [REGENERATED]' : '';
      console.log(`[OK] ${r.postId}${regeneratedTag}`);
      console.log(`     Modality: ${r.selectedModality}`);
      console.log(`     Headline: ${r.headline}`);
      console.log(`     PNG: ${r.pngPath}`);
      if ('evalScore' in r && r.evalScore) {
        const es = r.evalScore as { overall: number; passes: boolean; compositeScore?: number };
        const displayScore = es.compositeScore ?? es.overall;
        console.log(`     Eval: ${displayScore.toFixed(1)}/10 ${es.passes ? '(PASS)' : '(BELOW THRESHOLD)'}${es.compositeScore != null ? ' (composite)' : ' (text-only)'}`);
      }
      if (r.regenerated && r.feedbackLog) {
        const fl = r.feedbackLog as FeedbackLog;
        console.log(`     Feedback: ${fl.improvement.originalComposite.toFixed(1)} → ${fl.improvement.finalComposite.toFixed(1)} (Δ${fl.improvement.delta >= 0 ? '+' : ''}${fl.improvement.delta.toFixed(2)})`);
        if (fl.improvement.axesImproved.length > 0) {
          console.log(`     Improved: ${fl.improvement.axesImproved.join(', ')}`);
        }
        regeneratedPosts.push({ postId: r.postId as string, feedbackLog: fl });
      }
      console.log('');
    } else {
      console.log(`[FAIL] ${r.postId}`);
      console.log(`       Error: ${'error' in r ? r.error : 'unknown'}`);
      console.log('');
    }
  }

  const successes = results.filter((r) => r.success).length;
  const regenerated = results.filter((r) => r.success && r.regenerated).length;
  console.log(`${successes}/${posts.length} posts processed successfully.`);
  if (regenerated > 0) {
    console.log(`${regenerated} post(s) were regenerated via feedback loop.`);
    console.log('\n========== FEEDBACK LOOP DETAILS ==========\n');
    for (const { postId, feedbackLog } of regeneratedPosts) {
      console.log(`--- ${postId} ---`);
      console.log(`  Result: ${feedbackLog.finalResult}`);
      console.log(`  Attempts: ${feedbackLog.attempts.length}`);
      for (const attempt of feedbackLog.attempts) {
        const score = attempt.scores.compositeScore ?? attempt.scores.overall;
        console.log(`    #${attempt.attempt}: ${score.toFixed(1)}/10 ${attempt.scores.passesThreshold ? '(PASS)' : '(FAIL)'}`);
        if (attempt.conceptChanges) {
          console.log(`      Changes: ${attempt.conceptChanges}`);
        }
      }
      console.log(`  Score improvement: ${feedbackLog.improvement.originalComposite.toFixed(1)} → ${feedbackLog.improvement.finalComposite.toFixed(1)} (Δ${feedbackLog.improvement.delta >= 0 ? '+' : ''}${feedbackLog.improvement.delta.toFixed(2)})`);
      console.log('');
    }
  }
}

main().catch((err) => {
  log.fatal(err, 'Demo failed');
  process.exit(1);
});
