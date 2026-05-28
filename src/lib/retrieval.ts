/**
 * Keyword-based chunk retrieval. Deliberately no embeddings — see
 * DECISIONS.md D-03 for why semantic retrieval is overengineering for this
 * closed-package extraction task.
 *
 * Strategy:
 *   1. Extract significant words (≥3 chars, drop stopwords, retain known
 *      short technical acronyms like SIL / ISO / API / ASME / NACE).
 *   2. Score each chunk by weighted keyword frequency.
 *   3. Boost any chunk that contains a literal valve-tag token from the
 *      query (`SDV-1041A`, `BDV-4003`, etc.) — those are exact-match
 *      anchors and should always rank first regardless of word score.
 *   4. Dedupe chunks whose opening line matches an already-selected chunk
 *      (boilerplate headers like "INSTRUMENT DATA SHEET — IDS Attachment A"
 *      otherwise crowd out the actual data pages).
 *   5. Return the top N. If no chunk scored above zero, return [] — never
 *      blindly hand the LLM the first N chunks; "no evidence" is a
 *      legitimate, auditable outcome.
 */

export type Chunk = {
  chunkId: string;
  docId: string;
  docRole: string;
  page: number;
  text: string;
};

const STOPWORDS = new Set([
  'shall',
  'must',
  'should',
  'with',
  'from',
  'this',
  'that',
  'which',
  'have',
  'been',
  'will',
  'such',
  'each',
  'their',
  'than',
  'them',
  'these',
  'those',
  'where',
  'when',
  'while',
  'whose',
  'about',
  'after',
  'before',
  'between',
  'including',
  // common short words that would slip past a ≥3-char floor
  'the',
  'and',
  'for',
  'are',
  'all',
  'any',
  'its',
  'not',
  'per',
  'use',
  'one',
  'two',
  'has',
  'was',
]);

/**
 * Short technical acronyms / domain tokens we want to KEEP even though
 * they're below the general word-length floor. Capture-list, not
 * derived — keep small and review when the customer changes.
 */
const ACRONYM_WHITELIST = new Set([
  'sil',
  'iso',
  'api',
  'asme',
  'nace',
  'cri',
  'mto',
  'fat',
  'sat',
  'sdv',
  'bdv',
  'esd',
  'esdv',
  'pcv',
  'lcv',
  'tcv',
  'fcv',
  'hv',
  'zv',
  'bv',
  'fv',
  'lv',
  'tv',
  'mr',
  'lng',
  'bog',
  'agru',
  'lpg',
  'hp',
  'lp',
  'ip',
  'gas',
  'oil',
]);

/** Regex for valve tag tokens like "SDV-1041A" or "BDV-4003". */
const TAG_REGEX = /\b([A-Z]{1,5}-\d{2,5}[A-Z]?)\b/g;

const TAG_BOOST = 10_000; // overwhelms any word-frequency score

export function retrieveChunks(
  query: string,
  chunks: Chunk[],
  topN = 8,
): Chunk[] {
  const keywords = extractKeywords(query);
  const tags = extractTags(query);

  // No usable signal at all → "no grounded evidence". The caller will
  // surface this as Review / "tag not located", which is the correct
  // auditability outcome — never fall back to "first N chunks".
  if (keywords.length === 0 && tags.length === 0) return [];

  const scored = chunks.map((chunk) => {
    const text = chunk.text.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const matches = text.match(new RegExp(escapeRegex(kw), 'g'));
      if (matches) score += matches.length * kw.length;
    }
    // Tag exact match — case-insensitive on the same canonical form the
    // downstream readers use.
    if (tags.length > 0) {
      const original = chunk.text;
      for (const tag of tags) {
        // Match both "SDV-1041A" verbatim and "SDV 1041 A" (whitespace
        // variants extracted PDFs sometimes produce).
        const compact = tag;
        const spaced = tag.replace(/-/g, '[-\\s]?').replace(/([A-Z])([A-Z])/gi, '$1\\s?$2');
        if (
          original.includes(compact) ||
          new RegExp(`\\b${spaced}\\b`, 'i').test(original)
        ) {
          score += TAG_BOOST;
          break; // one boost per chunk, not per tag
        }
      }
    }
    return { chunk, score };
  });

  const ranked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Dedupe by chunk header (first non-empty line). Multiple pages of the
  // same template-formatted document repeat the same banner; once we've
  // pulled one, the others rarely add evidence.
  const seenHeaders = new Set<string>();
  const out: Chunk[] = [];
  for (const s of ranked) {
    if (out.length >= topN) break;
    const header = firstMeaningfulLine(s.chunk.text);
    if (header && seenHeaders.has(header)) continue;
    if (header) seenHeaders.add(header);
    out.push(s.chunk);
  }
  return out;
}

function extractKeywords(text: string): string[] {
  // ≥3-char tokens. We later filter against STOPWORDS but keep
  // ACRONYM_WHITELIST entries regardless.
  const matches = text.toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/g) ?? [];
  const unique = Array.from(new Set(matches));
  return unique.filter((w) => {
    if (STOPWORDS.has(w)) return false;
    if (w.length >= 5) return true; // legacy floor: keep longer technical terms
    return ACRONYM_WHITELIST.has(w);
  });
}

function extractTags(query: string): string[] {
  const matches = query.match(TAG_REGEX) ?? [];
  return Array.from(new Set(matches));
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length >= 12) return t.slice(0, 80);
  }
  return '';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
