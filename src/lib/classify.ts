/**
 * Rule-based document classifier for the Helios RFQ package.
 *
 * We resolve `DocRole` from the filename pattern first (cheap, deterministic)
 * and use the first few bytes only to detect MIME type. Classification is
 * intentionally hard-coded for the Helios Azura Sul package — the brief
 * gives us this package and nothing else, and per-customer taxonomy would
 * live in a YAML config in production (see DECISIONS.md D-08).
 */

import type { DocRole } from './types';

// ─── Filename → DocRole ──────────────────────────────────────────────────────

type Rule = { role: DocRole; pattern: RegExp };

/**
 * Ordered list: first match wins. Patterns are case-insensitive and use the
 * Helios doc-number prefixes (HEL-AZ2-* for project docs, HEL-GS-* for
 * general specs, HEL-SCC-* for legal, RFQ_HEL-PRO-* for the master RFQ).
 */
const RULES: Rule[] = [
  { role: 'tcm_template', pattern: /HEL-AZ2-TCM-Template/i },
  { role: 'dev_register_template', pattern: /HEL-AZ2-DEV-Register-Template/i },
  { role: 'vendor_ref_list_template', pattern: /HEL-AZ2-VendorRefList-Template/i },
  { role: 'instrument_datasheets', pattern: /HEL-AZ2-IDS-INS/i },
  { role: 'pid_drawing_register', pattern: /HEL-AZ2-PID-PRC/i },
  { role: 'general_valve_spec', pattern: /HEL-GS-VAL/i },
  { role: 'actuator_spec', pattern: /HEL-GS-ACT/i },
  { role: 'sis_spec', pattern: /HEL-GS-SIS/i },
  { role: 'cryogenic_supplement', pattern: /HEL-GS-CRY/i },
  { role: 'painting_spec', pattern: /HEL-GS-PNT/i },
  { role: 'packing_spec', pattern: /HEL-GS-PKG/i },
  { role: 'supplier_code_of_conduct', pattern: /HEL-SCC/i },
  { role: 'master_rfq', pattern: /RFQ_HEL-PRO/i },
];

export function classifyByFilename(filename: string): DocRole {
  for (const r of RULES) if (r.pattern.test(filename)) return r.role;
  return 'unknown';
}

// ─── First-bytes → MIME type ─────────────────────────────────────────────────

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04 (xlsx is a zip)

export type DetectedMime =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'application/octet-stream';

export function detectMimeType(firstBytes: Buffer): DetectedMime {
  if (firstBytes.length < 4) return 'application/octet-stream';
  if (firstBytes.subarray(0, 4).equals(PDF_MAGIC)) return 'application/pdf';
  if (firstBytes.subarray(0, 4).equals(ZIP_MAGIC))
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

// ─── Role-based metadata defaults ────────────────────────────────────────────
// In production we'd detect these by inspecting the file (e.g. checking if a
// PDF has a text layer to determine `scanned`). For the take-home, the
// package is known and stable, so we look up by role and surface the seam.

export function detectScanned(role: DocRole): boolean {
  // HEL-GS-PNT-010 Rev 5 is scanned per package analysis (DECISIONS.md D-07).
  // The OCR path is intentionally out of scope; the document is flagged so
  // the UI can downgrade any citation referencing it.
  return role === 'painting_spec';
}

export function detectLanguage(role: DocRole): 'en' | 'en+it' | 'unknown' {
  // HEL-GS-CRY-002 Rev 1 has bilingual Italian/English cover + final note.
  return role === 'cryogenic_supplement' ? 'en+it' : 'en';
}
