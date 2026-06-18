import { chromium } from 'playwright';
import { readdir, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUTPUT_ROOT = 'data/outputs';
const VIEWPORT = { width: 1200, height: 630 };

async function findHtmlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findHtmlFiles(full)));
    } else if (entry.name.endsWith('.html')) {
      results.push(full);
    }
  }
  return results;
}

async function main() {
  const htmlFiles = await findHtmlFiles(OUTPUT_ROOT);

  if (htmlFiles.length === 0) {
    console.log('No HTML files found in', OUTPUT_ROOT);
    process.exit(0);
  }

  console.log(`Found ${htmlFiles.length} HTML file(s) to export:\n`);
  for (const f of htmlFiles) console.log(`  ${f}`);
  console.log();

  const browser = await chromium.launch({ headless: true });
  const successes: string[] = [];
  const failures: string[] = [];

  try {
    for (const htmlPath of htmlFiles) {
      const dir = dirname(htmlPath);
      const base = basename(htmlPath, '.html');
      const pngPath = join(dir, `${base}.png`);
      const pdfPath = join(dir, `${base}.pdf`);
      const fileUrl = pathToFileURL(join(process.cwd(), htmlPath)).href;

      console.log(`[EXPORT] ${htmlPath}`);

      try {
        const page = await browser.newPage({ viewport: VIEWPORT });

        await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 15_000 });

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
          clip: { x: 0, y: 0, ...VIEWPORT },
        });
        console.log(`  -> PNG: ${pngPath}`);

        await page.pdf({
          path: pdfPath,
          width: `${VIEWPORT.width}px`,
          height: `${VIEWPORT.height}px`,
          printBackground: true,
        });
        console.log(`  -> PDF: ${pdfPath}`);

        await page.close();
        successes.push(pngPath);
      } catch (err) {
        console.error(`  [FAIL] ${htmlPath}:`, err instanceof Error ? err.message : err);
        failures.push(htmlPath);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n========== EXPORT SUMMARY ==========');
  console.log(`Success: ${successes.length}/${htmlFiles.length}`);
  for (const p of successes) console.log(`  [OK]   ${p}`);
  for (const p of failures) console.log(`  [FAIL] ${p}`);
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});
