// Full demo dry-run: simulate exactly what happens when the user uploads
// the 14-file Helios package via the UI, including the cancellable-fetch
// pitfall (we run upload → enrich → risks sequentially against the running
// dev server, then download the filled TCM, then validate it round-trips).
//
// Run with:  npx tsx scripts/dry-run.mjs
//
// Exit code 0 if every gate passes, 1 if anything misbehaves.

import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

const API = process.env.API_BASE ?? 'http://localhost:4711';
// Point this at any folder containing the 14-file Helios package. The default
// is convenient on the original author's machine; on a fresh clone, set
// SOURCE_DIR=/path/to/your/helios/files before running.
const SOURCE_DIR = process.env.SOURCE_DIR ?? 'uploads/0eeeec04-4ba3-49aa-9c02-d539bb4918a7';
const TMP_TCM = '/tmp/dry-run-tcm.xlsx';

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// ─── Phase 1: server reachable ───────────────────────────────────────────────

console.log('\n── Phase 1: server reachable ──');
{
  const r = await fetch(API).catch(() => null);
  check('dev server responds on 4711', r?.status === 200, `HTTP ${r?.status ?? 'no response'}`);
  if (!r) {
    console.error('aborting: dev server not running');
    process.exit(1);
  }
}

// ─── Phase 2: classifier picks roles correctly ───────────────────────────────

console.log('\n── Phase 2: full 14-file upload + classify ──');
const files = [
  'HEL-AZ2-DEV-Register-Template_RFQ-CV-0412.xlsx',
  'HEL-AZ2-IDS-INS-0412_RevB2_InstrumentDataSheets.pdf',
  'HEL-AZ2-PID-PRC-Series_DrawingRegister.pdf',
  'HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx',
  'HEL-AZ2-VendorRefList-Template_RFQ-CV-0412.xlsx',
  'HEL-GS-ACT-003_Rev2_ActuatorControlsSpec.pdf',
  'HEL-GS-CRY-002_Rev1_CryogenicSupplement.pdf',
  'HEL-GS-PKG-004_Rev3_PackingPreservationSpec.pdf',
  'HEL-GS-PNT-010_Rev5_PaintingCoatingSpec.pdf',
  'HEL-GS-SIS-007_Rev3_SISSILSpec.pdf',
  'HEL-GS-VAL-001_Rev4_GeneralValveSpec.pdf',
  'HEL-SCC-001_Rev2_SupplierCodeOfConduct.pdf',
  'Invoice 4.pdf',
  'RFQ_HEL-PRO-2026-CV-0412_AzuraSulFLNG.pdf',
];

const form = new FormData();
for (const f of files) {
  const buf = await readFile(path.join(SOURCE_DIR, f));
  const mime = f.endsWith('.xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'application/pdf';
  form.append('files', new File([buf], f, { type: mime }));
}

const t0 = Date.now();
const upRes = await fetch(`${API}/api/jobs`, { method: 'POST', body: form });
const upBody = await upRes.json();
const upElapsed = Date.now() - t0;

check('POST /api/jobs returns 200', upRes.status === 200, `${upElapsed}ms`);
check('14 docs persisted', upBody.documents?.length === 14, `got ${upBody.documents?.length}`);
check('TCM classified', upBody.documents?.some((d) => d.role === 'tcm_template'));
check('IDS classified', upBody.documents?.some((d) => d.role === 'instrument_datasheets'));
check('PID register classified', upBody.documents?.some((d) => d.role === 'pid_drawing_register'));
check('Painting spec flagged scanned', upBody.documents?.find((d) => d.role === 'painting_spec')?.scanned === true);
check('Cryogenic supplement flagged en+it', upBody.documents?.find((d) => d.role === 'cryogenic_supplement')?.language === 'en+it');
check('Invoice 4 classified as unknown', upBody.documents?.find((d) => d.filename === 'Invoice 4.pdf')?.role === 'unknown');
check('TCM parsed 108 reqs', upBody.tcm?.requirements === 108, `got ${upBody.tcm?.requirements}`);
check('TCM parsed 29 tags', upBody.tcm?.tags === 29, `got ${upBody.tcm?.tags}`);
// Package has 11 PDFs (master RFQ + IDS + PID register + 6 general specs +
// supplier code + Invoice 4) and 3 .xlsx (TCM, DEV Register, VendorRefList).
check('PDF indexing reported per PDF', Array.isArray(upBody.pdfs) && upBody.pdfs.length === 11, `got ${upBody.pdfs?.length}`);

const jobId = upBody.jobId;
console.log(`\njobId = ${jobId}`);

// ─── Phase 3: enrich sweep ───────────────────────────────────────────────────

console.log('\n── Phase 3: enrich (108 reqs) ──');
const e0 = Date.now();
const enrichRes = await fetch(`${API}/api/jobs/${jobId}/enrich`, { method: 'POST' });
const enrichBody = await enrichRes.json();
const eElapsed = Date.now() - e0;

check('POST /enrich returns 200', enrichRes.status === 200, `${eElapsed}ms`);
check('108/108 enriched', enrichBody.enriched === 108, `got ${enrichBody.enriched}`);
check('0 failures', enrichBody.failed === 0, `errors: ${enrichBody.errors?.length ?? 0}`);
check('citations.total > 0', (enrichBody.citations?.total ?? 0) > 0, `${enrichBody.citations?.total} citations`);
check('verified > 50%', enrichBody.citations?.verified / Math.max(1, enrichBody.citations?.total) > 0.5, `${enrichBody.citations?.verified}/${enrichBody.citations?.total}`);
check('compliance distribution has C', (enrichBody.byCompliance?.['C'] ?? 0) > 0, `${enrichBody.byCompliance?.['C']} C`);
check('compliance distribution has Review', (enrichBody.byCompliance?.['Review'] ?? 0) > 0, `${enrichBody.byCompliance?.['Review']} Review`);

// ─── Phase 4: risks sweep ────────────────────────────────────────────────────

console.log('\n── Phase 4: risks (29 tags) ──');
const r0 = Date.now();
const riskRes = await fetch(`${API}/api/jobs/${jobId}/risks`, { method: 'POST' });
const riskBody = await riskRes.json();
const rElapsed = Date.now() - r0;

check('POST /risks returns 200', riskRes.status === 200, `${rElapsed}ms`);
check('29 tags analysed', riskBody.tagsAnalysed === 29, `got ${riskBody.tagsAnalysed}`);
check('0 failures', riskBody.failed === 0, `errors: ${riskBody.errors?.length ?? 0}`);
check('at least 5 high-severity risks detected', (riskBody.bySeverity?.high ?? 0) >= 5, `${riskBody.bySeverity?.high} high`);

// ─── Phase 5: GET returns full state with risks ──────────────────────────────

console.log('\n── Phase 5: GET /api/jobs/[id] ──');
const getRes = await fetch(`${API}/api/jobs/${jobId}`);
const fullJob = await getRes.json();

check('GET returns 200', getRes.status === 200);
check('full state has documents', fullJob.documents?.length === 14);
check('full state has requirements', fullJob.requirements?.length === 108);
check('full state has tags', fullJob.tagRequirements?.length === 29);
check('full state has risks array', Array.isArray(fullJob.risks));
check('every requirement has enrichedAt timestamp', fullJob.requirements?.every((r) => r.enrichedAt != null));
check('high-confidence reqs have verified citations', fullJob.requirements?.filter((r) => r.suggestedCompliance === 'C').every((r) => r.evidence.some((e) => e.verified)));

// ─── Phase 6: TCM export ─────────────────────────────────────────────────────

console.log('\n── Phase 6: TCM export ──');
const expRes = await fetch(`${API}/api/jobs/${jobId}/export/tcm`);
check('GET /export/tcm returns 200', expRes.status === 200);
check('content-type is xlsx', expRes.headers.get('content-type')?.includes('spreadsheetml'));
check('content-disposition is attachment', expRes.headers.get('content-disposition')?.startsWith('attachment'));

const expBuf = Buffer.from(await expRes.arrayBuffer());
await writeFile(TMP_TCM, expBuf);
const fileStat = await stat(TMP_TCM);
check('downloaded file > 5KB', fileStat.size > 5000, `${fileStat.size} bytes`);

// Open the workbook and validate it round-trips.
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(expBuf.buffer.slice(expBuf.byteOffset, expBuf.byteOffset + expBuf.byteLength));
check('3 sheets present', wb.worksheets.length === 3, wb.worksheets.map((w) => w.name).join(', '));

const reqsSheet = wb.worksheets.find((w) => /requirements?\s*matrix/i.test(w.name));
let cFilled = 0;
let dFilled = 0;
let reviewBlanks = 0;
let commentsFilled = 0;
reqsSheet?.eachRow((row) => {
  const reqId = String(row.getCell(1).value ?? '').trim();
  if (!/^R-\d{3}$/i.test(reqId)) return;
  const compliance = String(row.getCell(4).value ?? '').trim();
  const comment = String(row.getCell(6).value ?? '').trim();
  if (compliance === 'C') cFilled++;
  if (compliance === 'D') dFilled++;
  if (compliance === '' && comment.startsWith('[NEEDS VENDOR REVIEW')) reviewBlanks++;
  if (comment.length > 0) commentsFilled++;
});

check('C compliance written in column D', cFilled > 0, `${cFilled} rows`);
check('D compliance written in column D', dFilled > 0, `${dFilled} rows`);
check('Review rows blank D + flagged comment', reviewBlanks > 0, `${reviewBlanks} rows`);
check('Vendor Comment column populated', commentsFilled > 50, `${commentsFilled}/108 rows`);

// ─── Phase 7: edge cases ─────────────────────────────────────────────────────

console.log('\n── Phase 7: edge cases ──');

// 7a — TCM only (no PDFs).
{
  const f = new FormData();
  const tcm = await readFile(path.join(SOURCE_DIR, 'HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx'));
  f.append('files', new File([tcm], 'HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const r = await fetch(`${API}/api/jobs`, { method: 'POST', body: f });
  const b = await r.json();
  check('TCM only — upload accepted', r.status === 200);
  check('TCM only — 108 reqs parsed', b.tcm?.requirements === 108);
  check('TCM only — no PDFs indexed', !b.pdfs?.length);
}

// 7b — PDF only (no TCM).
{
  const f = new FormData();
  const pdf = await readFile(path.join(SOURCE_DIR, 'RFQ_HEL-PRO-2026-CV-0412_AzuraSulFLNG.pdf'));
  f.append('files', new File([pdf], 'RFQ_HEL-PRO-2026-CV-0412_AzuraSulFLNG.pdf', { type: 'application/pdf' }));
  const r = await fetch(`${API}/api/jobs`, { method: 'POST', body: f });
  const b = await r.json();
  check('PDF only — upload accepted', r.status === 200);
  check('PDF only — no TCM parsed', b.tcm == null);
  check('PDF only — 1 PDF indexed', b.pdfs?.length === 1);

  // Calling enrich on a no-TCM job should 400 cleanly.
  const e = await fetch(`${API}/api/jobs/${b.jobId}/enrich`, { method: 'POST' });
  check('enrich on no-TCM returns 400', e.status === 400);
}

// 7c — empty multipart.
{
  const r = await fetch(`${API}/api/jobs`, { method: 'POST', body: new FormData() });
  check('empty upload returns 400', r.status === 400);
}

// 7d — random unrecognised filename.
{
  const f = new FormData();
  const buf = await readFile(path.join(SOURCE_DIR, 'Invoice 4.pdf'));
  f.append('files', new File([buf], 'random_unknown_file.pdf', { type: 'application/pdf' }));
  const r = await fetch(`${API}/api/jobs`, { method: 'POST', body: f });
  const b = await r.json();
  check('unknown filename — upload accepted', r.status === 200);
  check('unknown filename — role=unknown', b.documents?.[0]?.role === 'unknown');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(70)}`);
if (failures.length === 0) {
  console.log(`✅ DRY-RUN PASS — every gate green.`);
  console.log(`Timing: upload ${upElapsed}ms · enrich ${eElapsed}ms · risks ${rElapsed}ms.`);
  process.exit(0);
}
console.log(`❌ DRY-RUN FAIL — ${failures.length} gate(s):`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
