/**
 * POST /api/jobs/[id]/risks
 *
 * Cross-document tag-level risk analysis. For every row of the TCM
 * Tag-Level Confirmation sheet, locate the corresponding tag in the
 * indexed IDS chunks and use an LLM to decide whether the two binding
 * documents describe the same valve. Mismatches are persisted as
 * RiskSignal rows; non-issues (severity = 'none') are not stored.
 *
 * Re-running this endpoint clears the previous signals for the job and
 * recomputes — useful when prompts evolve or when re-indexing.
 */

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import type { Chunk } from '@/lib/retrieval';
import { analyseOneTagRisk, toRiskSignal } from '@/lib/risks';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_CONCURRENCY = 4;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await ctx.params;

  const [job] = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).all();
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // Tags to analyse come from the TCM Tag-Level Confirmation parse.
  const tags = db
    .select()
    .from(schema.tagRequirements)
    .where(eq(schema.tagRequirements.jobId, jobId))
    .all();

  if (tags.length === 0) {
    return NextResponse.json(
      { error: 'No tag-level entries to analyse (TCM Tag-Level sheet was empty or missing)' },
      { status: 400 },
    );
  }

  // Pull IDS chunks for this job (one document role, many pages).
  const idsRows = db
    .select({
      chunkId: schema.chunks.id,
      docId: schema.chunks.documentId,
      page: schema.chunks.page,
      text: schema.chunks.text,
      role: schema.documents.role,
    })
    .from(schema.chunks)
    .innerJoin(schema.documents, eq(schema.chunks.documentId, schema.documents.id))
    .where(
      and(
        eq(schema.documents.jobId, jobId),
        eq(schema.documents.role, 'instrument_datasheets'),
      ),
    )
    .all();

  const idsChunks: Chunk[] = idsRows.map((r) => ({
    chunkId: r.chunkId,
    docId: r.docId,
    docRole: r.role,
    page: r.page,
    text: r.text,
  }));

  // The TCM document id is what RiskSignal citations point to on the TCM side.
  const [tcmDoc] = db
    .select()
    .from(schema.documents)
    .where(
      and(eq(schema.documents.jobId, jobId), eq(schema.documents.role, 'tcm_template')),
    )
    .all();
  const tcmDocId = tcmDoc?.id ?? null;

  // Reset previous signals for idempotency.
  db.delete(schema.riskSignals).where(eq(schema.riskSignals.jobId, jobId)).run();

  db.update(schema.jobs)
    .set({ status: 'detecting_risks' })
    .where(eq(schema.jobs.id, jobId))
    .run();

  // Concurrent sweep over tags.
  const errors: Array<{ tagNo: string; error: string }> = [];
  const persistedSignals: string[] = []; // ids
  let cursor = 0;

  async function worker() {
    while (cursor < tags.length) {
      const idx = cursor++;
      const tag = tags[idx];
      if (!tag) continue;
      try {
        const analysed = await analyseOneTagRisk(
          { tagNo: tag.tagNo, tcmServiceDescription: tag.heliosServiceDescription },
          idsChunks,
        );
        const signal = toRiskSignal(analysed, tcmDocId, tag.heliosServiceDescription);
        if (!signal) continue;

        db.insert(schema.riskSignals)
          .values({
            id: `${jobId}:${signal.id}`,
            jobId,
            tagNo: signal.tagNo,
            scope: signal.scope,
            severity: signal.severity,
            reason: signal.reason,
            sources: signal.sources,
          })
          .run();
        persistedSignals.push(signal.id);
      } catch (e) {
        errors.push({
          tagNo: tag.tagNo,
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

  // Aggregate by severity for the UI summary.
  const bySeverity = db
    .select()
    .from(schema.riskSignals)
    .where(eq(schema.riskSignals.jobId, jobId))
    .all()
    .reduce<Record<string, number>>((acc, r) => {
      acc[r.severity] = (acc[r.severity] ?? 0) + 1;
      return acc;
    }, {});

  return NextResponse.json({
    jobId,
    tagsAnalysed: tags.length,
    risksDetected: persistedSignals.length,
    failed: errors.length,
    errors,
    bySeverity,
  });
}
