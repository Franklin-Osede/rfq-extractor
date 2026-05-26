# Design decisions — Loonar take-home

Every meaningful scope and architecture decision, with the rationale and the alternative considered. Read in the order they were made.

---

## D-01 — The TCM is the output, not a side artifact

**Decision:** The MVP pre-fills `HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx` and exports the same file with structure preserved.

**Alternative:** Generic CSV/JSON output with the extracted requirements.

**Rationale:** Helios shipped the official response format with 108 pre-populated requirements and 29 tag-level rows. The sales engineer's actual job is to return this file to the buyer. Inventing a different output schema would have meant the user copy-pastes from our tool into Helios's template — exactly the friction the brief asks us to eliminate. CSV/JSON are kept as a secondary debug output, not the headline.

---

## D-02 — Citation enforcement before LLM judgment

**Decision:** Every LLM-suggested compliance status carries `(docId, page, snippet)` citations. A deterministic validator (literal substring + fuzzy ratio ≥ 0.9) checks each snippet against the cited page. Failed citations downgrade the suggestion to `Review`.

**Alternative:** Trust the LLM's self-reported confidence score; show suggestions without verification.

**Rationale:** The founder interview transcript: *"these traditional industries don't trust AI… we need to be really good at creating a UX that allows them to double check everything that we extract into the actual document where it was extracted."* Without a grounding check, the headline promise of the product is theater. The validator is also deterministic (no second LLM call for the common case), so it's cheap.

---

## D-03 — No RAG, no vector DB

**Decision:** The retrieval layer is keyword-based search within the parsed page chunks of the uploaded package. No embeddings, no Chroma/pgvector/etc.

**Alternative:** Standard RAG stack (embeddings + vector DB + retrieval).

**Rationale:** The problem is structured extraction with citation enforcement against a closed document set of 13 files. It is not semantic retrieval against an open corpus. Embeddings would add infrastructure complexity, latency, and an entire failure mode (semantic drift) with no win for this specific task. If the project ever grows into Loonar's "Budgetary Proposals" module (search across past proposals), embeddings would enter then — not here.

---

## D-04 — No LLM critic on every field

**Decision:** A second LLM call ("critic") is invoked only when the deterministic validator flags low confidence (`evidence.verified === false`) or when no citation could be produced. The default path is single-LLM-call extraction → deterministic validation.

**Alternative:** Run a critic agent on every field as a quality gate.

**Rationale:** The founder transcript explicitly endorses the "agents working together in a cycle" pattern, but a critic on all 108 requirements × 1-3 citations each would 3-4x the latency and API cost for marginal gain — the deterministic validator catches the same failures more cheaply. The critic is reserved for hard cases where literal matching fails (e.g. when the LLM paraphrased the source rather than quoting it).

---

## D-05 — Risk panel surfaces, never resolves

**Decision:** Where the TCM, IDS, P&ID Drawing Register, and SIS spec disagree on a tag-level field (service description, SIL classification, rating, body material), the tool surfaces a severity-classified risk with literal citations from each source. It does not auto-resolve and does not declare a "winner".

**Alternative:** Apply a precedence rule (TCM > IDS > PID, or stringency-based) and present a single answer.

**Rationale:** Two binding documents contain conflicting precedence clauses themselves: TCM Cover Instructions §10 says *"entries of this TCM shall prevail"*; IDS pg. 3 says *"the more stringent requirement shall govern"*. A correct precedence rule cannot be derived mechanically; it requires proposal-engineer judgment in context. Auto-resolving would produce confidently wrong outputs. Surfacing keeps the human in the loop where they belong.

---

## D-06 — No bbox / no pixel-perfect highlighting

**Decision:** The source viewer opens the PDF at the cited page; the snippet appears in the side panel as text. No overlay highlighting.

**Alternative:** Use `react-pdf` overlay APIs to draw a bounding box over the exact snippet.

**Rationale:** Page + verified text snippet already satisfies the auditability promise — the user can visually confirm the text on the page. Bbox highlighting is 2-3 hours of fighting `react-pdf` worker setup + coordinate transformation in App Router + Tailwind 4, for a marginal UX gain. Cut consciously, not by accident.

---

## D-07 — No OCR of the scanned painting spec

**Decision:** `HEL-GS-PNT-010 Rev 5` (the scanned document) is detected by signal (no embedded text layer) and flagged as `degraded-quality`. Requirements referencing it (e.g. R-065 painting spec compliance) get `Review` status with an "OCR required for verification" note.

**Alternative:** Run `pytesseract` or call Azure Document Intelligence for OCR.

**Rationale:** Local OCR with tesseract on a scanned PDF with tables is hit-or-miss; cleaning up output for the painting/coating tables would be a 4-6h sink. Azure DI is reliable but requires cloud credentials and contradicts Loonar's stated "EU storage / data minimisation" architecture. The seam where DI would plug in is documented; the take-home demo doesn't need it.

---

## D-08 — Per-customer taxonomy as declarative YAML

**Decision:** The extraction schema (which fields exist per IDS section, what value types are expected, which fields participate in cross-doc reconciliation) lives in `schemas/helios_valves.yaml`. The same schema would be a separate YAML file for a pump manufacturer.

**Alternative:** Hardcode the schema into the extractor prompts.

**Rationale:** The founder said in the interview: *"We have six companies in production, six different products, six different taxonomies of product catalog… we are a bit struggling with that."* A declarative YAML per customer is the architectural seam where Loonar's 3-month personalization phase plugs in. Not exercised end-to-end in this MVP (only one customer = Helios), but the design lives in the type system and the schema file.

---

## D-09 — Stack: Next.js + TypeScript, single runtime

**Decision:** Next.js 16 App Router + TypeScript + Tailwind 4 + shadcn/ui for the entire app. SQLite via better-sqlite3 + Drizzle for state. ExcelJS for Excel I/O. unpdf + pdfjs-dist for PDFs. Anthropic SDK + Claude Sonnet 4.6 for LLM.

**Alternative:** Python/FastAPI backend + React frontend (two runtimes).

**Rationale:** Single repo, single language, single dev experience. The Python ecosystem's advantage in PDF parsing (pdfplumber, tabula) is real but evaporates once we cut bbox highlighting and table extraction — `unpdf` is sufficient for text + page metadata. Avoiding the Python ↔ Node boundary saves at least a day across the 72h.

**Production note — SQLite vs Postgres:** SQLite was chosen for the take-home because the brief mandates *"a README that gets us running in under 5 minutes"*. SQLite is a single file with zero external dependencies; Postgres requires Docker or a local install + port availability + migrations, each of which can break the 5-minute promise on the founder's machine. A real Loonar deployment would use Postgres with per-tenant schemas for tenant isolation and concurrent access. Drizzle keeps the schema portable: the swap is ~30 lines of column type changes (`integer` timestamps → `timestamp with time zone`, JSON columns to JSONB, etc.) plus replacing the `better-sqlite3` driver with `postgres-js`. The application code calling Drizzle does not change.

---

## D-10 — npm over pnpm

**Decision:** Project initialized and locked with npm. README quickstart is `npm install && npm run dev`.

**Alternative:** pnpm (already used during initial scaffold).

**Rationale:** The brief: *"a README that gets us running in under 5 minutes."* npm is guaranteed on any machine with Node; pnpm is not. The cost to the maintainer is a few seconds of slower install; the cost of the founders hitting a "command not found" error is the whole demo. Universal default wins.

---

## D-11 — VendorRefList: detect but do not autofill

**Decision:** `HEL-AZ2-VendorRefList-Template_RFQ-CV-0412.xlsx` is classified by the uploader and listed in the document inventory, but its fields are not auto-populated.

**Alternative:** Try to extract vendor identity / references from the package and pre-fill.

**Rationale:** The VendorRefList contains fields like ISO 9001 certificate number, last financial year revenue, list of past comparable projects with client contacts. These data come from the vendor's own internal systems, not from the RFQ package. Pre-filling with hallucinated values would be actively dangerous. Detecting the file and surfacing it as "vendor must complete" is the correct behavior.

---

## D-12 — Demo opening uses risk panel, framed as "review risks", not "contradictions"

**Decision:** The 45-min walkthrough opens with the risk panel showing 27 high-severity + 2 medium tag mismatches that I verified by hand across TCM / IDS / PID Register / SIS spec.

**Wording locked:** *"Before autofilling the TCM, the system cross-checks the response template against the technical evidence. It found N tag-level review risks where binding documents disagree. These are not auto-resolved; they are surfaced for the proposal engineer with literal citations from each source."*

**Alternative:** Open with the TCM table.

**Rationale:** The risk panel is the visible payoff of the cross-doc analysis and proves the tool does more than parse PDFs. The wording avoids "contradictions" because that takes a position; "review risks" is descriptive and defensible. The TCM autofill table follows immediately — the risk panel is the hook, the autofill is the substance.
