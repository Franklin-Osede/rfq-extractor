/**
 * Deterministic citation validator.
 *
 * The promise: every LLM-suggested compliance value must point to a snippet
 * that actually exists in the cited document/page. This file implements that
 * check without any LLM calls — pure string operations against the indexed
 * page text from `chunks`.
 *
 * Three-tier check:
 *   1. Whitespace-normalised substring match  → verified, similarity 1.00.
 *   2. Aggressive normalisation (drop punctuation, lowercase) substring
 *      match → verified, similarity 0.95. This catches the common cases of
 *      curly vs straight quotes, en-dash vs hyphen, parenthesisation noise.
 *   3. Sentence-tokenise the source, compute string-similarity vs the
 *      snippet for each sentence, take the max. If ≥ 0.9 → verified (fuzzy).
 *
 * Anything below 0.9 is reported as unverified, which the caller uses to
 * downgrade a suggested compliance to "Review".
 */

import stringSimilarity from 'string-similarity';

export const SIMILARITY_THRESHOLD = 0.9;

export type ValidationResult = {
  verified: boolean;
  similarity: number;
  matchType: 'exact' | 'normalised' | 'fuzzy' | 'none';
};

export function validateSnippet(
  snippet: string,
  sourceText: string,
): ValidationResult {
  if (!snippet || !sourceText) {
    return { verified: false, similarity: 0, matchType: 'none' };
  }

  // Tier 1 — whitespace-normalised substring.
  const ns = collapseWhitespace(snippet);
  const nt = collapseWhitespace(sourceText);
  if (nt.includes(ns)) {
    return { verified: true, similarity: 1.0, matchType: 'exact' };
  }

  // Tier 2 — aggressive normalisation (case + punctuation stripped).
  const ans = aggressive(snippet);
  const ant = aggressive(sourceText);
  if (ans.length > 0 && ant.includes(ans)) {
    return { verified: true, similarity: 0.95, matchType: 'normalised' };
  }

  // Tier 3 — sentence-level fuzzy match.
  const sentences = splitSentences(nt);
  let bestSim = 0;
  for (const sent of sentences) {
    if (sent.length < 10) continue;
    const sim = stringSimilarity.compareTwoStrings(ns.toLowerCase(), sent.toLowerCase());
    if (sim > bestSim) bestSim = sim;
    if (bestSim >= 0.99) break;
  }

  if (bestSim >= SIMILARITY_THRESHOLD) {
    return { verified: true, similarity: bestSim, matchType: 'fuzzy' };
  }
  return { verified: false, similarity: bestSim, matchType: 'none' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function aggressive(s: string): string {
  return collapseWhitespace(
    s
      .toLowerCase()
      // Normalise common typographic substitutions before stripping.
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—−]/g, '-')
      .replace(/[^\w\s]/g, ''),
  );
}

function splitSentences(s: string): string[] {
  return s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
}
