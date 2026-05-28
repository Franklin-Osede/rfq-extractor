/**
 * Deterministic parser for the SIS / SIL Equipment Specification.
 *
 * The Helios document `HEL-GS-SIS-007` ships a structured table on page 4
 * titled "SIL Allocation by Tag" where each row maps one or more valve tags
 * to the allocated SIL (1, 2 or 3). This is the COMPANY-side ground truth
 * for functional safety classification — it overrides any SIL implied in
 * the TCM service description because the SIS is a binding spec.
 *
 * Notation we have to handle:
 *   "SDV-1041A/B"         → two tags (SDV-1041A, SDV-1041B)
 *   "FV-2021A/B/C"        → three tags
 *   "SDV-7001 to 7006"    → range (SDV-7001, SDV-7002, ..., SDV-7006)
 *   "BDV-4003"            → single tag
 *
 * Output: a Map<tagNo, { sil, pageNo, lineText }> so the cross-checker can
 * cite the exact page and the verbatim table row.
 *
 * No LLM. No external dependencies beyond ExcelJS-free string ops.
 */

export type SisAllocation = {
  sil: 1 | 2 | 3 | 4;
  pageNo: number;
  /** The verbatim line from the SIS table, for citation. */
  lineText: string;
};

export type SisAllocationMap = Map<string, SisAllocation>;

/**
 * Parse the SIL allocation table out of the indexed SIS page texts.
 * `pages` is the per-page text array as produced by `unpdf.extractText`
 * (one entry per PDF page, 0-indexed).
 *
 * Returns an empty map if the SIS document is not present or the table is
 * not detected — the caller should treat that as "SIS source unavailable",
 * not as "no risks found".
 */
export function parseSisAllocations(pages: string[]): SisAllocationMap {
  const map: SisAllocationMap = new Map();

  // Find the page containing the SIL allocation table. The expected header
  // text is "SIL Allocation by Tag", and the right page is the one with
  // the MOST `SIL [1234]` tokens (the actual table, not a TOC reference).
  // Picking the first match would break on docs where a contents page
  // mentions "SIL Allocation by Tag" and the prose around it happens to
  // include a handful of SIL tokens. We also require at least 3 SIL tokens
  // to suppress noise pages.
  let tablePageIdx = -1;
  let bestSilTokens = 0;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const silTokens = (p.match(/\bSIL\s*[-]?\s*[1234]\b/g) ?? []).length;
    const hasHeader = /SIL Allocation by Tag|allocation by tag|SIL allocation/i.test(p);
    if (hasHeader && silTokens >= 3 && silTokens > bestSilTokens) {
      tablePageIdx = i;
      bestSilTokens = silTokens;
    }
  }
  if (tablePageIdx === -1) return map;

  const pageNo = tablePageIdx + 1;
  const lines = pages[tablePageIdx].split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const sil = extractSilFromLine(line);
    if (!sil) continue;

    const tags = extractTagsFromLine(line);
    if (tags.length === 0) continue;

    for (const tag of tags) {
      // First mention wins — later lines (notes, etc) should not overwrite.
      if (!map.has(tag)) {
        map.set(tag, { sil, pageNo, lineText: line });
      }
    }
  }

  return map;
}

/** Extract a SIL number 1..4 from a line. Returns null if no token found. */
export function extractSilFromLine(line: string): 1 | 2 | 3 | 4 | null {
  const m = line.match(/\bSIL\s*[-]?\s*([1234])\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n !== 1 && n !== 2 && n !== 3 && n !== 4) return null;
  return n;
}

/**
 * Extract canonical tag IDs from one SIL-table line.
 *
 * Handles the Helios conventions we observed in `HEL-GS-SIS-007 Rev 3`:
 *   - Pair / triple slash notation:        SDV-1041A/B, FV-2021A/B/C
 *   - Bare range notation:                 SDV-7001 to 7006
 *   - Range with shared letter suffix:     ZV-8011A to 8015A
 *   - Bare single tag:                     BDV-4003
 *
 * NOT supported (no occurrence in the Helios package; would also be
 * ambiguous to expand safely):
 *   - "SDV-1041/B" — missing first letter. Treat as malformed; if you
 *     hit this in another customer's doc, add an inference rule there.
 *
 * Output is always canonical UPPERCASE so the downstream Map lookup
 * matches TCM tags regardless of source casing.
 *
 * Tag prefixes recognised: SDV, BDV, FV, LV, PCV, TV, ZV, HV, ESDV, BV.
 * Add more here if a new tag prefix appears in the table.
 */
export function extractTagsFromLine(line: string): string[] {
  const tags = new Set<string>();
  const PREFIX = '(SDV|BDV|ESDV|FV|LV|PCV|TV|ZV|HV|BV)';

  // Pattern 1a: range with shared suffix "ZV-8011A to 8015A".
  // We match the suffix on the FROM side and require it (when present) to
  // appear identically on the TO side; otherwise we fall through to the
  // bare-range pattern.
  const rangeSuffixRe = new RegExp(
    `${PREFIX}-(\\d+)([A-Z])\\s+to\\s+(\\d+)([A-Z])`,
    'gi',
  );
  const consumedRanges = new Set<string>();
  for (const m of line.matchAll(rangeSuffixRe)) {
    const prefix = m[1].toUpperCase();
    const fromN = parseInt(m[2], 10);
    const fromLetter = m[3].toUpperCase();
    const toN = parseInt(m[4], 10);
    const toLetter = m[5].toUpperCase();
    if (fromLetter !== toLetter) continue;
    if (!(Number.isFinite(fromN) && Number.isFinite(toN) && toN >= fromN && toN - fromN < 50)) continue;
    for (let n = fromN; n <= toN; n++) tags.add(`${prefix}-${n}${fromLetter}`);
    consumedRanges.add(`${prefix}-${fromN}-${toN}`);
  }

  // Pattern 1b: bare range "SDV-7001 to 7006". Skip ranges already consumed
  // by 1a (so we don't expand them as bare on top of suffixed).
  const rangeRe = new RegExp(`${PREFIX}-(\\d+)\\s+to\\s+(\\d+)`, 'gi');
  for (const m of line.matchAll(rangeRe)) {
    const prefix = m[1].toUpperCase();
    const from = parseInt(m[2], 10);
    const to = parseInt(m[3], 10);
    if (consumedRanges.has(`${prefix}-${from}-${to}`)) continue;
    if (!(Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from < 50)) continue;
    for (let n = from; n <= to; n++) tags.add(`${prefix}-${n}`);
  }

  // Pattern 2: paired / multi-slash "SDV-1041A/B" or "FV-2021A/B/C".
  // Case-insensitive on the letters; canonicalize to uppercase in output.
  const pairRe = new RegExp(`${PREFIX}-(\\d+)([A-Za-z](?:\\s*/\\s*[A-Za-z])+)`, 'gi');
  for (const m of line.matchAll(pairRe)) {
    const prefix = m[1].toUpperCase();
    const base = m[2];
    const letters = m[3].split('/').map((s) => s.trim().toUpperCase()).filter(Boolean);
    for (const l of letters) tags.add(`${prefix}-${base}${l}`);
  }

  // Pattern 3: bare single tag "BDV-4003" or "SDV-1041A". Case-insensitive
  // letter; canonicalized uppercase in output.
  const singleRe = new RegExp(`${PREFIX}-(\\d+)([A-Za-z]?)(?![A-Za-z0-9/])`, 'gi');
  for (const m of line.matchAll(singleRe)) {
    const prefix = m[1].toUpperCase();
    const base = m[2];
    const letter = (m[3] ?? '').toUpperCase();
    const tag = `${prefix}-${base}${letter}`;
    // Don't add a bare "SDV-1041A" if we already split a pair that covers it.
    if (!Array.from(tags).some((t) => t.startsWith(`${prefix}-${base}`) && t !== tag)) {
      tags.add(tag);
    }
  }

  return Array.from(tags);
}

/**
 * Extract a SIL classification from free-text service description (e.g. the
 * TCM Tag-Level Confirmation column B text). Returns null if no SIL is
 * mentioned — that's not an error, plenty of low-criticality valves are
 * described without a SIL.
 */
export function extractSilFromServiceDescription(
  description: string,
): 1 | 2 | 3 | 4 | null {
  return extractSilFromLine(description);
}
