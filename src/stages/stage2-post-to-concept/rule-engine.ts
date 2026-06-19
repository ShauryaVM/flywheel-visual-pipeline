import type { PostSignals } from './signals.js';
import type { DecisionRulesData, ContentTypeRules } from '../../types/index.js';

export interface CandidateModality {
  modality: string;
  confidence: number;
  source_content_type: string;
}

/**
 * Evaluate a single condition string against computed signals.
 * Conditions use simple boolean expressions like:
 *   "has_list_structure && word_count >= 100"
 *   "mentions_person && !has_numbers"
 *   "true"
 */
function evaluateCondition(condition: string, signals: PostSignals): boolean {
  if (condition.trim() === 'true') return true;

  const ctx: Record<string, boolean | number> = {
    word_count: signals.word_count,
    has_numbers: signals.has_numbers,
    has_list_structure: signals.has_list_structure,
    has_questions: signals.has_questions,
    has_url_links: signals.has_url_links,
    mentions_person: signals.mentions_person,
    mentions_metric_or_stat: signals.mentions_metric_or_stat,
    exclamation_density: signals.exclamation_density,
    has_comparison_data: signals.has_comparison_data,
    has_trend_data: signals.has_trend_data,
    has_proportion_data: signals.has_proportion_data,
    numeric_count: signals.numeric_count,
  };

  try {
    const parts = condition.split('&&').map((p) => p.trim());
    return parts.every((part) => {
      const negated = part.startsWith('!');
      const expr = negated ? part.slice(1) : part;

      const compMatch = expr.match(
        /^(\w+)\s*(>=|<=|>|<|===|==)\s*(\d+(?:\.\d+)?)$/,
      );
      if (compMatch) {
        const [, varName, op, val] = compMatch;
        const lhs = ctx[varName!] as number;
        const rhs = parseFloat(val!);
        let result: boolean;
        switch (op) {
          case '>=':
            result = lhs >= rhs;
            break;
          case '<=':
            result = lhs <= rhs;
            break;
          case '>':
            result = lhs > rhs;
            break;
          case '<':
            result = lhs < rhs;
            break;
          default:
            result = lhs === rhs;
        }
        return negated ? !result : result;
      }

      const val = ctx[expr];
      const truthiness = typeof val === 'number' ? val > 0 : Boolean(val);
      return negated ? !truthiness : truthiness;
    });
  } catch {
    return false;
  }
}

/**
 * Run all decision rules across all content types and collect
 * the top matching candidate modalities, sorted by confidence.
 */
export function evaluateRules(
  signals: PostSignals,
  rulesData: DecisionRulesData,
): CandidateModality[] {
  const candidates: CandidateModality[] = [];

  for (const ctRules of rulesData.rules) {
    for (const rule of ctRules.rules) {
      if (evaluateCondition(rule.condition, signals)) {
        const isCatchAll = rule.condition.trim() === 'true';
        const confidence = isCatchAll
          ? Math.min(rule.confidence, 50)
          : rule.confidence;
        candidates.push({
          modality: rule.visual_modality,
          confidence,
          source_content_type: ctRules.content_type,
        });
        break;
      }
    }
  }

  // ChartGalaxy-inspired: inject chart modality candidates for data-heavy posts
  if (signals.has_comparison_data && signals.has_numbers && signals.numeric_count >= 2) {
    candidates.push({
      modality: 'bar_chart',
      confidence: 65,
      source_content_type: 'data_research_insight',
    });
  }

  if (signals.has_trend_data && signals.has_numbers) {
    candidates.push({
      modality: 'line_sparkline',
      confidence: 60,
      source_content_type: 'data_research_insight',
    });
  }

  if (signals.has_proportion_data && signals.has_numbers) {
    candidates.push({
      modality: 'pie_donut_chart',
      confidence: 58,
      source_content_type: 'data_research_insight',
    });
  }

  const deduped = new Map<string, CandidateModality>();
  for (const c of candidates) {
    const existing = deduped.get(c.modality);
    if (!existing || c.confidence > existing.confidence) {
      deduped.set(c.modality, c);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}
