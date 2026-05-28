/**
 * Excel writers for the two vendor-facing outputs:
 *
 *   1. exportFilledTcm — re-opens the original Helios TCM template (the
 *      `.xlsx` the vendor uploaded), writes Compliance / Deviation Ref /
 *      Vendor Comment per requirement based on the persisted reviewed
 *      state, and returns the workbook as a Buffer. The file structure
 *      (sheet names, columns, styles, instructions, legend, cover sheet)
 *      is preserved byte-for-byte — Helios's clause "any modification to
 *      the structure of this workbook ... may result in the offer being
 *      declared technically non-conforming" makes this non-negotiable.
 *
 *   2. exportDevRegister — TODO, separate task.
 *
 * The contract for what we write to the Compliance column:
 *   - vendorCompliance (if the user approved/edited) takes precedence,
 *     otherwise we use the LLM-suggested compliance.
 *   - "Review" is an internal sentinel — we never write it to the TCM.
 *     A Review requirement is left blank in column D (Compliance) with
 *     a flag in the Vendor Comment column so the proposal engineer
 *     sees that the row still needs attention.
 *   - If a deviationRef is set, it is written to column E.
 *   - The Vendor Comment column always gets either the vendor-edited
 *     comment or the LLM-suggested comment as a starting draft.
 */

import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';

/** Just the fields the writer needs from a requirement row. */
export type ExportableRequirement = {
  reqId: string;
  suggestedCompliance: string | null;
  suggestedComment: string | null;
  vendorCompliance: string | null;
  vendorComment: string | null;
  deviationRef: string | null;
};

/** Shape of a deviation row going into the DEV Register. */
export type DeviationRow = {
  reqId: string;
  rfqSectionRef: string;
  description: string;
  deviationDescription: string; // = vendorComment or suggestedComment
  justification: string; // = rationale
  deviationRef: string | null; // optional DEV-NNN override from the user
};

export async function exportFilledTcm(
  originalTcmPath: string,
  requirements: ExportableRequirement[],
): Promise<Buffer> {
  const fileBuf = await readFile(originalTcmPath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    fileBuf.buffer.slice(
      fileBuf.byteOffset,
      fileBuf.byteOffset + fileBuf.byteLength,
    ) as ArrayBuffer,
  );

  const reqsSheet = workbook.worksheets.find((w) =>
    /requirements?\s*matrix/i.test(w.name),
  );
  if (!reqsSheet) {
    throw new Error(
      'The provided TCM workbook is missing the "Requirements Matrix" sheet',
    );
  }

  // Index requirements by R-id for O(1) lookup during the row walk.
  const byReqId = new Map<string, ExportableRequirement>();
  for (const r of requirements) byReqId.set(r.reqId.toUpperCase(), r);

  reqsSheet.eachRow((row) => {
    const reqId = String(row.getCell(1).value ?? '').trim().toUpperCase();
    if (!/^R-\d{3}$/.test(reqId)) return;

    const req = byReqId.get(reqId);
    if (!req) return;

    // Resolve effective compliance: vendor's choice wins, fall back to LLM.
    const effective = req.vendorCompliance ?? req.suggestedCompliance ?? null;
    const isReview = effective === 'Review';

    // Column D — Compliance (C / D / N/A). We never write Review here.
    if (effective && !isReview) {
      row.getCell(4).value = effective;
    }
    // Column E — Deviation Ref (Att. J). Only filled when the row is a deviation.
    if (req.deviationRef) {
      row.getCell(5).value = req.deviationRef;
    }
    // Column F — Vendor Comment.
    const comment = req.vendorComment ?? req.suggestedComment ?? '';
    const finalComment = isReview
      ? `[NEEDS VENDOR REVIEW — no grounded evidence suggested]${comment ? ' · ' + comment : ''}`
      : comment;
    if (finalComment) row.getCell(6).value = finalComment;
  });

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Re-opens the Helios DEV Register template and populates the Deviation
 * Register sheet with one row per requirement the vendor marked as a
 * deviation. The "DELETE BEFORE SUBMISSION" example rows in the template
 * are stripped first. Pre-numbered DEV-001..DEV-NNN slot rows are reused
 * in order. If we run out, additional rows are appended with the next
 * sequential number.
 *
 * Columns (per the template):
 *   A — Deviation No. (DEV-NNN)
 *   B — Date Raised
 *   C — RFQ Reference (Section / Attachment / Page)
 *   D — Requirement Description (as stated in RFQ)
 *   E — Deviation Description (what vendor is offering instead)
 *   F — Justification (technical reason)
 *   G — Alternative Proposed (vendor's proposed solution) — left blank
 *   H — Risk / Impact — left blank for vendor to fill at PE time
 *   I — Vendor Disposition — set to "Deviation"
 *   J — Helios Disposition — left blank (COMPANY use)
 */
export async function exportDevRegister(
  originalDevPath: string,
  deviations: DeviationRow[],
): Promise<Buffer> {
  const fileBuf = await readFile(originalDevPath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    fileBuf.buffer.slice(
      fileBuf.byteOffset,
      fileBuf.byteOffset + fileBuf.byteLength,
    ) as ArrayBuffer,
  );

  const sheet = workbook.worksheets.find((w) =>
    /deviation\s*register/i.test(w.name),
  );
  if (!sheet) {
    throw new Error(
      'The provided DEV Register workbook is missing the "Deviation Register" sheet',
    );
  }

  // Step 1 — locate example rows ("DEV-EX-NNN — EXAMPLE — DELETE BEFORE
  // SUBMISSION") and clear them. Helios's template includes 3 of these as
  // guidance for the vendor; we strip them so the submitted file is clean.
  const rowsToClear: number[] = [];
  const slotRows: number[] = [];
  sheet.eachRow((row, rowIndex) => {
    if (rowIndex === 1) return; // header
    const a = String(row.getCell(1).value ?? '').trim();
    if (/^DEV-EX-/i.test(a)) {
      rowsToClear.push(rowIndex);
    } else if (/^DEV-\d{3,}$/i.test(a)) {
      slotRows.push(rowIndex);
    }
  });
  for (const r of rowsToClear) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= 10; c++) row.getCell(c).value = null;
  }

  // Step 2 — write each deviation into a slot row (or append).
  const today = new Date().toISOString().slice(0, 10);
  let nextSlotIdx = 0;

  // Find the highest existing slot number so any overflow appends sequentially.
  let highestSlot = 0;
  for (const r of slotRows) {
    const a = String(sheet.getRow(r).getCell(1).value ?? '').trim();
    const m = a.match(/^DEV-(\d+)$/i);
    if (m) highestSlot = Math.max(highestSlot, parseInt(m[1], 10));
  }

  for (const d of deviations) {
    let targetRow: ExcelJS.Row;
    let assignedNo: string;

    if (nextSlotIdx < slotRows.length) {
      const rowIdx = slotRows[nextSlotIdx++];
      targetRow = sheet.getRow(rowIdx);
      assignedNo =
        d.deviationRef ?? String(targetRow.getCell(1).value ?? '').trim();
    } else {
      // Append after the last existing data row.
      highestSlot++;
      const newRowIdx = (slotRows[slotRows.length - 1] ?? 4) + (nextSlotIdx - slotRows.length) + 1;
      targetRow = sheet.getRow(newRowIdx);
      assignedNo = d.deviationRef ?? `DEV-${String(highestSlot).padStart(3, '0')}`;
      nextSlotIdx++;
    }

    targetRow.getCell(1).value = assignedNo;
    targetRow.getCell(2).value = today;
    targetRow.getCell(3).value = d.rfqSectionRef;
    targetRow.getCell(4).value = d.description;
    targetRow.getCell(5).value = d.deviationDescription;
    targetRow.getCell(6).value = d.justification;
    // 7, 8 left blank for vendor proposal engineer.
    targetRow.getCell(9).value = 'Deviation';
    // 10 left blank for Helios.
  }

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}
