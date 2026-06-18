import { z } from 'zod';

// ---------------------------------------------------------------------------
// Color tokens
// ---------------------------------------------------------------------------
const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{3,8}$/, 'Must be a valid hex color');

export const ColorToken = z.object({
  name: z.string().describe('Semantic name, e.g. "primary", "surface"'),
  hex: HexColor,
  usage: z.string().optional().describe('Where this color is typically used'),
});
export type ColorToken = z.infer<typeof ColorToken>;

export const ColorPalette = z.object({
  primary: HexColor,
  secondary: HexColor.optional(),
  accent: HexColor.optional(),
  background: HexColor,
  surface: HexColor.optional(),
  text: HexColor,
  textSecondary: HexColor.optional(),
  border: HexColor.optional(),
  allExtracted: z
    .array(ColorToken)
    .describe('Every color found on the site, including the above'),
});
export type ColorPalette = z.infer<typeof ColorPalette>;

// ---------------------------------------------------------------------------
// Typography tokens
// ---------------------------------------------------------------------------
export const FontWeight = z.enum([
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
]);

export const FontEntry = z.object({
  family: z.string().describe('Font family name, e.g. "Inter"'),
  weights: z.array(FontWeight).min(1),
  source: z
    .enum(['google-fonts', 'adobe-fonts', 'self-hosted', 'system', 'unknown'])
    .default('unknown'),
  fallback: z.string().optional().describe('CSS fallback stack'),
});
export type FontEntry = z.infer<typeof FontEntry>;

export const Typography = z.object({
  headingFont: FontEntry,
  bodyFont: FontEntry,
  monoFont: FontEntry.optional(),
  baseSizePx: z.number().positive().default(16),
  lineHeight: z.number().positive().default(1.5),
  scale: z
    .array(
      z.object({
        level: z.string().describe('e.g. "h1", "h2", "body", "caption"'),
        sizePx: z.number().positive(),
        weight: FontWeight,
        lineHeight: z.number().positive().optional(),
      }),
    )
    .optional()
    .describe('Type scale extracted from the site'),
});
export type Typography = z.infer<typeof Typography>;

// ---------------------------------------------------------------------------
// Spacing / layout tokens
// ---------------------------------------------------------------------------
export const SpacingTokens = z.object({
  unit: z.number().positive().default(4).describe('Base spacing unit in px'),
  borderRadiusPx: z.number().min(0).default(8),
  containerMaxWidthPx: z.number().positive().optional(),
  sectionPaddingPx: z.number().min(0).optional(),
  cardPaddingPx: z.number().min(0).optional(),
});
export type SpacingTokens = z.infer<typeof SpacingTokens>;

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------
export const LogoInfo = z.object({
  url: z.string().url().optional(),
  altText: z.string().optional(),
  widthPx: z.number().positive().optional(),
  heightPx: z.number().positive().optional(),
  format: z.enum(['svg', 'png', 'jpg', 'webp', 'unknown']).default('unknown'),
  base64: z.string().optional().describe('Base64-encoded logo data for embedding'),
});
export type LogoInfo = z.infer<typeof LogoInfo>;

// ---------------------------------------------------------------------------
// Component patterns
// ---------------------------------------------------------------------------
export const ComponentPattern = z.object({
  name: z.string().describe('e.g. "card", "hero-section", "CTA-button"'),
  cssClasses: z.array(z.string()).optional(),
  borderRadius: z.string().optional(),
  shadow: z.string().optional(),
  notes: z.string().optional(),
});
export type ComponentPattern = z.infer<typeof ComponentPattern>;

// ---------------------------------------------------------------------------
// CSS Variables (raw)
// ---------------------------------------------------------------------------
export const CssVariable = z.object({
  property: z.string().describe('e.g. "--color-primary"'),
  value: z.string(),
  selector: z.string().default(':root'),
});
export type CssVariable = z.infer<typeof CssVariable>;

// ---------------------------------------------------------------------------
// Full design system
// ---------------------------------------------------------------------------
export const DesignSystem = z.object({
  version: z.string().default('1.0.0'),
  sourceUrl: z.string().url(),
  crawledAt: z.string().datetime(),
  colors: ColorPalette,
  typography: Typography,
  spacing: SpacingTokens,
  logo: LogoInfo.optional(),
  components: z.array(ComponentPattern).default([]),
  rawCssVariables: z.array(CssVariable).default([]),
});
export type DesignSystem = z.infer<typeof DesignSystem>;
