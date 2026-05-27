// Read the exported filled TCM and dump the first 20 rows of the
// Requirements Matrix sheet to confirm Compliance / Comment columns are
// populated. Run with:  npx tsx scripts/verify-export.mjs <path-to-xlsx>

import ExcelJS from 'exceljs';

const filePath = process.argv[2] ?? '/tmp/tcm_filled.xlsx';
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(filePath);

const reqs = workbook.worksheets.find((w) => /requirements?\s*matrix/i.test(w.name));
if (!reqs) throw new Error('Requirements Matrix sheet missing');

console.log(`Sheets: ${workbook.worksheets.map((w) => w.name).join(', ')}\n`);
console.log('Requirements Matrix — first 20 data rows:\n');
console.log('Req ID   | Section | Compliance | Dev Ref | Vendor Comment');
console.log('---------+---------+------------+---------+' + '-'.repeat(60));

let shown = 0;
reqs.eachRow((row) => {
  const reqId = String(row.getCell(1).value ?? '').trim();
  if (!/^R-\d{3}$/i.test(reqId)) return;
  if (shown >= 20) return;
  const section = String(row.getCell(2).value ?? '');
  const compliance = String(row.getCell(4).value ?? '');
  const devRef = String(row.getCell(5).value ?? '');
  const comment = String(row.getCell(6).value ?? '').slice(0, 60);
  console.log(
    `${reqId.padEnd(8)} | ${section.padEnd(7)} | ${compliance.padEnd(10)} | ${devRef.padEnd(7)} | ${comment}`,
  );
  shown++;
});

console.log(`\nTotal rows in Requirements Matrix: ${reqs.rowCount}`);
