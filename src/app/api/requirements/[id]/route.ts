/**
 * PATCH /api/requirements/[id]
 *
 * Apply a vendor review decision to a single requirement row. The id is
 * the composite `${jobId}:${reqId}` used as primary key in the
 * requirements table.
 *
 * Supported field updates (any subset, all optional):
 *   - vendorCompliance: 'C' | 'D' | 'N/A' | 'Review' | null
 *   - vendorComment: string | null
 *   - deviationRef: string | null
 *   - reviewStatus: 'pending' | 'approved' | 'edited' | 'rejected' | 'deviation'
 *
 * Any field absent from the body is left untouched. Returns the updated row.
 */

import { eq } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { db, schema } from '@/lib/db';

export const runtime = 'nodejs';

const PatchSchema = z.object({
  vendorCompliance: z.enum(['C', 'D', 'N/A', 'Review']).nullable().optional(),
  vendorComment: z.string().nullable().optional(),
  deviationRef: z.string().nullable().optional(),
  reviewStatus: z
    .enum(['pending', 'approved', 'edited', 'rejected', 'deviation'])
    .optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let parsed;
  try {
    parsed = PatchSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error: 'Invalid request body',
        details: e instanceof Error ? e.message : String(e),
      },
      { status: 400 },
    );
  }

  const [existing] = db
    .select()
    .from(schema.requirements)
    .where(eq(schema.requirements.id, id))
    .all();

  if (!existing) {
    return NextResponse.json({ error: 'Requirement not found' }, { status: 404 });
  }

  // Build the update object only with provided fields. We always bump
  // reviewedAt so the row is timestamped as having been touched by a
  // human (or at least an automated review action).
  const update: Partial<typeof schema.requirements.$inferInsert> = {
    reviewedAt: new Date(),
  };
  if (parsed.vendorCompliance !== undefined) update.vendorCompliance = parsed.vendorCompliance;
  if (parsed.vendorComment !== undefined) update.vendorComment = parsed.vendorComment;
  if (parsed.deviationRef !== undefined) update.deviationRef = parsed.deviationRef;
  if (parsed.reviewStatus !== undefined) update.reviewStatus = parsed.reviewStatus;

  db.update(schema.requirements)
    .set(update)
    .where(eq(schema.requirements.id, id))
    .run();

  const [updated] = db
    .select()
    .from(schema.requirements)
    .where(eq(schema.requirements.id, id))
    .all();

  return NextResponse.json(updated);
}
