/**
 * Cross-document risk detection for tag-level Service Descriptions.
 *
 * Helios's RFQ §8.2 and TCM Cover §10 each contain a precedence clause; they
 * conflict (TCM "shall prevail" vs IDS "more stringent shall govern"). In
 * practice a real vendor cannot quote without manually reconciling every
 * tag where the two binding documents disagree on service description, SIL
 * classification, vessel, fluid, or pressure rating.
 *
 * This module surfaces those mismatches for the proposal engineer. It does
 * NOT auto-resolve — that requires judgement we won't pretend to have.
 *
 * Approach (per DECISIONS.md D-04 / D-05):
 *   1. Keyword retrieval (rule-based) finds the IDS chunks mentioning each
 *      tag — typically the corresponding "SHEET ## OF 15 - TAG <TAGNO>"
 *      header plus the data table on that page.
 *   2. A single LLM call per tag performs the semantic comparison and
 *      assigns a severity. The output is schema-constrained.
 *   3. Each persisted RiskSignal carries citations (TCM tag-level row,
 *      IDS pages) so the proposal engineer can inspect both sources.
 *
 * Cost: 29 tags × 1 call (gpt-4o-mini) ≈ $0.003. Latency: ~10-20s
 * with concurrency 4. Negligible vs. the enrichment sweep.
 */

import { callStructured } from './llm';
import type { Chunk } from './retrieval';
import { retrieveChunks } from './retrieval';
import type { Citation, RiskSeverity, RiskSignal } from './types';
import { validateSnippet } from './validate';

const SYSTEM_PROMPT = `You are a senior proposal engineer cross-checking valve tag service descriptions between two binding documents:
- TCM (Technical Compliance Matrix) — the vendor response template, Tag-Level Confirmation sheet.
- IDS (Instrument Data Sheets) — Helios's technical specification, one sheet per tag.

For one valve tag (e.g. SDV-1041A/B), you'll be given:
- The Helios Service Description from the TCM Tag-Level Confirmation sheet.
- 2-3 candidate chunks from the IDS document that mention this tag.

Decide:
1. idsServiceDescription — the service description for this tag verbatim from the IDS chunks. If the tag is not found, return "".
2. hasMismatch — true if the TCM description and the IDS description describe materially DIFFERENT valves (different fluid, vessel, SIL classification, pressure rating, or service).
3. severity:
   - "high"   = different valves (e.g. one says HP gas SIL 3, the other says LNG cryogenic SIL 3 — radically different design/price).
   - "medium" = similar service but key parameter differs (e.g. same service but SIL 2 vs SIL 3, or different vessel tag).
   - "low"    = naming granularity only (e.g. "Inlet Separator" vs "HP Separator V-1010" — plausibly the same vessel under different naming conventions).
   - "none"   = descriptions align on all the parameters that matter for quoting.
4. reason — ONE sentence (≤200 chars) explaining the call. Cite specific differences ("TCM says X, IDS says Y").

Never invent. If the IDS chunks do not contain the tag, return idsServiceDescription="", hasMismatch=false, severity="none", reason="Tag not found in IDS evidence."`;

const RISK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['idsServiceDescription', 'hasMismatch', 'severity', 'reason'],
  properties: {
    idsServiceDescription: { type: 'string' },
    hasMismatch: { type: 'boolean' },
    severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    reason: { type: 'string' },
  },
} as const;

type LlmRiskOutput = {
  idsServiceDescription: string;
  hasMismatch: boolean;
  severity: 'none' | RiskSeverity;
  reason: string;
};

export type AnalyseTagInput = {
  tagNo: string;
  tcmServiceDescription: string;
};

export type AnalysedTagRisk = {
  tagNo: string;
  idsServiceDescription: string;
  hasMismatch: boolean;
  severity: 'none' | RiskSeverity;
  reason: string;
  citations: Citation[];
};

/**
 * Run risk analysis for one tag against the indexed IDS chunks.
 * Pure function — no DB writes here.
 */
export async function analyseOneTagRisk(
  input: AnalyseTagInput,
  idsChunks: Chunk[],
): Promise<AnalysedTagRisk> {
  const candidates = retrieveChunks(input.tagNo, idsChunks, 3);

  if (candidates.length === 0) {
    return {
      tagNo: input.tagNo,
      idsServiceDescription: '',
      hasMismatch: false,
      severity: 'none',
      reason: 'Tag not located in the indexed IDS — cannot cross-check.',
      citations: [],
    };
  }

  const chunkContext = candidates
    .map((c, i) => `[Chunk ${i + 1}] docId=${c.docId} page=${c.page}\n${c.text.slice(0, 1500)}`)
    .join('\n\n---\n\n');

  const user = `Tag: ${input.tagNo}
TCM Tag-Level Confirmation service description:
"${input.tcmServiceDescription}"

IDS candidate chunks:

${chunkContext}

Extract the IDS service description for this tag and decide whether it materially aligns with the TCM description.`;

  const result = await callStructured<LlmRiskOutput>({
    system: SYSTEM_PROMPT,
    user,
    schema: RISK_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'tag_risk_analysis',
    temperature: 0,
    maxTokens: 400,
  });

  // Per-chunk citation verification. The LLM hands us one IDS service
  // description extracted from somewhere in the candidate chunks. We must
  // not blindly attach that snippet to every chunk — only the ones where
  // the snippet actually appears (literal / normalized / fuzzy ≥ 0.9 per
  // validateSnippet). Chunks that don't match are dropped from the
  // citation set entirely; if no chunk validates, the risk signal cannot
  // be grounded and we downgrade.
  const snippet = result.idsServiceDescription.slice(0, 300);
  const citations: Citation[] = [];
  for (const c of candidates) {
    if (!snippet) break;
    const v = validateSnippet(snippet, c.text);
    if (v.verified) {
      citations.push({ docId: c.docId, page: c.page, snippet, verified: true });
    }
  }

  const groundedSeverity: 'none' | RiskSeverity =
    citations.length === 0 && result.severity !== 'none'
      ? 'none' // can't ground the IDS side → don't surface as a confirmed risk
      : result.severity;

  return {
    tagNo: input.tagNo,
    idsServiceDescription: result.idsServiceDescription,
    hasMismatch: result.hasMismatch && citations.length > 0,
    severity: groundedSeverity,
    reason:
      citations.length === 0 && result.hasMismatch
        ? `${result.reason} [unverified — no IDS chunk contained the extracted description]`
        : result.reason,
    citations,
  };
}

/**
 * Convert an analysed-tag result into a RiskSignal record suitable for the
 * risk_signals table. Returns null for "none" severity (we don't persist
 * non-issues — the panel would be cluttered with 0/29 mismatch noise).
 */
export function toRiskSignal(
  analysed: AnalysedTagRisk,
  tcmDocId: string | null,
  tcmServiceDescription: string,
): RiskSignal | null {
  if (analysed.severity === 'none' || !analysed.hasMismatch) return null;

  const tcmCitation: Citation = {
    docId: tcmDocId ?? 'tcm-template',
    page: 0, // TCM is .xlsx not paginated; use 0 as a sentinel.
    snippet: tcmServiceDescription,
    verified: true, // Comes straight from the parsed TCM.
  };

  return {
    id: `${analysed.tagNo}:service-mismatch`,
    tagNo: analysed.tagNo,
    scope: 'tag-service-description',
    severity: analysed.severity as RiskSeverity,
    reason: analysed.reason,
    sources: [
      { source: 'tcm', text: tcmServiceDescription, citation: tcmCitation },
      ...analysed.citations.map((c) => ({
        source: 'ids' as const,
        text: analysed.idsServiceDescription,
        citation: c,
      })),
    ],
  };
}
