# Workstream B: Method for Post-Type and Visual-Modality Schema Induction

## Problem Statement

We needed to derive a structured, two-axis schema (content type × visual modality) from 300 real LinkedIn posts. Content type captures the rhetorical shape and purpose of a post; visual modality captures the best-fit visual format for a branded graphic. The schema must produce actionable decision rules that Stage 2 of the pipeline can use to select visuals programmatically, not just descriptive labels.

## Literature Review

We analyzed four methods from the research literature. **TnT-LLM** (Microsoft, KDD 2024) uses SGD-inspired minibatch iteration with lightweight classifier training; we rejected it because the SGD machinery is overkill for 300 posts, Phase 2 classifier training is unnecessary at our scale, and it handles only a single text axis. **Iterative Topic Taxonomy Induction** (arXiv 2510.15125) applies HDBSCAN clustering with iterative LLM labeling; embedding-based clusters group by topic similarity rather than rhetorical structure, and text embeddings cannot capture visual modality. **TopicGPT** (NAACL 2024) generates topics via prompting with evidence-backed assignment; it is single-axis, its "quote as evidence" mechanism does not transfer to visual modality, and it supports merge-only refinement. **LLooM** (Stanford HCI, CHI 2024) performs concept induction via Distill-Cluster-Synthesize-Score; its embedding clustering has the same semantic-similarity problem, operates on a single concept dimension, and has no actionability constraint.

We also examined industry approaches (LinkedIn embeddings, Pinterest Pin2Interest, Netflix contextual bandits, Canva design-type detection, HubSpot content pillars). None handle our specific problem: two correlated axes, prescriptive output, small corpus, and a visual-format actionability constraint.

## Our Method: Dual-Axis Constrained Taxonomy Induction (DACTI)

DACTI is a six-phase pipeline designed specifically for the "post to visual" problem.

**Phase 0, Signal Enrichment.** Extract deterministic structural signals from each post (word count, has_numbers, has_list_structure, has_questions, mentions_metric, engagement_tier, etc.) before any LLM involvement. These signals serve as features for decision rules and reduce LLM hallucination by providing concrete evidence.

**Phase 1, Dual-Axis Open Exploration.** A stratified sample of roughly 40 posts is processed in batches. The LLM proposes both content_type and visual_modality labels simultaneously for each post, with evidence and a correlation note explaining why the pairing makes sense. Simultaneous induction forces the model to reason about the relationship between axes from the start.

**Phase 2, Schema Synthesis.** All Phase 1 labels are consolidated into a formal taxonomy with explicit inclusion criteria per category (borrowed from LLooM). Visual modalities include a "renderability spec," a constraint that each modality must be implementable as HTML/CSS. This is our novel actionability constraint.

**Phase 3, Iterative Refinement.** The schema is exposed to 30 fresh posts (borrowing TnT-LLM's iterative exposure principle, simplified from SGD to 1-2 focused rounds). Posts that do not fit trigger schema modifications: split, merge, add, or redefine. Convergence criterion: >85% of posts classified with high confidence.

**Phase 4, Full Classification with Evidence.** All 300 posts are labeled with both axes, a confidence score, and an evidence trail (borrowing TopicGPT's evidence-backed assignment). Zod-validated structured output ensures consistency.

**Phase 5, Cross-Axis Correlation and Decision Rules.** We build the content_type × visual_modality cross-tabulation and extract conditional decision rules that reference Phase 0 signals (e.g., "if content_type is data_insight AND has_numbers AND mentions_metric, select single_stat_callout"). Rules are validated against labeled data with accuracy percentages. This is what no prior method produces.

**Phase 6, Distribution Analysis.** Report distributions, flag thin or dominant categories, and produce coverage metrics.

## What We Borrowed and What Is Novel

| Source | What We Borrowed |
|---|---|
| TnT-LLM | Iterative refinement via new data exposure |
| TopicGPT | Evidence-backed classification with rationale per label |
| LLooM | Explicit inclusion criteria per concept, seeded axis steering |
| Canva | Structured signal-to-format mapping as target output shape |

**Novel contributions:** dual-axis simultaneous induction, renderability constraint on visual modalities, signal enrichment as decision-rule features, cross-axis decision rule extraction, convergence-driven iteration.

## What Surprised Us

- **"Career / personal milestone" dominated the corpus (52 of 301 posts, 17%).** We expected product or industry commentary to lead, but LinkedIn's professional-celebration culture produced the largest single category — and these posts spread across five different visual modalities, making them the hardest to route with a single rule (top-rules coverage only 84.6%).
- **`headline_subtext_card` became the catch-all modality (60 posts, 20%).** Despite designing 14 distinct modalities, the simplest card format absorbed posts from 12 of 16 content types. This suggests a "long tail" problem: many posts lack the structural signals (lists, stats, quotes) needed to trigger a more specific visual.
- **Inter-rater reliability was moderate (content-type κ = 0.605, visual-modality κ = 0.574), but disagreements were instructive.** Raters agreed most on unambiguous types like `event_promotion_announcement` and `product_feature_pitch`, but frequently confused `industry_news_commentary` with `opinion_hot_take` and `narrative_scenario_case_study` — revealing that rhetorical intent is harder to classify than structural form. Visual modality disagreements often occurred between adjacent formats (e.g., `key_takeaway_card` vs. `numbered_list_graphic`).
- **Engagement correlations were counterintuitive.** `multi_stat_panel` had the highest overall median engagement (2,032) despite being assigned to only 23 posts, while the most-assigned `headline_subtext_card` was middling (median 166). For `opinion_hot_take` posts, `pull_quote_card` (median 2,382) massively outperformed `bold_statement_card` (median 185) — the opposite of what we expected for punchy, contrarian content.
- **Several modalities needed post-hoc splitting or remained dangerously thin.** The original `quote_card` was split into `pull_quote_card` and `attribution_quote_card` during Phase 3 refinement because community recaps quote speakers (needing attribution) while reflections use unattributed pull-quotes. Meanwhile, `two_column_process_diagram` (1 post), `timeline_graphic` (4), `checklist_graphic` (4), and `ranked_list_graphic` (4) each appeared fewer than 5 times — too few for reliable decision rules, and candidates for merge or deprecation.
