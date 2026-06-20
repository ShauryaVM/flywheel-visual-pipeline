import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { createStageLogger } from '../../observability/logger.js';
import type { BrandAssets } from '../../types/index.js';

const log = createStageLogger('stage1:crawler');

// ---------------------------------------------------------------------------
// Types for raw crawl data (all JSON-serializable)
// ---------------------------------------------------------------------------

export interface PageScreenshot {
  url: string;
  title: string;
  screenshotBase64: string;
}

export interface RawCrawlData {
  pages: PageData[];
  screenshots: PageScreenshot[];
  cssVariables: Record<string, string>;
  logoCandidates: LogoCandidate[];
  allColors: string[];
  brandAssets: BrandAssets;
  totalTimeMs: number;
}

export interface PageData {
  url: string;
  title: string;
  elements: ElementStyleData[];
  internalLinks: string[];
  timeTakenMs: number;
}

export interface ElementStyleData {
  selector: string;
  tagName: string;
  textPreview: string;
  classes: string;
  styles: Record<string, string>;
}

export interface LogoCandidate {
  url: string;
  alt?: string;
  svgData?: string;
  width?: number;
  height?: number;
  source: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const KNOWN_SUBPATHS = [
  '/about',
  '/pricing',
  '/features',
  '/product',
  '/platform',
  '/solutions',
  '/resources',
  '/blog',
  '/docs',
  '/contact',
  '/careers',
  '/customers',
  '/integrations',
  '/security',
  '/enterprise',
];

const MAX_PAGES = 6;
const PAGE_TIMEOUT = 45_000;

const STYLE_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'color',
  'background-color',
  'border-color',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'border-radius',
  'border-top-left-radius',
  'border-width',
  'box-shadow',
  'text-transform',
  'text-decoration',
  'opacity',
  'gap',
];

const ELEMENT_SELECTORS: Array<{ selector: string; label: string }> = [
  { selector: 'h1', label: 'h1' },
  { selector: 'h2', label: 'h2' },
  { selector: 'h3', label: 'h3' },
  { selector: 'h4', label: 'h4' },
  { selector: 'h5', label: 'h5' },
  { selector: 'h6', label: 'h6' },
  { selector: 'p', label: 'p' },
  { selector: 'body', label: 'body' },
  { selector: 'button', label: 'button' },
  { selector: '[class*="btn"]', label: 'btn-class' },
  { selector: 'a[class*="button"], a[class*="cta"], a[class*="btn"]', label: 'button-link' },
  { selector: '[class*="card"]', label: 'card' },
  { selector: '[class*="badge"], [class*="tag"], [class*="chip"]', label: 'badge' },
  { selector: 'section', label: 'section' },
  { selector: 'a:not([class*="btn"]):not([class*="button"])', label: 'a' },
  { selector: 'nav', label: 'nav' },
  { selector: 'header', label: 'header' },
  { selector: 'footer', label: 'footer' },
  { selector: 'input, textarea', label: 'input' },
  { selector: 'small', label: 'small' },
  { selector: 'figcaption, [class*="caption"]', label: 'caption' },
  { selector: '[class*="hero"]', label: 'hero' },
  { selector: '[class*="cta"]', label: 'cta' },
  { selector: 'blockquote, [class*="quote"]', label: 'quote' },
];

// ---------------------------------------------------------------------------
// Main crawl function
// ---------------------------------------------------------------------------

export async function crawlSite(targetUrl: string): Promise<RawCrawlData> {
  const totalStart = Date.now();
  log.info({ targetUrl }, 'Starting multi-page site crawl with screenshots');

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    });

    // Phase 1: Crawl homepage and take screenshot
    const homePage = await context.newPage();
    const homeData = await crawlPage(homePage, targetUrl);
    const homeScreenshot = await takePageScreenshot(homePage, targetUrl, homeData.title);
    await homePage.close();

    const screenshots: PageScreenshot[] = [homeScreenshot];

    // Phase 2: Discover and crawl subpages
    const baseUrl = new URL(targetUrl);
    const subpagePaths = discoverSubpages(homeData.internalLinks, baseUrl);
    const pagesToVisit = subpagePaths.slice(0, MAX_PAGES - 1);

    log.info(
      { discovered: subpagePaths.length, visiting: pagesToVisit.length },
      'Discovered subpages',
    );

    const subpageData: PageData[] = [];
    for (const path of pagesToVisit) {
      const pageUrl = new URL(path, baseUrl).href;
      try {
        const page = await context.newPage();
        const data = await crawlPage(page, pageUrl);
        const screenshot = await takePageScreenshot(page, pageUrl, data.title);
        subpageData.push(data);
        screenshots.push(screenshot);
        await page.close();
      } catch (err) {
        log.warn(
          { pageUrl, error: (err as Error).message },
          'Failed to crawl subpage, skipping',
        );
      }
    }

    const allPages = [homeData, ...subpageData];

    // Phase 3: Extract global data from homepage
    const globalPage = await context.newPage();
    await globalPage.goto(targetUrl, {
      waitUntil: 'networkidle',
      timeout: PAGE_TIMEOUT,
    });
    await globalPage.waitForTimeout(1500);

    const cssVariables = await extractCssVariables(globalPage);
    const logoCandidates = await extractLogoCandidates(globalPage, targetUrl);
    const allColors = await extractAllColors(globalPage);

    log.info('Phase 3b: Extracting brand assets from DOM…');
    const brandAssets = await extractBrandAssets(globalPage, targetUrl);
    log.info(
      {
        hasLogo: !!brandAssets.logo,
        decorativeSvgCount: brandAssets.decorativeSvgs.length,
        animationCount: brandAssets.animations.length,
        gradientCount: brandAssets.gradients.length,
        hasFavicon: !!brandAssets.favicon,
      },
      'Brand assets extracted from DOM',
    );

    await globalPage.close();

    const totalTimeMs = Date.now() - totalStart;
    log.info(
      {
        pagesAnalyzed: allPages.length,
        screenshotsTaken: screenshots.length,
        cssVarCount: Object.keys(cssVariables).length,
        logoCount: logoCandidates.length,
        uniqueColorCount: allColors.length,
        totalTimeMs,
      },
      'Multi-page crawl with screenshots complete',
    );

    return { pages: allPages, screenshots, cssVariables, logoCandidates, allColors, brandAssets, totalTimeMs };
  } finally {
    if (browser) await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Screenshot capture — full-page screenshot capped to avoid huge images
// ---------------------------------------------------------------------------

async function takePageScreenshot(
  page: Page,
  url: string,
  title: string,
): Promise<PageScreenshot> {
  try {
    // Use a clip to limit height to 4000px (well under 8000px API limit at 1440px width)
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const clipHeight = Math.min(pageHeight, 4000);

    const buffer = await page.screenshot({
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: clipHeight },
      type: 'jpeg',
      quality: 55,
    });

    // Cap at ~1MB base64 to stay within API token limits
    const MAX_BYTES = 900_000;
    let screenshotBase64: string;

    if (buffer.length > MAX_BYTES) {
      // Take viewport-only screenshot (above-the-fold) as fallback
      const viewportBuffer = await page.screenshot({
        fullPage: false,
        type: 'jpeg',
        quality: 45,
      });
      screenshotBase64 = viewportBuffer.toString('base64');
      log.info({ url, fullSizeKB: Math.round(buffer.length / 1024), croppedKB: Math.round(viewportBuffer.length / 1024) }, 'Screenshot too large, using viewport crop');
    } else {
      screenshotBase64 = buffer.toString('base64');
    }

    log.info({ url, sizeKB: Math.round(screenshotBase64.length * 0.75 / 1024) }, 'Screenshot captured');
    return { url, title, screenshotBase64 };
  } catch (err) {
    log.warn({ url, error: (err as Error).message }, 'Screenshot capture failed, using empty');
    return { url, title, screenshotBase64: '' };
  }
}

// ---------------------------------------------------------------------------
// Per-page crawl
// ---------------------------------------------------------------------------

async function crawlPage(page: Page, url: string): Promise<PageData> {
  const start = Date.now();
  log.info({ url }, 'Crawling page');

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  }
  await page.waitForTimeout(1500);

  const title = await page.title();

  const elements = await page.evaluate(
    (config: { selectors: Array<{ selector: string; label: string }>; styleProps: string[] }) => {
      const results: Array<{
        selector: string;
        tagName: string;
        textPreview: string;
        classes: string;
        styles: Record<string, string>;
      }> = [];

      for (const { selector, label } of config.selectors) {
        let els: NodeListOf<Element>;
        try {
          els = document.querySelectorAll(selector);
        } catch {
          continue;
        }
        const limit = Math.min(els.length, 3);
        for (let i = 0; i < limit; i++) {
          const el = els[i] as HTMLElement;
          if (!el) continue;

          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;

          const computed = getComputedStyle(el);
          const styles: Record<string, string> = {};
          for (const prop of config.styleProps) {
            const val = computed.getPropertyValue(prop);
            if (val) styles[prop] = val;
          }

          results.push({
            selector: label,
            tagName: el.tagName.toLowerCase(),
            textPreview: (el.textContent ?? '').trim().slice(0, 120),
            classes: typeof el.className === 'string' ? el.className : '',
            styles,
          });
        }
      }

      return results;
    },
    { selectors: ELEMENT_SELECTORS, styleProps: STYLE_PROPS },
  );

  const baseOrigin = new URL(url).origin;
  const internalLinks = await page.evaluate((origin) => {
    const links: string[] = [];
    document.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href) return;

      // Handle relative paths
      if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/#')) {
        links.push(href);
        return;
      }

      // Handle absolute URLs on same origin
      try {
        const linkUrl = new URL(href);
        if (linkUrl.origin === origin && linkUrl.pathname !== '/') {
          links.push(linkUrl.pathname);
        }
      } catch {
        /* invalid URL */
      }
    });
    return [...new Set(links)];
  }, baseOrigin);

  const timeTakenMs = Date.now() - start;
  log.info(
    { url, elementCount: elements.length, linkCount: internalLinks.length, timeTakenMs },
    'Page crawl complete',
  );

  return { url, title, elements, internalLinks, timeTakenMs };
}

// ---------------------------------------------------------------------------
// Subpage discovery
// ---------------------------------------------------------------------------

function discoverSubpages(homeLinks: string[], baseUrl: URL): string[] {
  const found = new Set<string>();

  for (const link of homeLinks) {
    const normalized = link.toLowerCase().replace(/\/$/, '');
    for (const known of KNOWN_SUBPATHS) {
      if (normalized === known || normalized.startsWith(known + '/')) {
        found.add(link);
      }
    }
  }

  for (const link of homeLinks) {
    const depth = link.split('/').filter(Boolean).length;
    if (depth === 1) {
      found.add(link);
    }
  }

  // Prioritize: known paths first, then discovered top-level
  const prioritized = [...found].sort((a, b) => {
    const aKnown = KNOWN_SUBPATHS.some((k) => a.toLowerCase().startsWith(k));
    const bKnown = KNOWN_SUBPATHS.some((k) => b.toLowerCase().startsWith(k));
    if (aKnown && !bKnown) return -1;
    if (!aKnown && bKnown) return 1;
    return 0;
  });

  return prioritized;
}

// ---------------------------------------------------------------------------
// CSS custom properties extraction
// ---------------------------------------------------------------------------

async function extractCssVariables(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const result: Record<string, string> = {};

    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (
            rule instanceof CSSStyleRule &&
            (rule.selectorText === ':root' ||
              rule.selectorText === 'html' ||
              rule.selectorText === ':root, :host' ||
              rule.selectorText === '*')
          ) {
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              if (prop?.startsWith('--')) {
                result[prop] = rule.style.getPropertyValue(prop).trim();
              }
            }
          }
        }
      } catch {
        /* cross-origin stylesheet */
      }
    }

    const rootStyles = getComputedStyle(document.documentElement);
    for (let i = 0; i < rootStyles.length; i++) {
      const prop = rootStyles[i];
      if (prop?.startsWith('--')) {
        if (!result[prop]) {
          result[prop] = rootStyles.getPropertyValue(prop).trim();
        }
      }
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Logo extraction
// ---------------------------------------------------------------------------

async function extractLogoCandidates(
  page: Page,
  _baseUrl: string,
): Promise<LogoCandidate[]> {
  return page.evaluate(() => {
    const candidates: Array<{
      url: string;
      alt?: string;
      svgData?: string;
      width?: number;
      height?: number;
      source: string;
    }> = [];
    const seen = new Set<string>();

    // Images: prefer those in header/nav, skip investor sections
    document.querySelectorAll('img').forEach((img) => {
      const src = img.src;
      const alt = (img.alt ?? '').toLowerCase();
      const cls = (typeof img.className === 'string' ? img.className : '').toLowerCase();
      const id = (img.id ?? '').toLowerCase();
      const inHeader = img.closest('header, nav');
      const inLogoContainer = img.closest('[class*="logo"], [class*="brand"], a[href="/"]');

      // Skip images that are clearly partner/investor/third-party logos
      const partnerKeywords = [
        'venture', 'fund', 'capital', 'invest', 'horowitz', 'accel',
        'coatue', 'gv logo', 'khosla', 'catalyst', 'index venture', 'public investment',
        'andreessen', 'sequoia', 'greylock', 'benchmark', 'lightspeed',
      ];
      const isPartnerLogo =
        partnerKeywords.some((kw) => alt.includes(kw) || src.toLowerCase().includes(kw)) ||
        img.closest('[class*="partner"], [class*="investor"], [class*="backer"], [class*="trusted"], [class*="logo-cloud"], [class*="logo-grid"], [class*="logos"]') !== null;

      if (isPartnerLogo) return;

      const isSiteLogo = inHeader || inLogoContainer ||
        alt.includes('logo') || cls.includes('logo') || id.includes('logo') || src.includes('logo');

      if (isSiteLogo) {
        const key = src;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({
            url: src,
            alt: img.alt || undefined,
            width: img.naturalWidth || img.width || undefined,
            height: img.naturalHeight || img.height || undefined,
            source: inHeader ? 'img (header)' : inLogoContainer ? 'img (logo-container)' : 'img',
          });
        }
      }
    });

    // SVGs in header/nav/logo containers — prefer larger ones (logos, not icons)
    document
      .querySelectorAll(
        'header svg, nav svg, [class*="logo"] svg, [id*="logo"] svg, a[href="/"] svg',
      )
      .forEach((svg) => {
        try {
          const serialized = new XMLSerializer().serializeToString(svg);
          const rect = svg.getBoundingClientRect();
          if (rect.width >= 16 && rect.height >= 12) {
            const key = serialized.slice(0, 100);
            if (!seen.has(key)) {
              seen.add(key);
              candidates.push({
                url: '',
                svgData: serialized,
                width: Math.round(rect.width) || undefined,
                height: Math.round(rect.height) || undefined,
                source: 'inline-svg (header/nav)',
              });
            }
          }
        } catch {
          /* serialization failed */
        }
      });

    // Check for text-based logos (common for SaaS): a link to "/" in header with prominent text
    const headerHomeLinks = document.querySelectorAll('header a[href="/"], nav a[href="/"]');
    headerHomeLinks.forEach((a) => {
      const text = (a.textContent ?? '').trim();
      if (text && text.length < 30 && !seen.has('text:' + text)) {
        seen.add('text:' + text);
        const rect = a.getBoundingClientRect();
        candidates.unshift({
          url: '',
          alt: text,
          width: Math.round(rect.width) || undefined,
          height: Math.round(rect.height) || undefined,
          source: 'text-logo (header home link)',
        });
      }
    });

    return candidates;
  });
}

// ---------------------------------------------------------------------------
// Brand asset extraction — real DOM assets (logos, SVGs, animations, gradients)
// ---------------------------------------------------------------------------

async function extractBrandAssets(page: Page, baseUrl: string): Promise<BrandAssets> {
  const domAssets = await page.evaluate(() => {
    // ---- 1. Logo extraction ----
    let logo: { svg?: string; imgUrl?: string; source: string } | null = null;

    const logoSelectors = [
      'header a[href="/"] svg',
      'nav a[href="/"] svg',
      '[class*="logo"] svg',
      '[id*="logo"] svg',
      'header svg',
    ];

    for (const sel of logoSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 20 && rect.height >= 12) {
          logo = {
            svg: new XMLSerializer().serializeToString(el),
            source: sel,
          };
          break;
        }
      }
    }

    if (!logo) {
      const imgSelectors = [
        'header a[href="/"] img',
        'nav a[href="/"] img',
        '[class*="logo"] img',
        '[id*="logo"] img',
      ];
      for (const sel of imgSelectors) {
        const img = document.querySelector(sel) as HTMLImageElement | null;
        if (img?.src) {
          const inLogoSection = !img.closest(
            '[class*="partner"], [class*="investor"], [class*="backer"], [class*="logo-cloud"], [class*="logo-grid"]',
          );
          if (inLogoSection) {
            logo = { imgUrl: img.src, source: sel };
            break;
          }
        }
      }
    }

    // ---- 2. Decorative SVGs (large, non-icon SVGs) ----
    const decorativeSvgs: Array<{
      svg: string;
      context: string;
      dimensions: { width: number; height: number };
    }> = [];

    document.querySelectorAll('svg').forEach((svg) => {
      const rect = svg.getBoundingClientRect();
      const vb = svg.getAttribute('viewBox');
      let vbArea = 0;
      if (vb) {
        const parts = vb.split(/[\s,]+/).map(Number);
        if (parts.length === 4) vbArea = (parts[2] ?? 0) * (parts[3] ?? 0);
      }

      const isLargeEnough = rect.width > 100 || rect.height > 100 || vbArea > 10000;
      const isHeader = !!svg.closest('header, nav, [class*="logo"]');
      if (!isLargeEnough || isHeader) return;

      try {
        const serialized = new XMLSerializer().serializeToString(svg);
        if (serialized.length > 200 && serialized.length < 50000) {
          const parent = svg.parentElement;
          const ctx =
            parent?.closest('section')?.className ||
            parent?.closest('[class*="hero"]')?.className ||
            parent?.className ||
            'page';
          decorativeSvgs.push({
            svg: serialized,
            context: typeof ctx === 'string' ? ctx.slice(0, 80) : 'unknown',
            dimensions: {
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          });
        }
      } catch {
        /* serialization failed */
      }
    });

    // ---- 3. CSS Animations & Keyframes ----
    const animations: Array<{
      name: string;
      keyframes: string;
      duration: string;
      easing: string;
      appliedTo: string;
    }> = [];
    const seenKeyframes = new Set<string>();

    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSKeyframesRule) {
            if (seenKeyframes.has(rule.name)) continue;
            seenKeyframes.add(rule.name);

            let keyframeText = `@keyframes ${rule.name} {`;
            for (let i = 0; i < rule.cssRules.length; i++) {
              keyframeText += ` ${rule.cssRules[i]!.cssText}`;
            }
            keyframeText += ' }';

            animations.push({
              name: rule.name,
              keyframes: keyframeText,
              duration: '',
              easing: '',
              appliedTo: '',
            });
          }
        }
      } catch {
        /* cross-origin stylesheet */
      }
    }

    const animatedSelectors = [
      '[class*="hero"]',
      '[class*="cta"]',
      'section',
      '[class*="animate"]',
      '[class*="motion"]',
      '[class*="float"]',
    ];

    for (const sel of animatedSelectors) {
      let els: NodeListOf<Element>;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (let i = 0; i < Math.min(els.length, 5); i++) {
        const el = els[i] as HTMLElement;
        if (!el) continue;
        const cs = getComputedStyle(el);
        const animName = cs.animationName;
        const transition = cs.transition;

        if (animName && animName !== 'none') {
          const existing = animations.find((a) => a.name === animName);
          if (existing && !existing.appliedTo) {
            existing.duration = cs.animationDuration;
            existing.easing = cs.animationTimingFunction;
            existing.appliedTo = el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(' ')[0]}` : '');
          }
        }

        if (transition && transition !== 'all 0s ease 0s' && transition !== 'none') {
          const transName = `transition-${sel.replace(/[\[\]*="]/g, '')}`;
          if (!seenKeyframes.has(transName)) {
            seenKeyframes.add(transName);
            animations.push({
              name: transName,
              keyframes: '',
              duration: cs.transitionDuration,
              easing: cs.transitionTimingFunction,
              appliedTo: `${el.tagName.toLowerCase()} (${sel})`,
            });
          }
        }
      }
    }

    // ---- 4. Real gradient definitions ----
    const gradients: Array<{ css: string; context: string }> = [];
    const seenGradients = new Set<string>();

    const gradientSelectors = [
      '[class*="hero"]',
      'section:first-of-type',
      'header',
      'button',
      '[class*="btn"]',
      '[class*="cta"]',
      '[class*="gradient"]',
      'main > div:first-child',
      'body',
    ];

    for (const sel of gradientSelectors) {
      let els: NodeListOf<Element>;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (let i = 0; i < Math.min(els.length, 3); i++) {
        const el = els[i] as HTMLElement;
        if (!el) continue;
        const cs = getComputedStyle(el);
        const bg = cs.backgroundImage;
        if (bg && bg !== 'none' && (bg.includes('gradient') || bg.includes('linear') || bg.includes('radial'))) {
          if (!seenGradients.has(bg)) {
            seenGradients.add(bg);
            gradients.push({
              css: bg,
              context: `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} (${sel})`,
            });
          }
        }
      }
    }

    // ---- 5. Favicon ----
    let favicon: string | undefined;
    const iconLink = document.querySelector(
      'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
    ) as HTMLLinkElement | null;
    if (iconLink?.href) {
      favicon = iconLink.href;
    }

    if (!favicon) {
      const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
      if (ogImage?.content) {
        favicon = ogImage.content;
      }
    }

    return { logo, decorativeSvgs: decorativeSvgs.slice(0, 10), animations: animations.slice(0, 20), gradients: gradients.slice(0, 10), favicon };
  });

  // Download logo image if it's an external URL (not inline SVG)
  if (domAssets.logo?.imgUrl && !domAssets.logo.svg) {
    try {
      const imgUrl = new URL(domAssets.logo.imgUrl, baseUrl).href;
      if (imgUrl.endsWith('.svg')) {
        const resp = await fetch(imgUrl);
        if (resp.ok) {
          domAssets.logo.svg = await resp.text();
          log.info({ url: imgUrl }, 'Downloaded logo SVG from URL');
        }
      } else {
        const resp = await fetch(imgUrl);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          (domAssets.logo as { imgBase64?: string }).imgBase64 = buf.toString('base64');
          log.info({ url: imgUrl, sizeKB: Math.round(buf.length / 1024) }, 'Downloaded logo image');
        }
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to download logo image');
    }
  }

  // Download favicon if needed
  if (domAssets.favicon && !domAssets.favicon.startsWith('data:')) {
    try {
      const favUrl = new URL(domAssets.favicon, baseUrl).href;
      if (favUrl.endsWith('.svg')) {
        const resp = await fetch(favUrl);
        if (resp.ok) {
          domAssets.favicon = await resp.text();
        }
      } else {
        const resp = await fetch(favUrl);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          domAssets.favicon = `data:image/png;base64,${buf.toString('base64')}`;
        }
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to download favicon');
    }
  }

  return domAssets as BrandAssets;
}

// ---------------------------------------------------------------------------
// Color extraction
// ---------------------------------------------------------------------------

async function extractAllColors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const colorSet = new Set<string>();
    const colorProps = [
      'color',
      'background-color',
      'border-color',
      'border-top-color',
      'border-bottom-color',
      'border-left-color',
      'border-right-color',
      'outline-color',
      'text-decoration-color',
      'box-shadow',
    ];

    const elements = document.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, p, span, a, button, div, section, header, footer, nav, ' +
        'li, td, th, input, label, small, figcaption, main, article, aside, ' +
        '[class*="btn"], [class*="card"], [class*="badge"], [class*="tag"], [class*="hero"]',
    );

    const limit = Math.min(elements.length, 600);
    for (let i = 0; i < limit; i++) {
      const el = elements[i] as HTMLElement;
      if (!el) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const computed = getComputedStyle(el);
      for (const prop of colorProps) {
        const val = computed.getPropertyValue(prop);
        if (
          val &&
          val !== 'rgba(0, 0, 0, 0)' &&
          val !== 'transparent' &&
          val !== 'none' &&
          val !== 'currentcolor'
        ) {
          if (prop === 'box-shadow' && val !== 'none') {
            const rgbMatches = val.match(/rgba?\([^)]+\)/g);
            if (rgbMatches) {
              for (const m of rgbMatches) colorSet.add(m);
            }
          } else {
            colorSet.add(val);
          }
        }
      }
    }

    return Array.from(colorSet);
  });
}
