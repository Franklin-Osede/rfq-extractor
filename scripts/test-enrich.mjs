// End-to-end test of the enrich pipeline (no DB, no HTTP).
// Hard-codes a requirement + a few realistic chunks from the Helios IDS,
// runs enrichRequirement against the live LLM, validates citations.
//
// Run with:  npx tsx scripts/test-enrich.mjs

import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

const { enrichRequirement } = await import('../src/lib/enrich.ts');

// ─── Fixture: a real TCM requirement + chunks from the IDS Annex 1 ───────────

const requirement = {
  reqId: 'R-049',
  rfqSectionRef: '§5.4',
  description:
    'Charpy V-notch impact testing at -196 °C: 27 J average / 20 J minimum per specimen, three specimens per heat.',
};

const corpus = [
  {
    chunkId: 'doc-ids:p22',
    docId: 'doc-ids',
    docRole: 'instrument_datasheets',
    page: 22,
    text: `Note A1.2 - All carbon steel and low-alloy steel materials in service below -29 degC shall undergo Charpy V-notch impact testing per ASME B31.3 Table A-1, with minimum acceptance criteria of 27 J average / 20 J single-specimen at the minimum design metal temperature. Three test specimens per heat per heat-treat lot.`,
  },
  {
    chunkId: 'doc-ids:p5',
    docId: 'doc-ids',
    docRole: 'instrument_datasheets',
    page: 5,
    text: `NACE MR0175 / ISO 15156 - sour service, H2S 14 ppm wet. Fire-safe per API 607 7th Ed. All wetted parts to be PMI verified. Anti-cavitation trim required; vendor to confirm sigma at min flow.`,
  },
  {
    chunkId: 'doc-val:p13',
    docId: 'doc-val',
    docRole: 'general_valve_spec',
    page: 13,
    text: `8.3 Charpy V-Notch Impact Testing. Charpy V-notch impact testing shall be performed on each heat of body, bonnet and bolting material per ASME BPVC Sec. VIII Div. 1 UG-84. Test temperature shall be the minimum design temperature or -196 degC, whichever is colder. Acceptance criteria for austenitic materials at -196 degC shall be: average of three specimens 27 J minimum; lowest single value 20 J minimum.`,
  },
  {
    chunkId: 'doc-rfq:p6',
    docId: 'doc-rfq',
    docRole: 'master_rfq',
    page: 6,
    text: `5.4 Cryogenic Service Special Requirements. Tags ZV-8011A/B and SDV-2055A/B are classified as cryogenic service (design temperature -196 degC). All body and bonnet materials certified and impact-tested at -196 degC per ASME BPVC Section VIII Div. 1 UG-84; Charpy V-notch minimum 27 J average, 20 J minimum individual.`,
  },
];

console.log(`Provider: ${process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'NONE'}`);
console.log(`\nEnriching ${requirement.reqId} with ${corpus.length} candidate chunks…\n`);

const t0 = Date.now();
const result = await enrichRequirement(requirement, corpus);
const elapsed = Date.now() - t0;

console.log(`(${elapsed}ms)\n`);
console.log(JSON.stringify(result, null, 2));

const verified = result.evidence.filter((e) => e.verified).length;
console.log(`\nCitations: ${verified}/${result.evidence.length} verified`);
console.log(`Compliance: ${result.suggestedCompliance}`);

if (result.suggestedCompliance === 'Review' && verified === 0 && result.evidence.length === 0) {
  console.error('\n⚠️  LLM returned no citations — check the prompt or chunk relevance.');
  process.exit(1);
}
console.log('\n✅ PASS — enrich pipeline returned a structured response with citations.');
