// End-to-end smoke test for POST /api/jobs and GET /api/jobs/[id].
//
// Builds a minimal multi-file package in memory (1 TCM xlsx + 1 dummy PDF),
// uploads it to the local dev server, and verifies the response.
//
// Run with:  npx tsx scripts/test-upload.mjs

import ExcelJS from 'exceljs';

const API = process.env.API_BASE ?? 'http://localhost:4711';

// ─── Fixture: minimal TCM (3 reqs + 3 tags) and a fake PDF ───────────────────

const REQS = [
  ['R-001', '§3', 'Scope of supply per Incoterms 2020.'],
  ['R-049', '§5.4', 'Charpy V-notch impact testing at -196 °C.'],
  ['R-108', '§10', 'Conflict Minerals declaration (CMRT).'],
];
const TAGS = [
  ['FV-1012A', 'Inlet Separator Level CV - Train A (LP gas/condensate)'],
  ['SDV-1041A', 'Inlet ESDV - Train A (HP gas, fail close, SIL 3)'],
  ['ZV-8011A', 'Cold Box Feed Isolation Valve - Train A (cryogenic)'],
];

const wb = new ExcelJS.Workbook();
const cover = wb.addWorksheet('Cover & Instructions');
cover.getCell('B9').value = 'Document No.';
cover.getCell('C9').value = 'HEL-AZ2-TCM-001 (Rev. 0)';
cover.getCell('B10').value = 'Project';
cover.getCell('C10').value = 'Azura Sul FLNG Phase 2 - Topsides';
const reqs = wb.addWorksheet('Requirements Matrix');
reqs.addRow(['Req. ID', 'RFQ Section Ref', 'Requirement Description', '', '', '']);
for (const r of REQS) reqs.addRow([...r, '', '', '']);
const tags = wb.addWorksheet('Tag-Level Confirmation');
tags.addRow(['Tag No.', 'Helios Service Description', '', '', '', '']);
for (const t of TAGS) tags.addRow([...t, '', '', '', '']);
const tcmBuffer = Buffer.from(await wb.xlsx.writeBuffer());

// A 4-byte fake PDF magic so the classifier can detect it. The body content
// is irrelevant — we're testing classification + persistence, not PDF parsing.
const fakePdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100)]);

// ─── Build the multipart payload ─────────────────────────────────────────────

const form = new FormData();
form.append(
  'files',
  new File([tcmBuffer], 'HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }),
);
form.append(
  'files',
  new File([fakePdf], 'RFQ_HEL-PRO-2026-CV-0412_AzuraSulFLNG.pdf', {
    type: 'application/pdf',
  }),
);
form.append(
  'files',
  new File([fakePdf], 'HEL-GS-PNT-010_Rev5_PaintingCoatingSpec.pdf', {
    type: 'application/pdf',
  }),
);

console.log(`→ POST ${API}/api/jobs (3 files)`);
const postRes = await fetch(`${API}/api/jobs`, { method: 'POST', body: form });
const postBody = await postRes.json();

console.log(`← ${postRes.status}`);
console.log(JSON.stringify(postBody, null, 2));

if (postRes.status !== 200) {
  console.error('\n❌ POST failed');
  process.exit(1);
}

// ─── Verify via GET ──────────────────────────────────────────────────────────

console.log(`\n→ GET ${API}/api/jobs/${postBody.jobId}`);
const getRes = await fetch(`${API}/api/jobs/${postBody.jobId}`);
const getBody = await getRes.json();

console.log(`← ${getRes.status}`);
console.log(`  documents:        ${getBody.documents.length}`);
console.log(`  requirements:     ${getBody.requirements.length}`);
console.log(`  tagRequirements:  ${getBody.tagRequirements.length}`);
console.log(`  job.status:       ${getBody.job.status}`);

// ─── Assertions ──────────────────────────────────────────────────────────────

const failures = [];
if (postBody.documents.length !== 3) failures.push(`expected 3 docs, got ${postBody.documents.length}`);
if (postBody.tcm?.requirements !== REQS.length) failures.push(`tcm.requirements ≠ ${REQS.length}`);
if (postBody.tcm?.tags !== TAGS.length) failures.push(`tcm.tags ≠ ${TAGS.length}`);

const tcmDoc = postBody.documents.find((d) => d.role === 'tcm_template');
if (!tcmDoc) failures.push('TCM was not classified as tcm_template');

const pntDoc = postBody.documents.find((d) => d.role === 'painting_spec');
if (!pntDoc?.scanned) failures.push('Painting spec should be flagged scanned=true');

if (getBody.requirements.length !== REQS.length) failures.push(`GET requirements ≠ ${REQS.length}`);
if (getBody.tagRequirements.length !== TAGS.length) failures.push(`GET tags ≠ ${TAGS.length}`);

if (failures.length) {
  console.error('\n❌ FAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✅ PASS — upload pipeline works end-to-end.');
