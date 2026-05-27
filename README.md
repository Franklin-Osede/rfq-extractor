# Loonar RFQ Assistant — Technical Assessment

> Pre-fills the official Helios TCM (Technical Compliance Matrix) from a full RFQ document package, with evidence-cited compliance suggestions and cross-document review-risk detection.

A sales engineer drops the 13-document RFQ package. In ~60 seconds the app pre-fills Helios's official response template (`HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx`), suggests compliance per requirement with literal citations from the source documents, flags cross-document review risks, and exports the filled `.xlsx` plus a populated Deviation Register.

## Quickstart (under 5 minutes)

```bash
git clone <repo>
cd rfk-extractor
npm install
cp .env.example .env.local   # paste your ANTHROPIC_API_KEY
npm run dev
```

Open <http://localhost:4711>, drop the 13 files from `samples/rfq_helios/` into the upload zone, and the review experience opens automatically. Sample API key is **not** committed; bring your own.

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
| LLM | Anthropic SDK + Claude Sonnet 4.6 |
| Validation | zod (schemas) + string-similarity (fuzzy snippet match) |

Single Node runtime. Single repo. No Docker required for development.

> **DB choice:** SQLite is used so the README quickstart actually runs in under 5 minutes — no Docker, no external service, no port conflicts. A production deployment would use Postgres with per-tenant schemas; Drizzle keeps the schema portable, so the swap is ~30 lines. See [DECISIONS.md D-09](./DECISIONS.md) for the full rationale.

## Project structure

```
src/
  app/
    api/
      jobs/          # POST: upload + process
      requirements/  # GET/PATCH: review actions
      export/        # GET: filled TCM / DEV Register
    page.tsx         # main review UI
  lib/
    types.ts         # domain types (Document, Requirement, TagRequirement, Citation, Conflict)
    classify.ts      # filename-based doc role detection
    tcm-parser.ts    # ExcelJS read of the TCM
    pdf-parser.ts    # unpdf text + page metadata
    enrich.ts        # Claude: compliance suggestion + citations
    validate.ts      # deterministic snippet validator
    risks.ts         # cross-doc tag comparison
    export.ts        # ExcelJS write
    db.ts            # Drizzle setup
  components/
    UploadZone.tsx
    RequirementsTable.tsx
    EvidencePanel.tsx
    RiskPanel.tsx
    SourceViewer.tsx
db/
  schema.ts          # Drizzle table definitions
samples/
  rfq_helios/        # 13-doc test package
schemas/
  helios_valves.yaml # extraction schema (per manufacturer)
prompts/
  enrich-requirement.md
```

## How I used AI

Filled at end of Day 3 with the actual orchestration log. See [PROGRESS.md](./PROGRESS.md) for the running journal.

## Status

- 📋 [BRIEF.md](./BRIEF.md) — the original Loonar assessment, pinned for reference.
- 🛠️ [PROGRESS.md](./PROGRESS.md) — live build log, Day 0 → Day 3.
- 🧭 [DECISIONS.md](./DECISIONS.md) — locked scope decisions with rationale.

---

Built for Loonar's technical assessment, May 2026.
