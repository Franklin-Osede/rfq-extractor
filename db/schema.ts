/**
 * Drizzle schema for the SQLite database backing the RFQ Assistant.
 *
 * Tables (one upload = one Job):
 *   jobs              — top-level state machine of a single upload+process run.
 *   documents         — the 13 files in the package, classified by role.
 *   chunks            — text content of every PDF page, indexed for citation.
 *   requirements      — the 108 rows of the TCM Requirements Matrix sheet.
 *   tag_requirements  — the 29 rows of the TCM Tag-Level Confirmation sheet.
 *   risk_signals      — cross-document mismatches surfaced for human triage.
 *
 * Citation arrays / technical envelopes / risk source lists live as JSON
 * columns. SQLite's JSON1 is enabled by default in better-sqlite3, and
 * Drizzle's `text({ mode: 'json' })` gives full type-safety on read/write.
 */

import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  Citation,
  ComplianceStatus,
  DocRole,
  JobStatus,
  RequirementDifficulty,
  ReviewStatus,
  RiskScope,
  RiskSeverity,
  RiskSource,
  TechnicalEnvelope,
} from '../src/lib/types';

// ─── jobs ────────────────────────────────────────────────────────────────────

/**
 * Persisted summary of the last /risks sweep — failed-tag counts, errors,
 * and LLM telemetry. Stored on the job (not on risk_signals) so the UI
 * can reconstruct the partial-failure warning after a page reload, not
 * just during the active upload flow.
 */
export type RiskRunSummary = {
  tagsAnalysed: number;
  risksDetected: number;
  failed: number;
  errors: Array<{ tagNo: string; error: string }>;
  bySeverity: Record<string, number>;
  sis: {
    sisTableFound: boolean;
    sisTagsAllocated: number;
    tagsAnalysed: number;
    hardMismatches: number;
    tcmSilent: number;
    aligned: number;
    notInSis: number;
  };
  llm: {
    provider: string | null;
    model: string | null;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    avgLatencyMs: number;
  };
  ranAt: string;
};

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  status: text('status').$type<JobStatus>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  error: text('error'),
  riskRunSummary: text('risk_run_summary', { mode: 'json' }).$type<RiskRunSummary | null>(),
});

// ─── documents ───────────────────────────────────────────────────────────────

export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  role: text('role').$type<DocRole>().notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  pageCount: integer('page_count'),
  scanned: integer('scanned', { mode: 'boolean' }).notNull().default(false),
  language: text('language')
    .$type<'en' | 'en+it' | 'unknown'>()
    .notNull()
    .default('unknown'),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ─── chunks (per-page PDF text for citation lookup) ──────────────────────────

export const chunks = sqliteTable('chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  page: integer('page').notNull(),
  text: text('text').notNull(),
});

// ─── requirements (108 rows from TCM Requirements Matrix) ────────────────────

export const requirements = sqliteTable('requirements', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  /** R-001 .. R-108 as printed in the TCM. */
  reqId: text('req_id').notNull(),
  rfqSectionRef: text('rfq_section_ref').notNull(),
  description: text('description').notNull(),
  difficulty: text('difficulty').$type<RequirementDifficulty>(),
  // LLM-suggested fields.
  suggestedCompliance: text('suggested_compliance').$type<ComplianceStatus>(),
  suggestedComment: text('suggested_comment'),
  rationale: text('rationale'),
  evidence: text('evidence', { mode: 'json' })
    .$type<Citation[]>()
    .notNull()
    .default(sql`'[]'`),
  // Vendor-confirmed fields.
  vendorCompliance: text('vendor_compliance').$type<ComplianceStatus>(),
  vendorComment: text('vendor_comment'),
  deviationRef: text('deviation_ref'),
  reviewStatus: text('review_status')
    .$type<ReviewStatus>()
    .notNull()
    .default('pending'),
  enrichedAt: integer('enriched_at', { mode: 'timestamp' }),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
});

// ─── tag_requirements (29 rows from TCM Tag-Level Confirmation) ──────────────

export const tagRequirements = sqliteTable('tag_requirements', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  /** Tag number verbatim from TCM column A (e.g. "SDV-1041A"). */
  tagNo: text('tag_no').notNull(),
  /** TCM column B, ground truth for what the vendor quotes against. */
  heliosServiceDescription: text('helios_service_description').notNull(),
  // Extracted from IDS in runtime (never hardcoded).
  idsServiceDescription: text('ids_service_description'),
  idsSheetNo: integer('ids_sheet_no'),
  technicalEnvelope: text('technical_envelope', {
    mode: 'json',
  }).$type<TechnicalEnvelope | null>(),
  // Vendor-fillable TCM columns.
  vendorProposedModel: text('vendor_proposed_model'),
  catalogueSheetRef: text('catalogue_sheet_ref'),
  silCertRef: text('sil_cert_ref'),
  leadTimeWeeks: integer('lead_time_weeks'),
  reviewStatus: text('review_status')
    .$type<ReviewStatus>()
    .notNull()
    .default('pending'),
});

// ─── risk_signals (cross-document mismatches) ────────────────────────────────

export const riskSignals = sqliteTable('risk_signals', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  tagNo: text('tag_no').notNull(),
  scope: text('scope').$type<RiskScope>().notNull(),
  severity: text('severity').$type<RiskSeverity>().notNull(),
  reason: text('reason').notNull(),
  sources: text('sources', { mode: 'json' })
    .$type<Array<{ source: RiskSource; text: string; citation: Citation }>>()
    .notNull()
    .default(sql`'[]'`),
});
