/**
 * PDF text extractor — one row per page, no bbox.
 *
 * Uses `unpdf` (the modern PDF.js wrapper that works in any JS runtime).
 * Returns the text content of every page so we can index it in the `chunks`
 * table and look up citations later (substring + fuzzy match).
 *
 * Out of scope (intentional, see DECISIONS.md D-06): bounding boxes,
 * pixel-perfect highlighting. Page + verified snippet is enough for the
 * auditability promise.
 *
 * Scanned PDFs (e.g. HEL-GS-PNT-010 Rev 5): `unpdf` will return empty or
 * near-empty strings per page because there's no embedded text layer.
 * That's fine — those documents are flagged `scanned: true` at upload time
 * and any citation pointing to them will fail the validator, downgrading
 * the suggestion to `Review`.
 */

import { extractText } from 'unpdf';

export type ParsedPdfPage = {
  page: number;
  text: string;
};

export type ParsedPdf = {
  pageCount: number;
  pages: ParsedPdfPage[];
};

export class PdfParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PdfParseError';
  }
}

export async function parsePdf(buffer: Buffer): Promise<ParsedPdf> {
  try {
    const data = new Uint8Array(buffer);
    const result = await extractText(data, { mergePages: false });

    // unpdf returns string[] when mergePages: false. Defensive: it can also
    // return a single string if the input had only one logical page.
    const rawPages: string[] = Array.isArray(result.text)
      ? result.text
      : [result.text];

    const pages = rawPages.map<ParsedPdfPage>((t, i) => ({
      page: i + 1,
      text: (t ?? '').trim(),
    }));

    return {
      pageCount: result.totalPages,
      pages,
    };
  } catch (e) {
    throw new PdfParseError(
      `Failed to parse PDF: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

/**
 * True when a parsed PDF has effectively no text (every page is empty or
 * just whitespace). Used to detect scanned-without-OCR documents at runtime
 * and downgrade them to `degraded-quality` status.
 */
export function isEffectivelyEmpty(parsed: ParsedPdf): boolean {
  const total = parsed.pages.reduce((sum, p) => sum + p.text.length, 0);
  // Threshold: less than 50 characters across the whole document means
  // either an empty PDF or a scanned one with no text layer.
  return total < 50;
}
