# Post Idea to Visual Pipeline — Writeup

## How I planned this

The brief asked for a system that takes a LinkedIn post and produces an on-brand visual. My first instinct was to treat this as a rendering problem — take post text, pick a template, fill it in. But that underestimates the hard part: knowing *which* visual format fits *which* kind of post, and doing so in a way that isn't just vibes.

I split the work into two parallel workstreams:

- **Workstream B (schema induction):** Analyze ~300 real LinkedIn posts to derive a structured taxonomy — what kinds of posts exist, what visual formats work for each, and what deterministic signals (word count, presence of numbers, list structure) predict the best pairing. This had to come first because its outputs (the schema, the decision rules) directly inform Stage 2 of the pipeline.

- **Workstream A (the pipeline):** A four-stage pipeline: (1) crawl a brand's website to extract a design system, (2) take a post and select a visual concept, (3) render that concept as on-brand HTML and export to PDF/PNG, (4) evaluate the result with an LLM judge.

The ordering mattered. Schema induction produces the content-type × visual-modality taxonomy and the decision rules that Stage 2 uses to rank candidate modalities before the LLM ever sees the post. Without Workstream B, Stage 2 would be guessing. With it, the LLM generates concepts within a constrained, data-grounded solution space.

## Architecture decisions

**TypeScript with strict ESM** was chosen for type safety across the pipeline's many structured interfaces (design system tokens, Zod-validated concept schemas, decision rule formats) and because the Anthropic SDK has first-class TypeScript support.

**Handlebars over React/JSX.** The visuals are static — no interactivity, no state, no hydration. Handlebars produces self-contained HTML strings that Playwright can screenshot directly. React would have added a build step, a runtime, and complexity for zero benefit. Handlebars templates are also easy to inspect and iterate on without understanding a component tree.

**Playwright for export.** The visuals need to be pixel-perfect at 1200×630px (LinkedIn image dimensions). Playwright gives us a real browser rendering engine, proper font loading with base64-embedded WOFF2 files, and both PDF (print-to-PDF) and PNG (viewport screenshot) export in a single browser session.

**Zod for LLM output validation.** LLMs return JSON, but they hallucinate structure. Zod schemas validate the shape of concept generation output at runtime, catching missing fields and type mismatches before they cascade. Combined with `zod-validation-error`, failures produce readable messages that could be fed back to the LLM in a retry loop.

**Design system as a flat JSON file** rather than a database or API. The design system is extracted once (Stage 1) and consumed by Stages 2 and 3. A single JSON file is the simplest contract between stages, easy to version, and easy to manually audit.

## Schema method: DACTI

Existing taxonomy induction methods weren't sufficient for our problem. TnT-LLM (Microsoft, KDD 2024) handles only a single text axis and uses SGD-style minibatch iteration that's overkill for 300 posts. TopicGPT (NAACL 2024) is also single-axis and its evidence mechanism doesn't transfer to visual modality. LLooM (Stanford, CHI 2024) uses embedding clustering, which groups by semantic similarity rather than rhetorical structure — and embeddings can't capture "this post should become a stat callout."

I developed **Dual-Axis Constrained Taxonomy Induction (DACTI)**, a six-phase method:

1. **Signal enrichment** — extract deterministic features (word count, has_numbers, list structure, mentions metrics) before any LLM involvement, providing concrete evidence for decision rules.
2. **Dual-axis open exploration** — a stratified sample of ~40 posts is classified on both axes simultaneously (content type and visual modality), forcing the LLM to reason about the relationship between rhetorical shape and visual format.
3. **Schema synthesis** — consolidate labels into a formal taxonomy with inclusion criteria per category and a *renderability spec* per modality (each visual format must be implementable as HTML/CSS).
4. **Iterative refinement** — expose the schema to 30 fresh posts, triggering split/merge/add/redefine operations until >85% of posts classify with high confidence.
5. **Full classification** — label all 300 posts with both axes, confidence scores, and evidence trails.
6. **Cross-axis correlation and decision rules** — build the content_type × visual_modality cross-tabulation and extract conditional rules referencing Phase 0 signals.

The key innovation is simultaneous dual-axis induction with a renderability constraint. No prior method produces actionable decision rules mapping post signals to specific visual formats.

## Concept-selection logic

Stage 2 is where schema meets pipeline. The flow:

1. **Signal computation** — deterministic features are extracted from the post text (word count, whether it contains numbers, list structure, questions, metric mentions).
2. **Rule engine** — the decision rules from Workstream B are evaluated against these signals. Each content type's rules are tested in priority order; the first matching rule emits a candidate modality with a confidence score. Catch-all rules (`condition: "true"`) are capped at 50% confidence. Results are deduplicated by modality (keeping highest confidence) and the top 5 candidates are passed forward.
3. **LLM concept generation** — Claude receives the candidate modalities, the full design system (colors, typography, composition rules, prohibitions, signature motifs), and the post text. It generates 2–3 visual concepts as Zod-validated structured output, each specifying modality, headline, subtext, data points, layout description, and color usage.
4. **Best concept selection** — the LLM selects the single strongest concept and explains why. The system prompt is heavily constrained: headlines must be under 10 words in sentence case, subtext under 25 words, no em dashes, no dark backgrounds, 60%+ negative space.

The rule engine acts as a prior — it narrows the modality space from 14+ options to 5 ranked candidates, so the LLM operates within a data-grounded constraint rather than choosing freely.

## Design system as a portfolio

The design system extraction (Stage 1) goes beyond typical CSS token scraping. `design-system.json` captures:

- **Design tokens** — colors (with usage context, not just hex values), typography scale, spacing, border radii, and raw CSS variables.
- **Compositional philosophy** — "editorial restraint and Swiss-design precision," the 60%+ negative space rule, maximum 3 focal elements, left-heavy content placement.
- **Visual density constraints** — no more than 3 text blocks, data points limited to 4–7 items, decorative elements at 0.03–0.20 opacity.
- **Signature motifs** — particle dot networks, warm sand accent bars, square geometry (border-radius: 0px), the FLYWHEEL watermark at near-invisible opacity.
- **Prohibitions** — no gradients on text, no colorful icons, no photography, no rounded cards, no chartreuse (it's in the CSS variables but never rendered on the site).
- **Layout patterns** — left-anchored hero, centered statement, structured data, stacked list — each with content/decorative zone splits and reference compositions.

This goes from "here are some colors and fonts" to "here is the brand's compositional DNA." The concept generator receives all of this, which is why its outputs feel like Flywheel rather than generic LinkedIn graphics.

## Generic pipeline: supporting any brand

The pipeline is now fully generic. When pointed at any company's website, it produces visuals that look like they're from that company. No Flywheel-specific hardcoding remains.

### How it works

1. **Stage 1 extracts brand identity.** When the extractor runs on a new site, it captures `brand_identity` (name, URL, tagline, description) and generates a `decorative_pattern_svg` that matches the site's visual language. These fields are stored in `data/design-system.json` as the single source of truth.

2. **Templates are fully dynamic.** All 9 Handlebars templates use template variables (`{{ds.brandName}}`, `{{ds.brandUrl}}`, `{{{ds.logoSvg}}}`, `{{{ds.decorativePatternSvg}}}`, `{{ds.logoText}}`) instead of any hardcoded brand elements.

3. **The concept generator prompt is data-driven.** The system prompt reads composition rules, prohibitions, motifs, tone, and brand description from the design system JSON. When you switch to a new brand, the prompt automatically reflects that brand's aesthetic.

### Using with a new company

1. Pass the brand URL when running the pipeline or harness (e.g. `https://newcompany.com` in the harness, or `npm run pipeline -- --url https://newcompany.com --post "..."`).
2. Stage 1 re-crawls the target site and produces a new `data/design-system.json` with that brand's identity, colors, typography, and design portfolio.
3. Stages 2–4 automatically use the new brand data.

### Backward compatibility

The existing `data/design-system.json` for Flywheel has all new fields populated with Flywheel-specific data, so the pipeline continues to produce identical Flywheel visuals without any changes.

## What I'd build next

With another week, the priorities would be:

1. **Full Stage 4 eval loop with automated regeneration.** The judge already scores visuals on four axes. The next step is closing the loop: if a visual scores below threshold, feed the critique back into Stage 2 as a system prompt amendment and regenerate, capping at 2 retries. This is the difference between "generate and hope" and "generate, evaluate, improve."

2. **Chart sub-type rendering.** The schema includes modalities like comparison tables, timelines, and two-column process diagrams. These need specialized Handlebars templates with proper data visualization — bar segments, timeline markers, flow arrows — all in pure HTML/CSS.

3. **A/B testing different visual styles per post.** Generate 2–3 final visuals (not just concepts) for each post, score all of them, and let the user pick or auto-select the highest-scoring one.

4. **Expand the template library.** Currently covering ~8 of the 14 modalities with dedicated templates. The remaining 6 fall back to simpler templates. Each deserves a purpose-built Handlebars template with modality-specific layout logic.

5. **Animation and motion for video export.** LinkedIn supports video and GIF. Adding CSS animations (fade-in headlines, counter animations for stats, subtle particle motion) and exporting via Playwright's video recording would produce scroll-stopping content.
