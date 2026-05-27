// Smoke test: build a minimal 3-sheet xlsx in memory mirroring the real
// Helios TCM, parse it with our parser, and assert the structure round-trips.
// Run with:  npx tsx scripts/test-tcm-parser.mjs

import ExcelJS from 'exceljs';
import { parseTcm } from '../src/lib/tcm-parser.ts';

// ─── Fixture: 3 reqs + 3 tags (real Helios row text from the IDS/TCM) ────────

const REQS = [
  [
    'R-001',
    '§3',
    'Scope of supply: complete engineering, manufacture, testing, inspection, painting, preservation, packing, marking and delivery DAP Porto Austral terminal per Incoterms 2020.',
  ],
  [
    'R-049',
    '§5.4',
    'Charpy V-notch impact testing at -196 °C: 27 J average / 20 J minimum per specimen, three specimens per heat.',
  ],
  [
    'R-108',
    '§10',
    'Conflict Minerals declaration (CMRT, latest RMI template) for tin, tantalum, tungsten and gold.',
  ],
];

const TAGS = [
  ['FV-1012A', 'Inlet Separator Level Control Valve - Train A (LP gas/condensate)'],
  ['SDV-1041A', 'Inlet ESDV - Train A (HP gas, fail close, SIL 3)'],
  ['ZV-8011A', 'Cold Box Feed Isolation Valve - Train A (cryogenic, extended bonnet)'],
];

// ─── Build the workbook ──────────────────────────────────────────────────────

const wb = new ExcelJS.Workbook();

const cover = wb.addWorksheet('Cover & Instructions');
cover.getCell('B2').value = 'ATTACHMENT I';
cover.getCell('B3').value = 'TECHNICAL COMPLIANCE MATRIX (TCM)';
cover.getCell('B8').value = 'Document Control';
cover.getCell('B9').value = 'Document No.';
cover.getCell('C9').value = 'HEL-AZ2-TCM-001 (Rev. 0)';
cover.getCell('B10').value = 'Project';
cover.getCell('C10').value = 'Azura Sul FLNG Phase 2 - Topsides';
cover.getCell('B11').value = 'Package';
cover.getCell('C11').value = 'Control, Shutdown & Blowdown Valves (Package CV-04)';
cover.getCell('B12').value = 'Issued by';
cover.getCell('C12').value = 'Helios Energy S.p.A. - Procurement & Subcontracts';
cover.getCell('B13').value = 'Issue Date';
cover.getCell('C13').value = '2026-04-22';

const reqs = wb.addWorksheet('Requirements Matrix');
reqs.addRow([
  'Req. ID',
  'RFQ Section Ref',
  'Requirement Description',
  'Compliance (C / D / N/A)',
  'Deviation Ref (Att. J)',
  'Vendor Comment',
]);
for (const r of REQS) reqs.addRow([...r, '', '', '']);

const tags = wb.addWorksheet('Tag-Level Confirmation');
tags.addRow([
  'Tag No.',
  'Helios Service Description',
  'Vendor Proposed Model',
  'Catalogue Sheet Ref',
  'SIL Cert Ref',
  'Lead Time (weeks)',
]);
for (const t of TAGS) tags.addRow([...t, '', '', '', '']);

const buffer = await wb.xlsx.writeBuffer();

// ─── Parse it back ───────────────────────────────────────────────────────────

const result = await parseTcm(Buffer.from(buffer));

console.log('Metadata:', JSON.stringify(result.metadata, null, 2));
console.log(`\nRequirements parsed: ${result.requirements.length}`);
for (const r of result.requirements) {
  console.log(`  ${r.reqId.padEnd(6)} ${r.rfqSectionRef.padEnd(8)} ${r.description.slice(0, 60)}…`);
}
console.log(`\nTags parsed: ${result.tagRequirements.length}`);
for (const t of result.tagRequirements) {
  console.log(`  ${t.tagNo.padEnd(12)} ${t.heliosServiceDescription.slice(0, 70)}…`);
}

// ─── Assert ──────────────────────────────────────────────────────────────────

const failures = [];
if (result.requirements.length !== REQS.length) {
  failures.push(`expected ${REQS.length} requirements, got ${result.requirements.length}`);
}
if (result.tagRequirements.length !== TAGS.length) {
  failures.push(`expected ${TAGS.length} tags, got ${result.tagRequirements.length}`);
}
if (result.metadata.documentNo !== 'HEL-AZ2-TCM-001 (Rev. 0)') {
  failures.push(`metadata.documentNo mismatch: got "${result.metadata.documentNo}"`);
}
if (result.requirements[0]?.rfqSectionRef !== '§3') {
  failures.push(`section ref normalisation failed: got "${result.requirements[0]?.rfqSectionRef}"`);
}

if (failures.length) {
  console.error('\n❌ FAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✅ PASS — parser round-trips correctly.');
