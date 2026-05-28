/**
 * GET /api/jobs/[id]/export/tcm
 *
 * Streams the original Helios TCM template re-filled with Compliance /
 * Deviation Ref / Vendor Comment from the persisted requirement state.
 * Structure preserved byte-for-byte per Helios's RFQ §8.2 clause.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { exportFilledTcm } from '@/lib/export';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await ctx.params;

  const [tcmDoc] = db
    .select()
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.jobId, jobId),
        eq(schema.documents.role, 'tcm_template'),
      ),
    )
    .all();

  if (!tcmDoc) {
    return NextResponse.json(
      {
        error:
          'No TCM template found for this job. Upload the HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx file and re-process.',
      },
      { status: 400 },
    );
  }

  const requirements = db
    .select({
      reqId: schema.requirements.reqId,
      suggestedCompliance: schema.requirements.suggestedCompliance,
      suggestedComment: schema.requirements.suggestedComment,
      vendorCompliance: schema.requirements.vendorCompliance,
      vendorComment: schema.requirements.vendorComment,
      deviationRef: schema.requirements.deviationRef,
      reviewStatus: schema.requirements.reviewStatus,
    })
    .from(schema.requirements)
    .where(eq(schema.requirements.jobId, jobId))
    .all();

  if (requirements.length === 0) {
    return NextResponse.json(
      {
        error:
          'TCM file is present but no requirements were parsed. The workbook may be malformed.',
      },
      { status: 400 },
    );
  }

  // Make sure the original file exists on disk before we try to load it.
  const originalPath = path.resolve('./uploads', jobId, tcmDoc.filename);
  try {
    await readFile(originalPath);
  } catch {
    return NextResponse.json(
      {
        error: `Original TCM file no longer on disk at ${originalPath}. Re-upload to regenerate.`,
      },
      { status: 410 },
    );
  }

  const buffer = await exportFilledTcm(originalPath, requirements);

  const outName = tcmDoc.filename.replace(/\.xlsx$/i, '_FILLED.xlsx');

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
