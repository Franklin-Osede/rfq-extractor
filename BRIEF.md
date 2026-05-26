# Loonar — Technical Assessment

> Pinned for reference. The original assessment as received from Loonar founders.

## About Loonar

Loonar automates the most painful part of industrial sales: turning messy RFQ documents into structured, actionable data. Sales engineers at manufacturers spend hours manually extracting technical specs from PDFs and spreadsheets into quoting tools — slow, error-prone, demoralizing. We turn that into seconds.

## The brief

A sales engineer at a valve manufacturer just received the attached RFQ package from Helios Engineering — a 14-page master RFQ plus 12 supporting attachments of varying format, length, and quality.

Today they extract everything by hand.

**Build a tool that lets that sales engineer drop in this RFQ package and, within ~60 seconds, get back structured technical parameters they can review, correct, and export.**

You decide what "structured" means. You decide what the review experience looks like. You decide what to cut.

## What you get

- One master RFQ PDF (`RFQ_HEL-PRO-2026-CV-0412_AzuraSulFLNG.pdf`)
- 12 supporting attachments (A–L) of varying format (PDF, Excel), length, and quality
- Nothing else. No schema, no spec, no stack guidance.

## Constraints

- **Deadline: 3 calendar days from receipt of this brief, end of day.**
- **Use AI heavily.** Claude Code, Cursor, Codex, whatever you ship fastest with. This brief is intentionally too large to complete without AI — we want to see how you wield it.
- **Pick any stack.** Optimize for shipping, not for what we use.
- **Out of scope (don't waste time):** auth, multi-tenancy, deployment infrastructure, scale, exhaustive test suites, polished marketing copy.

## Deliverable

- A GitHub repo (public or private — invite `matteo@coosmo.co`) with a README that gets us running in under 5 minutes.
- A **45-minute videocall walkthrough** with the two founders: live demo + discussion of what you built, what you cut, and how you used AI.
- No writeup, no Loom. The walkthrough is the writeup.

## What we're evaluating

- **Product judgment** — what did you build, what did you cut, why?
- **AI-tool leverage** — how much real software did you produce in 3 days, and how did you orchestrate the tools?
- **Shipping + communication** — does it actually work end-to-end, and can you explain the decisions clearly?

We are *not* grading code style. We will notice if the code is a disaster, but elegance is not the bar — working software and clear thinking are.

## Logistics

- Submit within **72 hours** of receiving this brief, end of day.
- We'll schedule the 45-min videocall walkthrough within 3 working days of submission.
- Asking sharp clarifying questions during the assessment is encouraged, not penalized.

---

## Package received — the 13 documents

| # | Document | Type | Role |
|---|----------|------|------|
| 1 | `RFQ_HEL-PRO-2026-CV-0412_AzuraSulFLNG.pdf` | PDF | Master RFQ — 14 pages |
| A | `HEL-AZ2-IDS-INS-0412_RevB2_InstrumentDataSheets.pdf` | PDF | Instrument Data Sheets — 25 pages, 15 sheets, 47 valve units |
| B | `HEL-AZ2-PID-PRC-Series_DrawingRegister.pdf` | PDF | P&ID Drawing Register + Tag-to-Drawing Cross-Reference + stylised excerpts |
| C | `HEL-GS-VAL-001_Rev4_GeneralValveSpec.pdf` | PDF | General Valve Specification (Rev 4) |
| D | `HEL-GS-ACT-003_Rev2_ActuatorControlsSpec.pdf` | PDF | Actuator and Controls Specification (Rev 2) |
| E | `HEL-GS-SIS-007_Rev3_SISSILSpec.pdf` | PDF | SIS / SIL Equipment Specification (Rev 3) |
| F | `HEL-GS-CRY-002_Rev1_CryogenicSupplement.pdf` | PDF | Cryogenic Equipment Supplement (Rev 1, bilingual IT/EN) |
| G | `HEL-GS-PNT-010_Rev5_PaintingCoatingSpec.pdf` | PDF | Painting & Coating Specification (Rev 5, **scanned**) |
| H | `HEL-GS-PKG-004_Rev3_PackingPreservationSpec.pdf` | PDF | Packing & Preservation Specification (Rev 3, embeds superseded Rev 2 content) |
| I | `HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx` | Excel | **Technical Compliance Matrix** — 108 requirements + 29 Tag-Level rows |
| J | `HEL-AZ2-DEV-Register-Template_RFQ-CV-0412.xlsx` | Excel | Deviation / Exception Register template |
| K | `HEL-AZ2-VendorRefList-Template_RFQ-CV-0412.xlsx` | Excel | Vendor Reference List template (vendor-filled, not autofill target) |
| L | `HEL-SCC-001_Rev2_SupplierCodeOfConduct.pdf` | PDF | Supplier Code of Conduct (legal boilerplate) |

## Critical context from the founder interview transcript

- *"These traditional industries don't trust AI... we need to be really good at creating a UX that allows them to double check everything that we extract into the actual document where it was extracted. Visibility and auditability create trust."*
- *"Different agents working together but having that cycle — you cannot ship anything until it has been validated."*
- *"We have six companies in production, six different products, six different taxonomies of product catalog."*
- *"Pragmatic and quick in delivering stuff. We don't necessarily need rocket science distributed systems."*
- *"Two things with juice"* = (1) Information extraction, (2) Internal document research for answering.

## Submission targets (locked)

- ✅ Repo with README that runs in <5 min
- ✅ 45-min videocall walkthrough preparation
- ✅ Demo headline: "Helios already gave the output format. We pre-fill it."
- ✅ Risk panel as prominent secondary feature (not headline) — with verified citations, not opinions
- ✅ "How I used AI" section in README must read like orchestration, not autocomplete
