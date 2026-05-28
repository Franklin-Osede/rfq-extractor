// Pre-implementation feasibility check for the SIS SIL-allocation cross-check.
// Decides whether the SIS PDF carries enough text-extractable signal per tag
// to justify building an LLM analyzer over it.
//
// Run with: node scripts/check-sis-coverage.mjs

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { extractText } from 'unpdf';

const SIS_PDF = process.env.SIS_PDF
  ?? 'uploads/0eeeec04-4ba3-49aa-9c02-d539bb4918a7/HEL-GS-SIS-007_Rev3_SISSILSpec.pdf';
const DB_PATH = process.env.DB_PATH ?? 'db/app.db';

const db = new Database(DB_PATH, { readonly: true });
const tagRows = db
  .prepare(`SELECT DISTINCT tag_no FROM tag_requirements ORDER BY tag_no`)
  .all();
db.close();

if (tagRows.length === 0) {
  console.error('No tag_requirements found in DB — upload the TCM first.');
  process.exit(2);
}

const tags = tagRows.map((r) => r.tag_no);
console.log(`Loaded ${tags.length} tags from TCM Tag-Level Confirmation.\n`);

const pdfBuf = await readFile(path.resolve(SIS_PDF));
const { text, totalPages } = await extractText(new Uint8Array(pdfBuf), {
  mergePages: false,
});

console.log(`SIS PDF: ${SIS_PDF}`);
console.log(`Pages: ${totalPages}`);
console.log(`Total chars (sum of all pages): ${text.reduce((s, p) => s + p.length, 0)}`);
console.log(`Avg chars/page: ${Math.round(text.reduce((s, p) => s + p.length, 0) / totalPages)}`);

// Sanity check that the extract is actually useful text and not scanner garbage.
const wholeText = text.join('\n\n');
const wordCount = wholeText.split(/\s+/).filter(Boolean).length;
const looksLikeRealText = wordCount > 200 && /[a-zA-Z]{4,}/.test(wholeText);
console.log(`Total words: ${wordCount}`);
console.log(`Extract looks like real text? ${looksLikeRealText ? 'YES' : 'NO — possibly scanned'}\n`);

// How does SIL appear at all in the document?
const silMentions = (wholeText.match(/\bSIL\s*[-]?\s*[1234]\b/gi) ?? []).length;
console.log(`Mentions of "SIL 1/2/3/4" anywhere: ${silMentions}`);

// Per-tag coverage.
const results = [];
for (const tag of tags) {
  // Normalize: SIS docs sometimes write "SDV-1041 A/B" instead of "SDV-1041A/B".
  const tagBase = tag.replace(/\s+/g, '').replace(/\/.*/, ''); // strip /B suffix
  const reTag = new RegExp(tagBase.replace(/[-\/]/g, '[-\\s\\/]?'), 'i');

  const pagesWithTag = [];
  text.forEach((p, i) => {
    if (reTag.test(p)) pagesWithTag.push(i + 1);
  });

  // For each page where the tag appears, look for a SIL token within 200 chars.
  let silNearTag = null;
  let silNearTagPage = null;
  for (const pageNo of pagesWithTag) {
    const p = text[pageNo - 1];
    const tagMatch = p.match(reTag);
    if (!tagMatch) continue;
    const around = p.slice(
      Math.max(0, tagMatch.index - 200),
      tagMatch.index + tagMatch[0].length + 200,
    );
    const silMatch = around.match(/\bSIL\s*[-]?\s*([1234])\b/i);
    if (silMatch) {
      silNearTag = silMatch[1];
      silNearTagPage = pageNo;
      break;
    }
  }

  results.push({
    tag,
    appears: pagesWithTag.length > 0,
    pages: pagesWithTag,
    silNearTag,
    silNearTagPage,
  });
}

// Summary.
const appearing = results.filter((r) => r.appears);
const withSil = results.filter((r) => r.silNearTag !== null);

console.log('\n─── Per-tag coverage ───');
for (const r of results) {
  const flag = r.silNearTag
    ? `SIL ${r.silNearTag} @ p.${r.silNearTagPage}`
    : r.appears
      ? `appears @ pages ${r.pages.join(',')} but no SIL within 200 chars`
      : 'NOT in SIS';
  console.log(`  ${r.tag.padEnd(20)} ${flag}`);
}

console.log('\n─── Verdict ───');
console.log(`Tags appearing in SIS at all:        ${appearing.length}/${tags.length}`);
console.log(`Tags with SIL within 200 chars:      ${withSil.length}/${tags.length}`);
const pct = Math.round((withSil.length / tags.length) * 100);
console.log(`SIS-grounded cross-check coverage:   ${pct}%`);

if (pct >= 60) {
  console.log('\nRecommendation: BUILD the SIS analyzer. Coverage justifies the effort.');
  process.exit(0);
} else if (pct >= 25) {
  console.log('\nRecommendation: BUILD but narrate as "additional safety evidence where available".');
  process.exit(0);
} else {
  console.log('\nRecommendation: SKIP analyzer. Document SIS as future source; spend time elsewhere.');
  process.exit(1);
}
