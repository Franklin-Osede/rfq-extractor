// Standalone smoke test for the SIS allocation parser.
// Runs the parser against the real SIS PDF and prints expected counts.

import { readFile } from 'node:fs/promises';
import { extractText } from 'unpdf';
import { parseSisAllocations } from '../src/lib/sis-parser.ts';

const SIS_PDF = process.env.SIS_PDF
  ?? 'uploads/0eeeec04-4ba3-49aa-9c02-d539bb4918a7/HEL-GS-SIS-007_Rev3_SISSILSpec.pdf';

const buf = await readFile(SIS_PDF);
const { text } = await extractText(new Uint8Array(buf), { mergePages: false });
const map = parseSisAllocations(text);

console.log(`Total tags allocated by SIS: ${map.size}\n`);

const sorted = Array.from(map.entries()).sort();
for (const [tag, alloc] of sorted) {
  console.log(`  ${tag.padEnd(15)} SIL ${alloc.sil}  @ p.${alloc.pageNo}`);
}

// Quick sanity checks against the verified ground truth.
const expected = {
  'SDV-1041A': 3, 'SDV-1041B': 3,
  'SDV-1043': 3,
  'SDV-2055A': 3, 'SDV-2055B': 3,
  'BDV-4001A': 3, 'BDV-4001B': 3,
  'BDV-4003': 3,
  'SDV-7001': 2, 'SDV-7002': 2, 'SDV-7003': 2,
  'SDV-7004': 2, 'SDV-7005': 2, 'SDV-7006': 2,
  'ZV-8011A': 2, 'ZV-8011B': 2,
  'FV-1012A': 2, 'FV-1012B': 2,
  'FV-1014': 2,
  'PCV-1033': 2,
  'FV-2021A': 1, 'FV-2021B': 1, 'FV-2021C': 1,
  'TV-5022A': 1, 'TV-5022B': 1,
  'LV-6031': 1,
  'LV-6033A': 1, 'LV-6033B': 1,
};

let passed = 0, failed = 0;
for (const [tag, expSil] of Object.entries(expected)) {
  const got = map.get(tag);
  if (got && got.sil === expSil) {
    passed++;
  } else {
    console.log(`✗ ${tag} — expected SIL ${expSil}, got ${got ? `SIL ${got.sil}` : 'undefined'}`);
    failed++;
  }
}

console.log(`\n${passed}/${passed + failed} expected tag mappings present.`);
if (failed > 0) process.exit(1);
