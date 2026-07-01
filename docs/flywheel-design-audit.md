# Flywheel Design Audit

Maps assets in `Flywheel-scraper` to `flywheel-visual-pipeline` gaps and implementations.

**Local clone:** `C:\Users\Shaurya\Documents\GitHub\Flywheel-scraper`  
**Env var:** `FLYWHEEL_SCRAPER_PATH` (optional; defaults to sibling `../Flywheel-scraper`)

## Reference posts

| Format | LinkedIn URL | Pipeline modality | Template |
|--------|--------------|-------------------|----------|
| Mafias | [Chris Pisarski / Cruise Mafia](https://www.linkedin.com/posts/chris-pisarski_the-cruise-mafia-has-raised-more-than-900-activity-7396305736387158016-V8NE) | `mafia_ecosystem_graphic` | `mafia-ecosystem.hbs` |
| Stats | [Peter Wong / impressions](https://www.linkedin.com/posts/peter-wong-flywheel_you-can-get-millions-of-impressions-and-generate-activity-7470196717276073984-GeYT) | `multi_stat_panel` | `flywheel-stat-panel.hbs` |

Save screenshots manually to `data/reference-formats/` (LinkedIn blocks automated fetch).

## Source file mapping

| Flywheel-scraper path | Purpose | Pipeline use |
|----------------------|---------|--------------|
| `Design/infographic-design-system.md` | Cream gradient, glass cards, iOS pills, numbered labels | `src/utils/flywheel-infographic.ts` + templates |
| `Design/tokens.css` | Dark canvas diagram tokens | Not used for feed cards (different use case) |
| `Design/website-components/flywheel-logo.svg` | Brand mark | Loaded into infographic templates |
| `Design/templates/diagrams/GridDiagram.tsx` | Company grid layout | Ported to `mafia-ecosystem.hbs` |
| `Flywheel/Marketing/Instructions/MafiaProcess.md` | Content workflow, Phase 7 designer table | Stage 2 prompt + `data_points` format |
| `Flywheel/Marketing/LinkedIn/Ecosystem/CountryMafias/` | Example mafia post copy | Demo post text |
| `Flywheel/Marketing/Posts/peter-wong.json` | Peter Wong post corpus | Demo post text |

## Not used as primary Stats reference

`clients/ThinkBridge/Design/collateral/stat-square.html` is a **ThinkBridge client** template (1080x1080, orange accent). Layout pattern only, not Flywheel brand.

## Gaps closed in this implementation

1. New `mafia_ecosystem_graphic` modality + template with glass pills and favicons
2. `flywheel-stat-panel.hbs` using production infographic tokens (cream gradient, hero stats)
3. `has_mafia_framing` signal + rule-engine boost for mafia posts
4. `FLYWHEEL_SCRAPER_PATH` + logo loader
5. Demo posts in `src/demo-flywheel-formats.ts`

## Dimension note

Pipeline exports **1200x630** (link preview). Flywheel Design docs often specify 1080x1080 feed squares. Typography scaled proportionally.

## Workstream B

No rerun required. `mafia_ecosystem_graphic` added via manual schema + rule-engine injection.
