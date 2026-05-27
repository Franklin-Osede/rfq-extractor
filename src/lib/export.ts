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
