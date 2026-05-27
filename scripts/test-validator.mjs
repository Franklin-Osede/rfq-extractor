// Unit tests for the deterministic snippet validator.
// Run with:  npx tsx scripts/test-validator.mjs

import { validateSnippet, SIMILARITY_THRESHOLD } from '../src/lib/validate.ts';

const HELIOS_PAGE = `
8. NOTES & SPECIAL REQUIREMENTS
NACE MR0175 / ISO 15156 - sour service, H2S 14 ppm wet. Fire-safe per
API 607 7th Ed. All wetted parts to be PMI verified. Anti-cavitation
trim required; vendor to confirm sigma at min flow.
`.trim();

const cases = [
  // [label, snippet, expectedVerified, expectedMatchType]
  ['exact substring', 'Anti-cavitation trim required', true, 'exact'],
  ['exact with extra whitespace', '  Anti-cavitation   trim required  ', true, 'exact'],
  [
    'full sentence',
    'NACE MR0175 / ISO 15156 - sour service, H2S 14 ppm wet.',
    true,
    'exact',
  ],
  [
    'curly quotes vs straight (normalised match)',
    'NACE MR0175 / ISO 15156 — sour service', // em-dash instead of hyphen
    true,
    'normalised',
  ],
  [
    'fuzzy: rephrased close enough',
    'NACE MR0175 / ISO 15156 sour service H2S 14 ppm',
    true,
    'normalised',
  ],
  [
    'unverified: snippet not in source',
    'The valve shall be manufactured in stainless steel only',
    false,
    'none',
  ],
  ['empty snippet', '', false, 'none'],
  ['empty source', 'anything', false, 'none'],
];

let failures = 0;
for (const [label, snippet, expectedVerified, expectedMatchType] of cases) {
  const source = label === 'empty source' ? '' : HELIOS_PAGE;
  const r = validateSnippet(snippet, source);
  const pass = r.verified === expectedVerified && r.matchType === expectedMatchType;
  const sim = r.similarity.toFixed(2);
  console.log(
    `${pass ? '✓' : '✗'} ${label.padEnd(40)} verified=${r.verified} type=${r.matchType.padEnd(10)} sim=${sim}`,
  );
  if (!pass) {
    failures++;
    console.error(
      `   expected verified=${expectedVerified}, matchType=${expectedMatchType}`,
    );
  }
}

console.log(`\nthreshold: ${SIMILARITY_THRESHOLD}`);
if (failures > 0) {
  console.error(`\n❌ ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\n✅ PASS — ${cases.length} cases.`);
