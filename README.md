# flywheel-visual-pipeline

A standalone service that takes a finished LinkedIn-style post + a brand's design context (from crawling flywheelos.com) and produces polished, on-brand visuals as HTML/CSS, exported to PDF and PNG.

## Architecture

```
+------------------+     +-------------------+     +-------------------+     +----------------+
|  Stage 1         |     |  Stage 2          |     |  Stage 3          |     |  Stage 4       |
|  Website -->     |---->|  Post -->         |---->|  Concept -->      |---->|  Eval +        |
|  Design System   |     |  Concept          |     |  HTML/PDF/PNG     |     |  Feedback Loop |
+------------------+     +-------------------+     +-------------------+     +----------------+
        |                        ^
        |                        |
        |               +-------------------+
        |               |  Workstream B     |
        +-------------->|  Schema Induction |
                        +-------------------+
```

### Stage 1: Website to Design System
- Crawls the target website with Playwright
- Extracts design tokens: colors (hex), fonts, weights, logos, spacing, border radius, component patterns
- Outputs `design_system.json` with structured tokens and raw CSS variables

### Stage 2: Post to Concept
- Takes post text + design system + modality schema as input
- LLM proposes 2-3 visual concepts as Zod-validated structured output
- Selects the strongest concept with an explained selection rule
- Outputs concept JSON with full layout specification

### Stage 3: Concept to HTML
- Renders the chosen concept as on-brand HTML/CSS using Handlebars templates
- Applies extracted design tokens (colors, fonts, spacing)
- Exports to PDF (Playwright print-to-PDF) and PNG (Playwright screenshot)
- Includes templates: `quote-card`, `stat-callout`

### Stage 4: Eval + Feedback Loop (stretch)
- LLM judge scores the visual on: on-brand, legible, clear hierarchy, not generic
- If below threshold, triggers one regeneration pass with critique feedback
- Logs every evaluation score

### Workstream B: Schema Induction
- Analyzes ~300 real posts to derive a data-grounded schema
- Two axes: content type (rhetorical shape) x visual modality (form of visual)
- Outputs Zod schema, JSON distribution, and summary

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
  designSystem: DesignSystem;            // Extracted design tokens
  conceptOutput: ConceptGenerationOutput; // Selected visual concept
  renderedHtml: string;                   // Final HTML
  pdfPath: string;                        // Path to exported PDF
  pngPath: string;                        // Path to exported PNG
  evalScore?: EvalScore;                  // Quality evaluation (optional)
}
```

### Design System Shape
```typescript
interface DesignSystem {
  colors: { primary, secondary?, accent?, background, surface?, text, ... }
  typography: { headingFont, bodyFont, baseSizePx, lineHeight, scale? }
  spacing: { unit, borderRadiusPx, containerMaxWidthPx? }
  logo?: { url?, base64?, format }
  components: Array<{ name, cssClasses?, shadow?, notes? }>
  rawCssVariables: Array<{ property, value, selector }>
}
```

## Setup

### Prerequisites
- Node.js 20+
- npm

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd flywheel-visual-pipeline

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Copy environment template
cp .env.example .env
# Then fill in your API keys in .env
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | API key for Claude LLM calls |
| `LANGFUSE_SECRET_KEY` | No | Langfuse secret key for tracing |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse public key for tracing |
| `LANGFUSE_HOST` | No | Langfuse host (defaults to cloud) |
| `TARGET_URL` | No | Website to crawl (defaults to flywheelos.com) |

## Usage

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

### CLI Options

```bash
npx tsx src/cli.ts --help

Options:
  --run       Run the full pipeline
  --stage     Run a specific stage (1, 2, 3, 4, workstream-b)
  --post      Post text to process
  --url       Target website URL (default: https://flywheelos.com)
  --output    Output directory (default: data/outputs)
  --help      Show help
```

### Development

```bash
# Run in dev mode
npm run dev

# Run tests
npm test

# Lint
npm run lint

# Format
npm run format

# Build
npm run build
```

## Project Structure

```
src/
  index.ts                          Pipeline orchestrator
  cli.ts                            CLI entry point
  config.ts                         Environment + config loading
  types/index.ts                    Shared TypeScript types
  schemas/
    design-system.schema.ts         Zod schema for design tokens
    concept.schema.ts               Zod schema for visual concepts
    modality.schema.ts              Zod schema for post modalities
  stages/
    stage1-design-system/           Website crawling + token extraction
    stage2-post-to-concept/         LLM concept generation
    stage3-concept-to-html/         Handlebars rendering + PDF/PNG export
    stage4-eval/                    LLM quality evaluation (stretch)
  workstream-b/                     Post classification + schema induction
  observability/
    logger.ts                       pino structured logging
    tracer.ts                       Langfuse tracing wrapper
data/
  posts/                            Input posts for Workstream B
  schema/                           Generated schema outputs
  outputs/                          Generated visuals (PDF, PNG, HTML)
tests/                              Vitest test files
```

## Tech Stack

- **Runtime**: Node.js 20+, TypeScript (strict, ESM)
- **LLM**: Anthropic Claude via @anthropic-ai/sdk
- **Browser automation**: Playwright (crawling + PDF/PNG export)
- **HTML parsing**: cheerio
- **Templating**: Handlebars
- **Validation**: Zod + zod-validation-error
- **Observability**: pino (logging) + Langfuse (tracing)
- **Testing**: Vitest
- **Code quality**: ESLint + Prettier
