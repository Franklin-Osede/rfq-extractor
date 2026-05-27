/**
 * Parser for the Helios TCM template (`HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx`).
 *
 * The TCM is the official response format Helios shipped. It contains three
 * sheets:
 *
 *   1. Cover & Instructions — project metadata (doc no., project, package,
 *      RFQ ref, issue date) plus 10 instruction lines and a C/D/N/A legend.
 *   2. Requirements Matrix — 108 rows (R-001 .. R-108), each with a section
 *      ref (§3, §5.1, …, §10), a requirement description, and three empty
 *      columns (Compliance, Deviation Ref, Vendor Comment) for the vendor.
 *   3. Tag-Level Confirmation — 29 rows, one per valve tag, with the Helios
 *      service description and four empty columns (Vendor Model, Catalogue
 *      Ref, SIL Cert Ref, Lead Time).
 *
 * Sheet names are resolved by case-insensitive regex so we tolerate minor
 * variations across Helios revisions. Every parsing error throws a typed
 * `TcmParseError` with the sheet name and row index so the caller can
 * surface a useful message in the UI.
 */

import ExcelJS from 'exceljs';

export class TcmParseError extends Error {
  constructor(
    message: string,
    public readonly sheet?: string,
    public readonly row?: number,
  ) {
    super(message);
    this.name = 'TcmParseError';
  }
}

export type TcmMetadata = {
  documentNo: string | null;
  project: string | null;
  package: string | null;
  issuedBy: string | null;
  issueDate: string | null;
  rfqReference: string | null;
};

export type ParsedRequirement = {
  reqId: string;
  rfqSectionRef: string;
  description: string;
};

export type ParsedTagRequirement = {
  tagNo: string;
  heliosServiceDescription: string;
};

export type TcmParseResult = {
  metadata: TcmMetadata;
  requirements: ParsedRequirement[];
  tagRequirements: ParsedTagRequirement[];
};

/**
 * Parse the TCM workbook from a Buffer (uploaded file) or a file path.
 * Returns structured data; does not insert anything into the DB.
 */
export async function parseTcm(
  input: Buffer | string,
): Promise<TcmParseResult> {
  const workbook = new ExcelJS.Workbook();

  if (typeof input === 'string') {
    await workbook.xlsx.readFile(input);
  } else {
    // Convert Node Buffer to ArrayBuffer for ExcelJS.
    const arrayBuffer = input.buffer.slice(
      input.byteOffset,
      input.byteOffset + input.byteLength,
    ) as ArrayBuffer;
    await workbook.xlsx.load(arrayBuffer);
  }

  const coverSheet =
    workbook.worksheets.find((w) => /cover|instruction/i.test(w.name)) ??
    workbook.worksheets[0];
  const reqsSheet = workbook.worksheets.find((w) =>
    /requirements?\s*matrix/i.test(w.name),
  );
  const tagsSheet = workbook.worksheets.find((w) =>
    /tag.?level|tag.?confirmation/i.test(w.name),
  );

  if (!reqsSheet) {
    throw new TcmParseError(
      'TCM is missing the "Requirements Matrix" sheet',
      undefined,
      undefined,
    );
  }
  if (!tagsSheet) {
    throw new TcmParseError(
      'TCM is missing the "Tag-Level Confirmation" sheet',
      undefined,
      undefined,
    );
  }

  return {
    metadata: parseCoverSheet(coverSheet),
    requirements: parseRequirementsSheet(reqsSheet),
    tagRequirements: parseTagsSheet(tagsSheet),
  };
}

// ─── Cover & Instructions ────────────────────────────────────────────────────

/**
 * The Cover sheet has free-form labelled rows in column B with values in
 * column C. We scan for known labels via substring match (defensive against
 * label wording changes across Helios revisions).
 */
function parseCoverSheet(sheet: ExcelJS.Worksheet): TcmMetadata {
  const m: TcmMetadata = {
    documentNo: null,
    project: null,
    package: null,
    issuedBy: null,
    issueDate: null,
    rfqReference: null,
  };

  sheet.eachRow((row) => {
    const label = cellString(row.getCell(2)).toLowerCase();
    const value = cellString(row.getCell(3));
    if (!label) return;

    if (label.includes('document no')) m.documentNo = value || null;
    else if (label === 'project') m.project = value || null;
    else if (label === 'package') m.package = value || null;
    else if (label.includes('issued by')) m.issuedBy = value || null;
    else if (label.includes('issue date')) m.issueDate = value || null;

    // The RFQ reference is on its own row, often without a label — sniff it
    // out from the first column instead.
    const rawA = cellString(row.getCell(2));
    if (!m.rfqReference && /rfq reference/i.test(rawA)) {
      const match = rawA.match(/HEL-[A-Z0-9-]+/i);
      if (match) m.rfqReference = match[0];
    }
  });

  return m;
}

// ─── Requirements Matrix (108 rows) ──────────────────────────────────────────

function parseRequirementsSheet(
  sheet: ExcelJS.Worksheet,
): ParsedRequirement[] {
  const out: ParsedRequirement[] = [];

  sheet.eachRow((row, rowIndex) => {
    // Skip header row (row 1). Identify data rows by the R-### pattern.
    const reqId = cellString(row.getCell(1)).trim();
    if (!/^R-\d{3}$/i.test(reqId)) return;

    const rfqSectionRef = normaliseSectionRef(cellString(row.getCell(2)));
    const description = cellString(row.getCell(3)).trim();

    if (!description) {
      throw new TcmParseError(
        `Requirement ${reqId} has no description`,
        sheet.name,
        rowIndex,
      );
    }

    out.push({
      reqId: reqId.toUpperCase(),
      rfqSectionRef,
      description,
    });
  });

  if (out.length === 0) {
    throw new TcmParseError(
      'No requirements found in Requirements Matrix sheet',
      sheet.name,
    );
  }

  return out;
}

// ─── Tag-Level Confirmation (29 rows) ────────────────────────────────────────

const TAG_PATTERN = /^(FV|PCV|SDV|BDV|HV|TV|LV|ZV|XV|UV)-\d{3,5}[A-Z]?$/i;

function parseTagsSheet(sheet: ExcelJS.Worksheet): ParsedTagRequirement[] {
  const out: ParsedTagRequirement[] = [];

  sheet.eachRow((row, rowIndex) => {
    const tagNo = cellString(row.getCell(1)).trim();
    if (!TAG_PATTERN.test(tagNo)) return;

    const heliosServiceDescription = cellString(row.getCell(2)).trim();

    if (!heliosServiceDescription) {
      throw new TcmParseError(
        `Tag ${tagNo} has no Helios service description`,
        sheet.name,
        rowIndex,
      );
    }

    out.push({
      tagNo: tagNo.toUpperCase(),
      heliosServiceDescription,
    });
  });

  if (out.length === 0) {
    throw new TcmParseError(
      'No tags found in Tag-Level Confirmation sheet',
      sheet.name,
    );
  }

  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cellString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString().split('T')[0];
  if (typeof v === 'object' && 'text' in v) return String(v.text);
  if (typeof v === 'object' && 'result' in v) return String(v.result);
  if (typeof v === 'object' && 'richText' in v) {
    return (v.richText as Array<{ text: string }>)
      .map((r) => r.text)
      .join('');
  }
  return String(v);
}

/**
 * Normalise a section ref like " §5.4 " or "Section 5.4" to "§5.4".
 * Tolerates the UTF-8 garbling ("Â§") that sometimes survives CSV exports.
 */
function normaliseSectionRef(raw: string): string {
  const trimmed = raw.replace(/Â/g, '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('§')) return trimmed;
  if (/^section\s+/i.test(trimmed)) {
    return '§' + trimmed.replace(/^section\s+/i, '').trim();
  }
  if (/^\d+(\.\d+)*$/.test(trimmed)) return '§' + trimmed;
  return trimmed;
}
