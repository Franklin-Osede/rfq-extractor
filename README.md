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
5. **Surfaces review risks** — cross-checks the 29 Tag-Level rows against two independent binding documents using two different strategies: an LLM-based service-description comparison against IDS Attachment A, and a deterministic SIL allocation comparison against the SIS spec (page 4 table, parsed verbatim, no LLM). Same tag can fire on both axes when the two binding docs disagree on what a valve is *and* what its safety classification is. P&ID drawings are out of scope for the MVP — see "What I cut" below.
6. **Lets the user review** — approve / edit / reject / mark-as-deviation per row, with the source PDF page opened in a side panel.
7. **Exports** the filled `TCM.xlsx` (preserving original structure) plus a populated `DEV-Register.xlsx` containing rows marked as deviations.

## Walkthrough — using the app + what every screen element means

End-to-end on a fresh clone, all of this happens in the browser at `localhost:4711`.

### Step 1. The idle landing

When you first hit the homepage you see three things:

- **Drop zone** (hero, centred) — multi-select file input. You can pick files across multiple clicks; the list accumulates and dedupes by name+size.
- **Pipeline card** (right side, below) — the 5 stages the package will go through: classify → parse → enrich → cross-check → export.
- **A typical run card** — concrete numbers from the dry-run against the 14-file Helios package: ~120s wall time, ~$0.08 cost per job, 108/108 reqs enriched, ~76% citation grounding, 22 HIGH risk signals.

If you've used the app before, the **Recent jobs** strip appears here too — clicking a card jumps you straight into that run via `/?job=<uuid>` deep-link (no re-upload).

### Step 2. Drop the package, click "Upload & process"

Select the 13 Helios documents plus the noise `Invoice 4.pdf` (the noise file is deliberate — it exercises the classifier's `unknown` role and the corpus filter). The button is disabled until at least one file is selected.

What happens behind the click:

1. `POST /api/jobs` accepts the multipart upload. Filenames are sanitised against path-traversal attacks (`../../tmp/foo.pdf` becomes `foo.pdf`); illegal entries are rejected with `400`.
2. Each file is classified by filename pattern + magic-byte sniffing.
3. If a TCM `.xlsx` is in the batch, it's parsed synchronously: 108 requirements (from the *Requirements Matrix* sheet) + 29 tag-level rows (from *Tag-Level Confirmation*).
4. All PDFs are text-indexed page-by-page into the `chunks` table.

The header **status bar** activates with an amber pulsing dot — `Uploading + parsing…`. Then it shifts to `Enriching N requirements…` while the LLM sweep runs.

### Step 3. Enrichment is the longest step

For each of the 108 requirements, the system runs **one LLM call** that:

1. Pulls 8 candidate evidence chunks via keyword retrieval (with tag-anchor boost and acronym whitelist for terms like SIL, ISO, API, ASME, NACE).
2. Asks the model for `{ suggestedCompliance, suggestedComment, citations[] }` using structured output.
3. Runs every returned citation through the **deterministic snippet validator** — the snippet must literally (or fuzzy ≥ 0.9) appear in the cited PDF page text.
4. If no citation survives validation, the suggestion is **forced to `Review`** regardless of what the model said. The model can never quietly claim compliance.

Concurrency is capped at 4 calls in flight; bumping it higher just walks into OpenAI's TPM ceiling. Total time: ~117 seconds on `gpt-4o-mini` tier 1.

### Step 4. The cross-document risk panel — the first thing you'll see when it's done

When the page reloads with results, **the risk panel renders at the very top** in a rose-bordered card. This is intentional: the most important thing a vendor needs to know is *where two of Helios's own binding documents disagree on the same valve*, before they start filling answers in.

| Element | What it means |
|---|---|
| **Header count** | `(N of M)` — shown when a filter is active; M is the total, N is the visible subset. |
| **Filter chips: severity** | HIGH (rose) / MEDIUM (amber) / LOW (zinc). Each chip shows its count. Default state is HIGH only — to avoid swamping the demo with 14 informational LOW signals. |
| **Filter chips: scope** | SIL (SIS-driven) vs SERVICE (IDS-driven). Toggle to see only one axis. |
| **Severity pill** (per row) | Same colour scheme as the filter. |
| **Scope chip** (per row) | `SIL` or `service` — tells you which evidence axis fired. A tag can appear twice if both fired. |
| **Tag number** | e.g. `SDV-1041A`. From the TCM Tag-Level Confirmation sheet. |
| **Reason** (one line) | Human-readable summary of the disagreement, with the specific values cited (e.g. "TCM states SIL 2, SIS allocates SIL 3"). |
| **Expand ▾** | Opens a 2-column side-by-side with the TCM citation on the left and the evidence source (IDS or SIS) on the right, including the page number on the source PDF. |

A common case: `SDV-1043` fires **both** a service-description mismatch (TCM says "Slug Catcher Outlet SDV", IDS says "BOG Compressor Suction ESD" — different valves) **and** a SIL mismatch (TCM says SIL 2, SIS table allocates SIL 3). Two independent evidence sources surfaced the same root issue from different angles.

### Step 5. The enrichment summary card

Below the risk panel sits a single zinc card with two rows:

**Top row** (compliance counts):

| Field | What it means |
|---|---|
| `Enriched: 108 / 108` | LLM successfully reached the row. If `failed > 0`, an amber `<PartialRiskWarning>` banner renders above. |
| `Citations verified: X / Y (Z%)` | Citations that passed `validateSnippet` over total emitted. Anything below 70% is a sign the LLM is generating snippets that don't exist verbatim. |
| `C: <n>` `D: <n>` `Review: <n>` `N/A: <n>` | Suggested-compliance breakdown. `Review` is the honest "no grounded evidence" bucket — `~25-30%` is the expected steady-state on the Helios package. |

**Bottom row** (LLM telemetry):

| Field | What it means |
|---|---|
| `LLM: openai · gpt-4o-mini` | Configured provider + model. Set via env var (`ANTHROPIC_API_KEY` takes priority over `OPENAI_API_KEY`). |
| `Calls: 137` | Total LLM calls across enrich (108) + risks (~29). |
| `Tokens: X in / Y out` | Real usage reported by the API, not estimated. |
| `Estimated cost: $0.08` | Per-1M-token pricing × usage. Updated when providers publish new tiers. |
| `Avg call: 700ms` | Mean per-call latency across both sweeps. |

### Step 6. Vendor deliverables (export bar)

| Button | When active | What you get |
|---|---|---|
| **filled TCM.xlsx** (green) | Always, once requirements are parsed | The original Helios TCM template, byte-for-byte identical in structure (sheets, headers, styling, instructions). Columns D (Compliance), E (Deviation Ref), F (Vendor Comment) on the *Requirements Matrix* sheet are populated. Rows flagged Review or Rejected get an explicit `[NEEDS VENDOR REVIEW…]` marker in F. **The sheet name, column order, and header rows are untouched** — Helios's RFQ §8.2 clause makes structure-preserving non-negotiable for technical conformance. |
| **DEV Register.xlsx** (yellow when armed, grey when disabled) | Only when at least one requirement is marked as `deviation` | The original Helios DEV Register template with the `DEV-EX-NNN` example rows cleared and each marked deviation written into a pre-numbered slot. Empty placeholder slots after the last filled entry are cleared too, so the submitted file has no visual noise. |

> **Why "DEV Register" is disabled on first load**: by design. The button is gated on `requirements.some(r => reviewStatus === 'deviation')`. Mark a row as deviation (see step 9) and it goes active.

### Step 7. Documents table

13 rows (or 14 if you included `Invoice 4.pdf`). Each row shows:

- **Filename** — verbatim from upload.
- **Role** — classifier output: `tcm_template`, `instrument_datasheets`, `sis_spec`, `general_valve_spec`, `master_rfq`, `actuator_spec`, `cryogenic_supplement`, `painting_spec`, `packing_spec`, `pid_drawing_register`, `supplier_code_of_conduct`, `dev_register_template`, `vendor_ref_list_template`, or `unknown`. Unknown-role docs are kept on disk for inventory but **excluded from the enrichment corpus** — this is a hard auditability boundary (otherwise an Invoice PDF could ground a compliance suggestion).
- **Type / Size / Pages** — basic metadata.
- **Scanned** — `⚠ yes` flags `HEL-GS-PNT-010_Rev5` (the painting spec is image-based; OCR is documented as a future seam, see DECISIONS.md D-07).
- **Lang** — `en+it` flags the cryogenic supplement which contains an Italian appendix.

### Step 8. Requirements table — the 108-row review workspace

Each row is one TCM requirement. The columns:

| Column | What it means |
|---|---|
| **status dot** | Tiny circle: grey (pending) / emerald (approved) / amber (edited) / zinc (rejected) / yellow (deviation). |
| **Req ID** | `R-001` through `R-108`, as printed in the TCM. |
| **Section** | `§3`, `§4`, etc. — the RFQ section this requirement comes from. |
| **Description** | The Helios-authored requirement text, verbatim from TCM column C. |
| **Suggested** | Compliance pill: `C` (green) / `D` (yellow) / `Review` (orange) / `N/A` (grey). Whatever the LLM proposed after validation. |
| **Citations** | `X/Y ▾` — verified over emitted. Click the row to expand. |

**Expand a row** to see:

- **Rationale** — the LLM's one-line explanation of why this compliance was chosen.
- **Evidence list** — each citation as `(docId, page, snippet)`. Verified citations show in zinc, failed ones in red. The page number is the source PDF page, not the chunk number.
- **Vendor decision form** — the workspace where you actually use the tool:
  - **Override compliance** dropdown — change C → D, etc. Setting it overrides the LLM suggestion in the final export.
  - **Vendor comment** textarea — pre-populated with the LLM's draft, edit freely.
  - **Deviation ref** input — if you fill this manually it's preserved verbatim. If you leave it blank and click *Mark deviation*, the server allocates the next free `DEV-NNN` for the job and writes it back.

### Step 9. Review actions

Four buttons at the bottom of the expanded form:

| Button | Effect on state | Effect on export |
|---|---|---|
| **Approve** | Sets `reviewStatus='approved'`, persists override + comment. | LLM suggestion (or your override) lands in TCM col D. Comment in col F. |
| **Mark deviation** | Sets `reviewStatus='deviation'`, `vendorCompliance='D'`. Auto-allocates `DEV-NNN` if not provided. | `D` in col D, `DEV-NNN` in col E, comment in col F. The DEV Register button activates. |
| **Reject** | Sets `reviewStatus='rejected'`, clears `vendorCompliance`. | Col D blank, col E blank, col F gets `[NEEDS VENDOR REVIEW — vendor rejected the AI suggestion]`. The LLM's suggestion **does not leak** into the export. |
| **Reset** | Clears all vendor fields, resets `reviewStatus='pending'`. | Row goes back to "LLM suggestion only" treatment. |

The state changes are persisted via `PATCH /api/requirements/[id]`. The table re-renders optimistically; no full page refetch.

### Step 10. Recent jobs (top of page, between upload and results)

Every successful upload and every deep-link load **upserts a localStorage entry** for the job. The strip shows up to 10, newest first, as a 1 / 2 / 3 column grid (responsive). Each card:

- **Label** — `Run · 5:23 PM · May 28` (derived from the savedAt timestamp; UUIDs are stored internally but never shown).
- **Counts** — `R: <reqs> T: <tags> Risks: <signals> ⚠ <failed>` (failed only shown if non-zero).
- **Actions** — `copy` puts `localhost:4711/?job=<uuid>` in your clipboard; `×` removes the entry (server-side job is untouched).
- The card for the currently-open job is highlighted **emerald** with an "open" badge so you always know where you are.

The list lives in localStorage only — clearing browser data wipes it; the server has no notion of "recent" jobs. This is pure UX layer.

### Step 11. Hard auditability rules — what the system will never do

These are constraints baked into the code. Each is observable from the source if you don't take my word for it.

1. **No ungrounded compliance**. If `validateSnippet` returns false for every citation in a requirement, the suggestion is overwritten to `Review` ([enrich.ts](src/lib/enrich.ts#L168)).
2. **No path traversal**. Uploaded filenames are `path.basename()`-sanitized and bound-checked against jobDir ([jobs route](src/app/api/jobs/route.ts#L88-L101)).
3. **No unknown-role evidence**. Docs classified as `unknown` (e.g. `Invoice 4.pdf`) are kept on disk but excluded from the enrichment corpus ([enrich route](src/app/api/jobs/[id]/enrich/route.ts#L70-L75)).
4. **No fallback to "first N chunks"** when retrieval finds zero keyword/tag matches. The system returns `[]` and the caller surfaces "tag not found" — never blindly hands the LLM irrelevant context ([retrieval.ts](src/lib/retrieval.ts)).
5. **No leakage from rejected rows**. `reviewStatus === 'rejected'` skips writing to cols D and E entirely; col F gets an explicit human-readable flag ([export.ts](src/lib/export.ts#L82-L107)).
6. **No SIS hallucination surface**. The SIL allocation cross-check is regex over `HEL-GS-SIS-007` page 4 — there is no LLM call to invent SIL values ([sis-parser.ts](src/lib/sis-parser.ts)).
7. **No silent partial failures**. Per-tag failures during /risks are persisted to `jobs.risk_run_summary`; the UI restores the amber `<PartialRiskWarning>` banner even after a page reload ([risks route](src/app/api/jobs/[id]/risks/route.ts)).

### What I'd evaluate first if I were reviewing this

1. **The risk panel content** — open any HIGH signal, expand, read the TCM citation vs the evidence citation side by side. Does the call match what the two docs actually say?
2. **Pick three Review rows** and inspect their citations. Are they verbatim from the cited page? If not, the validator is broken. If yes, the retrieval is doing its job.
3. **Mark one row as deviation, export both files**. Open them in Excel. Confirm the structure of the TCM is unchanged, col E has the `DEV-NNN`, and the DEV Register has exactly one populated row with no empty placeholders.
4. **Reject one row, export the TCM**. Confirm col D is blank and col F has the `[NEEDS VENDOR REVIEW — vendor rejected the AI suggestion]` marker.
5. **Reload the page**. The recent jobs panel should pick up where you left off; if /risks had any failures, the amber banner should reappear.

## What I cut, and why

- **No bbox / pixel-perfect PDF highlighting** — page + verified text snippet satisfies the auditability promise. Fighting `react-pdf` overlay was 2-3 hours for marginal gain.
- **No RAG / vector DB** — the task is extraction with citations against a closed package, not semantic retrieval against a corpus. Embeddings would be overengineering.
- **No LLM critic on every field** — a deterministic validator (literal + fuzzy snippet match) catches the vast majority of grounding failures. LLM critic is reserved for low-confidence cases only.
- **No P&ID drawing cross-check** in the risk panel. The P&ID Drawing Register is a text-light document (mostly drawing references); extracting tag-level service info from it needs a different strategy (drawing-aware OCR or vector parsing) than the text-grounded IDS/SIS approach. Used IDS + SIS in the MVP because they are text-grounded and auditably extractable within 72h; P&ID is documented as a future evidence source.
- **No OCR of the scanned painting spec** (`HEL-GS-PNT-010 Rev 5`) — flagged as `degraded-quality`, surfaced for manual review. The seam where Azure Document Intelligence would plug in is documented.
- **No autofill of the Vendor Reference List** (`Attachment K`) — fields require vendor-specific data not present in the RFQ package; surfaced for manual completion.
- **No auth, multi-tenancy, deployment, exhaustive tests** — out of scope per the brief.
- **No past-proposal corpus reuse** — out of scope per the brief and not Loonar's current focus.

## Key design decisions

### 1. The TCM is the output, not a side artifact
Helios shipped the official response format. The MVP pre-fills that exact file and exports it back unchanged in structure. A sales engineer hands the file back to the buyer — no copy-paste between systems, no schema invented.

### 2. Citation enforcement is non-negotiable
Every suggested compliance status carries one or more `(doc, page, snippet)` citations. A deterministic validator checks that the snippet appears literally in the cited page before the suggestion is shown. The vendor sees `Review` status whenever the model could not produce a verifiable citation.

### 3. Risk panel uses two independent evidence sources with different strategies
The 29 Tag-Level rows are cross-referenced against two binding documents with intentionally different methods:
- **IDS Attachment A (LLM-based)** — service descriptions are free-text; an LLM extracts the IDS description for each tag and a deterministic snippet validator (literal / normalized / fuzzy ≥ 0.9) confirms the extraction appears in the cited page. Failed validations drop the signal entirely.
- **SIS allocation table (deterministic)** — page 4 of `HEL-GS-SIS-007` is a structured table mapping tags to SIL 1/2/3. A regex-based parser handles Helios's paired (`SDV-1041A/B`), triple (`FV-2021A/B/C`) and range (`SDV-7001 to 7006`) notations, then integer-compares against the SIL stated in the TCM service description. No LLM, no hallucination surface.

Where the two sources disagree with the TCM (on service description or SIL allocation), a severity-classified risk is surfaced with literal citations from each side. The tool surfaces; the engineer decides.

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
    risks.ts          # LLM-driven tag service-description cross-check (TCM vs IDS)
    sis-parser.ts     # deterministic parser for the SIS SIL allocation table
    sis-risks.ts      # SIS SIL cross-check + signal builder
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
  dry-run.mjs           # end-to-end smoke test (upload → enrich → risks → export)
  check-sis-coverage.mjs  # feasibility check: does the SIS PDF carry enough signal?
  test-sis-parser.mjs   # standalone verifier for the SIS allocation parser
  verify-*.mjs          # standalone verifiers per pipeline stage
```

> The original plan reserved seams for a declarative `schemas/helios_valves.yaml` taxonomy and `prompts/*.md` files. Those directories exist but are empty — the per-customer taxonomy currently lives in `src/lib/types.ts` + the enrich prompt. They are the documented seam for Loonar's 3-month personalization phase. See [DECISIONS.md D-08](./DECISIONS.md).

## How I used AI

The brief asks how I *wielded* AI, not just whether I used it. Here's what was AI-driven, what was not, and where I drew the line.

### Inside the product

The product uses an LLM for exactly **two** call sites, and a deterministic parser for a **third** signal source that didn't need one:

1. **`enrichRequirement`** (LLM) — given one TCM requirement + a keyword-retrieved slice of the document corpus, produce `{ suggestedCompliance, suggestedComment, citations[] }` with structured tool-use output. One Sonnet/4o-mini call per row, ~108 calls per job, run with concurrency 4.
2. **`analyseOneTagRisk`** (LLM) — given one valve tag + retrieved IDS chunks, produce `{ idsServiceDescription, hasMismatch, severity, reason }` for the service-description axis. One call per tag, ~29 calls per job.
3. **`analyseTagSilAllocations`** (deterministic) — parses the structured SIL allocation table on page 4 of `HEL-GS-SIS-007`, expands Helios's paired and range notations (`SDV-1041A/B`, `SDV-7001 to 7006`), and integer-compares against the SIL stated in the TCM service description. **Zero LLM calls.** Adding one would only introduce hallucination risk on data that's already structured. The decision to skip the LLM here was driven by a coverage feasibility check (`scripts/check-sis-coverage.mjs`) that confirmed 28/29 tags are unambiguously allocated in the table.

Every LLM output passes through a **deterministic validator** before the user sees it: each citation's snippet must literally appear in the cited PDF page (or fuzzy-match at ratio ≥ 0.9 after whitespace normalization). Failed snippets force the suggestion to `Review`. **No second LLM call is used as a critic** — a string match is cheaper, faster, and unambiguous. This is the single most important architectural decision: the LLM cannot "convince" the system that an ungrounded citation is fine.

No embeddings. No RAG. No vector DB. The 13-doc package is closed — keyword retrieval over indexed PDF pages is sufficient and inspectable. See [DECISIONS.md D-03](./DECISIONS.md).

### Building the product

I drove the implementation with **Claude Code (Opus 4.7)** in an aggressive review-first loop:

- **Strategy first, code second.** Day 0 was a 90-minute hard-pushback round where Claude critiqued my own initial framing (`generic PDF extractor + side-by-side compare`) until I locked the right shape: *pre-fill Helios's official TCM template, with the risk panel as a secondary cross-document signal*. The 27 high-severity tag mismatches were verified by hand against the source docs before any code was written.
- **Iterative prompting on the enrich + risk prompts.** I treated the two LLM prompts as code: each version went through dry-runs against representative requirements (`SIL`, `material spec`, `Att. K reference`, `vendor data missing`) and the prompts were tightened until the validator's downgrade-to-Review rate stabilized in the high 20s % (the honest "no grounded evidence" rate, not a hallucination rate).
- **Independent AI review pass.** Mid-build I ran a separate AI review against the working branch. It surfaced five real correctness bugs (rejected rows leaked LLM suggestions to the TCM export; TCM↔DEV deviation refs could disagree; risk citations claimed "verified" without ever calling the validator; the noise `Invoice 4.pdf` was eligible as evidence; one lint error). I reproduced each finding against the running code before fixing, and treated one finding (build red on Google fonts) as **not reproduced** — `npx next build` passed cleanly. Useful calibration: the reviewer is valuable but not infallible.
- **Verification gates.** Every pipeline stage has its own `scripts/verify-*.mjs` and the full `scripts/dry-run.mjs` runs 46 assertion gates end-to-end. The CI of this repo is "the dry-run must stay green."

### Where I did **not** use AI

- The SIS SIL allocation table was parsed with a hand-written regex, not an LLM. Feasibility was verified up-front (`scripts/check-sis-coverage.mjs`): 28/29 tags are present, the table is text-extractable, the tag-notation conventions (`A/B`, `A/B/C`, `X to Y`) are deterministic. Adding an LLM here would only add hallucination risk on data that's already structured.
- The TCM column-mapping (which sheet, which column index, which rows are real vs example/instructions) was reverse-engineered by hand from the actual Helios `.xlsx`, not inferred by the model.
- The DEV Register slot-row reuse logic (DEV-001..DEV-NNN) was written by reading the template, not by trusting an LLM description of it.
- The risk-panel headline counts in the demo are claims the dry-run gates assert, not numbers the model emitted. If `npm run dev` + `node scripts/dry-run.mjs` doesn't pass the gates, the demo doesn't get told.

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

- 🛠️ [PROGRESS.md](./PROGRESS.md) — live build log, Day 0 → Day 3.
- 🧭 [DECISIONS.md](./DECISIONS.md) — 12 locked scope decisions with rationale.

---

Built for Loonar's technical assessment, May 2026.
