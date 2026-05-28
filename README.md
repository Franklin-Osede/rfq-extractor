# Loonar RFQ Assistant — Technical Assessment

> Pre-fills the official Helios TCM (Technical Compliance Matrix) from a full RFQ document package, with evidence-cited compliance suggestions and cross-document review-risk detection.

A sales engineer drops the 13-document RFQ package. In ~60 seconds the app pre-fills Helios's official response template (`HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx`), suggests compliance per requirement with literal citations from the source documents, flags cross-document review risks, and exports the filled `.xlsx` plus a populated Deviation Register.

## Quickstart (under 5 minutes)

```bash
git clone <repo>
cd rfk-extractor
npm install
cp .env.example .env.local   # paste ANTHROPIC_API_KEY or OPENAI_API_KEY (either works)
npm run dev
```

Open <http://localhost:4711>, drop the Helios RFQ package files (the 13 PDFs/XLSX Loonar sent in the assessment email, plus the "noise" `Invoice 4.pdf` if you want to test classifier resilience) into the upload zone. The review experience opens automatically when processing completes. No API key is committed; bring your own.

> **Why the package isn't checked in:** the Helios files are confidential assessment materials sent privately by Loonar. They're deliberately not committed to this public repo — drop your own copy in the upload zone instead. `samples/rfq_helios/` is left as an empty directory marker for clarity.

> **Resume an existing job** — every job gets a stable URL: <http://localhost:4711/?job=&lt;jobId&gt;>. Useful if you reopen the browser mid-review or want to share a specific run.

> **Ports used:** Next.js dev runs on **4711**, Drizzle Studio on **4712** (run `npm run db:studio` to inspect the local SQLite). Picked to avoid the common dev range (3000/3030/4200/5000/5432/6379/7000). Override via `PORT` env var if needed.

## What this does

1. **Classifies** the 13 documents — TCM template, IDS, P&ID register, SIS/CRY/VAL/ACT/PNT/PKG general specs, master RFQ, Supplier Code, DEV Register template, Vendor Reference List template.
2. **Parses** the TCM (3 sheets: Cover & Instructions / Requirements Matrix / Tag-Level Confirmation) loading 108 requirements and 29 valve tags.
3. **Enriches** each requirement with a suggested compliance status (`C` / `D` / `N/A` / `Review`), a vendor comment, and one or more cited evidence snippets from the source documents.
4. **Validates** every citation deterministically — the snippet must literally (or with fuzzy ratio ≥ 0.9) appear in the cited page. Failed citations downgrade the suggestion to `Review`.
5. **Surfaces review risks** — cross-checks the 29 Tag-Level rows against the IDS, P&ID register, and SIS spec, severity-classified. Does not auto-resolve; surfaces for triage.
6. **Lets the user review** — approve / edit / reject / mark-as-deviation per row, with the source PDF page opened in a side panel.
7. **Exports** the filled `TCM.xlsx` (preserving original structure) plus a populated `DEV-Register.xlsx` containing rows marked as deviations.

## What I cut, and why

- **No bbox / pixel-perfect PDF highlighting** — page + verified text snippet satisfies the auditability promise. Fighting `react-pdf` overlay was 2-3 hours for marginal gain.
- **No RAG / vector DB** — the task is extraction with citations against a closed package, not semantic retrieval against a corpus. Embeddings would be overengineering.
- **No LLM critic on every field** — a deterministic validator (literal + fuzzy snippet match) catches the vast majority of grounding failures. LLM critic is reserved for low-confidence cases only.
- **No OCR of the scanned painting spec** (`HEL-GS-PNT-010 Rev 5`) — flagged as `degraded-quality`, surfaced for manual review. The seam where Azure Document Intelligence would plug in is documented.
- **No autofill of the Vendor Reference List** (`Attachment K`) — fields require vendor-specific data not present in the RFQ package; surfaced for manual completion.
- **No auth, multi-tenancy, deployment, exhaustive tests** — out of scope per the brief.
- **No past-proposal corpus reuse** — out of scope per the brief and not Loonar's current focus.

## Key design decisions

### 1. The TCM is the output, not a side artifact
Helios shipped the official response format. The MVP pre-fills that exact file and exports it back unchanged in structure. A sales engineer hands the file back to the buyer — no copy-paste between systems, no schema invented.

### 2. Citation enforcement is non-negotiable
Every suggested compliance status carries one or more `(doc, page, snippet)` citations. A deterministic validator checks that the snippet appears literally in the cited page before the suggestion is shown. The vendor sees `Review` status whenever the model could not produce a verifiable citation.

### 3. Risk panel surfaces what needs human triage — not opinions
The 29 Tag-Level rows are cross-referenced against three other binding documents (IDS Attachment A, P&ID Drawing Register, SIS allocation table). Where they disagree on service description, SIL classification, or rating, a severity-classified risk is generated with literal citations from each source. The tool surfaces; the engineer decides.

### 4. Per-customer taxonomy lives in YAML, not in prompts
The extraction schema (sections, fields, expected value types per manufacturer) is declarative in `schemas/helios_valves.yaml`. This is the seam where Loonar's 3-month personalization phase plugs in for a new customer. Not exercised end-to-end in MVP, but architected.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript |
| Styling | Tailwind 4 + shadcn/ui |
| Database | SQLite via better-sqlite3 + Drizzle ORM |
| Excel I/O | ExcelJS (read + write, preserves structure) |
| PDF text | unpdf + pdfjs-dist |
| PDF viewer | react-pdf |
| LLM | Provider-agnostic — Anthropic SDK (Claude Sonnet 4.6) **or** OpenAI SDK (gpt-4o-mini). Picks Anthropic if both keys are present. |
| Validation | zod (schemas) + string-similarity (fuzzy snippet match) |

Single Node runtime. Single repo. No Docker required for development.

> **DB choice:** SQLite is used so the README quickstart actually runs in under 5 minutes — no Docker, no external service, no port conflicts. A production deployment would use Postgres with per-tenant schemas; Drizzle keeps the schema portable, so the swap is ~30 lines. See [DECISIONS.md D-09](./DECISIONS.md) for the full rationale.

## Project structure

```
src/
  app/
    api/
      jobs/
        route.ts                       # POST: multipart upload + classify + parse + persist
        [id]/route.ts                  # GET: job snapshot (docs + reqs + tags + risks)
        [id]/enrich/route.ts           # POST: run LLM enrich over all 108 requirements
        [id]/risks/route.ts            # POST: run cross-doc tag risk analysis
        [id]/export/tcm/route.ts       # GET: filled TCM .xlsx (preserves structure)
        [id]/export/dev-register/route.ts  # GET: populated DEV Register .xlsx
      requirements/[id]/route.ts       # PATCH: vendor review decision per row
    page.tsx                           # full review UI (upload + table + risk panel + export bar)
    layout.tsx
  lib/
    types.ts          # domain types (Document, Requirement, TagRequirement, Citation, RiskSignal)
    classify.ts       # filename-based doc role detection
    tcm-parser.ts     # ExcelJS read of the 3 TCM sheets
    pdf-parser.ts     # unpdf text + page metadata
    retrieval.ts      # keyword-based snippet retrieval over the corpus
    llm.ts            # provider-agnostic structured-output LLM client
    enrich.ts         # compliance suggestion + citations + deterministic guard
    validate.ts       # snippet validator (literal / normalized / fuzzy ≥ 0.9)
    risks.ts          # cross-doc tag risk analysis (TCM vs IDS / P&ID / SIS)
    export.ts         # ExcelJS writers for TCM + DEV Register
    db.ts             # Drizzle + better-sqlite3 + auto-migrate on boot
    utils.ts
  components/ui/      # shadcn primitives
db/
  schema.ts           # Drizzle tables: jobs, documents, chunks, requirements, tag_requirements, risk_signals
  migrations/         # generated by drizzle-kit, applied on boot
samples/
  rfq_helios/         # the 13-doc Helios assessment package
scripts/
  dry-run.mjs         # end-to-end smoke test (upload → enrich → risks → export)
  verify-*.mjs        # standalone verifiers per pipeline stage
```

> The original plan reserved seams for a declarative `schemas/helios_valves.yaml` taxonomy and `prompts/*.md` files. Those directories exist but are empty — the per-customer taxonomy currently lives in `src/lib/types.ts` + the enrich prompt. They are the documented seam for Loonar's 3-month personalization phase. See [DECISIONS.md D-08](./DECISIONS.md).

## How I used AI

The brief asks how I *wielded* AI, not just whether I used it. Here's what was AI-driven, what was not, and where I drew the line.

### Inside the product

**One LLM call per requirement, plus a deterministic guard.** The product itself uses an LLM for exactly two jobs:

1. **`enrichRequirement`** — given one TCM requirement + a keyword-retrieved slice of the document corpus, produce `{ suggestedCompliance, suggestedComment, citations[] }` with structured tool-use output. One Sonnet/4o-mini call per row, ~108 calls per job, run with concurrency 4.
2. **`analyseOneTagRisk`** — given one valve tag + the matching slices from TCM Tag-Level / IDS Attachment A / P&ID register, produce `{ idsServiceDescription, hasMismatch, severity, reason }`. One call per tag, ~29 calls per job.

Every output passes through a **deterministic validator** before the user sees it: each citation's snippet must literally appear in the cited PDF page (or fuzzy-match at ratio ≥ 0.9 after whitespace normalization). Failed snippets force the suggestion to `Review`. **No second LLM call is used as a critic** — a string match is cheaper, faster, and unambiguous. This is the single most important architectural decision: the LLM cannot "convince" the system that an ungrounded citation is fine.

No embeddings. No RAG. No vector DB. The 13-doc package is closed — keyword retrieval over indexed PDF pages is sufficient and inspectable. See [DECISIONS.md D-03](./DECISIONS.md).

### Building the product

I drove the implementation with **Claude Code (Opus 4.7)** in an aggressive review-first loop:

- **Strategy first, code second.** Day 0 was a 90-minute hard-pushback round where Claude critiqued my own initial framing (`generic PDF extractor + side-by-side compare`) until I locked the right shape: *pre-fill Helios's official TCM template, with the risk panel as a secondary cross-document signal*. The 27 high-severity tag mismatches were verified by hand against the source docs before any code was written.
- **Iterative prompting on the enrich + risk prompts.** I treated the two LLM prompts as code: each version went through dry-runs against representative requirements (`SIL`, `material spec`, `Att. K reference`, `vendor data missing`) and the prompts were tightened until the validator's downgrade-to-Review rate stabilized at ~29% (the honest "no grounded evidence" rate, not a hallucination rate).
- **Verification gates.** Every pipeline stage has its own `scripts/verify-*.mjs` and the full `scripts/dry-run.mjs` runs 42 assertion gates end-to-end. The CI of this repo is "the dry-run must stay green."

### Where I did **not** use AI

- The `27 HIGH + 2 MEDIUM` tag-mismatch list was verified manually by reading the TCM Tag-Level sheet against IDS Attachment A. The demo never claims a count the model produced; it claims a count a human verified.
- The TCM column-mapping (which sheet, which column index, which rows are real vs example/instructions) was reverse-engineered by hand from the actual Helios `.xlsx`, not inferred by the model.
- The DEV Register slot-row reuse logic (DEV-001..DEV-NNN) was written by reading the template, not by trusting an LLM description of it.

### What I cut on AI-grounds

- **No LLM critic on top of the validator.** A second model call to "verify" the first would be a costly tautology. The deterministic snippet match is the source of truth.
- **No autonomous browse / no agent loop in production code.** The product is a single-shot enrich + a single-shot risk per tag. Agentic loops would shift latency from 80s to minutes for no defendable gain in this scope.
- **No OCR on the scanned painting spec.** Flagged as `degraded-quality`, surface the seam for Azure Document Intelligence. See [DECISIONS.md D-07](./DECISIONS.md).

## Smoke test

`scripts/dry-run.mjs` runs the full pipeline (upload → classify → enrich → risks → export → round-trip validate) against a folder containing the 14-file Helios package, asserting 42 gates:

```bash
npm run dev                                       # in one terminal
SOURCE_DIR=/path/to/helios/package \
  node scripts/dry-run.mjs                        # in another
```

Expected output ends in `✅ 42/42 gates green`. If any gate fails, the run aborts with a pointer to the failing stage. The script needs the actual Helios files (see "Quickstart" note above on why they aren't checked in).

## Status

- 📋 [BRIEF.md](./BRIEF.md) — the original Loonar assessment, pinned for reference.
- 🛠️ [PROGRESS.md](./PROGRESS.md) — live build log, Day 0 → Day 3.
- 🧭 [DECISIONS.md](./DECISIONS.md) — locked scope decisions with rationale.

---

Built for Loonar's technical assessment, May 2026.
