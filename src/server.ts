import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, ensureBrandDesignSystem } from './index.js';
import { runStage2 } from './stages/stage2-post-to-concept/index.js';
import { runStage3 } from './stages/stage3-concept-to-html/index.js';
import { runStage4 } from './stages/stage4-eval/index.js';
import { clearDesignSystemSummaryCache, loadDesignSystemSummary } from './utils/design-system-summary.js';
import { clearRendererDesignSystemCache } from './stages/stage3-concept-to-html/renderer.js';
import { classifyCritique, generateRenderingOverrides } from './utils/rendering-overrides.js';
import { STRESS_TEST_CASES } from './stress-test-suite.js';
import type { DesignSystemData, EvalScore, PipelineResult } from './types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3737);
const HARNESS_PATH = resolve(__dirname, '..', 'harness', 'index.html');

/** Long pipeline runs exceed Node's default 5-minute requestTimeout if the HTTP connection is held open. */
const SERVER_REQUEST_TIMEOUT_MS = 0; // disabled — jobs return immediately; see /api/jobs/:id polling
const JOB_RETENTION_MS = 60 * 60 * 1000;

type JobStatus = 'running' | 'complete' | 'failed';

interface HarnessJob {
  status: JobStatus;
  error?: string;
  result?: Record<string, unknown>;
  startedAt: number;
  completedAt?: number;
}

const jobs = new Map<string, HarnessJob>();

function pruneOldJobs(): void {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.completedAt != null && job.completedAt < cutoff) {
      jobs.delete(id);
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

async function loadDesignSystemData(): Promise<DesignSystemData | null> {
  try {
    const raw = await readFile('data/design-system.json', 'utf-8');
    return JSON.parse(raw) as DesignSystemData;
  } catch {
    return null;
  }
}

function buildDesignSystemPayload(ds: DesignSystemData) {
  return {
    colors: ds.colors,
    typography: {
      families: ds.typography.font_families.map((f) => f.family),
      scale: ds.typography.scale,
    },
    brand: ds.brand_identity ?? null,
    borders: ds.borders ?? null,
  };
}

// In-memory cache for the last run to avoid re-crawling
let lastRunState: {
  postText: string;
  targetUrl: string;
  evalScore?: EvalScore;
} | null = null;

async function loadPngBase64(pngPath: string): Promise<string | null> {
  try {
    const pngBuf = await readFile(pngPath);
    return pngBuf.toString('base64');
  } catch {
    return null;
  }
}

async function buildGeneratePayload(result: PipelineResult): Promise<Record<string, unknown>> {
  const pngBase64 = await loadPngBase64(result.pngPath);
  const designSystem = await loadDesignSystemData();

  return {
    html: result.html,
    pngBase64,
    pngPath: result.pngPath,
    evalScore: result.evalScore ?? null,
    concept: {
      modality: result.selectedConcept.modality,
      headline: result.selectedConcept.headline,
      subhead: result.selectedConcept.subtext ?? null,
      all: result.concept.concepts.map((c) => ({
        modality: c.modality,
        headline: c.headline,
      })),
      selectedIndex: result.concept.selected,
    },
    designSystem: designSystem ? buildDesignSystemPayload(designSystem) : null,
  };
}

function startJob(jobId: string): void {
  pruneOldJobs();
  jobs.set(jobId, { status: 'running', startedAt: Date.now() });
}

function completeJob(jobId: string, result: Record<string, unknown>): void {
  jobs.set(jobId, {
    status: 'complete',
    result,
    startedAt: jobs.get(jobId)?.startedAt ?? Date.now(),
    completedAt: Date.now(),
  });
}

function failJob(jobId: string, error: string): void {
  jobs.set(jobId, {
    status: 'failed',
    error,
    startedAt: jobs.get(jobId)?.startedAt ?? Date.now(),
    completedAt: Date.now(),
  });
}

async function handleJobStatus(_req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    json(res, 404, { error: 'Job not found' });
    return;
  }

  json(res, 200, {
    jobId,
    status: job.status,
    error: job.error ?? null,
    result: job.result ?? null,
    startedAt: job.startedAt,
    completedAt: job.completedAt ?? null,
  });
}

async function handleRegenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { postText?: string; targetUrl?: string; critique?: string; previousScores?: Record<string, number> };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { postText, targetUrl, critique, previousScores } = body;
  if (!postText?.trim()) {
    json(res, 400, { error: 'postText is required' });
    return;
  }
  if (!targetUrl?.trim()) {
    json(res, 400, { error: 'targetUrl is required' });
    return;
  }
  if (!critique?.trim()) {
    json(res, 400, { error: 'critique is required' });
    return;
  }

  const postId = `harness-regen-${Date.now()}`;
  const outputDir = 'data/outputs';
  const jobId = postId;

  startJob(jobId);
  json(res, 202, { jobId, status: 'running' });

  void (async () => {
    try {
      clearDesignSystemSummaryCache();
      clearRendererDesignSystemCache();
      await ensureBrandDesignSystem(targetUrl);
      // Classify critique to determine regeneration strategy
      const classification = classifyCritique(critique);
      const renderingOverrides = generateRenderingOverrides(critique);

      let conceptOutput;
      let selectedConcept;

      if (classification.isRenderingOnly && lastRunState?.postText === postText) {
        // Rendering-only issues: re-render with CSS overrides, no concept regeneration
        const { readFile: readF } = await import('node:fs/promises');
        await readF(`${outputDir}/${postId.replace('regen', '')}/concept_output.json`, 'utf-8').catch(() => null);

        // Fall back to regenerating concept if we can't load the previous one
        conceptOutput = await runStage2(postText, {
          postId,
          outputDir,
        });
        selectedConcept = conceptOutput.concepts[conceptOutput.selected]!;
      } else {
        // Concept issues or both: regenerate concept with feedback
        conceptOutput = await runStage2(postText, {
          postId,
          outputDir,
          feedback: {
            previousScores: previousScores ?? {},
            critique,
          },
        });
        selectedConcept = conceptOutput.concepts[conceptOutput.selected]!;
      }

      const stage3 = await runStage3({
        concept: selectedConcept,
        postId,
        outputDir,
        renderingOverrides: renderingOverrides ?? undefined,
      });

      const subDir = `${outputDir}/${postId}`;
      const designSystemSummary = await loadDesignSystemSummary();

      const evalScore = await runStage4({
        htmlPath: stage3.htmlPath,
        postText,
        designSystemSummary,
        targetUrl,
        pngPath: stage3.pngPath,
        outputDir: subDir,
      });

      const pngBase64 = await loadPngBase64(stage3.pngPath);
      const designSystem = await loadDesignSystemData();

      const newComposite = evalScore.compositeScore ?? evalScore.overall;
      const oldComposite = previousScores?.compositeScore ?? previousScores?.overall ?? 0;
      const delta = Math.round((newComposite - oldComposite) * 100) / 100;

      const axesImproved: string[] = [];
      if (previousScores) {
        if (evalScore.onBrand > (previousScores.onBrand ?? 0)) axesImproved.push('onBrand');
        if (evalScore.legible > (previousScores.legible ?? 0)) axesImproved.push('legible');
        if (evalScore.clearHierarchy > (previousScores.clearHierarchy ?? 0)) axesImproved.push('clearHierarchy');
        if (evalScore.notGeneric > (previousScores.notGeneric ?? 0)) axesImproved.push('notGeneric');
      }

      lastRunState = { postText, targetUrl, evalScore };

      completeJob(jobId, {
        html: stage3.html,
        pngBase64,
        pngPath: stage3.pngPath,
        evalScore,
        concept: {
          modality: selectedConcept.modality,
          headline: selectedConcept.headline,
          subhead: selectedConcept.subtext ?? null,
          all: conceptOutput.concepts.map((c) => ({
            modality: c.modality,
            headline: c.headline,
          })),
          selectedIndex: conceptOutput.selected,
        },
        designSystem: designSystem ? buildDesignSystemPayload(designSystem) : null,
        comparison: {
          previousComposite: oldComposite,
          newComposite,
          delta,
          axesImproved,
        },
        regenerationStrategy: {
          classification: {
            isRenderingOnly: classification.isRenderingOnly,
            isConceptOnly: classification.isConceptOnly,
            isBoth: classification.isBoth,
            renderingIssues: classification.renderingIssues,
            conceptIssues: classification.conceptIssues,
          },
          renderingOverridesApplied: renderingOverrides?.appliedRules ?? [],
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failJob(jobId, `Regeneration failed: ${message}`);
    }
  })();
}

async function handleGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { postText?: string; targetUrl?: string; forceModality?: string; postId?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { postText, targetUrl, forceModality, postId: clientPostId } = body;
  if (!postText?.trim()) {
    json(res, 400, { error: 'postText is required' });
    return;
  }
  if (!targetUrl?.trim()) {
    json(res, 400, { error: 'targetUrl is required' });
    return;
  }

  const postId = clientPostId?.trim() || `harness-${Date.now()}`;
  const jobId = postId;

  startJob(jobId);
  json(res, 202, { jobId, status: 'running' });

  void (async () => {
    try {
      const result = await runPipeline({ postText, postId, targetUrl, forceModality });
      lastRunState = { postText, targetUrl, evalScore: result.evalScore };
      completeJob(jobId, await buildGeneratePayload(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failJob(jobId, `Pipeline failed: ${message}`);
    }
  })();
}

async function handleStressTestSuite(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  json(res, 200, {
    count: STRESS_TEST_CASES.length,
    cases: STRESS_TEST_CASES.map((c) => ({
      id: c.id,
      startup: c.startup,
      targetUrl: c.targetUrl,
      expectedModality: c.expectedModality,
      expectedTemplate: c.expectedTemplate,
      routing: c.routing ?? 'forced',
      text: c.text,
    })),
  });
}

async function handleRoot(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const html = await readFile(HARNESS_PATH, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Could not load harness/index.html');
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      await handleRoot(req, res);
    } else if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      const jobId = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
      await handleJobStatus(req, res, jobId);
    } else if (req.method === 'GET' && url.pathname === '/api/stress-test-suite') {
      await handleStressTestSuite(req, res);
    } else if (req.method === 'POST' && url.pathname === '/api/generate') {
      await handleGenerate(req, res);
    } else if (req.method === 'POST' && url.pathname === '/api/regenerate') {
      await handleRegenerate(req, res);
    } else {
      json(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    console.error('Unhandled server error:', err);
    if (!res.headersSent) {
      json(res, 500, { error: 'Internal server error' });
    }
  }
});

server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
server.headersTimeout = 65_000;

server.listen(PORT, () => {
  console.log(`\n  Flywheel Visual Pipeline Harness`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Running on http://localhost:${PORT}\n`);
});
