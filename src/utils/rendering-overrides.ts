import { createStageLogger } from '../observability/logger.js';

const log = createStageLogger('rendering-overrides');

export interface RenderingOverrides {
  css: string;
  appliedRules: string[];
}

interface CritiqueClassification {
  renderingIssues: string[];
  conceptIssues: string[];
  isRenderingOnly: boolean;
  isConceptOnly: boolean;
  isBoth: boolean;
}

const RENDERING_PATTERNS: Array<{ pattern: RegExp; cssRule: string; description: string }> = [
  {
    pattern: /headline\s*(is\s*)?(too\s+)?small|text\s*(is\s*)?(too\s+)?small|font.*(too\s+)?small|heading\s*(too\s+)?small|title\s*(too\s+)?small/i,
    cssRule: `.headline, .statement, .quote-text, h1 { font-size: clamp(32px, 4vw, 48px) !important; }`,
    description: 'increase headline font-size',
  },
  {
    pattern: /subtext\s*(is\s*)?(too\s+)?small|body\s*text\s*(too\s+)?small|supporting.*small/i,
    cssRule: `.subtext, .subtitle, .supporting-text, p { font-size: clamp(16px, 2vw, 22px) !important; }`,
    description: 'increase subtext font-size',
  },
  {
    pattern: /too\s+faint|too\s+sparse|barely\s+visible|decorative.*faint|pattern.*faint|background.*empty|not\s+enough\s+texture/i,
    cssRule: `.decorative-bg, .decorative-pattern, [class*="decorative"] { opacity: 0.25 !important; }`,
    description: 'increase decorative background opacity',
  },
  {
    pattern: /truncat|overflow|text.*cut\s*off|text.*clip|content.*overflow|doesn.*fit/i,
    cssRule: `.headline, .statement, h1 { overflow-wrap: break-word !important; word-break: break-word !important; } .content, .text-side { overflow: visible !important; }`,
    description: 'add overflow handling for text',
  },
  {
    pattern: /too\s+much\s+whitespace|excessive\s+padding|too\s+much\s+space|wasted\s+space|empty\s+space/i,
    cssRule: `.content, .text-side { padding: 36px 48px !important; } .card-inner { padding: 28px 36px !important; }`,
    description: 'reduce padding to use space better',
  },
  {
    pattern: /too\s+cramped|not\s+enough\s+space|crowded|elements.*overlap|too\s+tight|needs?\s+more\s+spacing/i,
    cssRule: `.content, .text-side { padding: 56px 72px !important; gap: 24px !important; } .data-point, .stat-item, .list-item { margin-bottom: 16px !important; }`,
    description: 'increase spacing between elements',
  },
  {
    pattern: /low\s+contrast|hard\s+to\s+read|illegible|poor\s+readability|text.*against/i,
    cssRule: `.headline, .statement, h1, .stat-value { text-shadow: 0 1px 3px rgba(0,0,0,0.08) !important; }`,
    description: 'improve text contrast and readability',
  },
  {
    pattern: /stat.*small|number.*small|metric.*small|data.*hard\s+to\s+read/i,
    cssRule: `.stat-value, .metric, .stat-number, [class*="stat"] { font-size: clamp(28px, 4vw, 44px) !important; font-weight: 700 !important; }`,
    description: 'increase stat/metric font-size',
  },
  {
    pattern: /visual\s+artifact|black\s+(line|bar|rect|shape|block)|rendering\s+(issue|problem|glitch|artifact)|opaque.*element|obscur/i,
    cssRule: `.decorative-bg svg *, .decorative-pattern svg * { max-width: 50% !important; opacity: 0.15 !important; } .decorative-bg svg rect, .decorative-pattern svg rect { display: none !important; }`,
    description: 'suppress decorative SVG artifacts',
  },
  {
    pattern: /hierarchy.*unclear|no\s+clear\s+hierarchy|flat.*hierarchy|same\s+visual\s+weight/i,
    cssRule: `.headline, h1 { font-size: 48px !important; font-weight: 700 !important; margin-bottom: 16px !important; } .subtext, .subtitle { font-size: 18px !important; font-weight: 400 !important; opacity: 0.8 !important; }`,
    description: 'strengthen visual hierarchy',
  },
  {
    pattern: /brand.*watermark.*missing|no\s+logo|logo.*missing|brand\s+identity.*weak/i,
    cssRule: `.brand-watermark, .logo-container { opacity: 0.6 !important; display: flex !important; }`,
    description: 'ensure brand watermark visibility',
  },
];

const CONCEPT_PATTERNS: RegExp[] = [
  /wrong\s+modality|different\s+format|should\s+(be|use)\s+a/i,
  /headline.*weak|headline.*generic|headline.*boring|headline.*vague/i,
  /data\s+points?\s*(are\s*)?(poorly\s+)?select|wrong\s+data|irrelevant\s+stat/i,
  /layout\s*(is\s*)?(wrong|bad|poor)|composition.*wrong|arrangement.*poor/i,
  /doesn.*match.*brand|off.brand|not.*on.brand|brand.*mismatch/i,
  /content.*irrelevant|message.*unclear|narrative.*weak/i,
  /too\s+generic|needs?\s+more\s+personality|bland|cookie.cutter/i,
  /chart.*wrong|wrong\s+chart\s+type|should.*chart/i,
];

/**
 * Classify a critique into rendering issues vs concept issues.
 */
export function classifyCritique(critique: string): CritiqueClassification {
  const renderingIssues: string[] = [];
  const conceptIssues: string[] = [];

  for (const { pattern, description } of RENDERING_PATTERNS) {
    if (pattern.test(critique)) {
      renderingIssues.push(description);
    }
  }

  for (const pattern of CONCEPT_PATTERNS) {
    const match = critique.match(pattern);
    if (match) {
      conceptIssues.push(match[0]);
    }
  }

  // If no specific matches, classify based on general language
  if (renderingIssues.length === 0 && conceptIssues.length === 0) {
    // Default: assume concept issue if we can't categorize
    conceptIssues.push('general improvement needed');
  }

  return {
    renderingIssues,
    conceptIssues,
    isRenderingOnly: renderingIssues.length > 0 && conceptIssues.length === 0,
    isConceptOnly: renderingIssues.length === 0 && conceptIssues.length > 0,
    isBoth: renderingIssues.length > 0 && conceptIssues.length > 0,
  };
}

/**
 * Parse a critique and generate CSS overrides for rendering issues.
 * Returns null if no rendering issues are detected.
 */
export function generateRenderingOverrides(critique: string): RenderingOverrides | null {
  const cssRules: string[] = [];
  const appliedRules: string[] = [];

  for (const { pattern, cssRule, description } of RENDERING_PATTERNS) {
    if (pattern.test(critique)) {
      cssRules.push(cssRule);
      appliedRules.push(description);
    }
  }

  if (cssRules.length === 0) return null;

  const css = `\n/* Rendering overrides from feedback critique */\n${cssRules.join('\n')}`;
  log.info({ overrideCount: appliedRules.length, rules: appliedRules }, 'Generated rendering overrides from critique');

  return { css, appliedRules };
}

/**
 * Apply CSS rendering overrides to an existing HTML string.
 * Injects the override CSS just before </style>.
 */
export function applyRenderingOverrides(html: string, overrides: RenderingOverrides): string {
  if (!overrides.css) return html;

  // Inject before the last </style> tag
  const lastStyleClose = html.lastIndexOf('</style>');
  if (lastStyleClose === -1) {
    // No style tag found, wrap in a style block before </head>
    const headClose = html.indexOf('</head>');
    if (headClose === -1) return html;
    return html.slice(0, headClose) + `<style>${overrides.css}</style>\n` + html.slice(headClose);
  }

  return html.slice(0, lastStyleClose) + overrides.css + '\n  ' + html.slice(lastStyleClose);
}
