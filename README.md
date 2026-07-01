# flywheel-visual-pipeline

A standalone service that takes a finished LinkedIn-style post + a brand's design context (from crawling any website) and produces polished, on-brand visuals as HTML/CSS, exported to PDF and PNG. Fully generic — repoint at any company's site to produce visuals in their brand.

## Architecture

```
+------------------------------- Workstream A --------------------------------+
|                                                                             |
|  +-------------+     +--------------+     +--------------+     +----------+ |
|  |  Stage 1    |     |  Stage 2     |     |  Stage 3     |     | Stage 4  | |
|  |  Website -> |---->|  Post ->     |---->|  Concept ->  |---->| Eval +   | |
|  |  Design Sys |     |  Concept     |     |  HTML/PNG    |     | Feedback | |
|  +-------------+     +--------------+     +--------------+     +----------+ |
|        |                    ^                                        |       |
|        |                    |                              (critique fed     |
|        |                    +-------------------------------back if < 7.0)  |
+---------|-------------------------------------------------------------------+
          |
          v
+------------------------------- Workstream B --------------------------------+
|  Schema Induction (DACTI): ~300 posts → two-axis content/modality schema    |
+-----------------------------------------------------------------------------+
```

## Workstream A: Post Idea → Visual Pipeline

- Crawls the target website with Playwright, extracting design tokens (colors, fonts, logos, spacing, components) and using Claude to identify brand identity, compositional rules, motifs, prohibitions, and tone
- LLM enumerates 3-4 key narratives/data points from the post before selecting a visual modality (goal enumeration)
- Proposes 2-3 visual concepts as Zod-validated structured output, selecting the strongest with an explained rule
- Detects data-heavy posts and maps them to chart modalities (bar, sparkline, pie/donut)
- Supports two rendering paths: fixed Handlebars templates (12+ modalities) and a JSON layout protocol for custom absolute-positioned compositions
- Applies all design tokens dynamically — colors, fonts, spacing, logos, decorative patterns — with fonts embedded as base64 woff2
- Exports to PDF and PNG via Playwright
- Evaluates each visual with a three-signal composite score: text-structural analysis (30%) + vision-based absolute quality (35%) + vision-based brand comparison (35%)
- Feedback loop: if composite score < 7.0, critique is fed back to regenerate the concept → re-render → re-evaluate
- Writes `eval_score.json` and `eval_feedback_log.json` per visual (scores per axis, what got regenerated, improvement delta)

## Workstream B: Schema Induction (DACTI Method)

- Custom 6-phase methodology: Signal Enrichment → Exploration → Synthesis → Refinement → Classification → Distribution
- Analyzes ~300 real posts to derive a two-axis schema: content type × visual modality
- Validated with Cohen's Kappa inter-rater reliability and held-out set
- Engagement correlation analysis
- Outputs Zod schema, JSON distribution, and `METHOD.md`

## Template Modalities (12+)

| Category | Templates |
|----------|-----------|
| **Text-focused** | `headline-subtext-card`, `bold-statement-card`, `key-takeaway-card`, `pull-quote-card` |
| **Data-focused** | `stat-callout`, `flywheel-stat-panel`, `bar-chart`, `line-sparkline`, `pie-donut-chart` |
| **List-focused** | `numbered-list-graphic`, `feature-list-graphic`, `mafia-ecosystem` |
| **Quote** | `quote-card`, `attribution-quote-card` |
| **Dynamic** | Layout protocol renderer (any composition via JSON) |

## Interface Contract

### Pipeline Input
```typescript
interface PipelineInput {
  postText: string;      // The LinkedIn-style post text
  targetUrl: string;     // Website to crawl for design context
  outputDir: string;     // Where to write generated files
}
```

### Pipeline Output
```typescript
interface PipelineResult {
  designSystem: DesignSystem;
  conceptOutput: ConceptGenerationOutput;
  renderedHtml: string;
  pdfPath: string;
  pngPath: string;
  evalScore?: EvalScore;
  feedbackLog?: FeedbackLog;
  regenerated?: boolean;
}
```

### EvalScore Shape
```typescript
interface EvalScore {
  onBrand: number;           // 1-10
  legible: number;           // 1-10
  clearHierarchy: number;    // 1-10
  notGeneric: number;        // 1-10
  overall: number;           // average of above
  critique: string;
  passesThreshold: boolean;
  visionAbsolute?: { layout: number; legibility: number; polish: number };
  visionComparative?: { colorMatch: number; typographyMatch: number; aestheticMatch: number };
  visionCritique?: string;
  compositeScore?: number;   // weighted: text 30% + absolute 35% + comparative 35%
}
```

## Setup

### Prerequisites
- Node.js 20+
- npm

### Installation

```bash
git clone https://github.com/ShauryaMantrala/flywheel-visual-pipeline.git
cd flywheel-visual-pipeline

npm install

npx playwright install chromium
```

### Configuration

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | API key for Claude LLM calls |
| `TARGET_URL` | Yes | Website to crawl for design context (e.g. `https://example.com`) |
| `LANGFUSE_SECRET_KEY` | No | Langfuse secret key for tracing |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse public key for tracing |
| `LANGFUSE_HOST` | No | Langfuse host (defaults to cloud) |
| `FLYWHEEL_SCRAPER_PATH` | No | Path to Flywheel-scraper clone for infographic logo/tokens (defaults to `../Flywheel-scraper`) |

### Flywheel production formats

Templates for Flywheel's LinkedIn infographic formats (mafia ecosystem grids + stat panels) use tokens from `Design/infographic-design-system.md` in the Flywheel-scraper repo. See `docs/flywheel-design-audit.md`.

```bash
# Run demo posts matching Mafias + Stats reference formats
npm run demo:flywheel
```

Outputs land in `data/outputs/demo-flywheel-stats/` and `data/outputs/demo-flywheel-mafias/`.

### Run the Full Pipeline

```bash
npm run pipeline -- --post "Your LinkedIn post text here"
```

### Run Individual Stages

```bash
# Stage 1: Crawl website and extract design system
npm run stage1

# Stage 2: Generate visual concepts from a post
npm run stage2 -- "Your post text here"

# Stage 3: Render concept to HTML, export PDF + PNG
npm run stage3

# Workstream B: Classify posts and induce schema
npm run workstream-b
```

### Visual Harness (Browser UI)

```bash
npm run harness
```

Opens a local web UI at `http://localhost:3737` where you can paste post text, enter a brand URL, generate visuals interactively, view eval scores, and trigger regeneration with feedback.

### CLI Options

```bash
npx tsx src/cli.ts --help

Options:
  --run       Run the full pipeline
  --stage     Run a specific stage (1, 2, 3, 4, workstream-b)
  --post      Post text to process
  --url       Target website URL
  --output    Output directory (default: data/outputs)
  --help      Show help
```

## Project Structure

```
src/
  index.ts                          Pipeline orchestrator + feedback loop
  demo.ts                           Demo runner (10 posts, full pipeline)
  export-outputs.ts                 Standalone HTML → PNG/PDF exporter
  cli.ts                            CLI entry point
  config.ts                         Environment + config loading
  types/index.ts                    Shared TypeScript types
  schemas/
    design-system.schema.ts         Zod schema for design tokens
    concept.schema.ts               Zod schema for visual concepts + layout protocol
    modality.schema.ts              Zod schema for post modalities (12+ types)
  stages/
    stage1-design-system/           Website crawling + token extraction + brand identity
    stage2-post-to-concept/         Goal enumeration + LLM concept generation + rule engine
    stage3-concept-to-html/         Template rendering + layout protocol + PDF/PNG export
      templates/                    12+ Handlebars templates (text, data, chart, quote)
      fonts/                        Embedded Inter + DM Mono woff2
    stage4-eval/                    Vision + text eval, feedback loop, regeneration
  workstream-b/                     DACTI 6-phase schema induction
  observability/
    logger.ts                       Pino structured logging
    tracer.ts                       Langfuse tracing wrapper
data/
  posts/                            ~300 input posts for Workstream B
  schema/                           Generated schema + METHOD.md + distribution
  design-system.json                Extracted design system (cached)
  reference-brand-screenshot.png    Brand homepage screenshot (for vision eval)
  outputs/                          Generated visuals (HTML, PNG, PDF, eval logs)
tests/                              Vitest test files (13 tests)
WRITEUP.md                          Architecture decisions + methodology writeup
```

## Tech Stack

- **Runtime**: Node.js 20+, TypeScript (strict, ESM)
- **LLM**: Anthropic Claude (`claude-sonnet-4-6`) via @anthropic-ai/sdk
- **Browser automation**: Playwright (crawling, screenshots, PDF/PNG export)
- **HTML parsing**: cheerio
- **Templating**: Handlebars (12+ templates)
- **Validation**: Zod + zod-validation-error
- **Observability**: Pino (structured logging) + Langfuse (tracing)
- **Testing**: Vitest (13 tests)
- **Code quality**: ESLint + Prettier

