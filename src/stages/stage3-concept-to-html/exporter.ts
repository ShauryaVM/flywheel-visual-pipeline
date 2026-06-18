import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createStageLogger } from '../../observability/logger.js';

const log = createStageLogger('stage3:exporter');

export interface ExportOptions {
  html: string;
  outputDir: string;
  fileBaseName: string;
  width?: number;
  height?: number;
}

export interface ExportResult {
  htmlPath: string;
  pdfPath: string;
  pngPath: string;
}

/**
 * Export rendered HTML to PDF and PNG using Playwright.
 * Viewport is set to 1200x630 (LinkedIn image dimensions).
 */
export async function exportVisual(options: ExportOptions): Promise<ExportResult> {
  const { html, outputDir, fileBaseName, width = 1200, height = 630 } = options;

  await mkdir(outputDir, { recursive: true });

  const htmlPath = join(outputDir, `${fileBaseName}.html`);
  const pdfPath = join(outputDir, `${fileBaseName}.pdf`);
  const pngPath = join(outputDir, `${fileBaseName}.png`);

  await writeFile(htmlPath, html, 'utf-8');
  log.info({ htmlPath }, 'HTML written');

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height } });

    await page.setContent(html, { waitUntil: 'networkidle', timeout: 15_000 });

    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((r) => setTimeout(r, 5000)),
      ]),
    );

    await page.screenshot({
      path: pngPath,
      fullPage: false,
      type: 'png',
      clip: { x: 0, y: 0, width, height },
    });
    log.info({ pngPath }, 'PNG exported');

    await page.pdf({
      path: pdfPath,
      width: `${width}px`,
      height: `${height}px`,
      printBackground: true,
    });
    log.info({ pdfPath }, 'PDF exported');

    return { htmlPath, pdfPath, pngPath };
  } finally {
    if (browser) await browser.close();
  }
}
