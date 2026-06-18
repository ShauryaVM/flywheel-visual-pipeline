import 'dotenv/config';
import { parseArgs } from 'node:util';
import { runPipeline } from './index.js';
import { runStage2 } from './stages/stage2-post-to-concept/index.js';
import { runStage3 } from './stages/stage3-concept-to-html/index.js';
import { logger } from './observability/logger.js';

const { values } = parseArgs({
  options: {
    run: { type: 'boolean', default: false },
    stage: { type: 'string' },
    post: { type: 'string' },
    url: { type: 'string', default: 'https://flywheelos.com' },
    output: { type: 'string', default: 'data/outputs' },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

function printHelp(): void {
  console.log(`
flywheel-visual-pipeline

Usage:
  npx tsx src/cli.ts --run --post "Your post text here"
  npx tsx src/cli.ts --stage 2 --post "Your post text"
  npx tsx src/demo.ts    (run 5 demo posts)

Options:
  --run       Run the full pipeline (stages 2+3)
  --stage     Run a specific stage (2, 3)
  --post      Post text to process (required for pipeline and stage 2)
  --output    Output directory (default: data/outputs)
  --help      Show this help message
`);
}

async function main(): Promise<void> {
  if (values.help) {
    printHelp();
    return;
  }

  if (values.run) {
    if (!values.post) {
      logger.error('--post is required for full pipeline run');
      process.exit(1);
    }
    const result = await runPipeline({
      postText: String(values.post),
      outputDir: String(values.output ?? 'data/outputs'),
    });
    logger.info({ pdfPath: result.pdfPath, pngPath: result.pngPath }, 'Pipeline complete');
    return;
  }

  if (values.stage) {
    switch (values.stage) {
      case '2':
        if (!values.post) {
          logger.error('--post is required for stage 2');
          process.exit(1);
        }
        await runStage2(String(values.post));
        break;
      case '3': {
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile('data/outputs/concept_output.json', 'utf-8');
        const conceptOutput = JSON.parse(raw);
        const selected = conceptOutput.concepts[conceptOutput.selected];
        await runStage3({ concept: selected });
        break;
      }
      case 'workstream-b':
        await import('./workstream-b/index.js');
        break;
      default:
        logger.error({ stage: values.stage }, 'Unknown stage');
        process.exit(1);
    }
    return;
  }

  printHelp();
}

main().catch((err) => {
  logger.fatal(err, 'CLI error');
  process.exit(1);
});
