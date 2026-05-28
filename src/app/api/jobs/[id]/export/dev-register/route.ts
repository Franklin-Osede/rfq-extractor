/**
 * GET /api/jobs/[id]/export/dev-register
 *
 * Streams the Helios DEV Register template populated with one row per
 * requirement the vendor marked as a deviation (reviewStatus = 'deviation').
 * Template structure preserved; example "DELETE BEFORE SUBMISSION" rows
 * are removed from the output.
 *
 * Returns 400 if the job had no DEV Register template uploaded.
 * Returns 422 if no requirements are marked as deviations (nothing to
 * write — the vendor should download the empty template directly instead).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { exportDevRegister, type DeviationRow } from '@/lib/export';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await ctx.params;

  const [devDoc] = db
    .select()
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.jobId, jobId),
        eq(schema.documents.role, 'dev_register_template'),
      ),
    )
    .all();

  if (!devDoc) {
    return NextResponse.json(
      {
        error:
          'No DEV Register template found for this job. Include HEL-AZ2-DEV-Register-Template_RFQ-CV-0412.xlsx in the upload.',
      },
      { status: 400 },
    );
  }

  // Pull requirements with reviewStatus = 'deviation'.
  const allReqs = db
    .select()
    .from(schema.requirements)
    .where(eq(schema.requirements.jobId, jobId))
    .all();

  const deviationReqs = allReqs.filter((r) => r.reviewStatus === 'deviation');

  if (deviationReqs.length === 0) {
    return NextResponse.json(
      {
        error:
          'No requirements are marked as deviations yet. Use the "Mark deviation" action in the review panel before exporting.',
      },
      { status: 422 },
    );
  }

  const rows: DeviationRow[] = deviationReqs.map((r) => ({
    reqId: r.reqId,
    rfqSectionRef: r.rfqSectionRef,
    description: r.description,
    deviationDescription: r.vendorComment ?? r.suggestedComment ?? '',
    justification: r.rationale ?? 'Vendor flagged this requirement as a deviation.',
    deviationRef: r.deviationRef,
  }));

  const originalPath = path.resolve('./uploads', jobId, devDoc.filename);
  try {
    await readFile(originalPath);
  } catch {
    return NextResponse.json(
      {
        error: `Original DEV Register file no longer on disk at ${originalPath}. Re-upload to regenerate.`,
      },
      { status: 410 },
    );
  }

  const buffer = await exportDevRegister(originalPath, rows);
  const outName = devDoc.filename.replace(/\.xlsx$/i, '_FILLED.xlsx');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${outName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
