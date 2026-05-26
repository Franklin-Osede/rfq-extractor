/**
 * Core domain types for the Loonar RFQ Assistant.
 *
 * The product is a TCM autofill review tool. These types model:
 *   - the package of documents the vendor uploads,
 *   - the 108 requirements + 29 tags loaded from the official TCM template,
 *   - the evidence and citations linking each enriched field to its source,
 *   - the cross-document review risks surfaced for human triage.
 *
 * Authoring rule: nullable fields are explicit (T | null) so that the UI
 * always knows whether something was "not enriched yet" vs. "the system
 * confirmed no value was found".
 */

// ─── Document classification ─────────────────────────────────────────────────

export type DocRole =
  | 'master_rfq'
  | 'tcm_template'
  | 'dev_register_template'
  | 'vendor_ref_list_template'
  | 'instrument_datasheets'
  | 'pid_drawing_register'
  | 'general_valve_spec'
  | 'actuator_spec'
  | 'sis_spec'
  | 'cryogenic_supplement'
  | 'painting_spec'
  | 'packing_spec'
  | 'supplier_code_of_conduct'
  | 'unknown';

export type DocumentRecord = {
  id: string;
  filename: string;
  role: DocRole;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  scanned: boolean;
  language: 'en' | 'en+it' | 'unknown';
  uploadedAt: Date;
};

// ─── Citation ────────────────────────────────────────────────────────────────

export type Citation = {
  docId: string;
  page: number;
  snippet: string;
  /** Deterministic validator result. False ⇒ the suggestion is downgraded to "Review". */
  verified: boolean;
};

// ─── TCM Requirements Matrix (108 rows) ──────────────────────────────────────

export type ComplianceStatus = 'C' | 'D' | 'N/A' | 'Review';

export type RequirementDifficulty = 'standard' | 'product-dependent' | 'hard';

export type ReviewStatus =
  | 'pending'
  | 'approved'
  | 'edited'
  | 'rejected'
  | 'deviation';

export type RequirementRecord = {
  /** R-001 .. R-108 from the TCM Requirements Matrix sheet. */
  id: string;
  /** RFQ section reference as printed in the TCM (e.g. "§5.4"). */
  rfqSectionRef: string;
  description: string;
  /** LLM-classified difficulty; informs review priority ordering. */
  difficulty: RequirementDifficulty | null;
  // LLM-suggested fields (pre-fill candidates).
  suggestedCompliance: ComplianceStatus | null;
  suggestedComment: string | null;
  rationale: string | null;
  evidence: Citation[];
  // Vendor-confirmed fields (post-review).
  vendorCompliance: ComplianceStatus | null;
  vendorComment: string | null;
  deviationRef: string | null;
  reviewStatus: ReviewStatus;
  enrichedAt: Date | null;
  reviewedAt: Date | null;
};

// ─── TCM Tag-Level Confirmation (29 rows) ────────────────────────────────────

export type TechnicalEnvelope = {
  valveType: string | null;
  size: string | null;
  ansiRating: string | null;
  bodyMaterial: string | null;
  operatingTempMin: string | null;
  operatingTempMax: string | null;
  silClassification: string | null;
  failPosition: string | null;
  /** NACE MR0175, Charpy, fire-safe API 6FA, etc. */
  specialRequirements: string[];
  citations: Citation[];
};

export type TagRequirementRecord = {
  /** Tag number as printed in the TCM Tag-Level Confirmation sheet (e.g. "SDV-1041A"). */
  tagNo: string;
  /** Verbatim from TCM column B. This is the official Helios description. */
  heliosServiceDescription: string;
  /** Extracted from IDS Attachment A in runtime, never hardcoded. */
  idsServiceDescription: string | null;
  idsSheetNo: number | null;
  technicalEnvelope: TechnicalEnvelope | null;
  // Vendor-fillable columns of the TCM.
  vendorProposedModel: string | null;
  catalogueSheetRef: string | null;
  silCertRef: string | null;
  leadTimeWeeks: number | null;
  reviewStatus: ReviewStatus;
};

// ─── Risk signal (cross-document mismatch) ───────────────────────────────────

export type RiskSeverity = 'high' | 'medium' | 'low';

export type RiskScope =
  | 'tag-service-description'
  | 'tag-sil-classification'
  | 'tag-pressure-rating'
  | 'tag-body-material'
  | 'tag-vessel-id'
  | 'tag-fluid-service';

export type RiskSource =
  | 'tcm'
  | 'rfq_master'
  | 'ids'
  | 'pid_register'
  | 'sis_spec';

export type RiskSignal = {
  id: string;
  tagNo: string;
  scope: RiskScope;
  severity: RiskSeverity;
  /** One-line human-readable reason for the surfaced risk. */
  reason: string;
  sources: Array<{
    source: RiskSource;
    text: string;
    citation: Citation;
  }>;
};

// ─── Job (one upload = one job) ──────────────────────────────────────────────

export type JobStatus =
  | 'uploading'
  | 'classifying'
  | 'parsing_tcm'
  | 'parsing_pdfs'
  | 'enriching_requirements'
  | 'enriching_tags'
  | 'detecting_risks'
  | 'completed'
  | 'failed';

export type Job = {
  id: string;
  status: JobStatus;
  createdAt: Date;
  completedAt: Date | null;
  documents: DocumentRecord[];
  requirements: RequirementRecord[];
  tags: TagRequirementRecord[];
  risks: RiskSignal[];
  error: string | null;
};
