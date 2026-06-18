import type { PostClassification } from '../schemas/modality.schema.js';
import { ModalitySchemaOutput, ContentType, VisualModality } from '../schemas/modality.schema.js';
import { createStageLogger } from '../observability/logger.js';

const log = createStageLogger('workstream-b:schema-inducer');

/**
 * Analyze classification results to produce a distribution summary and modality schema.
 */
export function induceSchema(classifications: PostClassification[]): ModalitySchemaOutput {
  log.info({ count: classifications.length }, 'Inducing schema from classifications');

  const total = classifications.length;
  const pairCounts = new Map<string, number>();

  for (const c of classifications) {
    const key = `${c.contentType}::${c.visualModality}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  const distribution = Array.from(pairCounts.entries()).map(([key, count]) => {
    const [contentType, visualModality] = key.split('::') as [string, string];
    return {
      contentType: contentType as PostClassification['contentType'],
      visualModality: visualModality as PostClassification['visualModality'],
      count,
      percentage: Math.round((count / total) * 10000) / 100,
    };
  });

  distribution.sort((a, b) => b.count - a.count);

  const topCombinations = distribution.slice(0, 10).map((entry, i) => ({
    contentType: entry.contentType,
    visualModality: entry.visualModality,
    count: entry.count,
    rank: i + 1,
  }));

  const contentTypeDescriptions: Record<string, { description: string; signals: string[] }> = {
    'hot-take': { description: 'A bold, contrarian opinion designed to spark debate', signals: ['strong stance', 'provocative framing', 'challenges conventional wisdom'] },
    'listicle': { description: 'Numbered or bulleted list of items, tips, or lessons', signals: ['numbered items', 'list format', '"X things" pattern'] },
    'story-arc': { description: 'Personal narrative with beginning, middle, and insight', signals: ['chronological flow', 'personal pronouns', 'lesson at end'] },
    'how-to': { description: 'Step-by-step instructions or process breakdown', signals: ['sequential steps', 'imperative verbs', 'actionable advice'] },
    'case-study': { description: 'Analysis of a specific example with results', signals: ['company/product name', 'before/after', 'metrics cited'] },
    'data-insight': { description: 'Post built around a key statistic or data point', signals: ['numbers prominent', 'percentage or metric', 'data source cited'] },
    'announcement': { description: 'News about a launch, hire, milestone, or event', signals: ['excited tone', 'news framing', 'call to action'] },
    'question-hook': { description: 'Opens with a provocative question to drive engagement', signals: ['starts with question', 'invites responses', 'curiosity gap'] },
    'contrarian': { description: 'Argues against popular belief in the industry', signals: ['negation of common view', '"unpopular opinion"', 'reframing'] },
    'before-after': { description: 'Shows transformation or comparison over time', signals: ['temporal contrast', 'change narrative', 'improvement metrics'] },
    'personal-reflection': { description: 'Introspective post sharing personal lessons', signals: ['vulnerability', 'first person', 'life/career lessons'] },
    'curated-roundup': { description: 'Collection of resources, tools, or recommendations', signals: ['multiple items', 'resource links', 'curation framing'] },
  };

  const modalityDescriptions: Record<string, { description: string; bestWith: string[] }> = {
    'quote-card': { description: 'Key quote or insight displayed prominently on a styled card', bestWith: ['hot-take', 'personal-reflection', 'contrarian'] },
    'single-stat-callout': { description: 'One bold statistic as the focal point', bestWith: ['data-insight', 'case-study', 'before-after'] },
    'multi-stat-panel': { description: 'Multiple statistics arranged in a panel layout', bestWith: ['data-insight', 'case-study', 'before-after'] },
    'chart-line': { description: 'Line chart showing trends over time', bestWith: ['data-insight', 'case-study'] },
    'chart-bar': { description: 'Bar chart comparing categories', bestWith: ['data-insight', 'curated-roundup'] },
    'chart-column': { description: 'Column chart for categorical comparison', bestWith: ['data-insight', 'case-study'] },
    'chart-pie': { description: 'Pie chart showing proportional breakdown', bestWith: ['data-insight'] },
    'chart-area': { description: 'Area chart for cumulative trends', bestWith: ['data-insight', 'before-after'] },
    'table': { description: 'Structured data in rows and columns', bestWith: ['curated-roundup', 'listicle', 'how-to'] },
    'diagram-flowchart': { description: 'Process flow or system diagram', bestWith: ['how-to', 'case-study', 'story-arc'] },
    'carousel-cover': { description: 'Cover slide for a multi-image carousel', bestWith: ['listicle', 'how-to', 'curated-roundup'] },
    'plain-graphic': { description: 'Logo + headline graphic with brand styling', bestWith: ['announcement', 'question-hook'] },
  };

  const contentTypes = ContentType.options.map((type: string) => ({
    type: type as PostClassification['contentType'],
    description: contentTypeDescriptions[type]?.description ?? '',
    exampleSignals: contentTypeDescriptions[type]?.signals ?? ['signal'],
  }));

  const visualModalities = VisualModality.options.map((modality: string) => ({
    modality: modality as PostClassification['visualModality'],
    description: modalityDescriptions[modality]?.description ?? '',
    bestPairedWith: (modalityDescriptions[modality]?.bestWith ?? ['hot-take']) as PostClassification['contentType'][],
  }));

  return ModalitySchemaOutput.parse({
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    totalPostsAnalyzed: total,
    contentTypes,
    visualModalities,
    distribution,
    topCombinations,
  });
}
