/**
 * GET /api/jobs/[id]
 *
 * Returns the full state of a job: header, documents, requirements, and
 * tag-level entries. The UI consumes this to render the review experience.
 *
 * Risk signals and citations come online in later stages (separate todos).
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const [job] = db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).all();
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const documents = db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.jobId, id))
    .all();

  const requirements = db
    .select()
    .from(schema.requirements)
    .where(eq(schema.requirements.jobId, id))
    .all();

  const tagRequirements = db
    .select()
    .from(schema.tagRequirements)
    .where(eq(schema.tagRequirements.jobId, id))
    .all();

  return NextResponse.json({
    job,
    documents,
    requirements,
    tagRequirements,
  });
}
