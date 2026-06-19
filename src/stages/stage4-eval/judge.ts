import Anthropic from '@anthropic-ai/sdk';
import type { ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages.js';
import { readFile, access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { loadConfig } from '../../config.js';
import { createStageLogger } from '../../observability/logger.js';
import { traceGeneration } from '../../observability/tracer.js';
import type {
  EvalScore,
  VisionAbsoluteScore,
  VisionComparativeScore,
} from '../../types/index.js';

const log = createStageLogger('stage4:judge');

const SCORE_THRESHOLD = 7.0;
const REFERENCE_SCREENSHOT_PATH = 'data/reference-brand-screenshot.png';

// Weight allocation for composite score
const WEIGHT_TEXT = 0.30;
const WEIGHT_VISION_ABSOLUTE = 0.35;
const WEIGHT_VISION_COMPARATIVE = 0.35;

// ---------------------------------------------------------------------------
// Reference brand screenshot
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure we have a reference brand screenshot. Uses a cached version if
 * available, otherwise takes a fresh screenshot of TARGET_URL via Playwright.
 */
async function ensureReferenceScreenshot(): Promise<string | null> {
  if (await fileExists(REFERENCE_SCREENSHOT_PATH)) {
    log.info({ path: REFERENCE_SCREENSHOT_PATH }, 'Using cached reference screenshot');
    return REFERENCE_SCREENSHOT_PATH;
  }

  const config = loadConfig();
  log.info({ url: config.targetUrl }, 'Capturing reference brand screenshot');

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(config.targetUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 500));

    await page.screenshot({
      path: REFERENCE_SCREENSHOT_PATH,
      fullPage: false,
      type: 'png',
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });
    log.info({ path: REFERENCE_SCREENSHOT_PATH }, 'Reference screenshot captured');
    return REFERENCE_SCREENSHOT_PATH;
  } catch (err) {
    log.warn({ err }, 'Failed to capture reference screenshot; comparative eval will be skipped');
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Text-based eval (existing)
// ---------------------------------------------------------------------------

/**
 * Use an LLM to judge the quality of a rendered visual via HTML source analysis.
 *
 * Scores on four dimensions (1-10 each):
 *   - On-brand: Does it match the design system?
 *   - Legible: Is text readable and well-sized?
 *   - Clear hierarchy: Is visual hierarchy obvious?
 *   - Not generic: Does it feel custom, not templated?
 */
export async function judgeVisualText(
  client: Anthropic,
  html: string,
  postText: string,
  designSystemSummary: string,
): Promise<{
  onBrand: number;
  legible: number;
  clearHierarchy: number;
  notGeneric: number;
  critique: string;
  textAvg: number;
}> {
  const trace = traceGeneration('visual-evaluation-text');

  const llmStart = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: TEXT_JUDGE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          `## Original Post\n${postText}`,
          `## Design System Summary\n${designSystemSummary}`,
          `## Rendered HTML\n\`\`\`html\n${html}\n\`\`\``,
          '',
          'Score this visual. Return JSON with: onBrand, legible, clearHierarchy, notGeneric (each 1-10), critique (string).',
        ].join('\n\n'),
      },
    ],
  });
  const llmLatency = Date.now() - llmStart;
  log.info({ model: 'claude-sonnet-4-6', latencyMs: llmLatency }, 'Text eval LLM call');

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from text judge LLM');
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in text judge response');
  }

  const raw = JSON.parse(jsonMatch[0]) as {
    onBrand: number;
    legible: number;
    clearHierarchy: number;
    notGeneric: number;
    critique: string;
  };

  trace.end();

  const textAvg = (raw.onBrand + raw.legible + raw.clearHierarchy + raw.notGeneric) / 4;
  return { ...raw, textAvg };
}

// ---------------------------------------------------------------------------
// Vision-based eval (new — single multimodal call)
// ---------------------------------------------------------------------------

interface VisionResult {
  absolute: VisionAbsoluteScore;
  comparative: VisionComparativeScore;
  visionCritique: string;
  absoluteAvg: number;
  comparativeAvg: number;
}

/**
 * Send the generated PNG (and optionally a reference brand screenshot) to
 * Claude Vision in a single multimodal call. Returns absolute quality scores
 * and brand-alignment comparison scores.
 */
async function judgeVisualVision(
  client: Anthropic,
  pngPath: string,
  referencePath: string | null,
): Promise<VisionResult> {
  const trace = traceGeneration('visual-evaluation-vision');

  const generatedPng = await readFile(pngPath);
  const generatedB64 = generatedPng.toString('base64');

  const imageBlocks: (ImageBlockParam | TextBlockParam)[] = [
    {
      type: 'text' as const,
      text: 'IMAGE 1 — Generated LinkedIn visual:',
    },
    {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: generatedB64,
      },
    },
  ];

  if (referencePath) {
    const refPng = await readFile(referencePath);
    const refB64 = refPng.toString('base64');
    imageBlocks.push(
      {
        type: 'text' as const,
        text: 'IMAGE 2 — Brand reference (company homepage screenshot):',
      },
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png' as const,
          data: refB64,
        },
      },
    );
  }

  imageBlocks.push({
    type: 'text' as const,
    text: referencePath
      ? 'Score both the absolute quality of IMAGE 1 and its brand alignment compared to IMAGE 2. Return JSON per the system instructions.'
      : 'No brand reference available. Score the absolute quality of IMAGE 1. For the comparative scores (colorMatch, typographyMatch, aestheticMatch), return 5 for each since no reference is available. Return JSON per the system instructions.',
  });

  const llmStart = Date.now();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: VISION_JUDGE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: imageBlocks,
      },
    ],
  });
  const llmLatency = Date.now() - llmStart;
  log.info({ model: 'claude-sonnet-4-6', latencyMs: llmLatency }, 'Vision eval LLM call');

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from vision judge LLM');
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in vision judge response');
  }

  const raw = JSON.parse(jsonMatch[0]) as {
    layout: number;
    legibility: number;
    polish: number;
    colorMatch: number;
    typographyMatch: number;
    aestheticMatch: number;
    vision_critique: string;
  };

  trace.end();

  const absolute: VisionAbsoluteScore = {
    layout: raw.layout,
    legibility: raw.legibility,
    polish: raw.polish,
  };

  const comparative: VisionComparativeScore = {
    colorMatch: raw.colorMatch,
    typographyMatch: raw.typographyMatch,
    aestheticMatch: raw.aestheticMatch,
  };

  const absoluteAvg = (absolute.layout + absolute.legibility + absolute.polish) / 3;
  const comparativeAvg =
    (comparative.colorMatch + comparative.typographyMatch + comparative.aestheticMatch) / 3;

  return { absolute, comparative, visionCritique: raw.vision_critique, absoluteAvg, comparativeAvg };
}

// ---------------------------------------------------------------------------
// Combined eval entry point
// ---------------------------------------------------------------------------

/**
 * Run the full evaluation: text-based HTML analysis + vision-based PNG analysis.
 * Falls back to text-only if no PNG is available.
 */
export async function judgeVisual(
  html: string,
  postText: string,
  designSystemSummary: string,
  pngPath?: string,
): Promise<EvalScore> {
  const config = loadConfig();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  log.info({ hasPng: !!pngPath }, 'Starting combined evaluation');

  // Always run text-based eval
  const textResult = await judgeVisualText(client, html, postText, designSystemSummary);

  const score: EvalScore = {
    onBrand: textResult.onBrand,
    legible: textResult.legible,
    clearHierarchy: textResult.clearHierarchy,
    notGeneric: textResult.notGeneric,
    overall: textResult.textAvg,
    critique: textResult.critique,
    passesThreshold: textResult.textAvg >= SCORE_THRESHOLD,
  };

  // Run vision eval if PNG exists
  if (pngPath && (await fileExists(pngPath))) {
    const referencePath = await ensureReferenceScreenshot();

    const visionResult = await judgeVisualVision(client, pngPath, referencePath);
    score.visionAbsolute = visionResult.absolute;
    score.visionComparative = visionResult.comparative;
    score.visionCritique = visionResult.visionCritique;

    // Weighted composite: text 30%, absolute vision 35%, comparative vision 35%
    score.compositeScore =
      WEIGHT_TEXT * textResult.textAvg +
      WEIGHT_VISION_ABSOLUTE * visionResult.absoluteAvg +
      WEIGHT_VISION_COMPARATIVE * visionResult.comparativeAvg;

    score.compositeScore = Math.round(score.compositeScore * 100) / 100;
    score.passesThreshold = score.compositeScore >= SCORE_THRESHOLD;

    log.info(
      {
        textAvg: textResult.textAvg,
        visionAbsoluteAvg: visionResult.absoluteAvg,
        visionComparativeAvg: visionResult.comparativeAvg,
        compositeScore: score.compositeScore,
      },
      'Composite score computed',
    );
  } else {
    if (pngPath) {
      log.warn({ pngPath }, 'PNG not found; skipping vision eval, using text-only scores');
    } else {
      log.warn('No PNG path provided; skipping vision eval, using text-only scores');
    }
  }

  log.info(
    { overall: score.compositeScore ?? score.overall, passes: score.passesThreshold },
    'Evaluation complete',
  );

  return score;
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const TEXT_JUDGE_SYSTEM_PROMPT = `You are a visual design quality judge. You evaluate LinkedIn-style visual content cards by analyzing their HTML source code.

Score each dimension from 1 (worst) to 10 (best):
- onBrand: Does the visual match the brand's design system (colors, fonts, spacing)?
- legible: Is all text readable with appropriate sizing and contrast?
- clearHierarchy: Is there a clear visual hierarchy guiding the reader's eye?
- notGeneric: Does it feel custom and branded, not like a generic template?

Return a JSON object with those four numeric scores and a "critique" string with specific, actionable feedback.`;

const VISION_JUDGE_SYSTEM_PROMPT = `You are a visual design quality judge. You evaluate rendered LinkedIn-style visual content cards by looking at screenshots.

You will receive one or two images:
- IMAGE 1: The generated LinkedIn visual card (always provided)
- IMAGE 2: A reference brand screenshot from the company's website (provided when available)

Score these dimensions from 1 (worst) to 10 (best):

**A) ABSOLUTE QUALITY (from IMAGE 1 alone):**
- layout (1-10): Is it well-composed with clear visual hierarchy?
- legibility (1-10): Is all text readable with good contrast?
- polish (1-10): Does it feel professionally designed, not generic?

**B) BRAND ALIGNMENT (compare IMAGE 1 vs IMAGE 2, if available):**
- colorMatch (1-10): Do colors match the brand reference?
- typographyMatch (1-10): Do fonts/weights/styles match?
- aestheticMatch (1-10): Does the overall style/feel belong alongside the brand?

Return a JSON object with exactly these keys: layout, legibility, polish, colorMatch, typographyMatch, aestheticMatch, vision_critique (string with specific actionable feedback).`;
