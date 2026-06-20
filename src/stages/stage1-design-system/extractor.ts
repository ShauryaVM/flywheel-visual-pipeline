import Anthropic from '@anthropic-ai/sdk';
import { createStageLogger } from '../../observability/logger.js';
import type { RawCrawlData, ElementStyleData, PageScreenshot } from './crawler.js';
import type { DesignPortfolio, BrandAssets } from '../../types/index.js';

const log = createStageLogger('stage1:extractor');

// ---------------------------------------------------------------------------
// Output type matching the target design system JSON structure
// ---------------------------------------------------------------------------

export interface BrandIdentity {
  name: string;
  url: string;
  tagline: string;
  logo_text: string;
  description: string;
  decorative_pattern_svg: string;
}

export interface DesignSystemOutput {
  metadata: {
    source_url: string;
    crawled_at: string;
    pages_analyzed: string[];
  };
  brand_identity?: BrandIdentity;
  colors: {
    primary: { hex: string; usage: string };
    secondary: { hex: string; usage: string };
    accent: { hex: string; usage: string };
    background: { hex: string; usage: string };
    text: { hex: string; usage: string };
    palette: Array<{ hex: string; name?: string; usage_context: string }>;
  };
  typography: {
    font_families: Array<{ family: string; weights: string[]; source: string }>;
    scale: Record<
      string,
      {
        font_family: string;
        font_size: string;
        font_weight: string;
        line_height: string;
        color: string;
      }
    >;
  };
  spacing: {
    unit: string;
    scale: Record<string, string>;
  };
  borders: {
    radius: Record<string, string>;
    widths: string[];
    colors: string[];
  };
  logo: {
    url: string;
    svg_data?: string;
    dimensions?: { width: number; height: number };
  };
  components: {
    buttons: Array<{ variant: string; styles: Record<string, string> }>;
    cards: Array<{ variant: string; styles: Record<string, string> }>;
    badges: Array<{ variant: string; styles: Record<string, string> }>;
    sections: Array<{ variant: string; styles: Record<string, string> }>;
  };
  css_variables: Record<string, string>;
  raw_tokens: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API — try Claude first, fall back to local heuristics
// ---------------------------------------------------------------------------

export async function analyzeDesignSystem(
  rawData: RawCrawlData,
  apiKey: string,
  portfolio?: DesignPortfolio,
): Promise<DesignSystemOutput> {
  let result: DesignSystemOutput;
  try {
    result = await analyzeWithClaude(rawData, apiKey);
  } catch (err) {
    log.warn(
      { error: (err as Error).message },
      'Claude analysis failed, falling back to local heuristic analysis',
    );
    result = analyzeLocally(rawData);
  }

  validateAccentWithVision(result, portfolio, rawData);

  // Apply real brand assets from DOM extraction
  const brandAssets = rawData.brandAssets;
  if (brandAssets) {
    applyBrandAssets(result, brandAssets);
  }

  if (!result.brand_identity) {
    try {
      result.brand_identity = await extractBrandIdentity(rawData, result, apiKey, portfolio);
      log.info({ brandName: result.brand_identity.name }, 'Brand identity extracted');
    } catch (err) {
      log.warn(
        { error: (err as Error).message },
        'Brand identity extraction failed, using fallback',
      );
      result.brand_identity = buildFallbackBrandIdentity(rawData, result);
    }
  }

  // Override the Claude-generated decorative SVG if a real decorative SVG was found
  if (brandAssets && result.brand_identity) {
    overrideDecorativeSvg(result.brand_identity, brandAssets);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Apply real brand assets extracted from the DOM
// ---------------------------------------------------------------------------

function applyBrandAssets(result: DesignSystemOutput, assets: BrandAssets): void {
  // Replace logo with real extracted logo
  if (assets.logo) {
    if (assets.logo.svg) {
      result.logo = {
        url: assets.logo.imgUrl || '',
        svg_data: assets.logo.svg,
        dimensions: result.logo?.dimensions,
      };
      log.info({ source: assets.logo.source }, 'Logo replaced with real SVG from DOM');
    } else if (assets.logo.imgUrl) {
      result.logo = {
        url: assets.logo.imgUrl,
        svg_data: assets.logo.imgBase64
          ? `<!-- base64 image: ${assets.logo.imgUrl} -->`
          : result.logo?.svg_data,
        dimensions: result.logo?.dimensions,
      };
      log.info({ source: assets.logo.source, url: assets.logo.imgUrl }, 'Logo URL set from DOM');
    }
  }

  // Use real gradients for hero/background styling
  if (assets.gradients.length > 0) {
    const heroGradient = assets.gradients.find(
      (g) => g.context.toLowerCase().includes('hero') || g.context.toLowerCase().includes('section'),
    ) ?? assets.gradients[0]!;
    log.info(
      { gradient: heroGradient.css.slice(0, 80), context: heroGradient.context },
      'Real gradient found from DOM',
    );
  }

  // Log animation/motion data
  const realAnimations = assets.animations.filter((a) => a.keyframes);
  if (realAnimations.length > 0) {
    log.info(
      { count: realAnimations.length, names: realAnimations.map((a) => a.name).slice(0, 5) },
      'CSS animations extracted from DOM',
    );
  }
}

function overrideDecorativeSvg(brandIdentity: BrandIdentity, assets: BrandAssets): void {
  if (assets.decorativeSvgs.length > 0) {
    const candidates = assets.decorativeSvgs.filter((s) => {
      const hasShapeElements = /<(circle|ellipse|rect|path|polygon|line|polyline)\b/.test(s.svg);
      if (!hasShapeElements) {
        log.debug(
          { context: s.context },
          'Skipping DOM SVG with no visible shape elements (filter/defs only)',
        );
        return false;
      }

      // Reject SVGs with suspicious elements (video player controls, iframes)
      if (/<(video|iframe)\b/i.test(s.svg)) {
        log.debug({ context: s.context }, 'Skipping DOM SVG containing video/iframe elements');
        return false;
      }
      if (/<image\b[^>]*href\s*=\s*["']https?:\/\//i.test(s.svg)) {
        log.debug({ context: s.context }, 'Skipping DOM SVG with external image reference');
        return false;
      }

      // Reject SVGs that have oversized opaque elements
      if (hasOversizedOpaqueElements(s.svg, s.dimensions.width, s.dimensions.height)) {
        log.debug({ context: s.context }, 'Skipping DOM SVG with oversized opaque element (>20% coverage)');
        return false;
      }

      // Reject SVGs that contain play-button-like triangles
      if (hasPlayButtonTriangle(s.svg, s.dimensions.width, s.dimensions.height)) {
        log.debug({ context: s.context }, 'Skipping DOM SVG with play-button-like triangle');
        return false;
      }

      return true;
    });

    if (candidates.length === 0) return;

    const best = candidates.reduce((a, b) =>
      (a.dimensions.width * a.dimensions.height) >= (b.dimensions.width * b.dimensions.height) ? a : b,
    );

    if (best.dimensions.width >= 200 || best.dimensions.height >= 200) {
      brandIdentity.decorative_pattern_svg = best.svg;
      log.info(
        { context: best.context, w: best.dimensions.width, h: best.dimensions.height },
        'Decorative SVG replaced with real DOM asset',
      );
    }
  }
}

/**
 * Check if an SVG contains any rect or path covering > 20% of the viewbox
 * with opacity > 0.5 (a solid-looking large shape that would obscure content).
 */
function hasOversizedOpaqueElements(svg: string, vbWidth: number, vbHeight: number): boolean {
  const viewboxArea = (vbWidth || 1200) * (vbHeight || 630);

  // Check <rect> elements
  const rectPattern = /<rect\b([^>]*)\/?>(\s*<\/rect>)?/gi;
  let match;
  while ((match = rectPattern.exec(svg)) !== null) {
    const attrs = match[1] || '';
    const wMatch = attrs.match(/width\s*=\s*["']([\d.]+)/);
    const hMatch = attrs.match(/height\s*=\s*["']([\d.]+)/);
    if (!wMatch || !hMatch) continue;

    const w = parseFloat(wMatch[1]!);
    const h = parseFloat(hMatch[1]!);
    const rectArea = w * h;

    if (rectArea / viewboxArea > 0.20) {
      const opacityMatch = attrs.match(/opacity\s*=\s*["']([\d.]+)["']/);
      const opacity = opacityMatch ? parseFloat(opacityMatch[1]!) : 1;
      const fillMatch = attrs.match(/fill\s*=\s*["']([^"']+)["']/);
      const fill = fillMatch?.[1] || '';
      const isTransparent = fill === 'none' || fill === 'transparent';

      if (!isTransparent && opacity > 0.5) {
        return true;
      }
    }
  }

  // Check <path> elements for large bounding boxes by parsing simple path data
  const pathPattern = /<path\b([^>]*)\/?>(\s*<\/path>)?/gi;
  while ((match = pathPattern.exec(svg)) !== null) {
    const attrs = match[1] || '';
    const dMatch = attrs.match(/d\s*=\s*["']([^"']+)["']/);
    if (!dMatch) continue;

    const pathBounds = estimatePathBounds(dMatch[1]!);
    if (!pathBounds) continue;

    const pathArea = pathBounds.width * pathBounds.height;
    if (pathArea / viewboxArea > 0.20) {
      const opacityMatch = attrs.match(/opacity\s*=\s*["']([\d.]+)["']/);
      const opacity = opacityMatch ? parseFloat(opacityMatch[1]!) : 1;
      const fillMatch = attrs.match(/fill\s*=\s*["']([^"']+)["']/);
      const fill = fillMatch?.[1] || '';
      const isTransparent = fill === 'none' || fill === 'transparent';

      if (!isTransparent && opacity > 0.5) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if an SVG contains a triangle (polygon with 3 points) that looks like a play button.
 */
function hasPlayButtonTriangle(svg: string, vbWidth: number, vbHeight: number): boolean {
  const viewboxArea = (vbWidth || 1200) * (vbHeight || 630);

  const polygonPattern = /<polygon\b([^>]*)\/?>(\s*<\/polygon>)?/gi;
  let match;
  while ((match = polygonPattern.exec(svg)) !== null) {
    const attrs = match[1] || '';
    const pointsMatch = attrs.match(/points\s*=\s*["']([^"']+)["']/);
    if (!pointsMatch) continue;

    const coords = pointsMatch[1]!.trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
    if (coords.length === 6) {
      const xs = [coords[0]!, coords[2]!, coords[4]!];
      const ys = [coords[1]!, coords[3]!, coords[5]!];
      const triWidth = Math.max(...xs) - Math.min(...xs);
      const triHeight = Math.max(...ys) - Math.min(...ys);
      const triArea = (triWidth * triHeight) / 2;

      if (triArea / viewboxArea > 0.01) {
        return true;
      }
    }
  }

  // Also check <path> elements that are simple triangles (M..L..L..Z with 3 points)
  const pathPattern = /<path\b([^>]*)\/?>(\s*<\/path>)?/gi;
  while ((match = pathPattern.exec(svg)) !== null) {
    const attrs = match[1] || '';
    const dMatch = attrs.match(/d\s*=\s*["']([^"']+)["']/);
    if (!dMatch) continue;

    const d = dMatch[1]!.trim();
    // Simple triangle: M x y L x y L x y Z
    const triMatch = d.match(/^M\s*[\d.]+[\s,]+[\d.]+\s*L\s*[\d.]+[\s,]+[\d.]+\s*L\s*[\d.]+[\s,]+[\d.]+\s*Z?$/i);
    if (triMatch) {
      const nums = d.match(/[\d.]+/g)?.map(Number) || [];
      if (nums.length >= 6) {
        const xs = [nums[0]!, nums[2]!, nums[4]!];
        const ys = [nums[1]!, nums[3]!, nums[5]!];
        const triWidth = Math.max(...xs) - Math.min(...xs);
        const triHeight = Math.max(...ys) - Math.min(...ys);
        const triArea = (triWidth * triHeight) / 2;

        if (triArea / viewboxArea > 0.01) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Estimate the bounding box of an SVG path from its d attribute (approximate).
 */
function estimatePathBounds(d: string): { width: number; height: number } | null {
  const nums = d.match(/-?[\d.]+/g);
  if (!nums || nums.length < 4) return null;

  const values = nums.map(Number).filter(n => !isNaN(n) && Math.abs(n) < 10000);
  if (values.length < 4) return null;

  // Take alternating values as x and y coordinates
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i % 2 === 0) xs.push(values[i]!);
    else ys.push(values[i]!);
  }

  if (xs.length < 2 || ys.length < 2) return null;

  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  return { width, height };
}

// ---------------------------------------------------------------------------
// Brand identity extraction — uses Claude to infer brand name, tagline, etc.
// ---------------------------------------------------------------------------

async function extractBrandIdentity(
  rawData: RawCrawlData,
  designSystem: DesignSystemOutput,
  apiKey: string,
  portfolio?: DesignPortfolio,
): Promise<BrandIdentity> {
  const client = new Anthropic({ apiKey });

  const siteUrl = designSystem.metadata.source_url || rawData.pages[0]?.url || '';
  const pageTitles = rawData.pages.map((p) => p.title).filter(Boolean);
  const logoText = rawData.logoCandidates
    .filter((l) => l.source.includes('text-logo'))
    .map((l) => l.alt)
    .filter(Boolean);
  const headings = rawData.pages
    .flatMap((p) => p.elements.filter((e) => e.selector === 'h1' || e.selector === 'h2'))
    .map((e) => e.textPreview)
    .filter(Boolean)
    .slice(0, 10);

  const portfolioContext = portfolio
    ? `\nVisual Portfolio Analysis (from screenshot analysis):
- Illustration style: ${portfolio.illustration_style}
- Visual motifs: ${portfolio.visual_motifs.join(', ')}
- Signature elements: ${portfolio.signature_elements.join(', ')}
- Background style: ${portfolio.background_style}
- Accent treatment: ${portfolio.accent_treatment}`
    : '';

  const svgTechniqueGuide = portfolio
    ? buildSvgTechniqueGuide(portfolio, designSystem)
    : '';

  const prompt = `Analyze this website data and produce a brand identity JSON object.

Website URL: ${siteUrl}
Page titles: ${JSON.stringify(pageTitles)}
Logo text found: ${JSON.stringify(logoText)}
Key headings: ${JSON.stringify(headings)}
Logo SVG available: ${!!designSystem.logo.svg_data}
Primary color: ${designSystem.colors.primary.hex}
Accent color: ${designSystem.colors.accent.hex}
Background color: ${designSystem.colors.background.hex}
${portfolioContext}

## CRITICAL: Decorative Pattern SVG Generation

Generate a decorative SVG (1200x630px) that is a HIGH-FIDELITY reproduction of this brand's ACTUAL visual motifs. The SVG must be immediately recognizable as belonging to this specific brand.

${portfolio ? `### Brand Visual Identity (from screenshot analysis):
- Visual motifs: ${portfolio.visual_motifs.join(', ')}
- Illustration style: ${portfolio.illustration_style}
- Signature elements: ${portfolio.signature_elements.join(', ')}

### SVG Technical Requirements:
${svgTechniqueGuide}

### Density & Composition (CRITICAL — READ CAREFULLY):
The decorative pattern must be RICH and PRESENT — a professional designer would call this a "textured background", NOT an empty canvas with a few scattered dots. Generate MANY elements. The pattern should be dense enough that zooming into ANY 200x200px section of the canvas reveals multiple elements. Think of it like a subtle wallpaper pattern — consistently dense, never sparse.

- Follow the EXACT element counts specified in the technique guide above — these are MINIMUM requirements
- Distribute elements across the FULL 1200x630 canvas — no large empty zones
- Natural clustering: denser at corners/edges (60%), sparser in center where text goes (40%)
- Opacity keeps it readable: most elements at 0.04-0.12, a few anchors at 0.12-0.20
- The result should feel TEXTURED and PROFESSIONAL, not minimal or anemic

### Color Palette for SVG:
- Primary: ${designSystem.colors.primary.hex}
- Accent: ${designSystem.colors.accent.hex}
- Background: ${designSystem.colors.background.hex}
- Use the brand's ACTUAL colors, not black/white placeholders
- Mix primary and accent colors at varying low opacities
- ONLY use colors explicitly listed above (primary, accent, background) — do NOT pull colors from CSS variables or other sources` : `Consider the site's aesthetic and generate a DENSE decorative pattern using the brand colors.
- Primary: ${designSystem.colors.primary.hex}
- Accent: ${designSystem.colors.accent.hex}
- Generate at LEAST 60-80 SVG elements (circles, lines, or shapes depending on the brand aesthetic)
- The pattern should be dense enough that any 200x200px section has multiple elements
- Distribute across the full 1200x630 canvas with natural clustering (denser at edges, sparser in center)
- Keep element opacities in range 0.03-0.15 so text remains readable when overlaid
- ONLY use colors explicitly listed above — do NOT pull colors from CSS variables or other sources`}

### SVG Constraints:
- Viewbox: width="1200" height="630"
- Must be valid SVG that can be injected as innerHTML of a positioned div
- No external references (no xlink:href to external files)
- No <script> tags
- Can use <defs> for gradients, filters, patterns
- NO xmlns:xlink attribute needed (just xmlns="http://www.w3.org/2000/svg")

Return ONLY a JSON object with these fields:
{
  "name": "Company Name",
  "url": "domain.com (no protocol)",
  "tagline": "Their main tagline or value proposition",
  "logo_text": "BRAND NAME (uppercase version for watermarks)",
  "description": "1-2 sentence description of what the company does and its brand personality",
  "decorative_pattern_svg": "<svg width=\\"1200\\" height=\\"630\\" xmlns=\\"http://www.w3.org/2000/svg\\">...brand-specific pattern using ONLY the technique described above...</svg>"
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
    system: `You are an expert brand designer and SVG artist. You generate decorative SVG patterns that are high-fidelity reproductions of a brand's actual visual language. Your SVGs are DENSE, DETAILED, and DISTINCTIVE — never generic or sparse. Return only valid JSON, no markdown fences or explanation.`,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response for brand identity');
  }

  let jsonStr = textBlock.text.trim();
  const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch?.[1]) jsonStr = fenceMatch[1];

  return JSON.parse(jsonStr) as BrandIdentity;
}

function buildSvgTechniqueGuide(
  portfolio: DesignPortfolio,
  designSystem: DesignSystemOutput,
): string {
  const motifs = portfolio.visual_motifs.join(' ').toLowerCase();
  const style = portfolio.illustration_style.toLowerCase();
  const signatures = portfolio.signature_elements.join(' ').toLowerCase();
  const all = `${motifs} ${style} ${signatures}`;

  // Score each technique and pick the BEST match (exclusive)
  const candidates: Array<{ score: number; name: string; guide: string }> = [];

  // Particle/Dot technique
  let score = 0;
  if (all.includes('particle')) score += 3;
  if (all.includes('dot')) score += 2;
  if (all.includes('constellation')) score += 3;
  if (all.includes('scatter')) score += 2;
  if (all.includes('dot-grid')) score += 2;
  if (all.includes('floating')) score += 1;
  if (score > 0) {
    candidates.push({ score, name: 'particle_dot', guide: `**USE THIS TECHNIQUE — Particle/Dot Field:**
- Generate 80-120 <circle> elements of varying sizes:
  - ~70% small particles (r="2" to r="6"): opacity 0.08-0.15 — clearly visible as texture
  - ~25% medium particles (r="7" to r="12"): opacity 0.10-0.20 — noticeable mid-range dots
  - ~5% large "anchor" circles (r="13" to r="25"): opacity 0.06-0.12 — subtle depth anchors
- Add 20-40 <line> elements connecting nearby particles:
  - stroke-width: 0.8-1.5px
  - Only connect circles within ~80-150px of each other
  - Connection opacity: 0.08-0.15 — visible constellation/network lines
- Distribute across full 1200x630 canvas with NATURAL CLUSTERING:
  - Denser clusters in corners and edges (60% of elements)
  - Sparser in center area (where text overlay goes)
  - Create 3-5 distinct cluster zones with 15-25 circles each
- The overall effect should be a VISIBLE constellation network — a clearly textured background, NOT invisible whispers of dots
- DO NOT include geometric shapes, rectangles, polygons, or gradient blobs
- ONLY circles and connecting lines
- Colors: ${designSystem.colors.primary.hex} for dots, ${designSystem.colors.accent.hex} for some connecting lines
- TOTAL ELEMENT COUNT: aim for 100-160 SVG elements (circles + lines combined)` });
  }

  // Node-Graph/Network technique
  score = 0;
  if (all.includes('node')) score += 3;
  if (all.includes('graph')) score += 3;
  if (all.includes('network')) score += 3;
  if (all.includes('wireframe')) score += 3;
  if (all.includes('sphere')) score += 2;
  if (all.includes('3d')) score += 2;
  if (all.includes('connected')) score += 1;
  if (all.includes('data point')) score += 2;
  if (score > 0) {
    candidates.push({ score, name: 'node_graph', guide: `**USE THIS TECHNIQUE — Node-Graph/Network:**
- Generate 30-50 <circle> node elements with hierarchical sizing:
  - 5-8 "hub" nodes: r="8" to r="12" (major connection points)
  - 15-25 "branch" nodes: r="4" to r="7" (secondary nodes)
  - 10-17 "leaf" nodes: r="2" to r="4" (terminal/detail nodes)
- Connect nodes with 40-60 <line> or curved <path> edges:
  - stroke-width: 0.5-1.5px
  - Include 5-10 dashed lines (stroke-dasharray="4 4") for visual variety
  - Hub-to-hub connections: slightly thicker (1-1.5px)
  - Leaf connections: thinner (0.5-0.8px)
- Create a structured network layout spanning the full 1200x630 canvas:
  - 2-3 major network clusters connected by long-distance edges
  - Avoid empty zones — every 200x200px area should have at least 2-3 nodes
- Opacity: connections at 0.04-0.10, nodes at 0.08-0.20
- DO NOT include gradient blobs, rectangles, or blur filters
- ONLY circles (nodes) and lines/paths (edges)
- Colors: ${designSystem.colors.primary.hex} for nodes, ${designSystem.colors.accent.hex} for edges
- TOTAL ELEMENT COUNT: aim for 80-110 SVG elements (circles + lines/paths combined)` });
  }

  // Gradient Blob/Atmospheric technique
  score = 0;
  if (all.includes('gradient') && (all.includes('radial') || all.includes('blob') || all.includes('soft'))) score += 4;
  if (all.includes('blob')) score += 3;
  if (all.includes('atmospheric')) score += 3;
  if (all.includes('glow')) score += 2;
  if (all.includes('radial') && all.includes('soft')) score += 3;
  if (all.includes('lavender') || all.includes('lilac') || all.includes('rose') || all.includes('mauve')) score += 2;
  if (all.includes('bloom')) score += 2;
  if (score > 0) {
    candidates.push({ score, name: 'gradient_blob', guide: `**USE THIS TECHNIQUE — Soft Gradient Blobs (ONLY):**
- Use <defs> to define 5-8 <radialGradient> elements with multiple color stops each (3-4 stops per gradient)
- Generate 5-8 large <ellipse> elements (rx=200-500, ry=150-350):
  - Position at corners, edges, AND 1-2 near center for full coverage
  - Overlap blobs — at least 3-4 should partially overlap for color mixing
  - Vary ellipse rotation with transform="rotate(...)" for organic feel
- Apply <filter><feGaussianBlur stdDeviation="40-80"/></filter> for very soft edges
- Opacity guidance — choose based on brand context:
  - If the brand's background IS gradient blobs (i.e. the blobs are the defining visual, not subtle accents), use HIGHER opacities so they're clearly visible:
    - Corner/edge blobs: 0.30-0.50 (prominent, clearly visible)
    - Center blobs: 0.20-0.35 (slightly subtler near text but still present)
  - If the blobs are subtle background accents only:
    - Corner blobs: 0.20-0.35
    - Center blobs: 0.10-0.20
- Add 8-15 tiny <circle> elements (r="2" to r="6", opacity 0.05-0.12) scattered as "dust" for texture
- NO hard edges, NO lines, NO geometric shapes, NO nodes
- PURELY atmospheric — soft overlapping color clouds with dust particles
- Colors: ${designSystem.colors.primary.hex} and ${designSystem.colors.accent.hex} tones
- The result should look like a gentle out-of-focus light photograph with subtle texture
- TOTAL ELEMENT COUNT: 15-25 SVG elements (ellipses + dust circles)` });
  }

  // Geometric Pattern technique
  score = 0;
  if (all.includes('geometric')) score += 3;
  if (all.includes('angular')) score += 2;
  if (all.includes('polygon')) score += 2;
  if (all.includes('grid') && !all.includes('dot-grid')) score += 2;
  if (all.includes('precise')) score += 1;
  if (score > 0) {
    candidates.push({ score, name: 'geometric', guide: `**USE THIS TECHNIQUE — Geometric Pattern:**
- Generate 20-40 geometric shapes using <rect>, <polygon>, <path>:
  - 8-15 rectangles with varying sizes (20-120px) and rotations (transform="rotate(15-75)")
  - 6-12 triangles/polygons at different scales
  - 5-10 <path> elements for decorative lines, arcs, or angular swoops
- Add 10-20 thin grid/alignment lines spanning partial canvas width/height:
  - stroke-width: 0.3-1px, opacity 0.03-0.08
  - Some horizontal, some vertical, some diagonal
- Distribute across full 1200x630 canvas:
  - Denser arrangement at corners and edges
  - Sparser in center (text area)
  - Use varying rotations (0°, 15°, 30°, 45°, 60°, 90°) for dynamic feel
- Use thin strokes (0.5-1.5px) with no fill or very low-opacity fills (0.03-0.12)
- DO NOT include blobs, gradients, or blurred elements
- Colors: ${designSystem.colors.primary.hex} and ${designSystem.colors.accent.hex}
- TOTAL ELEMENT COUNT: aim for 40-70 SVG elements (shapes + grid lines combined)` });
  }

  // Sort by score and pick the best match
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return `**Decorative Technique (match the brand's actual visual style):**
- Analyze the motifs: "${portfolio.visual_motifs.join(', ')}"
- Generate SVG elements that reproduce ONLY those specific motifs
- Use brand colors: ${designSystem.colors.primary.hex}, ${designSystem.colors.accent.hex}
- Keep opacities in range 0.03-0.15
- Generate AT LEAST 60-100 elements distributed across the full 1200x630 canvas
- Ensure EVERY 200x200px region of the canvas contains multiple elements — no empty zones
- Include size variation (small detail elements + a few larger anchor elements for depth)`;
  }

  const best = candidates[0]!;
  const excluded = candidates.slice(1).map(c => c.name).join(', ');

  return `${best.guide}

**IMPORTANT: Use ONLY the technique above. DO NOT mix in elements from other styles${excluded ? ` (no ${excluded} elements)` : ''}. The SVG should be purely one visual language.**`;
}

function buildFallbackBrandIdentity(
  rawData: RawCrawlData,
  designSystem: DesignSystemOutput,
): BrandIdentity {
  const siteUrl = designSystem.metadata.source_url || rawData.pages[0]?.url || '';
  const hostname = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const textLogo = rawData.logoCandidates.find((l) => l.source.includes('text-logo'));
  const name = textLogo?.alt || hostname.split('.')[0] || 'Brand';
  const capitalName = name.charAt(0).toUpperCase() + name.slice(1);

  return {
    name: capitalName,
    url: hostname,
    tagline: '',
    logo_text: capitalName.toUpperCase(),
    description: `${capitalName} — brand visual identity extracted from ${hostname}.`,
    decorative_pattern_svg: generateFallbackPatternSvg(),
  };
}

function generateFallbackPatternSvg(): string {
  const elements: string[] = [];
  const rng = (min: number, max: number) => Math.floor(Math.random() * (max - min)) + min;

  for (let i = 0; i < 100; i++) {
    const cx = rng(20, 1180);
    const cy = rng(15, 615);
    const r = i < 5 ? rng(15, 25) : i < 25 ? rng(6, 12) : rng(2, 5);
    const opacity = i < 5
      ? (rng(3, 6) / 100).toFixed(2)
      : i < 25
        ? (rng(6, 12) / 100).toFixed(2)
        : (rng(4, 10) / 100).toFixed(2);
    elements.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000000" opacity="${opacity}"/>`);
  }

  for (let i = 0; i < 30; i++) {
    const x1 = rng(40, 1160);
    const y1 = rng(30, 600);
    const x2 = x1 + rng(-120, 120);
    const y2 = y1 + rng(-80, 80);
    const opacity = (rng(3, 8) / 100).toFixed(2);
    elements.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000000" stroke-width="${(rng(3, 12) / 10).toFixed(1)}" opacity="${opacity}"/>`);
  }

  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">${elements.join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// Vision-based design portfolio analysis — uses Claude Vision on screenshots
// ---------------------------------------------------------------------------

export async function analyzeDesignPortfolio(
  screenshots: PageScreenshot[],
  rawData: RawCrawlData,
  apiKey: string,
): Promise<DesignPortfolio> {
  const validScreenshots = screenshots.filter((s) => s.screenshotBase64.length > 0);
  if (validScreenshots.length === 0) {
    log.warn('No valid screenshots for vision analysis, returning defaults');
    return buildFallbackPortfolio();
  }

  log.info({ screenshotCount: validScreenshots.length }, 'Starting vision-based design portfolio analysis');
  const client = new Anthropic({ apiKey });

  // Send up to 4 screenshots to stay within token limits
  const screenshotsToAnalyze = validScreenshots.slice(0, 4);

  const imageBlocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const screenshot of screenshotsToAnalyze) {
    imageBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: screenshot.screenshotBase64,
      },
    });
    imageBlocks.push({
      type: 'text',
      text: `[Page: ${screenshot.title} — ${screenshot.url}]`,
    });
  }

  const cssContext = buildVisionCssContext(rawData.cssVariables);

  imageBlocks.push({
    type: 'text',
    text: VISION_ANALYSIS_PROMPT + (cssContext ? `\n\nRelevant CSS variables for reference:\n${cssContext}` : ''),
  });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: imageBlocks }],
    system: 'You are an expert visual designer analyzing website screenshots to extract a comprehensive design portfolio. Return ONLY valid JSON, no markdown fences or explanation text.',
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    log.warn('No text response from vision analysis');
    return buildFallbackPortfolio();
  }

  let jsonStr = textBlock.text.trim();
  const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch?.[1]) jsonStr = fenceMatch[1];

  try {
    const parsed = JSON.parse(jsonStr) as DesignPortfolio;
    log.info(
      { motifs: parsed.visual_motifs?.length, density: parsed.spacing_density },
      'Vision-based design portfolio extracted',
    );
    return parsed;
  } catch (err) {
    log.error({ error: (err as Error).message, preview: jsonStr.slice(0, 300) }, 'Failed to parse vision portfolio response');
    return buildFallbackPortfolio();
  }
}

const VISION_ANALYSIS_PROMPT = `Analyze these website screenshots and extract a comprehensive design portfolio. Look at the ACTUAL visual design — not just what colors exist, but HOW they are used.

For each screenshot, identify:
- Background treatments: gradients (direction, colors, opacity), textures, patterns, overlays
- Decorative elements: shapes, lines, illustrations, icons, abstract graphics
- Hero section style: how the main message is presented visually
- Card/component styles: shadows, borders, border-radius, hover effects
- Spacing philosophy: dense/airy, grid structure, whitespace usage
- Color usage patterns: HOW colors are used (gradient backgrounds? solid blocks? subtle tints?)
- Typography hierarchy: visual weight relationships, letter-spacing, text-transform
- Illustration/imagery style: abstract? photographic? isometric? line art? node graphs?
- Layout patterns: asymmetric? centered? grid-based? overlap? layered?
- Motion/animation hints: parallax? floating elements? transitions?
- Distinctive signature elements: what makes this brand instantly recognizable?

Return a JSON object with EXACTLY these fields:
{
  "background_style": "A full CSS background property that reproduces their main background treatment. E.g. 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' or 'radial-gradient(ellipse at top, #2d1b69 0%, #11001c 100%)'",
  "hero_treatment": "CSS properties for hero-style sections as a single string. E.g. 'background: linear-gradient(180deg, rgba(99,102,241,0.08) 0%, transparent 60%); border-bottom: 1px solid rgba(99,102,241,0.1)'",
  "card_style": "CSS for card components. E.g. 'background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.12)'",
  "accent_treatment": "How accents are applied as CSS. E.g. 'background: linear-gradient(90deg, #6366f1, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent' or 'border-left: 3px solid #f59e0b; padding-left: 16px'",
  "spacing_density": "compact" or "balanced" or "airy",
  "visual_motifs": ["Array of 3-6 distinctive visual elements described concisely, e.g. 'scattered particle dots at low opacity', 'gradient mesh overlays', 'thin ruled lines as section dividers', 'node-graph connector lines'"],
  "illustration_style": "A detailed description of the illustration/decorative style for SVG generation. E.g. 'Technical node-graph aesthetic with connected dots and thin lines, using brand purple (#6366f1) at 5-15% opacity, scattered across a dark background with varying node sizes (2-8px radius)'",
  "composition_rules": ["Array of 3-5 layout principles observed, e.g. 'Left-aligned text with generous right margin', 'Asymmetric hero with 60/40 split', 'Cards in 3-column grid with 24px gap'"],
  "signature_elements": ["Array of 2-4 elements that make this brand instantly recognizable, e.g. 'Purple-to-blue gradient curtain on dark backgrounds', 'Monospace numerals for data points', 'Warm amber accent on cool dark palette'"]
}

IMPORTANT: Be SPECIFIC to THIS brand. Don't return generic descriptions. Look at what actually makes these pages unique and distinctive. The CSS values should be directly usable in stylesheets.`;

function buildFallbackPortfolio(): DesignPortfolio {
  return {
    background_style: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    hero_treatment: 'background: linear-gradient(180deg, rgba(99,102,241,0.05) 0%, transparent 60%)',
    card_style: 'background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px',
    accent_treatment: 'border-left: 3px solid #6366f1; padding-left: 12px',
    spacing_density: 'balanced',
    visual_motifs: ['subtle dot pattern', 'gradient overlays'],
    illustration_style: 'Minimal geometric dots and lines at low opacity',
    composition_rules: ['Centered layout with max-width constraint', 'Generous vertical spacing between sections'],
    signature_elements: ['Brand color accent bar', 'Clean typography hierarchy'],
  };
}

// ---------------------------------------------------------------------------
// Render-validated accent selection — cross-reference CSS accent with colors
// actually observed on the rendered page (crawl ground truth)
// ---------------------------------------------------------------------------

const ACCENT_VISION_CSS_FIELDS: Array<keyof DesignPortfolio> = [
  'background_style',
  'hero_treatment',
  'card_style',
  'accent_treatment',
];

export function isAccentCssVariableKey(key: string): boolean {
  return key.toLowerCase().includes('accent');
}

export function buildVisionCssContext(cssVariables: Record<string, string>): string {
  return Object.entries(cssVariables)
    .filter(
      ([k]) =>
        !isAccentCssVariableKey(k) &&
        (k.includes('color') || k.includes('gradient') || k.includes('bg') || k.includes('font')),
    )
    .slice(0, 50)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

export function buildRenderedColorSet(allColors: string[]): Set<string> {
  const rendered = new Set<string>();
  for (const rgb of allColors) {
    const hex = rgbToHex(rgb);
    if (!hex) continue;
    const normalized = normalizeHex(hex).toLowerCase();
    if (normalized.length === 7) {
      rendered.add(normalized);
    }
  }
  return rendered;
}

export function validateAccentWithVision(
  result: DesignSystemOutput,
  portfolio: DesignPortfolio | undefined,
  rawData: RawCrawlData,
): void {
  const currentAccent = normalizeHex(result.colors.accent.hex).toLowerCase();
  const renderedColors = buildRenderedColorSet(rawData.allColors);

  if (isColorVisuallyConfirmed(currentAccent, renderedColors)) {
    log.debug({ accent: currentAccent }, 'Accent color confirmed by rendered page colors');
    return;
  }

  log.warn(
    { cssAccent: currentAccent, renderedColorCount: renderedColors.size },
    'CSS-defined accent color not found in rendered page colors — selecting render-validated alternative',
  );

  const excluded = new Set([
    normalizeHex(result.colors.primary.hex).toLowerCase(),
    normalizeHex(result.colors.background.hex).toLowerCase(),
    normalizeHex(result.colors.text.hex).toLowerCase(),
    normalizeHex(result.colors.secondary.hex).toLowerCase(),
    currentAccent,
  ]);

  const newAccent = pickAccentFallback(result, renderedColors, excluded, rawData.allColors);

  if (!newAccent) {
    log.warn('No suitable accent replacement found, keeping CSS-defined accent');
    return;
  }

  log.info(
    { replaced: currentAccent, newAccent },
    'Accent color replaced with render-validated color',
  );

  result.colors.accent = {
    hex: newAccent,
    usage: `Render-validated accent (CSS accent ${currentAccent} was defined but not present in rendered page colors)`,
  };

  propagateAccentReplacement(result, portfolio, currentAccent, newAccent);
}

function pickAccentFallback(
  result: DesignSystemOutput,
  renderedColors: Set<string>,
  excluded: Set<string>,
  allColors: string[],
): string | undefined {
  const isChromaticCandidate = (hex: string) =>
    !excluded.has(hex) && !isNearWhite(hex) && !isNearBlack(hex) && !isGrayish(hex);

  const paletteCandidates = (result.colors.palette ?? []).map((c) =>
    normalizeHex(c.hex).toLowerCase(),
  );

  const renderValidPalette = paletteCandidates.find(
    (hex) => isChromaticCandidate(hex) && isColorVisuallyConfirmed(hex, renderedColors),
  );
  if (renderValidPalette) return renderValidPalette;

  const primary = normalizeHex(result.colors.primary.hex).toLowerCase();
  if (isChromaticCandidate(primary) && isColorVisuallyConfirmed(primary, renderedColors)) {
    return primary;
  }

  const counts = new Map<string, number>();
  for (const rgb of allColors) {
    const hex = rgbToHex(rgb);
    if (!hex) continue;
    const norm = normalizeHex(hex).toLowerCase();
    if (!isChromaticCandidate(norm)) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }

  const [mostProminent] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return mostProminent?.[0];
}

export function propagateAccentReplacement(
  result: DesignSystemOutput,
  portfolio: DesignPortfolio | undefined,
  oldHex: string,
  newHex: string,
): void {
  const oldNorm = normalizeHex(oldHex).toLowerCase();
  const newNorm = normalizeHex(newHex);

  for (const entry of result.colors.palette ?? []) {
    const entryHex = normalizeHex(entry.hex).toLowerCase();
    const roleText = `${entry.name ?? ''} ${entry.usage_context ?? ''}`.toLowerCase();
    if (entryHex === oldNorm || (roleText.includes('accent') && colorsMatch(entryHex, oldNorm))) {
      entry.hex = newNorm;
    }
  }

  if (result.css_variables) {
    for (const [key, value] of Object.entries(result.css_variables)) {
      if (hexValueMatches(value, oldNorm)) {
        result.css_variables[key] = replaceHexInText(value, oldNorm, newNorm);
      }
    }
  }

  if (result.raw_tokens) {
    result.raw_tokens = replaceHexInUnknown(result.raw_tokens, oldNorm, newNorm) as Record<string, unknown>;
  }

  if (portfolio) {
    scrubPortfolioHexReferences(portfolio, oldNorm, newNorm);
  }
}

function scrubPortfolioHexReferences(
  portfolio: DesignPortfolio,
  oldHex: string,
  newHex: string,
): void {
  for (const field of ACCENT_VISION_CSS_FIELDS) {
    portfolio[field] = replaceHexInText(portfolio[field], oldHex, newHex);
  }
  portfolio.illustration_style = replaceHexInText(portfolio.illustration_style, oldHex, newHex);
  portfolio.visual_motifs = portfolio.visual_motifs.map((s) => replaceHexInText(s, oldHex, newHex));
  portfolio.composition_rules = portfolio.composition_rules.map((s) =>
    replaceHexInText(s, oldHex, newHex),
  );
  portfolio.signature_elements = portfolio.signature_elements.map((s) =>
    replaceHexInText(s, oldHex, newHex),
  );
}

function replaceHexInText(text: string, oldHex: string, newHex: string): string {
  return text.replace(/#[0-9a-fA-F]{3,8}/g, (match) => {
    const normalized = normalizeHex(match).toLowerCase();
    return colorsMatch(normalized, oldHex) ? newHex : match;
  });
}

function replaceHexInUnknown(value: unknown, oldHex: string, newHex: string): unknown {
  if (typeof value === 'string') {
    return replaceHexInText(value, oldHex, newHex);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceHexInUnknown(item, oldHex, newHex));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = replaceHexInUnknown(child, oldHex, newHex);
    }
    return out;
  }
  return value;
}

function hexValueMatches(value: string, targetHex: string): boolean {
  if (value.match(/^#[0-9a-fA-F]{3,8}$/i) && colorsMatch(normalizeHex(value).toLowerCase(), targetHex)) {
    return true;
  }
  for (const match of value.matchAll(/#[0-9a-fA-F]{3,8}/g)) {
    if (colorsMatch(normalizeHex(match[0]).toLowerCase(), targetHex)) {
      return true;
    }
  }
  return false;
}

function colorsMatch(a: string, b: string): boolean {
  return a === b || hexDistance(a, b) < 45;
}

function isColorVisuallyConfirmed(hex: string, visibleHexes: Set<string>): boolean {
  if (visibleHexes.has(hex)) return true;
  for (const visible of visibleHexes) {
    if (hexDistance(hex, visible) < 45) return true;
  }
  return false;
}

function hexDistance(a: string, b: string): number {
  const ra = parseInt(a.slice(1, 3), 16);
  const ga = parseInt(a.slice(3, 5), 16);
  const ba = parseInt(a.slice(5, 7), 16);
  const rb = parseInt(b.slice(1, 3), 16);
  const gb = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  return Math.sqrt((ra - rb) ** 2 + (ga - gb) ** 2 + (ba - bb) ** 2);
}

// ---------------------------------------------------------------------------
// Claude-powered analysis
// ---------------------------------------------------------------------------

async function analyzeWithClaude(
  rawData: RawCrawlData,
  apiKey: string,
): Promise<DesignSystemOutput> {
  log.info('Sending raw crawl data to Claude for design system analysis');

  const client = new Anthropic({ apiKey });
  const prompt = buildAnalysisPrompt(rawData);

  log.debug({ promptLength: prompt.length }, 'Analysis prompt built');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
    system: SYSTEM_PROMPT,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }

  let jsonStr = textBlock.text.trim();

  const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1];
  }

  try {
    const result = JSON.parse(jsonStr) as DesignSystemOutput;
    log.info(
      {
        colorCount: result.colors?.palette?.length ?? 0,
        fontCount: result.typography?.font_families?.length ?? 0,
      },
      'Claude analysis complete',
    );
    return result;
  } catch (err) {
    log.error(
      { responsePreview: jsonStr.slice(0, 500), error: (err as Error).message },
      'Failed to parse Claude response as JSON',
    );
    throw new Error(
      `Failed to parse design system from Claude response: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Local heuristic analysis (fallback when Claude unavailable)
// ---------------------------------------------------------------------------

function analyzeLocally(data: RawCrawlData): DesignSystemOutput {
  log.info('Running local heuristic design system analysis');

  const allElements = data.pages.flatMap((p) => p.elements);

  const colors = extractColorsLocally(data, allElements);
  const typography = extractTypographyLocally(data, allElements);
  const spacing = extractSpacingLocally(allElements);
  const borders = extractBordersLocally(data, allElements);
  const logo = extractLogoLocally(data);
  const components = extractComponentsLocally(allElements);

  return {
    metadata: {
      source_url: data.pages[0]?.url ?? '',
      crawled_at: new Date().toISOString(),
      pages_analyzed: data.pages.map((p) => p.url),
    },
    colors,
    typography,
    spacing,
    borders,
    logo,
    components,
    css_variables: data.cssVariables,
    raw_tokens: { analysis_method: 'local-heuristic' },
  };
}

// -- Color extraction -------------------------------------------------------

function rgbToHex(rgb: string): string | null {
  const match = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!match) return null;
  const [, r, g, b] = match;
  const toHex = (n: string) => parseInt(n!, 10).toString(16).padStart(2, '0');
  return `#${toHex(r!)}${toHex(g!)}${toHex(b!)}`;
}

function normalizeHex(hex: string): string {
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
}

function isNearWhite(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r > 240 && g > 240 && b > 240;
}

function isNearBlack(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r < 30 && g < 30 && b < 30;
}

function isGrayish(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min < 30;
}

function colorLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function extractColorsLocally(
  data: RawCrawlData,
  allElements: ElementStyleData[],
): DesignSystemOutput['colors'] {
  // Convert all found colors to hex
  const hexColors = new Map<string, number>();
  for (const rgb of data.allColors) {
    const hex = rgbToHex(rgb);
    if (hex) {
      hexColors.set(normalizeHex(hex), (hexColors.get(normalizeHex(hex)) ?? 0) + 1);
    }
  }

  // Also extract from CSS variables
  for (const [, val] of Object.entries(data.cssVariables)) {
    const hex = rgbToHex(val) ?? (val.match(/^#[0-9a-fA-F]{3,8}$/) ? normalizeHex(val) : null);
    if (hex) {
      const norm = normalizeHex(hex);
      hexColors.set(norm, (hexColors.get(norm) ?? 0) + 1);
    }
  }

  const sorted = [...hexColors.entries()].sort((a, b) => b[1] - a[1]);

  // Use semantic CSS variable names for role assignment (highest priority)
  const semanticColors = extractSemanticColorsFromVars(data.cssVariables);

  // Body element analysis
  const bodyElement = allElements.find((e) => e.selector === 'body');
  const textFromBody = bodyElement?.styles.color ? rgbToHex(bodyElement.styles.color) : null;

  // Button analysis
  const buttonElements = allElements.filter((e) =>
    e.selector === 'button' || e.selector === 'btn-class' || e.selector === 'button-link',
  );
  const primaryFromButtons = buttonElements
    .map((b) => rgbToHex(b.styles['background-color'] ?? ''))
    .find((hex) => hex && !isNearWhite(hex) && !isNearBlack(hex) && !isGrayish(hex));

  const chromatic = sorted.filter(([hex]) => !isNearWhite(hex) && !isNearBlack(hex) && !isGrayish(hex));

  // Assign roles with semantic CSS vars taking priority
  const bgColor = semanticColors.background ?? semanticColors.surface ?? sorted.find(([hex]) => isNearWhite(hex))?.[0] ?? '#ffffff';
  const textColor = semanticColors.textPrimary ?? (textFromBody ? normalizeHex(textFromBody) : null) ?? sorted.find(([hex]) => colorLuminance(hex) < 80)?.[0] ?? '#1a1a1a';
  const primaryColor = semanticColors.accent ?? primaryFromButtons ?? chromatic[0]?.[0] ?? '#3b82f6';
  const secondaryColor = semanticColors.textSecondary ?? chromatic.find(([hex]) => hex !== primaryColor)?.[0] ?? '#6366f1';
  const accentColor = semanticColors.accent ?? chromatic.find(([hex]) => hex !== primaryColor && hex !== secondaryColor)?.[0] ?? '#f59e0b';

  // Build palette with semantic names from CSS vars
  const namedColors = buildNamedPalette(data.cssVariables, sorted);

  return {
    primary: { hex: normalizeHex(primaryColor), usage: semanticColors.accent ? 'Accent/brand color used for highlights and CTAs' : 'Primary brand / CTA color' },
    secondary: { hex: normalizeHex(secondaryColor), usage: 'Secondary text and supporting elements' },
    accent: { hex: normalizeHex(accentColor), usage: 'Accent / highlight color' },
    background: { hex: normalizeHex(bgColor), usage: 'Page background' },
    text: { hex: normalizeHex(textColor), usage: 'Primary body text color' },
    palette: namedColors,
  };
}

function extractSemanticColorsFromVars(
  vars: Record<string, string>,
): Record<string, string | null> {
  const result: Record<string, string | null> = {
    textPrimary: null, textSecondary: null, accent: null,
    background: null, surface: null, border: null,
  };

  for (const [name, val] of Object.entries(vars)) {
    const lower = name.toLowerCase();
    const hex = val.match(/^#[0-9a-fA-F]{3,8}$/) ? normalizeHex(val) : null;
    if (!hex) continue;

    if (lower.includes('text-primary') || lower === '--foreground') {
      result.textPrimary ??= hex;
    } else if (lower.includes('text-secondary')) {
      result.textSecondary ??= hex;
    } else if (lower.includes('accent')) {
      result.accent ??= hex;
    } else if (lower.includes('surface')) {
      result.surface ??= hex;
    } else if (lower.includes('border') && !lower.includes('radius')) {
      result.border ??= hex;
    }
  }

  return result;
}

function buildNamedPalette(
  vars: Record<string, string>,
  sorted: Array<[string, number]>,
): Array<{ hex: string; name?: string; usage_context: string }> {
  const palette: Array<{ hex: string; name?: string; usage_context: string }> = [];
  const seen = new Set<string>();

  // Named colors from CSS variables
  const semanticVars = Object.entries(vars).filter(([name]) => {
    const l = name.toLowerCase();
    return (l.startsWith('--color-') && !l.includes('oklch') && !l.includes('rgb'));
  });

  for (const [name, val] of semanticVars) {
    const hex = val.match(/^#[0-9a-fA-F]{3,8}$/) ? normalizeHex(val) : null;
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    const cleanName = name.replace(/^--color-/, '').replace(/-/g, ' ');
    palette.push({ hex, name: cleanName, usage_context: `CSS var ${name}` });
  }

  // Fill with remaining frequency-sorted colors
  for (const [hex, count] of sorted) {
    if (seen.has(hex)) continue;
    seen.add(hex);
    const freq = count > 5 ? 'frequently used' : count > 2 ? 'moderately used' : 'rarely used';
    palette.push({ hex, usage_context: freq });
    if (palette.length >= 35) break;
  }

  return palette;
}

// -- Typography extraction --------------------------------------------------

function extractTypographyLocally(
  data: RawCrawlData,
  allElements: ElementStyleData[],
): DesignSystemOutput['typography'] {
  // Collect font families
  const fontCounts = new Map<string, Set<string>>();
  for (const el of allElements) {
    const rawFamily = el.styles['font-family'];
    if (!rawFamily) continue;
    const primary = rawFamily.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
    if (!primary || primary === 'inherit' || primary === 'initial') continue;
    if (!fontCounts.has(primary)) fontCounts.set(primary, new Set());
    const weight = el.styles['font-weight'] ?? '400';
    fontCounts.get(primary)!.add(weight);
  }

  // Also check CSS vars for font family references
  for (const [name, val] of Object.entries(data.cssVariables)) {
    if (name.toLowerCase().includes('font') && val.includes(',')) {
      const primary = val.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
      if (primary && !fontCounts.has(primary)) fontCounts.set(primary, new Set(['400']));
    }
  }

  const fontFamilies = [...fontCounts.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .map(([family, weights]) => ({
      family,
      weights: [...weights].sort(),
      source: inferFontSource(family),
    }));

  // Build type scale from actual element styles
  const scaleSelectors = ['h1', 'h2', 'h3', 'h4', 'body', 'small', 'caption'] as const;
  const scale: DesignSystemOutput['typography']['scale'] = {};

  for (const sel of scaleSelectors) {
    const target = sel === 'body' ? 'p' : sel;
    const el = allElements.find((e) => e.selector === target || e.selector === sel);
    if (el) {
      scale[sel] = {
        font_family: el.styles['font-family']?.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? fontFamilies[0]?.family ?? 'system-ui',
        font_size: el.styles['font-size'] ?? '16px',
        font_weight: el.styles['font-weight'] ?? '400',
        line_height: el.styles['line-height'] ?? '1.5',
        color: rgbToHex(el.styles.color ?? '') ?? '#1a1a1a',
      };
    }
  }

  // Ensure body exists
  if (!scale.body) {
    const bodyEl = allElements.find((e) => e.selector === 'body');
    scale.body = {
      font_family: fontFamilies[0]?.family ?? 'system-ui',
      font_size: bodyEl?.styles['font-size'] ?? '16px',
      font_weight: bodyEl?.styles['font-weight'] ?? '400',
      line_height: bodyEl?.styles['line-height'] ?? '1.5',
      color: bodyEl?.styles.color ? (rgbToHex(bodyEl.styles.color) ?? '#1a1a1a') : '#1a1a1a',
    };
  }

  return { font_families: fontFamilies, scale };
}

function inferFontSource(family: string): string {
  const lower = family.toLowerCase();
  const systemFonts = [
    'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui',
    'roboto', 'helvetica', 'arial', 'sans-serif', 'serif', 'monospace',
    'courier', 'times', 'georgia', 'verdana', 'tahoma', 'trebuchet',
  ];
  if (systemFonts.some((s) => lower.includes(s))) return 'system';
  return 'self-hosted';
}

// -- Spacing extraction -----------------------------------------------------

function extractSpacingLocally(
  allElements: ElementStyleData[],
): DesignSystemOutput['spacing'] {
  const spacingValues = new Set<number>();

  for (const el of allElements) {
    for (const prop of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left',
                         'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap']) {
      const val = el.styles[prop];
      if (val) {
        const px = parseInt(val, 10);
        if (!isNaN(px) && px > 0 && px < 200) spacingValues.add(px);
      }
    }
  }

  const sorted = [...spacingValues].sort((a, b) => a - b);

  // Infer base unit as GCD-ish of common values
  const commonValues = sorted.filter((v) => v >= 4 && v <= 48);
  const baseUnit = commonValues.length > 0
    ? (commonValues.find((v) => v === 4 || v === 8) ?? commonValues[0] ?? 8)
    : 8;

  return {
    unit: `${baseUnit}px`,
    scale: {
      xs: `${Math.max(baseUnit / 2, 2)}px`,
      sm: `${baseUnit}px`,
      md: `${baseUnit * 2}px`,
      lg: `${baseUnit * 3}px`,
      xl: `${baseUnit * 4}px`,
      xxl: `${baseUnit * 6}px`,
    },
  };
}

// -- Border extraction ------------------------------------------------------

function extractBordersLocally(
  data: RawCrawlData,
  allElements: ElementStyleData[],
): DesignSystemOutput['borders'] {
  const radii = new Set<string>();
  const widths = new Set<string>();
  const borderColors = new Set<string>();

  for (const el of allElements) {
    const r = el.styles['border-radius'] ?? el.styles['border-top-left-radius'];
    if (r && r !== '0px') radii.add(r);

    const w = el.styles['border-width'];
    if (w && w !== '0px') widths.add(w);

    const c = el.styles['border-color'];
    if (c && c !== 'rgba(0, 0, 0, 0)') {
      const hex = rgbToHex(c);
      if (hex) borderColors.add(hex);
    }
  }

  // Also from CSS vars
  for (const [name, val] of Object.entries(data.cssVariables)) {
    if (name.toLowerCase().includes('radius')) {
      radii.add(val);
    }
  }

  const sortedRadii = [...radii].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  return {
    radius: {
      sm: sortedRadii[0] ?? '4px',
      md: sortedRadii[Math.floor(sortedRadii.length / 2)] ?? '8px',
      lg: sortedRadii[sortedRadii.length - 1] ?? '16px',
      full: '9999px',
    },
    widths: [...widths],
    colors: [...borderColors],
  };
}

// -- Logo extraction --------------------------------------------------------

function extractLogoLocally(data: RawCrawlData): DesignSystemOutput['logo'] {
  if (data.logoCandidates.length === 0) {
    return { url: '', dimensions: { width: 0, height: 0 } };
  }

  // Prefer: text-logo > inline SVG from header > img from header > other
  const textLogo = data.logoCandidates.find((l) => l.source.includes('text-logo'));
  const svgLogo = data.logoCandidates.find((l) => l.source.includes('inline-svg') && l.svgData);
  const headerImg = data.logoCandidates.find((l) => l.source.includes('header'));
  const best = textLogo ?? svgLogo ?? headerImg ?? data.logoCandidates[0]!;

  return {
    url: best.url,
    svg_data: best.svgData,
    dimensions: best.width && best.height
      ? { width: best.width, height: best.height }
      : undefined,
  };
}

// -- Component extraction ---------------------------------------------------

function extractComponentsLocally(
  allElements: ElementStyleData[],
): DesignSystemOutput['components'] {
  const buttons: DesignSystemOutput['components']['buttons'] = [];
  const cards: DesignSystemOutput['components']['cards'] = [];
  const badges: DesignSystemOutput['components']['badges'] = [];
  const sections: DesignSystemOutput['components']['sections'] = [];

  // Buttons
  const buttonEls = allElements.filter(
    (e) => e.selector === 'button' || e.selector === 'btn-class' || e.selector === 'button-link',
  );
  const seenButtonStyles = new Set<string>();
  for (const el of buttonEls) {
    const bg = el.styles['background-color'] ?? '';
    const key = `${bg}|${el.styles.color ?? ''}|${el.styles['border-radius'] ?? ''}`;
    if (seenButtonStyles.has(key)) continue;
    seenButtonStyles.add(key);

    const bgHex = rgbToHex(bg);
    const variant = bgHex && !isNearWhite(bgHex) && !isGrayish(bgHex)
      ? 'primary'
      : bgHex && isNearWhite(bgHex)
        ? 'ghost'
        : 'secondary';

    buttons.push({
      variant: buttons.some((b) => b.variant === variant) ? `${variant}-alt` : variant,
      styles: pickRelevantStyles(el.styles, ['background-color', 'color', 'border-radius', 'padding-top', 'padding-right', 'font-weight', 'font-size', 'border-width', 'border-color']),
    });
  }

  // Cards
  const cardEls = allElements.filter((e) => e.selector === 'card');
  const seenCardStyles = new Set<string>();
  for (const el of cardEls) {
    const key = `${el.styles['background-color'] ?? ''}|${el.styles['border-radius'] ?? ''}|${el.styles['box-shadow'] ?? ''}`;
    if (seenCardStyles.has(key)) continue;
    seenCardStyles.add(key);

    cards.push({
      variant: cards.length === 0 ? 'default' : `variant-${cards.length + 1}`,
      styles: pickRelevantStyles(el.styles, ['background-color', 'border-radius', 'padding-top', 'padding-right', 'box-shadow', 'border-width', 'border-color']),
    });
  }

  // Badges
  const badgeEls = allElements.filter((e) => e.selector === 'badge');
  for (const el of badgeEls.slice(0, 3)) {
    badges.push({
      variant: badges.length === 0 ? 'default' : `variant-${badges.length + 1}`,
      styles: pickRelevantStyles(el.styles, ['background-color', 'color', 'border-radius', 'padding-top', 'padding-right', 'font-size', 'font-weight']),
    });
  }

  // Sections
  const sectionEls = allElements.filter(
    (e) => e.selector === 'section' || e.selector === 'hero' || e.selector === 'cta',
  );
  const seenSectionBg = new Set<string>();
  for (const el of sectionEls) {
    const bg = el.styles['background-color'] ?? '';
    if (seenSectionBg.has(bg)) continue;
    seenSectionBg.add(bg);

    const variant = el.selector === 'hero'
      ? 'hero'
      : el.selector === 'cta'
        ? 'cta'
        : sections.length === 0
          ? 'default'
          : `variant-${sections.length + 1}`;

    sections.push({
      variant,
      styles: pickRelevantStyles(el.styles, ['background-color', 'padding-top', 'padding-bottom', 'color']),
    });
  }

  return { buttons, cards, badges, sections };
}

function pickRelevantStyles(
  styles: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const val = styles[key];
    if (val && val !== '0px' && val !== 'none' && val !== 'normal' && val !== 'auto' && val !== 'rgba(0, 0, 0, 0)') {
      // Convert rgb to hex for color properties
      if (key.includes('color')) {
        const hex = rgbToHex(val);
        if (hex) {
          result[key] = hex;
          continue;
        }
      }
      result[key] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Claude prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a design system analyst. You analyze raw CSS and DOM data extracted from websites and produce structured design system JSON.

Your output must be a single valid JSON object — no markdown fences, no explanation text before or after, just pure JSON.

Guidelines:
- Convert ALL rgb/rgba color values to 6-digit hex (e.g., rgb(26, 26, 46) → #1a1a2e)
- For rgba with alpha < 1, still convert to hex of the RGB portion and note the alpha in usage_context
- Identify semantic color roles: primary (brand/CTA), secondary, accent, background, text
- Use the actual font families loaded, not generic fallbacks like "sans-serif"
- Map font sizes to a semantic scale (h1 through caption)
- Find the base spacing unit (common GCD of padding/margin values)
- Build spacing scale from actual values observed
- For components, extract the key visual properties that define each variant
- If a value can't be determined, make your best inference from available data
- Include ALL meaningfully distinct colors in the palette array (skip near-duplicates)`;

function buildAnalysisPrompt(data: RawCrawlData): string {
  const sections: string[] = [];

  // Pages crawled
  const pagesSection = data.pages
    .map(
      (p) =>
        `  - ${p.url} (title: "${p.title}", ${p.elements.length} elements inspected, ${p.timeTakenMs}ms)`,
    )
    .join('\n');
  sections.push(`## Pages Crawled\n${pagesSection}`);

  // CSS Custom Properties
  const cssVarEntries = Object.entries(data.cssVariables);
  if (cssVarEntries.length > 0) {
    const cssVarsText = cssVarEntries
      .slice(0, 200)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');
    sections.push(
      `## CSS Custom Properties (${cssVarEntries.length} total)\n${cssVarsText}`,
    );
  } else {
    sections.push('## CSS Custom Properties\n(none found)');
  }

  // Element computed styles — deduplicated by selector
  const elementsBySelector = new Map<
    string,
    Array<{ styles: Record<string, string>; text: string; classes: string }>
  >();
  for (const page of data.pages) {
    for (const el of page.elements) {
      if (!elementsBySelector.has(el.selector)) {
        elementsBySelector.set(el.selector, []);
      }
      elementsBySelector.get(el.selector)!.push({
        styles: el.styles,
        text: el.textPreview,
        classes: el.classes,
      });
    }
  }

  let elementSection = '';
  for (const [selector, elements] of elementsBySelector) {
    elementSection += `\n### ${selector} (${elements.length} instances)\n`;
    const shown = new Set<string>();
    for (const el of elements.slice(0, 3)) {
      const styleKey = Object.entries(el.styles)
        .filter(([, v]) => v && v !== 'normal' && v !== 'none' && v !== '0px')
        .map(([k, v]) => `${k}:${v}`)
        .join('|');
      if (shown.has(styleKey)) continue;
      shown.add(styleKey);

      if (el.text) elementSection += `  text: "${el.text.slice(0, 80)}"\n`;
      if (el.classes) elementSection += `  classes: "${el.classes.slice(0, 120)}"\n`;
      for (const [prop, val] of Object.entries(el.styles)) {
        if (val && val !== 'normal' && val !== 'none' && val !== '0px' && val !== 'auto') {
          elementSection += `    ${prop}: ${val}\n`;
        }
      }
      elementSection += '\n';
    }
  }
  sections.push(`## Element Computed Styles${elementSection}`);

  // All colors
  if (data.allColors.length > 0) {
    const colorsText = data.allColors.slice(0, 120).join('\n  ');
    sections.push(
      `## All Colors Found (${data.allColors.length} unique, showing first 120)\n  ${colorsText}`,
    );
  }

  // Logos
  if (data.logoCandidates.length > 0) {
    const logosText = data.logoCandidates
      .map(
        (l) =>
          `  - ${l.url || '(inline SVG)'}, source: ${l.source}` +
          (l.width ? `, ${l.width}x${l.height}` : '') +
          (l.alt ? `, alt: "${l.alt}"` : '') +
          (l.svgData ? `\n    SVG preview: ${l.svgData.slice(0, 300)}...` : ''),
      )
      .join('\n');
    sections.push(`## Logo Candidates\n${logosText}`);
  }

  const outputSchema = `## Required Output JSON Structure

{
  "metadata": {
    "source_url": "the base URL",
    "crawled_at": "${new Date().toISOString()}",
    "pages_analyzed": ["list of page URLs"]
  },
  "colors": {
    "primary": { "hex": "#xxxxxx", "usage": "description of where this is the primary/brand color" },
    "secondary": { "hex": "#xxxxxx", "usage": "description" },
    "accent": { "hex": "#xxxxxx", "usage": "description" },
    "background": { "hex": "#xxxxxx", "usage": "main page background" },
    "text": { "hex": "#xxxxxx", "usage": "body text color" },
    "palette": [
      { "hex": "#xxxxxx", "name": "semantic-name", "usage_context": "where/how this color is used" }
    ]
  },
  "typography": {
    "font_families": [
      { "family": "Actual Font Name", "weights": ["400", "600", "700"], "source": "google-fonts|adobe-fonts|self-hosted|system" }
    ],
    "scale": {
      "h1": { "font_family": "...", "font_size": "48px", "font_weight": "700", "line_height": "1.2", "color": "#..." },
      "h2": { "font_family": "...", "font_size": "36px", "font_weight": "700", "line_height": "1.3", "color": "#..." },
      "h3": { "font_family": "...", "font_size": "24px", "font_weight": "600", "line_height": "1.4", "color": "#..." },
      "body": { "font_family": "...", "font_size": "16px", "font_weight": "400", "line_height": "1.5", "color": "#..." },
      "small": { "font_family": "...", "font_size": "14px", "font_weight": "400", "line_height": "1.5", "color": "#..." },
      "caption": { "font_family": "...", "font_size": "12px", "font_weight": "400", "line_height": "1.4", "color": "#..." }
    }
  },
  "spacing": {
    "unit": "8px",
    "scale": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "32px", "xxl": "48px" }
  },
  "borders": {
    "radius": { "sm": "4px", "md": "8px", "lg": "16px", "full": "9999px" },
    "widths": ["1px", "2px"],
    "colors": ["#xxxxxx"]
  },
  "logo": {
    "url": "full URL to best logo image or empty string if SVG only",
    "svg_data": "raw SVG markup if available, otherwise omit",
    "dimensions": { "width": 120, "height": 40 }
  },
  "components": {
    "buttons": [{ "variant": "primary", "styles": { "background-color": "#...", "color": "#...", "border-radius": "...", "padding": "...", "font-weight": "..." } }],
    "cards": [{ "variant": "default", "styles": { "background-color": "#...", "border-radius": "...", "padding": "...", "box-shadow": "..." } }],
    "badges": [{ "variant": "default", "styles": { "background-color": "#...", "color": "#...", "border-radius": "...", "padding": "...", "font-size": "..." } }],
    "sections": [{ "variant": "hero", "styles": { "background-color": "#...", "padding": "...", "text-align": "..." } }]
  },
  "css_variables": { "--var-name": "value" },
  "raw_tokens": {}
}`;

  sections.push(outputSchema);

  return (
    'Analyze the following raw design data extracted from a website and produce a structured design system JSON.\n\n' +
    sections.join('\n\n')
  );
}
