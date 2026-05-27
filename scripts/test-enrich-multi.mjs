// Diversity test for enrichRequirement: 5 real TCM rows spanning very
// different RFQ sections, against a single shared corpus that mirrors what
// the indexed PDF chunks would look like.
//
// Goal: confirm the prompt + retrieval + validator hold up on something
// other than the textbook Charpy case. Specifically:
//   - R-001 commercial scope (§3)
//   - R-068 pricing terms (§7.1) — vendor-decided, evidence is procedural
//   - R-082 ATEX certification (§8.1) — standard for the market
//   - R-093 meta-requirement (return DEV Register, §8.2)
//   - R-104 REACH compliance (§10) — legal
//
// Run with:  npx tsx scripts/test-enrich-multi.mjs

import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

const { enrichRequirement } = await import('../src/lib/enrich.ts');

// ─── Corpus: 12 realistic chunks from across the package ─────────────────────

const corpus = [
  // RFQ §3 — Scope of supply
  {
    chunkId: 'rfq:p2',
    docId: 'doc-rfq',
    docRole: 'master_rfq',
    page: 2,
    text: `3. SCOPE OF SUPPLY. The scope of supply encompasses the complete engineering, manufacture, testing, inspection, painting, preservation, packing and delivery (DAP Porto Austral, East Africa, Incoterms 2020) of the valve packages described below. All items shall be furnished as complete, ready-to-install assemblies including actuators, positioners, limit switches, solenoid valves, handwheels, instrument air supply sets, junction boxes, and all ancillary hardware.`,
  },
  // RFQ §5.3 — actuator/positioner/solenoid requirements (ATEX mentioned)
  {
    chunkId: 'rfq:p5',
    docId: 'doc-rfq',
    docRole: 'master_rfq',
    page: 5,
    text: `Positioner: Smart digital positioner with HART 7.x communication, 4-20 mA input signal, 0.5% linearity, diagnostic capability. Solenoid valves: Dual redundant 3/2 solenoids on all SIL 2 and SIL 3 items. Limit switches: Namur-type inductive proximity switches, ATEX-certified.`,
  },
  // RFQ §7.1 — pricing instructions
  {
    chunkId: 'rfq:p9',
    docId: 'doc-rfq',
    docRole: 'master_rfq',
    page: 9,
    text: `7.1 Pricing Instructions. VENDOR shall submit pricing in EUR or USD; state currency clearly on all price schedules. Unit prices shall be provided for each tag number individually. Prices shall remain firm and not subject to escalation for a minimum of 90 calendar days from the date of quotation submission.`,
  },
  // RFQ §8.2 — TCM and DEV Register submission obligation
  {
    chunkId: 'rfq:p12',
    docId: 'doc-rfq',
    docRole: 'master_rfq',
    page: 12,
    text: `8.2 Technical Proposal Requirements. Completed and signed Technical Compliance Matrix (this workbook) returned in native .xlsx and signed PDF. Completed Deviation/Exception Register (Attachment J) - even if 'No deviations' shall be explicitly stated.`,
  },
  // RFQ §10 — Legal / General Conditions (REACH)
  {
    chunkId: 'rfq:p13',
    docId: 'doc-rfq',
    docRole: 'master_rfq',
    page: 13,
    text: `REACH / RoHS Compliance: VENDOR shall confirm REACH compliance for all materials supplied and shall provide Safety Data Sheets (SDS) for all hazardous substances contained in the equipment. RoHS compliance declaration required for all electronic and electrical components.`,
  },
  // Supplier Code of Conduct — REACH mentioned
  {
    chunkId: 'scc:p4',
    docId: 'doc-scc',
    docRole: 'supplier_code_of_conduct',
    page: 4,
    text: `Suppliers shall comply with all applicable laws, regulations, and binding international standards in force in the countries in which they operate or in which the goods or services are delivered. This includes, without limitation, data protection (GDPR), trade and customs regulations, and chemical safety regulations such as REACH (EC 1907/2006).`,
  },
  // ACT spec — hazardous area + ATEX
  {
    chunkId: 'act:p4',
    docId: 'doc-act',
    docRole: 'actuator_spec',
    page: 4,
    text: `Reference IEC 60079 series Explosive atmospheres - equipment construction (Ex d, Ex e, Ex i, Ex n). Reference ATEX 2014/34/EU Equipment and protective systems intended for use in potentially explosive atmospheres. Reference IECEx Scheme International certification scheme for explosive atmospheres equipment.`,
  },
  // ACT spec — solenoid hazardous-area certification
  {
    chunkId: 'act:p6',
    docId: 'doc-act',
    docRole: 'actuator_spec',
    page: 6,
    text: `5.4 Hazardous-area certification shall be either Ex d (flameproof) or Ex ia (intrinsically safe). The selection shall match the loop philosophy of the safety logic solver. ATEX and IECEx certificates shall be supplied.`,
  },
  // IDS Annex 2.2 — Hazardous Area Classification
  {
    chunkId: 'ids:p23',
    docId: 'doc-ids',
    docRole: 'instrument_datasheets',
    page: 23,
    text: `A2.2 Hazardous Area Classification. All electrical equipment shall be certified for the Hazardous Area in which it is installed. Default zone for topside is Zone 1, Gas Group IIA / IIB+H2, Temperature Class T3. ATEX (2014/34/EU) and IECEx certification mandatory; UKEX accepted as equivalent.`,
  },
  // IDS Annex 2.10 — Deviations and Clarifications
  {
    chunkId: 'ids:p23b',
    docId: 'doc-ids',
    docRole: 'instrument_datasheets',
    page: 23,
    text: `A2.10 Deviations and Clarifications. Bidders are required to submit a Technical Deviation List (TDL) and a Clarification Request List (CRL) as separate documents in the tender response. The TDL shall list each deviation from this Attachment A or the master RFQ.`,
  },
  // Distractor: cryogenic-specific (irrelevant for these 5 reqs)
  {
    chunkId: 'cry:p4',
    docId: 'doc-cry',
    docRole: 'cryogenic_supplement',
    page: 4,
    text: `All cryogenic valves shall be supplied with an extended bonnet. The minimum stem extension length shall be calculated by the Vendor by analytical conduction-convection model such that the temperature at the packing gland remains >= +10 °C under worst-case cryogenic soak.`,
  },
  // Distractor: SIS-specific
  {
    chunkId: 'sis:p5',
    docId: 'doc-sis',
    docRole: 'sis_spec',
    page: 5,
    text: `4.1 Mandatory Vendor Submittals. Product SIL certificate - issued by an accepted body, valid (not expired) at the proposal due date. PFDavg calculation prepared for Proof Test Intervals of 1 year and 5 years. FMEDA report signed by the certifying body.`,
  },
];

// ─── 5 representative requirements ───────────────────────────────────────────

const requirements = [
  {
    reqId: 'R-001',
    rfqSectionRef: '§3',
    description:
      'Scope of supply: complete engineering, manufacture, testing, inspection, painting, preservation, packing, marking and delivery DAP Porto Austral terminal per Incoterms 2020.',
  },
  {
    reqId: 'R-068',
    rfqSectionRef: '§7.1',
    description:
      'Pricing in EUR or USD; firm and fixed prices for a minimum validity of 90 calendar days from quotation date.',
  },
  {
    reqId: 'R-082',
    rfqSectionRef: '§8.1',
    description:
      'ATEX (2014/34/EU) and/or IECEx certification for positioners, solenoid valves, limit switches and any other electrical components in hazardous areas.',
  },
  {
    reqId: 'R-093',
    rfqSectionRef: '§8.2',
    description:
      "Completed Deviation/Exception Register (Attachment J) - even if 'No deviations' shall be explicitly stated.",
  },
  {
    reqId: 'R-104',
    rfqSectionRef: '§10',
    description:
      'REACH (EC 1907/2006) compliance and SDS (Safety Data Sheets) provided for all hazardous substances supplied.',
  },
];

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log(`Provider: ${process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'NONE'}`);
console.log(`Corpus: ${corpus.length} chunks across ${new Set(corpus.map((c) => c.docRole)).size} doc roles`);
console.log(`Running enrich for ${requirements.length} requirements (concurrency 4)…\n`);

const t0 = Date.now();

// Bounded-concurrency similar to the production endpoint.
const MAX = 4;
const results = [];
let cursor = 0;

async function worker() {
  while (cursor < requirements.length) {
    const idx = cursor++;
    const req = requirements[idx];
    try {
      const out = await enrichRequirement(req, corpus);
      results.push({ req, out });
    } catch (e) {
      results.push({ req, err: e.message });
    }
  }
}

await Promise.all(Array.from({ length: MAX }, worker));
const elapsed = Date.now() - t0;

// Order by reqId for deterministic display.
results.sort((a, b) => a.req.reqId.localeCompare(b.req.reqId));

console.log(`\n${'═'.repeat(100)}`);
console.log(`Completed ${results.length} in ${elapsed}ms (${(elapsed / results.length / 1000).toFixed(1)}s avg)\n`);

for (const { req, out, err } of results) {
  console.log(`\n── ${req.reqId} (${req.rfqSectionRef}) ─────`);
  console.log(`   ${req.description.slice(0, 120)}…`);
  if (err) {
    console.log(`   ❌ ${err}`);
    continue;
  }
  const verified = out.evidence.filter((e) => e.verified).length;
  const total = out.evidence.length;
  console.log(`   compliance: ${out.suggestedCompliance.padEnd(7)} difficulty: ${out.difficulty.padEnd(20)} citations: ${verified}/${total} verified`);
  console.log(`   rationale: ${out.rationale}`);
  console.log(`   vendor comment: ${out.suggestedComment.slice(0, 110)}…`);
  if (total > 0) {
    for (const c of out.evidence) {
      const flag = c.verified ? '✓' : '✗';
      console.log(`   ${flag} ${c.docId} p.${c.page} — "${c.snippet.slice(0, 80)}…"`);
    }
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const byCompliance = {};
let totalVerified = 0;
let totalCitations = 0;
for (const { out } of results) {
  if (!out) continue;
  byCompliance[out.suggestedCompliance] = (byCompliance[out.suggestedCompliance] ?? 0) + 1;
  totalVerified += out.evidence.filter((e) => e.verified).length;
  totalCitations += out.evidence.length;
}

console.log(`\n${'═'.repeat(100)}`);
console.log('Summary:');
console.log(`  compliance distribution: ${JSON.stringify(byCompliance)}`);
console.log(`  citation grounding rate: ${totalVerified}/${totalCitations} (${totalCitations ? Math.round((100 * totalVerified) / totalCitations) : 0}%)`);
console.log(`  avg latency per req: ${(elapsed / results.length / 1000).toFixed(1)}s`);

// PASS criteria: every result either has at least 1 verified citation, OR
// is explicitly marked "Review" with rationale.
const failures = results.filter(({ out, err }) => {
  if (err) return true;
  if (!out) return true;
  const hasVerifiedCitation = out.evidence.some((e) => e.verified);
  return !hasVerifiedCitation && out.suggestedCompliance !== 'Review';
});

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} requirement(s) returned a confident suggestion with no verified citation:`);
  for (const f of failures) console.error(`  - ${f.req.reqId}: ${f.err ?? `${f.out.suggestedCompliance} with 0 verified`}`);
  process.exit(1);
}
console.log('\n✅ PASS — every suggestion is either grounded or honestly downgraded to Review.');
