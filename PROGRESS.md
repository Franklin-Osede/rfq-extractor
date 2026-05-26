# Progress Log — Loonar take-home

**Deadline:** 72 horas desde la recepción del brief — fin del Day 3.
**Estado actual:** Day 0 — scaffolding en curso.
**Última actualización:** 2026-05-26 20:45.

---

## Plan por días

| Día | Foco | Outputs esperados |
|-----|------|-------------------|
| **Day 0** | Scaffolding + alineación de estrategia | Repo inicializado, deps instaladas, docs base (README/PROGRESS/BRIEF/DECISIONS), schema YAML, estructura `src/`, primer endpoint `/api/jobs` |
| **Day 1** | Pipeline core | TCM parser (ExcelJS) funcional, PDFs indexados (unpdf), LLM enrich para 5-10 reqs de muestra, validator determinista, smoke test end-to-end |
| **Day 2** | UI + extract completo | Review UI con tabla 108 reqs + 29 tags + side panel + PDF viewer; risk panel con los 27 high-severity mismatches verificados; review actions (approve / edit / reject / mark-as-deviation) |
| **Day 3** | Export + polish + demo | TCM.xlsx export preservando estructura, DEV Register export, README final con "How I used AI", smoke test desde clone limpio, push GitHub, invite `matteo@coosmo.co`, ensayo de demo |

---

## Task tracker

(El `TodoWrite` del chat es la source of truth a nivel ejecución; este file es el resumen humano de progreso por día.)

### Day 0 — scaffolding

- [x] Next.js 16 + TS + Tailwind 4 + App Router + src/ layout inicializado
- [x] Switch pnpm → npm (decisión: README "get us running in 5 min" exige el package manager universal)
- [x] Runtime deps instaladas: `drizzle-orm`, `better-sqlite3`, `exceljs`, `@anthropic-ai/sdk`, `unpdf`, `pdfjs-dist`, `react-pdf`, `zod`, `string-similarity`
- [x] Dev deps instaladas: `drizzle-kit`, `@types/string-similarity`, `@types/better-sqlite3`
- [x] README.md (profesional, en inglés para los founders)
- [x] PROGRESS.md (este file)
- [x] BRIEF.md (brief literal de Loonar)
- [ ] DECISIONS.md (decisiones de scope con rationale)
- [ ] shadcn/ui init
- [ ] Estructura `src/lib`, `src/components`, `db/`, `samples/`, `schemas/`, `prompts/`
- [ ] TypeScript types base (`src/lib/types.ts`)
- [ ] Drizzle schema + db init (`db/schema.ts`, `src/lib/db.ts`)
- [ ] Schema YAML (`schemas/helios_valves.yaml`)
- [ ] `.env.example` con `ANTHROPIC_API_KEY`

### Day 1 — parsers + LLM enrich

- [ ] ExcelJS reader del TCM (3 sheets: Cover, Requirements Matrix, Tag-Level Confirmation)
- [ ] unpdf reader de los PDFs (texto por página + metadatos)
- [ ] Endpoint `POST /api/jobs` (multipart upload + classify rule-based)
- [ ] Prompt v1 de enrich-requirement.md
- [ ] LLM enrich para 5-10 reqs representativos (validar accuracy y citation grounding)
- [ ] Validador determinista (literal + fuzzy ratio ≥ 0.9)
- [ ] Smoke test end-to-end: upload 13 docs → JSON con reqs enriquecidos + tags + risks

### Day 2 — UI + extract completo + risks

- [ ] Página principal con `UploadZone`
- [ ] `RequirementsTable` (108 rows con filter por status)
- [ ] Tabla `Tag-Level Confirmation` (29 rows)
- [ ] `EvidencePanel` con citation + snippet + link "ver en fuente"
- [ ] `SourceViewer` con react-pdf abriendo en la página correcta
- [ ] Review actions: approve / edit / reject / mark-as-deviation
- [ ] `RiskPanel` con los 27 high-severity mismatches verificados (orden: highest severity first)
- [ ] LLM enrich completo para los 108 reqs
- [ ] LLM enrich completo para los 29 tags (technical envelope from IDS)

### Day 3 — export + polish + demo

- [ ] ExcelJS writer del TCM filled (preservando structure, formulas, styling)
- [ ] ExcelJS writer del DEV Register (rows por cada deviation marcada)
- [ ] README final con sección "How I used AI" completa
- [ ] DECISIONS.md cerrado con todas las scope decisions
- [ ] Smoke test desde clone limpio (en una segunda máquina si es posible)
- [ ] `git push` + repo público o invite a `matteo@coosmo.co`
- [ ] Demo script ensayado 2 veces
- [ ] Preparar respuestas a las preguntas probables de los founders (ver sección demo prep)

---

## Decisiones tomadas en el camino (micro-log)

- **2026-05-26 20:35**: Stack final = Next.js + TS + SQLite + ExcelJS, no Python. Decisión propia del usuario tras debate. Razón: single runtime, single repo, no se necesita pdfplumber al haber cortado bbox.
- **2026-05-26 20:40**: Next.js 16 (último, lo que pulló `create-next-app@latest`). React 19, Tailwind 4, ESLint 9, TS 5.9.
- **2026-05-26 20:42**: npm en lugar de pnpm. Razón: README "get us running in under 5 minutes" — npm es universal, pnpm puede no estar instalado en la máquina de los founders.
- **2026-05-26 20:44**: TCM autofill como producto principal (no conflict detection como headline). Razón: el TCM es el formato oficial de respuesta que Helios entregó; el output del producto debe ser su .xlsx relleno.
- **2026-05-26 20:44**: 27 high-severity + 2 medium tag mismatches verificados. Demo abre con "review risks", lenguaje senior, no "contradictions".

---

## Blockers / riesgos del shipping

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| `react-pdf` worker setup en Next.js App Router | Media | Fallback Day 2: abrir PDF en pestaña nueva con `#page=N` sin overlay |
| ExcelJS write preservando estructura del TCM | Media | Probar early con el archivo real Day 1 PM; fallback es escribir nuevo .xlsx con misma estructura |
| Claude API rate limits durante iteración del prompt | Baja | Usar samples de 5-10 reqs durante dev; full 108 al final |
| OCR del PNT-010 escaneado | Cortado | Decisión locked: out-of-scope, marca como `degraded-quality`, surface el seam |
| `pdfjs-dist` worker import en serverless / dev | Media | Usar `pdfjs-dist/legacy/build/pdf.worker.mjs` o configurar webpack |

---

## Demo prep (Day 3 PM)

Cuando llegue al ensayo, validar:

- [ ] Demo flow funciona desde cero en menos de 5 min de setup
- [ ] El opener con risk panel suena profesional: *"Before autofilling the TCM, the system cross-checks the response template against the technical evidence..."*
- [ ] SDV-2055A funciona como ejemplo ancla (IDS+SIS alineados contra TCM — defendible)
- [ ] Edit / mark-as-deviation produce DEV Register row correcto
- [ ] Export TCM mantiene el archivo abrible en Excel sin warnings
- [ ] Preparado para las 6 preguntas probables:
  - "How did you wield AI?" → ver sección del README + log de prompts iterados
  - "Why no embeddings?" → extracción ≠ retrieval
  - "How do you handle hallucinations?" → deterministic validator + fallback a `Review`
  - "How does this scale to 6 customers / 6 taxonomies?" → schema YAML declarativo
  - "What about the scanned painting spec?" → degraded-quality flag + Azure DI seam
  - "What would you build next?" → past-proposal corpus (the missing Loonar module)
