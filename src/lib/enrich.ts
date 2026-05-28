/**
 * LLM enrichment for TCM requirements.
 *
 * For each requirement (R-001..R-108):
 *   1. Retrieve top candidate chunks from the PDF corpus by keyword overlap.
 *   2. Ask the LLM to assign a compliance suggestion (C/D/N/A/Review),
 *      difficulty bucket, one-sentence rationale, draft vendor comment,
 *      and a set of citations pointing at verbatim snippets from the chunks.
 *   3. Deterministically validate every citation against the cited chunk
 *      text (validateSnippet). Un-grounded citations get verified=false.
 *   4. If no citation survives validation, downgrade suggestedCompliance to
 *      "Review" — we never show a confident answer without evidence.
 *
 * This implements the "different agents in a cycle" pattern the founder
 * called out in the interview transcript, but cheaply: the validator runs
 * deterministically instead of via a second LLM call (DECISIONS.md D-04).
 */

import { callStructured, type LlmUsage } from './llm';
import type { Chunk } from './retrieval';
import { retrieveChunks } from './retrieval';
import type { Citation, ComplianceStatus, RequirementDifficulty } from './types';
import { validateSnippet } from './validate';

const SYSTEM_PROMPT = `You are a senior proposal engineer at a valve manufacturer responding to a Helios Engineering RFQ for the Azura Sul FLNG project.

For ONE requirement from the official Technical Compliance Matrix (TCM), and a set of candidate evidence chunks extracted verbatim from the RFQ and supporting specifications, decide:

- suggestedCompliance, one of:
    C  = standard requirement; virtually any qualified vendor in this market complies (ISO 9001, ASME B16.34, NACE MR0175, ATEX, basic API monograms, hydrostatic test, etc.).
    D  = vendor likely needs to flag a deviation (very Helios-specific clauses, unusual test intervals, specific bank guarantee terms, narrow material restrictions).
    N/A = the requirement does not apply to the proposed scope.
    Review = ambiguous or insufficient evidence — human must decide.
- difficulty: standard | product-dependent | hard.
- rationale: ONE sentence (≤300 chars) explaining the call.
- suggestedComment: a short text the vendor would paste in the TCM "Vendor Comment" column (≤500 chars).
- citations: array of {docId, page, snippet} pointing at the chunk(s) that ground the decision. The snippet MUST be a VERBATIM substring from one of the provided chunks — copied exactly, character by character. If you cannot find verbatim evidence in the chunks, return citations: [] and suggestedCompliance: "Review".

CRITICAL RULES:
1. Quote snippets EXACTLY as they appear. No paraphrasing, no normalisation of spaces or punctuation.
2. Use the docId and page values printed in the chunk header — never invent.
3. Never claim compliance based on prior knowledge alone — only on the chunks you were given.
4. Prefer 1-3 citations, not many. Quality over quantity.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'suggestedCompliance',
    'difficulty',
    'rationale',
    'suggestedComment',
    'citations',
  ],
  properties: {
    suggestedCompliance: {
      type: 'string',
      enum: ['C', 'D', 'N/A', 'Review'],
    },
    difficulty: {
      type: 'string',
      enum: ['standard', 'product-dependent', 'hard'],
    },
    rationale: { type: 'string' },
    suggestedComment: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['docId', 'page', 'snippet'],
        properties: {
          docId: { type: 'string' },
          page: { type: 'integer' },
          snippet: { type: 'string' },
        },
      },
    },
  },
} as const;

type LlmOutput = {
  suggestedCompliance: ComplianceStatus;
  difficulty: RequirementDifficulty;
  rationale: string;
  suggestedComment: string;
  citations: Array<{ docId: string; page: number; snippet: string }>;
};

export type EnrichInput = {
  reqId: string;
  rfqSectionRef: string;
  description: string;
};

export type EnrichOutput = {
  reqId: string;
  difficulty: RequirementDifficulty;
  suggestedCompliance: ComplianceStatus;
  rationale: string;
  suggestedComment: string;
  evidence: Citation[];
  /** null when the LLM wasn't called (e.g. zero candidate chunks). */
  usage: LlmUsage | null;
};

/** Enrich a single requirement. Pure function — no DB writes here. */
export async function enrichRequirement(
  req: EnrichInput,
  corpus: Chunk[],
): Promise<EnrichOutput> {
  const query = `${req.rfqSectionRef} ${req.description}`;
  const candidates = retrieveChunks(query, corpus, 8);

  // If we have zero candidate chunks, skip the LLM call entirely.
  if (candidates.length === 0) {
    return {
      reqId: req.reqId,
      difficulty: 'product-dependent',
      suggestedCompliance: 'Review',
      rationale: 'No matching evidence in the indexed document corpus.',
      suggestedComment: '',
      evidence: [],
      usage: null,
    };
  }

  const chunkContext = candidates
    .map(
      (c, i) =>
        `[Chunk ${i + 1}] docId=${c.docId} docRole=${c.docRole} page=${c.page}\n${c.text.slice(0, 1500)}`,
    )
    .join('\n\n---\n\n');

  const user = `Requirement ${req.reqId} (${req.rfqSectionRef}):
"${req.description}"

Candidate evidence chunks:

${chunkContext}

Decide compliance and cite VERBATIM snippets from the chunks above.`;

  const { output: llmOut, usage } = await callStructured<LlmOutput>({
    system: SYSTEM_PROMPT,
    user,
    schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'enriched_requirement',
    temperature: 0.1,
    maxTokens: 800,
  });

  // Deterministically validate each citation against its claimed chunk.
  const verifiedCitations: Citation[] = llmOut.citations.map((c) => {
    const chunk = candidates.find(
      (ch) => ch.docId === c.docId && ch.page === c.page,
    );
    if (!chunk) {
      return { docId: c.docId, page: c.page, snippet: c.snippet, verified: false };
    }
    const v = validateSnippet(c.snippet, chunk.text);
    return {
      docId: c.docId,
      page: c.page,
      snippet: c.snippet,
      verified: v.verified,
    };
  });

  // No verified citations ⇒ force Review status regardless of what the LLM said.
  const hasGrounding = verifiedCitations.some((c) => c.verified);
  const finalCompliance: ComplianceStatus = hasGrounding
    ? llmOut.suggestedCompliance
    : 'Review';

  return {
    reqId: req.reqId,
    difficulty: llmOut.difficulty,
    suggestedCompliance: finalCompliance,
    rationale: llmOut.rationale,
    suggestedComment: llmOut.suggestedComment,
    evidence: verifiedCitations,
    usage,
  };
}
