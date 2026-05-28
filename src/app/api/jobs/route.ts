/**
 * POST /api/jobs
 *
 * Accepts a multipart upload of N files (the RFQ package), persists each
 * file to disk under ./uploads/{jobId}/, classifies its DocRole by filename
 * + magic-byte sniffing, records everything in the DB, and — if the TCM
 * template is among the uploads — parses it synchronously and inserts the
 * 108 requirements + 29 tag-level rows.
 *
 * Response: { jobId, status, documents[], tcm? }
 *
 * Out of scope right now (next pipeline stages, separate todos):
 *   - PDF text indexing into the chunks table
 *   - LLM enrichment of requirements
 *   - Cross-document risk detection
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import {
  classifyByFilename,
  detectLanguage,
  detectMimeType,
  detectScanned,
} from '@/lib/classify';
import { db, schema } from '@/lib/db';
import { isEffectivelyEmpty, parsePdf, PdfParseError } from '@/lib/pdf-parser';
import { parseTcm, TcmParseError } from '@/lib/tcm-parser';

// Force the Node runtime (we need fs access). Allow up to 60s — the bulk of
// the work is ExcelJS + 13 file writes which is fast, but PDF indexing in a
// later stage may push us closer to the limit.
export const runtime = 'nodejs';
export const maxDuration = 60;

const UPLOAD_ROOT = path.resolve('./uploads');

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: 'Failed to parse multipart body', details: String(e) },
      { status: 400 },
    );
  }

  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json(
      { error: 'No files in request — POST with `files` field, multipart' },
      { status: 400 },
    );
  }

  const jobId = randomUUID();
  const jobDir = path.join(UPLOAD_ROOT, jobId);
  await mkdir(jobDir, { recursive: true });

  // Create the job row up front so any downstream failure can be attributed.
  db.insert(schema.jobs).values({ id: jobId, status: 'classifying' }).run();

  type DocOut = {
    id: string;
    filename: string;
    role: string;
    mimeType: string;
    sizeBytes: number;
    scanned: boolean;
    language: string;
  };
  const documents: DocOut[] = [];
  let tcmBuffer: Buffer | null = null;
  let tcmDocId: string | null = null;

  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());

    // Path traversal hardening: an attacker-controlled filename like
    // "../../../etc/foo" would, under naive path.join, escape jobDir
    // and let the upload write anywhere the process can write. Force
    // basename + a containment check; reject anything that doesn't end
    // up *strictly* inside jobDir.
    const safeName = path.basename(file.name);
    if (!safeName || safeName === '.' || safeName === '..') {
      return NextResponse.json(
        { error: `Refused upload — illegal filename: ${JSON.stringify(file.name)}` },
        { status: 400 },
      );
    }
    const filePath = path.resolve(jobDir, safeName);
    const rel = path.relative(jobDir, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
      return NextResponse.json(
        { error: `Refused upload — filename resolves outside jobDir: ${JSON.stringify(file.name)}` },
        { status: 400 },
      );
    }
    await writeFile(filePath, buffer);

    const role = classifyByFilename(safeName);
    const mimeType = detectMimeType(buffer.subarray(0, 16));
    const scanned = detectScanned(role);
    const language = detectLanguage(role);
    const docId = randomUUID();

    db.insert(schema.documents)
      .values({
        id: docId,
        jobId,
        filename: safeName,
        role,
        mimeType,
        sizeBytes: buffer.length,
        pageCount: null,
        scanned,
        language,
      })
      .run();

    documents.push({
      id: docId,
      filename: safeName,
      role,
      mimeType,
      sizeBytes: buffer.length,
      scanned,
      language,
    });

    if (role === 'tcm_template') {
      tcmBuffer = buffer;
      tcmDocId = docId;
    }
  }

  // If we found the TCM, parse it and persist requirements + tags.
  let tcmStats:
    | {
        requirements: number;
        tags: number;
        metadata: Awaited<ReturnType<typeof parseTcm>>['metadata'];
      }
    | { error: string }
    | null = null;

  if (tcmBuffer && tcmDocId) {
    db.update(schema.jobs).set({ status: 'parsing_tcm' }).where(eq(schema.jobs.id, jobId)).run();
    try {
      const parsed = await parseTcm(tcmBuffer);

      db.transaction((tx) => {
        for (const r of parsed.requirements) {
          tx.insert(schema.requirements)
            .values({
              id: `${jobId}:${r.reqId}`,
              jobId,
              reqId: r.reqId,
              rfqSectionRef: r.rfqSectionRef,
              description: r.description,
              evidence: [],
            })
            .run();
        }
        for (const t of parsed.tagRequirements) {
          tx.insert(schema.tagRequirements)
            .values({
              id: `${jobId}:${t.tagNo}`,
              jobId,
              tagNo: t.tagNo,
              heliosServiceDescription: t.heliosServiceDescription,
            })
            .run();
        }
      });

      tcmStats = {
        requirements: parsed.requirements.length,
        tags: parsed.tagRequirements.length,
        metadata: parsed.metadata,
      };
    } catch (e) {
      const msg = e instanceof TcmParseError ? e.message : String(e);
      tcmStats = { error: msg };
    }
  }

  // ─── Index PDF text per page (for citation lookup later) ───────────────────

  db.update(schema.jobs)
    .set({ status: 'parsing_pdfs' })
    .where(eq(schema.jobs.id, jobId))
    .run();

  type PdfStat = {
    docId: string;
    filename: string;
    pageCount: number;
    chunksInserted: number;
    degraded: boolean;
    error?: string;
  };
  const pdfStats: PdfStat[] = [];

  for (const doc of documents) {
    if (doc.mimeType !== 'application/pdf') continue;

    const filePath = path.join(jobDir, doc.filename);
    try {
      const buffer = await readFile(filePath);
      const parsed = await parsePdf(buffer);
      const degraded = isEffectivelyEmpty(parsed);

      db.update(schema.documents)
        .set({ pageCount: parsed.pageCount })
        .where(eq(schema.documents.id, doc.id))
        .run();

      let inserted = 0;
      if (!degraded) {
        db.transaction((tx) => {
          for (const page of parsed.pages) {
            if (page.text.length === 0) continue;
            tx.insert(schema.chunks)
              .values({
                id: `${doc.id}:p${page.page}`,
                documentId: doc.id,
                page: page.page,
                text: page.text,
              })
              .run();
            inserted++;
          }
        });
      }

      pdfStats.push({
        docId: doc.id,
        filename: doc.filename,
        pageCount: parsed.pageCount,
        chunksInserted: inserted,
        degraded,
      });
    } catch (e) {
      const msg =
        e instanceof PdfParseError ? e.message : e instanceof Error ? e.message : String(e);
      pdfStats.push({
        docId: doc.id,
        filename: doc.filename,
        pageCount: 0,
        chunksInserted: 0,
        degraded: true,
        error: msg,
      });
    }
  }

  db.update(schema.jobs)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))
    .run();

  return NextResponse.json({
    jobId,
    status: 'completed',
    documents,
    tcm: tcmStats,
    pdfs: pdfStats,
  });
}
