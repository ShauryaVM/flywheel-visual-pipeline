import { readFile } from 'node:fs/promises';
import type { DesignSystemData } from '../types/index.js';

let cachedSummary: string | null = null;
let cachedPath: string | null = null;

/**
 * Build a compact prose summary of the design system for Stage 4 eval prompts.
 * Reads brand identity, tokens, composition rules, motifs, and prohibitions
 * from design-system.json (same fields Stage 2 uses).
 */
export function buildDesignSystemSummary(designSystem: DesignSystemData): string {
  const dsAny = designSystem as unknown as Record<string, unknown>;
  const portfolio = dsAny.design_portfolio as Record<string, unknown> | undefined;
  const brandIdentity = designSystem.brand_identity;

  const brandName = brandIdentity?.name || 'the brand';
  const brandUrl = brandIdentity?.url || '';
  const parts: string[] = [`${brandName}${brandUrl ? ` (${brandUrl})` : ''}`];

  if (brandIdentity?.description) {
    parts.push(brandIdentity.description);
  }

  const philosophy = portfolio?.philosophy as string | undefined;
  if (philosophy) {
    parts.push(philosophy);
  } else {
    const tone = (portfolio?.tone as Record<string, unknown> | undefined)?.description as
      | string
      | undefined;
    if (tone) parts.push(`Tone: ${tone}`);
  }

  const { colors } = designSystem;
  parts.push(
    `Colors: primary/text ${colors.primary.hex}, secondary ${colors.secondary.hex}, accent ${colors.accent.hex}, background ${colors.background.hex}.`,
  );

  const families = designSystem.typography.font_families.map((f) => f.family).join(', ');
  const h1 = designSystem.typography.scale.h1;
  const body = designSystem.typography.scale.body;
  if (h1 && body) {
    parts.push(
      `Typography: ${families}. Headings ${h1.font_size} weight ${h1.font_weight}, body ${body.font_size}.`,
    );
  } else {
    parts.push(`Typography: ${families}.`);
  }

  const compositionRules = (portfolio?.composition_rules as string[]) || [];
  if (compositionRules.length > 0) {
    parts.push(`Composition: ${compositionRules.slice(0, 4).join(' ')}`);
  }

  const density = portfolio?.visual_density as Record<string, unknown> | undefined;
  const densityConstraints = (density?.constraints as string[]) || [];
  if (densityConstraints.length > 0) {
    parts.push(`Density: ${densityConstraints.slice(0, 3).join(' ')}`);
  }

  const motifs = portfolio?.motifs as Record<string, Record<string, unknown>> | undefined;
  if (motifs) {
    const motifNames = Object.keys(motifs)
      .map((k) => k.replace(/_/g, ' '))
      .join(', ');
    parts.push(`Signature motifs: ${motifNames}.`);
  }

  const prohibitions = (portfolio?.prohibitions as string[]) || [];
  if (prohibitions.length > 0) {
    const cleaned = prohibitions
      .slice(0, 6)
      .map((p) => p.replace(/^NO\s+/i, '').replace(/\.$/, ''));
    parts.push(`Prohibitions: ${cleaned.join('; ')}.`);
  }

  const radius = designSystem.borders?.radius?.md ?? designSystem.borders?.radius?.sm;
  if (radius) {
    parts.push(`Border radius: ${radius}.`);
  }

  parts.push('Canvas: 1200x630px LinkedIn image dimensions.');

  return parts.join(' ');
}

export async function loadDesignSystemSummary(
  dsPath = 'data/design-system.json',
): Promise<string> {
  if (cachedSummary && cachedPath === dsPath) return cachedSummary;

  const raw = await readFile(dsPath, 'utf-8');
  const designSystem = JSON.parse(raw) as DesignSystemData;
  cachedSummary = buildDesignSystemSummary(designSystem);
  cachedPath = dsPath;
  return cachedSummary;
}

/** Clear cached summary (useful in tests). */
export function clearDesignSystemSummaryCache(): void {
  cachedSummary = null;
  cachedPath = null;
}
