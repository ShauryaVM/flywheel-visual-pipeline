/**
 * Phase 0 signal computation for post text.
 * These signals drive the decision-rules engine to pick candidate modalities.
 */

export interface PostSignals {
  word_count: number;
  has_numbers: boolean;
  has_list_structure: boolean;
  has_questions: boolean;
  has_url_links: boolean;
  mentions_person: boolean;
  mentions_metric_or_stat: boolean;
  exclamation_density: number;
  has_comparison_data: boolean;
  has_trend_data: boolean;
  has_proportion_data: boolean;
  numeric_count: number;
}

export function computeSignals(postText: string): PostSignals {
  const words = postText.split(/\s+/).filter(Boolean);
  const word_count = words.length;

  const has_numbers = /\d+/.test(postText);

  const has_list_structure =
    /(?:^|\n)\s*(?:\d+[\.\)\-]|[-*\u2022])\s/m.test(postText) ||
    /(?:^|\n)\s*\d+\s*[-\.)\u2013]\s/m.test(postText);

  const has_questions = /\?/.test(postText);

  const has_url_links =
    /https?:\/\/[^\s]+/.test(postText) || /lnkd\.in/i.test(postText);

  const personPatterns = [
    /\b(?:CEO|CTO|CFO|COO|VP|founder|co-founder)\b/i,
    /@\w+/,
    /\b[A-Z][a-z]+ [A-Z][a-z]+\b/,
  ];
  const mentions_person = personPatterns.some((p) => p.test(postText));

  const metricPatterns = [
    /\d+[%x×]/,
    /\$\d+/,
    /\d+\s*(?:million|billion|M|B|K)\b/i,
    /\b(?:revenue|ARR|MRR|growth|raised|funding|valuation)\b/i,
    /\d+\+\s*(?:stars|forks|users|customers|companies|employees)/i,
  ];
  const mentions_metric_or_stat = metricPatterns.some((p) => p.test(postText));

  const exclamationCount = (postText.match(/!/g) || []).length;
  const sentenceCount = Math.max(
    1,
    postText.split(/[.!?]+/).filter((s) => s.trim().length > 0).length,
  );
  const exclamation_density = exclamationCount / sentenceCount;

  const comparisonPatterns = [
    /\bvs\.?\b/i,
    /\bversus\b/i,
    /\bcompared to\b/i,
    /\bmore than\b/i,
    /\bless than\b/i,
    /\bhigher\b.*\blower\b/i,
    /\b\d+.*\bvs\b.*\d+/i,
  ];
  const has_comparison_data = comparisonPatterns.some((p) => p.test(postText));

  const trendPatterns = [
    /\b(?:grew|growth|increased|rose|climbed|surged|jumped)\b/i,
    /\b(?:declined|dropped|fell|decreased|shrank)\b/i,
    /\b(?:year[- ]over[- ]year|YoY|QoQ|MoM|quarter[- ]over[- ]quarter)\b/i,
    /\b(?:trend|trajectory|over time)\b/i,
    /\d+[%x×].*\b(?:YoY|QoQ|growth|increase)\b/i,
  ];
  const has_trend_data = trendPatterns.some((p) => p.test(postText));

  const proportionPatterns = [
    /\d+%\s*(?:of|say|report|are|were|think|believe)/i,
    /\b(?:share|portion|proportion|distribution|breakdown)\b/i,
    /\b(?:majority|minority)\b/i,
  ];
  const has_proportion_data = proportionPatterns.some((p) => p.test(postText));

  const numericMatches = postText.match(/\d+(?:\.\d+)?[%x×]?/g) || [];
  const numeric_count = numericMatches.length;

  return {
    word_count,
    has_numbers,
    has_list_structure,
    has_questions,
    has_url_links,
    mentions_person,
    mentions_metric_or_stat,
    exclamation_density,
    has_comparison_data,
    has_trend_data,
    has_proportion_data,
    numeric_count,
  };
}
