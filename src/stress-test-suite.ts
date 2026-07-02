/**
 * Curated posts designed to route each visual modality through Stage 2 signals + rules.
 * Each case uses a different startup URL to stress-test multi-brand crawling/rendering.
 */
export interface StressTestCase {
  id: string;
  startup: string;
  targetUrl: string;
  expectedModality: string;
  /** Primary Handlebars template (fallback modalities map to a parent template). */
  expectedTemplate: string;
  /** If 'strict', rule engine should surface expectedModality in top candidates. */
  routing?: 'strict' | 'forced';
  text: string;
}

export const STRESS_TEST_CASES: StressTestCase[] = [
  {
    id: 'stress-linear-headline',
    startup: 'Linear',
    targetUrl: 'https://linear.app',
    expectedModality: 'headline_subtext_card',
    expectedTemplate: 'headline-subtext-card',
    routing: 'strict',
    text: `CEO Karri Saarinen shared that Linear is opening a design hub in Copenhagen.

A small team will work closer with European customers on workflow and project planning.

More details on the blog this week.`,
  },
  {
    id: 'stress-notion-takeaway',
    startup: 'Notion',
    targetUrl: 'https://notion.so',
    expectedModality: 'key_takeaway_card',
    expectedTemplate: 'key-takeaway-card',
    routing: 'forced',
    text: `After three years building docs inside fast-moving startups, one lesson keeps repeating.

The teams that ship clean knowledge bases do not start with perfect templates. They start with a single source of truth everyone actually opens.

They write short pages, link decisions to owners, and delete stale docs every month.

They treat documentation like product work: small iterations, visible owners, and ruthless pruning.

The takeaway is simple. Clarity compounds when maintenance is scheduled, not hoped for.`,
  },
  {
    id: 'stress-vercel-numbered-list',
    startup: 'Vercel',
    targetUrl: 'https://vercel.com',
    expectedModality: 'numbered_list_graphic',
    expectedTemplate: 'numbered-list-graphic',
    routing: 'strict',
    text: `How we cut preview deploy time for a Series B SaaS team last quarter.

1) Split the monorepo build graph so frontend and API compile in parallel.
2) Cache dependencies per package instead of one global node_modules layer.
3) Promote edge middleware only after smoke tests pass on the preview URL.
4) Gate production merges on Core Web Vitals from the preview environment.
5) Add a rollback playbook every engineer can run in under two minutes.
6) Document the deploy path so support can answer customer questions without paging infra.

Follow these steps and preview environments stop feeling like a tax on iteration.`,
  },
  {
    id: 'stress-stripe-bold',
    startup: 'Stripe',
    targetUrl: 'https://stripe.com',
    expectedModality: 'bold_statement_card',
    expectedTemplate: 'bold-statement-card',
    routing: 'strict',
    text: `Payments infrastructure is not a feature.

It is the floor every serious product stands on.`,
  },
  {
    id: 'stress-anthropic-pull-quote',
    startup: 'Anthropic',
    targetUrl: 'https://anthropic.com',
    expectedModality: 'pull_quote_card',
    expectedTemplate: 'pull-quote-card',
    routing: 'strict',
    text: `Safety and capability have to move together!

That is the line our research leads repeat before every major model release.

If you optimize only for benchmarks, you inherit every failure mode of the open web.`,
  },
  {
    id: 'stress-figma-quote',
    startup: 'Figma',
    targetUrl: 'https://figma.com',
    expectedModality: 'quote_card',
    expectedTemplate: 'quote-card',
    routing: 'forced',
    text: `"Design is the silent salesperson on every screen."

We remind new designers of this on day one.

When hierarchy is obvious, users do not hesitate. They just move.`,
  },
  {
    id: 'stress-ramp-multi-stat',
    startup: 'Ramp',
    targetUrl: 'https://ramp.com',
    expectedModality: 'multi_stat_panel',
    expectedTemplate: 'infographic-stat-panel',
    routing: 'strict',
    text: `Finance teams switched to Ramp and the operating metrics moved in the same direction.

Average month-end close dropped from 8 days to 3 days. Duplicate SaaS spend fell 27%. Receipt capture hit 94% within the first month. Card policy violations decreased 41% quarter over quarter.

Speed and control are not opposites when spend data is live.`,
  },
  {
    id: 'stress-supabase-mafia',
    startup: 'Supabase',
    targetUrl: 'https://supabase.com',
    expectedModality: 'mafia_ecosystem_graphic',
    expectedTemplate: 'mafia-ecosystem',
    routing: 'strict',
    text: `The open-source data mafia keeps getting stronger.

Here are 6 infrastructure companies winning the Postgres ecosystem right now:

1/ Supabase | $2B valuation | supabase.com
2/ Neon | $1B valuation | neon.tech
3/ PlanetScale | $1.5B valuation | planetscale.com
4/ CockroachDB | $5B valuation | cockroachlabs.com
5/ Timescale | $350M raised | timescale.com
6/ Hasura | $200M raised | hasura.io

Concentrated talent around one database creates compounding tooling.

Who else belongs on this list?`,
  },
  {
    id: 'stress-retool-features',
    startup: 'Retool',
    targetUrl: 'https://retool.com',
    expectedModality: 'feature_list_graphic',
    expectedTemplate: 'feature-list-graphic',
    routing: 'forced',
    text: `Why ops teams pick Retool for internal tools.

- Connect Postgres, Snowflake, and REST APIs without boilerplate.
- Drag-and-drop UI blocks with production auth baked in.
- Versioned apps with role-based access per environment.
- Audit logs for every query and component interaction.
- Deploy to cloud or self-host behind your VPC.

Internal software should not take six months to ship.`,
  },
  {
    id: 'stress-mercury-stat-callout',
    startup: 'Mercury',
    targetUrl: 'https://mercury.com',
    expectedModality: 'stat_callout',
    expectedTemplate: 'stat-callout',
    routing: 'forced',
    text: `Startup banking should feel instant.

Mercury customers activate their first account in 11 minutes on average.

That speed matters when payroll and runway decisions cannot wait.`,
  },
  {
    id: 'stress-segment-bar-chart',
    startup: 'Segment',
    targetUrl: 'https://segment.com',
    expectedModality: 'bar_chart',
    expectedTemplate: 'bar-chart',
    routing: 'forced',
    text: `We benchmarked event delivery latency across four CDPs last month.

Segment averaged 42ms per event vs Competitor A at 95ms vs Competitor B at 71ms vs Competitor C at 118ms.

Lower latency means fresher personalization and fewer dropped conversions in the funnel.`,
  },
  {
    id: 'stress-resend-sparkline',
    startup: 'Resend',
    targetUrl: 'https://resend.com',
    expectedModality: 'line_sparkline',
    expectedTemplate: 'line-sparkline',
    routing: 'strict',
    text: `Resend API volume climbed every quarter in 2025.

Q1: 120M emails. Q2: 210M emails. Q3: 340M emails. Q4: 520M emails.

YoY growth accelerated as teams migrated off legacy SMTP providers.`,
  },
  {
    id: 'stress-graphe-donut',
    startup: 'Graphe',
    targetUrl: 'https://graphe.cloud',
    expectedModality: 'pie_donut_chart',
    expectedTemplate: 'pie-donut-chart',
    routing: 'forced',
    text: `We surveyed 500 data teams on how they publish visuals.

34% of teams export static PNGs from notebooks. 28% of teams use BI dashboards only. 22% of teams embed programmatic charts in product. 16% of teams still screenshot slides for social posts.

The share of teams automating visual pipelines is still tiny.`,
  },
  {
    id: 'stress-flywheel-attribution',
    startup: 'Flywheel',
    targetUrl: 'https://flywheelos.com',
    expectedModality: 'attribution_quote_card',
    expectedTemplate: 'pull-quote-card',
    routing: 'strict',
    text: `"Impressions are vanity. Pipeline is the point."

That line from Peter Wong is the filter we use before every founder-led content calendar review.

If a post does not connect to revenue conversations, it is entertainment, not GTM.`,
  },
  {
    id: 'stress-lattice-event',
    startup: 'Lattice',
    targetUrl: 'https://lattice.com',
    expectedModality: 'event_details_card',
    expectedTemplate: 'headline-subtext-card',
    routing: 'strict',
    text: `Join us for People Ops Summit 2026 in San Francisco.

Date: September 18, 2026
Time: 9:00 AM to 5:00 PM PT
Location: Moscone West, Hall B
Register: lattice.com/events/summit-2026

Sessions on performance cycles, manager enablement, and AI-assisted reviews.`,
  },
  {
    id: 'stress-brex-comparison',
    startup: 'Brex',
    targetUrl: 'https://brex.com',
    expectedModality: 'comparison_table',
    expectedTemplate: 'numbered-list-graphic',
    routing: 'strict',
    text: `Corporate card comparison for a 200-person startup.

Brex vs legacy bank programs on the metrics finance leaders ask about first.

1) Setup time: Brex 2 days vs legacy 6 weeks.
2) Receipt capture: Brex 92% vs legacy 41%.
3) Policy enforcement: Brex real-time vs legacy monthly audits.
4) International FX fees: Brex 0% markup vs legacy 3.2% average.

Modern spend platforms should feel like software, not paperwork.`,
  },
  {
    id: 'stress-airtable-timeline',
    startup: 'Airtable',
    targetUrl: 'https://airtable.com',
    expectedModality: 'timeline_graphic',
    expectedTemplate: 'numbered-list-graphic',
    routing: 'forced',
    text: `How Airtable shipped AI Blocks from idea to general availability.

Phase 1 (Jan): prototype with design partners.
Phase 2 (Mar): private beta across 40 workspaces.
Phase 3 (Jun): public beta with usage limits.
Phase 4 (Sep): GA with enterprise controls.

A timeline beats a press release when customers want predictability.`,
  },
  {
    id: 'stress-gusto-checklist',
    startup: 'Gusto',
    targetUrl: 'https://gusto.com',
    expectedModality: 'checklist_graphic',
    expectedTemplate: 'feature-list-graphic',
    routing: 'forced',
    text: `First-week payroll checklist for new HR admins.

[ ] Confirm federal EIN and state tax accounts
[ ] Import employee W-4 and direct deposit forms
[ ] Map pay schedules to departments
[ ] Enable e-verify for new hires
[ ] Run a $0 test payroll before the first live cycle

Miss one step and onboarding confidence drops fast.`,
  },
];

export const STRESS_TEST_MODALITIES = [
  ...new Set(STRESS_TEST_CASES.map((c) => c.expectedModality)),
];
