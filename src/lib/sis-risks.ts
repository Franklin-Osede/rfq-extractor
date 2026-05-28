/**
 * Deterministic SIL-allocation cross-check.
 *
 * Compares the SIL stated in each TCM Tag-Level service description against
 * the SIL allocated to the same tag in the SIS spec table. Discrepancies
 * are surfaced as RiskSignal rows.
 *
 * Why deterministic: the SIS table is structured data (page 4 of
 * HEL-GS-SIS-007) and the TCM service description carries the SIL as a
 * literal "SIL N" token where it appears at all. There is zero ambiguity
 * here — an LLM call would add cost without adding correctness.
 *
 * Severity rules:
 *   - HIGH   = TCM mentions a SIL and SIS allocates a DIFFERENT one. This
 *              changes valve certification, FMEDA, architecture (HFT) and
 *              cost — proposal-blocking unless resolved before bid.
 *   - LOW    = SIS allocates a SIL but the TCM service description does
 *              not mention any SIL. Not a contradiction, just a vendor
 *              reminder to confirm the cert covers the SIS level. Kept
 *              out of the demo headline; visible on the full-list view.
 *   - (no signal emitted)
 *              = TCM and SIS agree, or neither side specifies a SIL.
 */

import type { Chunk } from './retrieval';
import { parseSisAllocations, extractSilFromServiceDescription } from './sis-parser';
import type { Citation, RiskSeverity, RiskSignal } from './types';

export type SisCheckInput = {
  tagNo: string;
  tcmServiceDescription: string;
};

export type SisCheckResult = {
  signal: RiskSignal | null;
  /** Whether the tag was found in the SIS table at all. Used for stats. */
  foundInSis: boolean;
};

/**
 * Run the SIS SIL cross-check for every TCM tag.
 * Returns one RiskSignal per mismatch, plus per-tag findings for telemetry.
 *
 * @param tags          The TCM Tag-Level rows for this job.
 * @param sisChunks     Indexed page chunks of the SIS document.
 * @param sisDocId      The document id of the SIS, used as the citation
 *                      pointer on the SIS side.
 * @param tcmDocId      The TCM document id, used on the TCM side.
 */
export function analyseTagSilAllocations(
  tags: Array<SisCheckInput>,
  sisChunks: Chunk[],
  sisDocId: string,
  tcmDocId: string,
): {
  signals: RiskSignal[];
  stats: {
    sisTableFound: boolean;
    sisTagsAllocated: number;
    tagsAnalysed: number;
    hardMismatches: number;
    tcmSilent: number;
    aligned: number;
    notInSis: number;
  };
} {
  // Reassemble pages in order. We don't care about page IDs beyond rebuilding
  // the page-indexed array; the parser will find page 4 (or wherever the
  // table is) by content, not by index.
  const byPage = new Map<number, string>();
  for (const c of sisChunks) byPage.set(c.page, c.text);
  const maxPage = sisChunks.reduce((m, c) => Math.max(m, c.page), 0);
  const pages: string[] = [];
  for (let p = 1; p <= maxPage; p++) pages.push(byPage.get(p) ?? '');

  const allocMap = parseSisAllocations(pages);

  const signals: RiskSignal[] = [];
  const stats = {
    sisTableFound: allocMap.size > 0,
    sisTagsAllocated: allocMap.size,
    tagsAnalysed: tags.length,
    hardMismatches: 0,
    tcmSilent: 0,
    aligned: 0,
    notInSis: 0,
  };

  for (const tag of tags) {
    const sisEntry = allocMap.get(tag.tagNo);
    const tcmSil = extractSilFromServiceDescription(tag.tcmServiceDescription);

    if (!sisEntry) {
      stats.notInSis += 1;
      continue;
    }

    if (tcmSil === null) {
      stats.tcmSilent += 1;
      signals.push(buildSignal(tag, sisEntry, sisDocId, tcmDocId, null, 'low'));
      continue;
    }

    if (tcmSil === sisEntry.sil) {
      stats.aligned += 1;
      continue;
    }

    stats.hardMismatches += 1;
    signals.push(buildSignal(tag, sisEntry, sisDocId, tcmDocId, tcmSil, 'high'));
  }

  return { signals, stats };
}

function buildSignal(
  tag: SisCheckInput,
  sisEntry: { sil: number; pageNo: number; lineText: string },
  sisDocId: string,
  tcmDocId: string,
  tcmSil: 1 | 2 | 3 | 4 | null,
  severity: RiskSeverity,
): RiskSignal {
  const tcmCitation: Citation = {
    docId: tcmDocId || 'tcm-template',
    page: 0,
    snippet: tag.tcmServiceDescription,
    verified: true,
  };
  const sisCitation: Citation = {
    docId: sisDocId,
    page: sisEntry.pageNo,
    snippet: sisEntry.lineText.slice(0, 300),
    verified: true,
  };

  const reason =
    tcmSil === null
      ? `SIS allocates SIL ${sisEntry.sil} to ${tag.tagNo}; TCM service description does not state a SIL — vendor must confirm cert coverage.`
      : `TCM service description states SIL ${tcmSil}; SIS allocates SIL ${sisEntry.sil} — two binding documents disagree on functional safety classification.`;

  return {
    id: `${tag.tagNo}:sil-allocation`,
    tagNo: tag.tagNo,
    scope: 'tag-sil-classification',
    severity,
    reason,
    sources: [
      { source: 'tcm', text: tag.tcmServiceDescription, citation: tcmCitation },
      { source: 'sis_spec', text: sisEntry.lineText, citation: sisCitation },
    ],
  };
}
