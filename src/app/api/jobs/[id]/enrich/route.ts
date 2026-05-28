/**
 * POST /api/jobs/[id]/enrich
 *
 * Runs LLM enrichment for every requirement of the given job. For each row
 * in `requirements`, retrieves candidate chunks from the indexed PDF text,
 * calls the LLM with a structured-output schema, validates citations
 * deterministically, and updates the row in DB.
 *
 * Concurrency: limited to 4 in-flight LLM calls. Empirically tested at
 * 4 / 6 / 8 against gpt-4o-mini tier 1 (200k TPM): 4 lands at 117s with
 * 0 failures; 6 lands at 114s with ~7 failures (the TPM cap dominates,
 * not concurrency); 8 produces 50+ failures. Retries (maxRetries=5 in
 * llm.ts) help with transient spikes but cannot lift the TPM ceiling.
 * To go faster than ~117s, bump the OpenAI tier.
 *
 * The route returns aggregate stats; the UI re-fetches the full job state.
 */

import { and, eq, ne } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { enrichRequirement, type EnrichInput, type EnrichOutput } from '@/lib/enrich';
import { estimateCostUsd } from '@/lib/llm';
import type { Chunk } from '@/lib/retrieval';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min upper bound for the full sweep.

const MAX_CONCURRENCY = 4;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await ctx.params;

  const [job] = db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .all();
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const requirements = db
    .select()
    .from(schema.requirements)
    .where(eq(schema.requirements.jobId, jobId))
    .all();

  if (requirements.length === 0) {
    return NextResponse.json(
      { error: 'No requirements to enrich (TCM was not parsed for this job)' },
      { status: 400 },
    );
  }

  // Build the corpus from the chunks table, joined with document role.
  // Unknown-role docs (e.g. the noise "Invoice 4.pdf" in the test package)
  // are kept on disk for inventory but excluded from the evidence corpus —
  // otherwise their text becomes citeable and an irrelevant document can
  // ground a compliance suggestion. This is a hard auditability boundary.
  const allChunks = db
    .select({
      chunkId: schema.chunks.id,
      docId: schema.chunks.documentId,
      page: schema.chunks.page,
      text: schema.chunks.text,
      docRole: schema.documents.role,
    })
    .from(schema.chunks)
    .innerJoin(schema.documents, eq(schema.chunks.documentId, schema.documents.id))
    .where(
      and(
        eq(schema.documents.jobId, jobId),
        ne(schema.documents.role, 'unknown'),
      ),
    )
    .all();

  const corpus: Chunk[] = allChunks.map((c) => ({
    chunkId: c.chunkId,
    docId: c.docId,
    docRole: c.docRole,
    page: c.page,
    text: c.text,
  }));

  db.update(schema.jobs)
    .set({ status: 'enriching_requirements' })
    .where(eq(schema.jobs.id, jobId))
    .run();

  // Bounded-concurrency sweep.
  const results: EnrichOutput[] = [];
  const errors: Array<{ reqId: string; error: string }> = [];
  let cursor = 0;

  async function worker() {
    while (cursor < requirements.length) {
      const idx = cursor++;
      const row = requirements[idx];
      if (!row) continue;
      const input: EnrichInput = {
        reqId: row.reqId,
        rfqSectionRef: row.rfqSectionRef,
        description: row.description,
      };
      try {
        const out = await enrichRequirement(input, corpus);
        results.push(out);
        db.update(schema.requirements)
          .set({
            difficulty: out.difficulty,
            suggestedCompliance: out.suggestedCompliance,
            suggestedComment: out.suggestedComment,
            rationale: out.rationale,
            evidence: out.evidence,
            enrichedAt: new Date(),
          })
          .where(eq(schema.requirements.id, row.id))
          .run();
      } catch (e) {
        errors.push({
          reqId: row.reqId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, worker));

  db.update(schema.jobs)
    .set({ status: 'completed' })
    .where(eq(schema.jobs.id, jobId))
    .run();

  // Aggregate stats for the UI.
  const byCompliance = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.suggestedCompliance] = (acc[r.suggestedCompliance] ?? 0) + 1;
    return acc;
  }, {});
  const verifiedCitations = results.reduce(
    (sum, r) => sum + r.evidence.filter((e) => e.verified).length,
    0,
  );
  const totalCitations = results.reduce((sum, r) => sum + r.evidence.length, 0);

  // Cost + latency telemetry across the LLM sweep. Skipped no-op rows
  // (usage === null) contribute nothing — we only count calls we actually
  // made. Latency stats use wall time per call (concurrent calls
  // overlap), so totalLatencyMs is "sum of per-call durations", not the
  // sweep duration. The dry-run prints the sweep duration separately.
  const calls = results
    .map((r) => r.usage)
    .filter((u): u is NonNullable<typeof u> => u !== null);
  const inputTokens = calls.reduce((s, u) => s + u.inputTokens, 0);
  const outputTokens = calls.reduce((s, u) => s + u.outputTokens, 0);
  const costUsd = calls.reduce((s, u) => s + estimateCostUsd(u), 0);
  const totalLatencyMs = calls.reduce((s, u) => s + u.latencyMs, 0);
  const avgLatencyMs = calls.length > 0 ? Math.round(totalLatencyMs / calls.length) : 0;
  const provider = calls[0]?.provider ?? null;
  const model = calls[0]?.model ?? null;

  return NextResponse.json({
    jobId,
    enriched: results.length,
    failed: errors.length,
    errors,
    byCompliance,
    citations: { total: totalCitations, verified: verifiedCitations },
    llm: {
      provider,
      model,
      calls: calls.length,
      inputTokens,
      outputTokens,
      costUsd: Number(costUsd.toFixed(4)),
      avgLatencyMs,
    },
  });
}
