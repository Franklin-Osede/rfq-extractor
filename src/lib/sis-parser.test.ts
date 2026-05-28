/**
 * Unit tests for the SIS allocation parser.
 *
 * The parser is the most regex-dense piece of code in the project and the
 * one most likely to silently lose tags on a customer-specific document
 * variation. These tests cover every notation we've seen in the real Helios
 * package plus the edge cases the second AI review flagged.
 */

import { describe, expect, it } from 'vitest';
import {
  extractSilFromLine,
  extractSilFromServiceDescription,
  extractTagsFromLine,
  parseSisAllocations,
} from './sis-parser';

describe('extractSilFromLine', () => {
  it('returns the SIL integer when present', () => {
    expect(extractSilFromLine('SDV-1041A/B LNG Loading Arm ESD SIL 3 Low 20 yrs')).toBe(3);
    expect(extractSilFromLine('FV-2021A/B/C Mixed Refrigerant Flow SIL 1 Low 20 yrs')).toBe(1);
  });

  it('handles SIL with a dash separator', () => {
    expect(extractSilFromLine('Tag X — SIL-2 — service Y')).toBe(2);
  });

  it('is case-insensitive', () => {
    expect(extractSilFromLine('something sil 3 etc')).toBe(3);
  });

  it('returns null when no SIL token is present', () => {
    expect(extractSilFromLine('Some text with no safety integrity level mentioned')).toBeNull();
  });

  it('rejects out-of-range numbers', () => {
    expect(extractSilFromLine('SIL 9 (typo)')).toBeNull();
  });
});

describe('extractTagsFromLine', () => {
  it('expands paired A/B notation', () => {
    expect(extractTagsFromLine('SDV-1041A/B LNG Loading Arm')).toEqual([
      'SDV-1041A',
      'SDV-1041B',
    ]);
  });

  it('expands triple A/B/C notation', () => {
    expect(extractTagsFromLine('FV-2021A/B/C Mixed Refrigerant Flow')).toEqual([
      'FV-2021A',
      'FV-2021B',
      'FV-2021C',
    ]);
  });

  it('expands bare numeric range', () => {
    expect(extractTagsFromLine('SDV-7001 to 7006 Train 3 Isolation')).toEqual([
      'SDV-7001',
      'SDV-7002',
      'SDV-7003',
      'SDV-7004',
      'SDV-7005',
      'SDV-7006',
    ]);
  });

  it('expands range with shared letter suffix', () => {
    expect(extractTagsFromLine('ZV-8011A to 8013A — banked')).toEqual([
      'ZV-8011A',
      'ZV-8012A',
      'ZV-8013A',
    ]);
  });

  it('preserves a single bare tag', () => {
    expect(extractTagsFromLine('BDV-4003 Scrub Column Blowdown')).toEqual(['BDV-4003']);
  });

  it('preserves a single suffixed tag', () => {
    expect(extractTagsFromLine('SDV-1043 BOG Compressor Suction ESD')).toEqual(['SDV-1043']);
  });

  it('canonicalizes lowercase letters to uppercase in output', () => {
    expect(extractTagsFromLine('sdv-1041a/b lower case input')).toEqual([
      'SDV-1041A',
      'SDV-1041B',
    ]);
  });

  it('handles multiple prefixes on the same line independently', () => {
    const tags = extractTagsFromLine(
      'cross-references: SDV-1043 and FV-1014 and PCV-1033',
    );
    expect(new Set(tags)).toEqual(new Set(['SDV-1043', 'FV-1014', 'PCV-1033']));
  });

  it('does not match an unsupported "missing first letter" pattern (documented)', () => {
    // The SIS table never writes "SDV-1041/B" — only "SDV-1041A/B". The
    // ambiguity of "what is the first letter?" makes inference unsafe;
    // we choose to drop rather than guess.
    expect(extractTagsFromLine('SDV-1041/B unsupported notation')).toEqual([]);
  });

  it('does not expand a range when "to" letters differ', () => {
    // "SDV-7001A to 7006B" mixes A and B — that's not a clean range. We
    // refuse to expand it (would produce wrong tags) and fall back to
    // recognising just the bare first tag, which is better than dropping
    // the whole line.
    expect(extractTagsFromLine('SDV-7001A to 7006B mixed')).toEqual(['SDV-7001A']);
  });

  it('rejects absurdly large ranges (sanity cap)', () => {
    // 50-tag cap suppresses the range expansion; falls back to bare first
    // tag only.
    expect(extractTagsFromLine('SDV-100 to 9999 should not expand')).toEqual(['SDV-100']);
  });

  it('ignores unknown tag prefixes', () => {
    expect(extractTagsFromLine('XX-1234 SIL 2 — not a recognised valve prefix')).toEqual(
      [],
    );
  });
});

describe('extractSilFromServiceDescription', () => {
  it('pulls SIL from a TCM service description', () => {
    expect(
      extractSilFromServiceDescription('Inlet ESDV - Train A (HP gas, fail close, SIL 3)'),
    ).toBe(3);
  });

  it('returns null when no SIL is mentioned', () => {
    expect(
      extractSilFromServiceDescription('Inlet Separator Level Control Valve - Train A'),
    ).toBeNull();
  });
});

describe('parseSisAllocations (integration)', () => {
  it('builds a map from synthesised SIS pages', () => {
    const pages = [
      'cover page — no SIL data',
      'revision history',
      'scope and definitions',
      [
        'HELIOS ENGINEERING — SIS SIL Equipment Specification page 4 of 10',
        '3. SIL Allocation by Tag',
        'Tag Service / SIF Description SIL Demand Mission',
        'SDV-1041A/B LNG Loading Arm ESD (jetty side) SIL 3 Low 20 yrs',
        'BDV-4003 Scrub Column Blowdown SIL 3 Low 20 yrs',
        'FV-2021A/B/C Mixed Refrigerant Flow (LP loop) SIL 1 Low 20 yrs',
        'SDV-7001 to 7006 Train 3 Isolation SIL 2 Low 20 yrs',
      ].join('\n'),
      'continuation — certification requirements (do not double-count)',
    ];

    const map = parseSisAllocations(pages);

    expect(map.get('SDV-1041A')?.sil).toBe(3);
    expect(map.get('SDV-1041B')?.sil).toBe(3);
    expect(map.get('BDV-4003')?.sil).toBe(3);
    expect(map.get('FV-2021A')?.sil).toBe(1);
    expect(map.get('FV-2021B')?.sil).toBe(1);
    expect(map.get('FV-2021C')?.sil).toBe(1);
    expect(map.get('SDV-7001')?.sil).toBe(2);
    expect(map.get('SDV-7006')?.sil).toBe(2);

    // Every allocation should cite the page it was parsed from.
    for (const alloc of map.values()) {
      expect(alloc.pageNo).toBe(4);
      expect(alloc.lineText.length).toBeGreaterThan(0);
    }
  });

  it('returns an empty map when no allocation table is found', () => {
    const pages = ['just a generic document', 'with no SIL allocations'];
    const map = parseSisAllocations(pages);
    expect(map.size).toBe(0);
  });

  it('does not double-count when the table format appears twice', () => {
    // First occurrence is the real table; later "SIL N" mentions in
    // certification clauses must not overwrite the allocation. The first
    // page must clear the parser's 3-token threshold to qualify as a real
    // table, so we include 3 allocations here.
    const pages = [
      [
        '3. SIL Allocation by Tag',
        'Tag Service SIL',
        'SDV-1041A/B ESD SIL 3 Low',
        'BDV-4003 Blowdown SIL 2 Low',
        'FV-2021A/B/C Mixed Refrigerant SIL 1 Low',
      ].join('\n'),
      [
        '4. Certification Requirements',
        'All SIL 3 final elements shall be third-party certified.',
        'Acceptable certification bodies are SafeCert GmbH, exida LLC.',
        'BDV-4003 — see clause 4.1 for documentation requirements (note: SIL 3 certs).',
      ].join('\n'),
    ];

    const map = parseSisAllocations(pages);
    expect(map.get('BDV-4003')?.sil).toBe(2);
  });
});
