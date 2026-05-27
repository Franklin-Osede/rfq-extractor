'use client';

/**
 * Day-1 PM smoke UI for the Loonar RFQ Assistant.
 *
 * Upload → POST /api/jobs → auto-fire POST /api/jobs/[id]/enrich →
 * re-fetch GET /api/jobs/[id] → render documents + requirements + tags
 * with compliance pills, expandable rationale, citation list.
 *
 * Day 2 layers: filter by compliance, side panel with PDF viewer, risk
 * panel for the 29 tag cross-doc mismatches, review actions (approve /
 * edit / mark deviation), export.
 */

import { Fragment, useEffect, useState } from 'react';

type DocOut = {
  id: string;
  filename: string;
  role: string;
  mimeType: string;
  sizeBytes: number;
  scanned: boolean;
  language: string;
  pageCount: number | null;
};

type Citation = {
  docId: string;
  page: number;
  snippet: string;
  verified: boolean;
};

type RequirementRow = {
  id: string;
  reqId: string;
  rfqSectionRef: string;
  description: string;
  difficulty: 'standard' | 'product-dependent' | 'hard' | null;
  suggestedCompliance: 'C' | 'D' | 'N/A' | 'Review' | null;
  suggestedComment: string | null;
  rationale: string | null;
  evidence: Citation[];
  reviewStatus: string;
  enrichedAt: string | null;
};

type TagRow = {
  id: string;
  tagNo: string;
  heliosServiceDescription: string;
  reviewStatus: string;
};

type FullJob = {
  job: { id: string; status: string };
  documents: DocOut[];
  requirements: RequirementRow[];
  tagRequirements: TagRow[];
};

type EnrichStats = {
  enriched: number;
  failed: number;
  byCompliance: Record<string, number>;
  citations: { total: number; verified: number };
};

type Phase = 'idle' | 'uploading' | 'enriching' | 'done' | 'failed';

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<FullJob | null>(null);
  const [enrichStats, setEnrichStats] = useState<EnrichStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Deep-link support: `?job=<uuid>` loads an existing job's state on mount.
  // Useful when the in-flight enrich fetch was cancelled (e.g. dev HMR
  // re-mount during a long sweep) so the user doesn't have to re-upload.
  useEffect(() => {
    const jobId = new URLSearchParams(window.location.search).get('job');
    if (!jobId) return;
    setPhase('uploading');
    fetch(`/api/jobs/${jobId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Job ${jobId} not found (HTTP ${r.status})`);
        const data = (await r.json()) as FullJob;
        setResult(data);
        setEnrichStats(computeStatsFromJob(data));
        setPhase('done');
      })
      .catch((e) => {
        setError(String(e));
        setPhase('failed');
      });
  }, []);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const incoming = e.target.files ? Array.from(e.target.files) : [];
    // Accumulate selections across multiple clicks; dedupe by name+size.
    setFiles((prev) => {
      const map = new Map<string, File>();
      for (const f of prev) map.set(`${f.name}:${f.size}`, f);
      for (const f of incoming) map.set(`${f.name}:${f.size}`, f);
      return Array.from(map.values());
    });
    // Reset the native input so picking the same file again still fires onChange.
    e.target.value = '';
    setResult(null);
    setEnrichStats(null);
    setError(null);
    setPhase('idle');
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function clearFiles() {
    setFiles([]);
    setResult(null);
    setEnrichStats(null);
    setError(null);
    setPhase('idle');
  }

  async function onUpload() {
    if (files.length === 0) return;
    setError(null);
    setPhase('uploading');
    try {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      const postRes = await fetch('/api/jobs', { method: 'POST', body: form });
      const postBody = await postRes.json();
      if (!postRes.ok) {
        setError(JSON.stringify(postBody, null, 2));
        setPhase('failed');
        return;
      }

      // Show the parsed-but-not-enriched state immediately so the user sees
      // progress while the LLM sweep runs.
      const getRes1 = await fetch(`/api/jobs/${postBody.jobId}`);
      const initialState = (await getRes1.json()) as FullJob;
      setResult(initialState);

      // If no TCM was in the upload, requirements is empty — skip the LLM
      // sweep entirely (no point enriching nothing, no banner-red error).
      if (initialState.requirements.length === 0) {
        setPhase('done');
        return;
      }

      // Fire enrichment (no progress events — we just wait, then re-fetch).
      setPhase('enriching');
      const enrichRes = await fetch(`/api/jobs/${postBody.jobId}/enrich`, {
        method: 'POST',
      });
      if (!enrichRes.ok) {
        setError(`Enrich failed: ${await enrichRes.text()}`);
        setPhase('failed');
        return;
      }
      setEnrichStats(await enrichRes.json());

      // Re-fetch full job state with enriched requirements.
      const getRes2 = await fetch(`/api/jobs/${postBody.jobId}`);
      setResult(await getRes2.json());
      setPhase('done');
    } catch (e) {
      setError(String(e));
      setPhase('failed');
    }
  }

  return (
    <main className="max-w-7xl mx-auto p-6 font-mono text-sm">
      <header className="mb-6 border-b pb-4">
        <h1 className="text-xl font-semibold">Loonar RFQ Assistant</h1>
        <p className="text-zinc-500 mt-1 text-xs">
          Drop the Helios RFQ package. The system classifies each file, parses
          the TCM template, indexes PDF text, and asks an LLM to suggest a
          compliance status + grounded citations per requirement.
        </p>
      </header>

      <section className="mb-8">
        <div className="border-2 border-dashed border-zinc-300 rounded p-6">
          <input
            type="file"
            multiple
            onChange={onPick}
            className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-black file:text-white hover:file:bg-zinc-800 cursor-pointer"
          />
          <p className="mt-2 text-[11px] text-zinc-500">
            Tip: pick files in multiple clicks to add more. Use the × next to a
            row to remove a single file.
          </p>
          {files.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-2 text-xs">
                <span className="text-zinc-600">
                  {files.length} file{files.length === 1 ? '' : 's'} selected
                </span>
                <button
                  onClick={clearFiles}
                  className="text-zinc-500 hover:text-zinc-900 underline"
                >
                  clear all
                </button>
              </div>
              <ul className="space-y-1 text-xs">
                {files.map((f, i) => (
                  <li
                    key={`${f.name}:${f.size}`}
                    className="flex items-center justify-between bg-zinc-50 rounded px-2 py-1"
                  >
                    <span className="text-zinc-700 truncate mr-3">
                      {f.name}{' '}
                      <span className="text-zinc-400">({humanSize(f.size)})</span>
                    </span>
                    <button
                      onClick={() => removeFile(i)}
                      className="text-red-600 hover:text-red-800 text-base leading-none px-1"
                      aria-label={`Remove ${f.name}`}
                      title="Remove"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <button
          onClick={onUpload}
          disabled={phase === 'uploading' || phase === 'enriching' || files.length === 0}
          className="mt-3 px-4 py-2 rounded bg-black text-white disabled:bg-zinc-400"
        >
          {phase === 'uploading'
            ? 'Uploading + parsing…'
            : phase === 'enriching'
              ? `Enriching ${result?.requirements.length ?? 0} requirements with LLM…`
              : 'Upload & process'}
        </button>
        {phase === 'done' && result && result.requirements.length === 0 && (
          <p className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded text-blue-900 text-xs">
            ℹ Upload successful, but no TCM template was detected in this
            batch. To run compliance enrichment, include the file
            <code className="mx-1 px-1 bg-blue-100 rounded">HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx</code>
            in the upload. You can add it now and re-process.
          </p>
        )}
        {error && (
          <pre className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-red-900 overflow-auto whitespace-pre-wrap">
            {error}
          </pre>
        )}
      </section>

      {phase === 'done' && result && <NoCorpusWarning data={result} stats={enrichStats} />}

      {enrichStats && phase === 'done' && <EnrichSummary stats={enrichStats} />}

      {phase === 'done' && result && result.requirements.length > 0 && (
        <ExportBar jobId={result.job.id} hasDeviations={result.requirements.some((r) => r.reviewStatus === 'deviation')} />
      )}

      {result && <ResultView data={result} phase={phase} />}
    </main>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

/**
 * Download bar for the vendor-facing outputs. The filled TCM is always
 * available once requirements are enriched. The DEV Register button only
 * shows when at least one requirement is marked as a deviation.
 */
function ExportBar({
  jobId,
  hasDeviations,
}: {
  jobId: string;
  hasDeviations: boolean;
}) {
  return (
    <div className="mb-8 p-4 bg-zinc-900 text-zinc-100 rounded flex items-center justify-between gap-4">
      <div className="text-xs">
        <div className="font-semibold text-sm mb-1">Vendor deliverables</div>
        <p className="text-zinc-300">
          Download the official Helios templates pre-filled with reviewed
          compliance + comments. Structure preserved per RFQ §8.2.
        </p>
      </div>
      <div className="flex gap-2 shrink-0">
        <a
          href={`/api/jobs/${jobId}/export/tcm`}
          download
          className="px-4 py-2 rounded bg-emerald-500 text-zinc-900 font-medium text-xs hover:bg-emerald-400"
        >
          ⬇ filled TCM.xlsx
        </a>
        <button
          disabled={!hasDeviations}
          className="px-4 py-2 rounded bg-zinc-700 text-zinc-300 font-medium text-xs disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-600"
          title={
            hasDeviations
              ? 'Download the Deviation/Exception Register'
              : 'No deviations marked yet — mark requirements as deviation to populate this file'
          }
        >
          ⬇ DEV Register.xlsx
        </button>
      </div>
    </div>
  );
}

/**
 * Surfaces when the TCM was parsed but the indexed corpus is empty (no PDFs
 * with usable text). In that case every requirement defaults to "Review"
 * because there is no evidence to cite from — the system being honest is
 * the headline trust mechanism, but the user needs to know WHY.
 */
function NoCorpusWarning({
  data,
  stats,
}: {
  data: FullJob;
  stats: EnrichStats | null;
}) {
  const hasReqs = data.requirements.length > 0;
  const hasIndexedPdf = data.documents.some(
    (d) => d.mimeType === 'application/pdf' && (d.pageCount ?? 0) > 0,
  );
  if (!hasReqs || hasIndexedPdf) return null;

  const reviewAll = stats?.byCompliance?.['Review'] ?? data.requirements.length;

  return (
    <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
      <div className="font-semibold mb-1">⚠ No evidence corpus indexed</div>
      <p>
        The TCM was parsed ({data.requirements.length} requirements loaded),
        but the upload had no PDFs to cite from — so all {reviewAll} requirements
        default to <strong>Review</strong>. This is the system being honest:
        without source documents to ground against, no confident compliance
        suggestion is shown.
      </p>
      <p className="mt-2">
        Add the source PDFs to enable evidence-backed enrichment:{' '}
        <code className="px-1 bg-amber-100 rounded">RFQ_HEL-PRO-…</code>,{' '}
        <code className="px-1 bg-amber-100 rounded">HEL-AZ2-IDS-INS-…</code>,{' '}
        <code className="px-1 bg-amber-100 rounded">HEL-GS-…</code> (specs).
        Then re-process.
      </p>
    </div>
  );
}

function EnrichSummary({ stats }: { stats: EnrichStats }) {
  const total = stats.enriched + stats.failed;
  const groundingRate =
    stats.citations.total > 0
      ? Math.round((100 * stats.citations.verified) / stats.citations.total)
      : 0;
  return (
    <div className="mb-8 p-4 bg-zinc-50 border border-zinc-200 rounded text-xs">
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <Stat label="Enriched" value={`${stats.enriched} / ${total}`} />
        <Stat
          label="Citations verified"
          value={`${stats.citations.verified} / ${stats.citations.total} (${groundingRate}%)`}
        />
        {Object.entries(stats.byCompliance).map(([k, v]) => (
          <Stat key={k} label={k} value={String(v)} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-zinc-500">{label}:</span>{' '}
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function ResultView({ data, phase }: { data: FullJob; phase: Phase }) {
  return (
    <div className="space-y-8">
      <Section title={`Documents (${data.documents.length})`}>
        <table className="w-full text-xs border rounded overflow-hidden">
          <thead className="bg-zinc-100">
            <tr>
              {['Filename', 'Role', 'Type', 'Size', 'Pages', 'Scanned', 'Lang'].map((h) => (
                <th key={h} className="text-left px-3 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.documents.map((d) => (
              <tr key={d.id} className="border-t hover:bg-zinc-50">
                <td className="px-3 py-2">{d.filename}</td>
                <td className="px-3 py-2 text-zinc-600">{d.role}</td>
                <td className="px-3 py-2 text-zinc-500">{d.mimeType.replace('application/', '')}</td>
                <td className="px-3 py-2 text-zinc-500 whitespace-nowrap">{humanSize(d.sizeBytes)}</td>
                <td className="px-3 py-2 text-zinc-500">{d.pageCount ?? '—'}</td>
                <td className="px-3 py-2">{d.scanned ? '⚠ yes' : 'no'}</td>
                <td className="px-3 py-2 text-zinc-500">{d.language}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={`Requirements (${data.requirements.length})`}>
        {data.requirements.length === 0 ? (
          <Note>No TCM template was detected in the upload, so no requirements were loaded.</Note>
        ) : (
          <RequirementsTable rows={data.requirements} phase={phase} />
        )}
      </Section>

      <Section title={`Tag-Level Confirmation (${data.tagRequirements.length})`}>
        {data.tagRequirements.length === 0 ? (
          <Note>No tags loaded — TCM Tag-Level Confirmation sheet was empty or missing.</Note>
        ) : (
          <table className="w-full text-xs border rounded overflow-hidden">
            <thead className="bg-zinc-100">
              <tr>
                {['Tag', 'Helios service description', 'Status'].map((h) => (
                  <th key={h} className="text-left px-3 py-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.tagRequirements.map((t) => (
                <tr key={t.id} className="border-t hover:bg-zinc-50">
                  <td className="px-3 py-2 font-medium">{t.tagNo}</td>
                  <td className="px-3 py-2">{t.heliosServiceDescription}</td>
                  <td className="px-3 py-2 text-zinc-500">{t.reviewStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function RequirementsTable({ rows, phase }: { rows: RequirementRow[]; phase: Phase }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="border rounded overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-zinc-100">
          <tr>
            <th className="text-left px-3 py-2 w-20">Req ID</th>
            <th className="text-left px-3 py-2 w-16">Section</th>
            <th className="text-left px-3 py-2">Description</th>
            <th className="text-left px-3 py-2 w-32">Suggested</th>
            <th className="text-left px-3 py-2 w-24">Citations</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isExpanded = expanded.has(r.id);
            const verifiedCount = r.evidence.filter((e) => e.verified).length;
            return (
              <Fragment key={r.id}>
                <tr
                  className="border-t hover:bg-zinc-50 cursor-pointer"
                  onClick={() => toggle(r.id)}
                >
                  <td className="px-3 py-2 font-medium align-top">{r.reqId}</td>
                  <td className="px-3 py-2 text-zinc-500 align-top">{r.rfqSectionRef}</td>
                  <td className="px-3 py-2 align-top">{r.description}</td>
                  <td className="px-3 py-2 align-top">
                    <CompliancePill value={r.suggestedCompliance} phase={phase} />
                  </td>
                  <td className="px-3 py-2 align-top text-zinc-600">
                    {r.evidence.length === 0 ? (
                      phase === 'enriching' ? <span className="text-zinc-400">…</span> : '—'
                    ) : (
                      <span>
                        <span className={verifiedCount === r.evidence.length ? 'text-green-700' : 'text-amber-700'}>
                          {verifiedCount}/{r.evidence.length}
                        </span>
                        <span className="text-zinc-400 ml-1">{isExpanded ? '▴' : '▾'}</span>
                      </span>
                    )}
                  </td>
                </tr>
                {isExpanded && (r.rationale || r.evidence.length > 0 || r.suggestedComment) && (
                  <tr className="bg-zinc-50">
                    <td colSpan={5} className="px-3 py-3 border-t border-zinc-200">
                      <ExpandedDetail row={r} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExpandedDetail({ row }: { row: RequirementRow }) {
  return (
    <div className="space-y-3 text-xs">
      {row.rationale && (
        <Field label="Rationale">
          <p className="text-zinc-700">{row.rationale}</p>
        </Field>
      )}
      {row.suggestedComment && (
        <Field label="Suggested vendor comment">
          <p className="text-zinc-700 italic">&ldquo;{row.suggestedComment}&rdquo;</p>
        </Field>
      )}
      {row.evidence.length > 0 && (
        <Field label="Citations">
          <ul className="space-y-2">
            {row.evidence.map((c, i) => (
              <li key={i} className="border-l-2 border-zinc-300 pl-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className={c.verified ? 'text-green-700' : 'text-red-700'}>
                    {c.verified ? '✓ verified' : '✗ unverified'}
                  </span>
                  <span className="text-zinc-500">
                    docId: <code>{c.docId.slice(0, 12)}</code> · page {c.page}
                  </span>
                </div>
                <blockquote className="text-zinc-700">&ldquo;{c.snippet}&rdquo;</blockquote>
              </li>
            ))}
          </ul>
        </Field>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-zinc-500 text-[10px] uppercase tracking-wide mb-1">{label}</div>
      {children}
    </div>
  );
}

function CompliancePill({
  value,
  phase,
}: {
  value: RequirementRow['suggestedCompliance'];
  phase: Phase;
}) {
  if (value === null) {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-[11px] bg-zinc-200 text-zinc-600">
        {phase === 'enriching' ? 'enriching…' : 'pending'}
      </span>
    );
  }
  const styles: Record<string, string> = {
    C: 'bg-green-100 text-green-800 border-green-300',
    D: 'bg-amber-100 text-amber-800 border-amber-300',
    'N/A': 'bg-zinc-100 text-zinc-700 border-zinc-300',
    Review: 'bg-orange-100 text-orange-800 border-orange-300',
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[11px] border font-medium ${styles[value] ?? 'bg-zinc-100'}`}
    >
      {value}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold mb-2">{title}</h2>
      {children}
    </section>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-zinc-500 italic p-3 bg-zinc-50 rounded">{children}</p>;
}

/** Compute enrich-stats from a hydrated FullJob (for the deep-link path). */
function computeStatsFromJob(data: FullJob): EnrichStats {
  const byCompliance: Record<string, number> = {};
  let enriched = 0;
  let total = 0;
  let verified = 0;
  for (const r of data.requirements) {
    if (r.suggestedCompliance) {
      enriched++;
      byCompliance[r.suggestedCompliance] =
        (byCompliance[r.suggestedCompliance] ?? 0) + 1;
    }
    total += r.evidence.length;
    verified += r.evidence.filter((e) => e.verified).length;
  }
  return {
    enriched,
    failed: data.requirements.length - enriched,
    byCompliance,
    citations: { total, verified },
  };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
