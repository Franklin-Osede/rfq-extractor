/**
 * Keyword-based chunk retrieval. Deliberately no embeddings — see
 * DECISIONS.md D-03 for why semantic retrieval is overengineering for this
 * closed-package extraction task.
 *
 * The strategy: extract significant words from the query (≥5 chars, drop
 * stopwords), then score each chunk by weighted keyword frequency. Return
 * the top N chunks that actually match.
 *
 * This is "good enough" for the take-home because:
 *   - Helios's requirements use the same domain vocabulary as the specs
 *     they reference (NACE MR0175, Charpy V-notch, fugitive emission ISO
 *     15848-1, etc.) — keyword overlap is high.
 *   - The corpus is tiny (~13 docs, maybe 200 chunks). Brute-force scoring
 *     is microseconds.
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
  'shall',
]);

export function retrieveChunks(
  query: string,
  chunks: Chunk[],
  topN = 8,
): Chunk[] {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return chunks.slice(0, topN);

  const scored = chunks.map((chunk) => {
    const text = chunk.text.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const matches = text.match(new RegExp(escapeRegex(kw), 'g'));
      if (matches) score += matches.length * kw.length; // weight by word length
    }
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((s) => s.chunk);
}

function extractKeywords(text: string): string[] {
  const matches = text.toLowerCase().match(/\b[a-z][a-z0-9-]{4,}\b/g) ?? [];
  const unique = Array.from(new Set(matches));
  return unique.filter((w) => !STOPWORDS.has(w));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
