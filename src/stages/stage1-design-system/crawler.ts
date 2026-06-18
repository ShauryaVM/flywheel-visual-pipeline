import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { createStageLogger } from '../../observability/logger.js';

const log = createStageLogger('stage1:crawler');

// ---------------------------------------------------------------------------
// Types for raw crawl data (all JSON-serializable)
// ---------------------------------------------------------------------------

export interface RawCrawlData {
  pages: PageData[];
  cssVariables: Record<string, string>;
  logoCandidates: LogoCandidate[];
  allColors: string[];
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
  log.info({ targetUrl }, 'Starting multi-page site crawl');

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    });

    // Phase 1: Crawl homepage
    const homePage = await context.newPage();
    const homeData = await crawlPage(homePage, targetUrl);
    await homePage.close();

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
        subpageData.push(data);
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
    await globalPage.close();

    const totalTimeMs = Date.now() - totalStart;
    log.info(
      {
        pagesAnalyzed: allPages.length,
        cssVarCount: Object.keys(cssVariables).length,
        logoCount: logoCandidates.length,
        uniqueColorCount: allColors.length,
        totalTimeMs,
      },
      'Multi-page crawl complete',
    );

    return { pages: allPages, cssVariables, logoCandidates, allColors, totalTimeMs };
  } finally {
    if (browser) await browser.close();
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
