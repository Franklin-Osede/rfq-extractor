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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  clearRecentJobs,
  loadRecentJobs,
  removeRecentJob,
  saveRecentJob,
  type RecentJob,
} from '@/lib/recent-jobs';

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
  // Vendor-confirmed fields (post-review actions).
  vendorCompliance: 'C' | 'D' | 'N/A' | 'Review' | null;
  vendorComment: string | null;
  deviationRef: string | null;
  reviewStatus: string;
  enrichedAt: string | null;
};

type TagRow = {
  id: string;
  tagNo: string;
  heliosServiceDescription: string;
  reviewStatus: string;
};

type RiskSource = {
  source: 'tcm' | 'ids' | 'pid_register' | 'sis_spec' | 'rfq_master';
  text: string;
  citation: Citation;
};

type RiskRow = {
  id: string;
  tagNo: string;
  scope: string;
  severity: 'high' | 'medium' | 'low';
  reason: string;
  sources: RiskSource[];
};

type FullJob = {
  job: {
    id: string;
    status: string;
    /** Persisted by /risks; null until the sweep has run at least once. */
    riskRunSummary: RiskStats | null;
  };
  documents: DocOut[];
  requirements: RequirementRow[];
  tagRequirements: TagRow[];
  risks: RiskRow[];
};

type LlmTelemetry = {
  provider: string | null;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
};

type EnrichStats = {
  enriched: number;
  failed: number;
  byCompliance: Record<string, number>;
  citations: { total: number; verified: number };
  llm?: LlmTelemetry;
};

type RiskStats = {
  tagsAnalysed: number;
  risksDetected: number;
  failed: number;
  errors: Array<{ tagNo: string; error: string }>;
  bySeverity: Record<string, number>;
  sis?: {
    sisTableFound: boolean;
    sisTagsAllocated: number;
    hardMismatches: number;
    tcmSilent: number;
    aligned: number;
    notInSis: number;
  };
  llm?: LlmTelemetry;
};

type Phase = 'idle' | 'uploading' | 'enriching' | 'done' | 'failed';

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  // Initial phase via lazy initializer: if the URL carries ?job=<uuid> we
  // start in 'uploading' so the first render already shows the loading
  // state. Setting it inside the deep-link useEffect would trigger a
  // cascading render (react-hooks/set-state-in-effect) — we avoid that.
  const [phase, setPhase] = useState<Phase>(() => {
    if (typeof window === 'undefined') return 'idle';
    return new URLSearchParams(window.location.search).has('job')
      ? 'uploading'
      : 'idle';
  });
  const [result, setResult] = useState<FullJob | null>(null);
  const [enrichStats, setEnrichStats] = useState<EnrichStats | null>(null);
  const [riskStats, setRiskStats] = useState<RiskStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lazy initializer reads localStorage on first render to avoid a
  // cascading setState in useEffect (react-hooks/set-state-in-effect).
  // The SSR pass returns [] because window is undefined; client-side
  // hydration then sees the persisted list.
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>(() =>
    loadRecentJobs(),
  );

  // Deep-link support: `?job=<uuid>` loads an existing job's state on mount.
  // Useful when the in-flight enrich fetch was cancelled (e.g. dev HMR
  // re-mount during a long sweep) so the user doesn't have to re-upload.
  useEffect(() => {
    const jobId = new URLSearchParams(window.location.search).get('job');
    if (!jobId) return;
    fetch(`/api/jobs/${jobId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Job ${jobId} not found (HTTP ${r.status})`);
        const data = (await r.json()) as FullJob;
        setResult(data);
        setEnrichStats(computeStatsFromJob(data));
        // Restore the partial-failure warning on reload. Without this,
        // a job where /risks had errors would look "clean" on deep-link.
        if (data.job.riskRunSummary) setRiskStats(data.job.riskRunSummary);
        setPhase('done');
        // Refresh the localStorage entry — opening a job counts as "seen".
        setRecentJobs(
          saveRecentJob({
            jobId: data.job.id,
            savedAt: new Date().toISOString(),
            status: data.job.status,
            docCount: data.documents.length,
            reqCount: data.requirements.length,
            tagCount: data.tagRequirements.length,
            riskCount: data.risks.length,
            failedCount: data.job.riskRunSummary?.failed ?? 0,
          }),
        );
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

  /**
   * Merge a freshly updated requirement (from PATCH /api/requirements/[id])
   * back into the result, recompute the stats panel. Optimistic UI: the
   * row reflects the change immediately, no re-fetch round-trip.
   */
  function handleRequirementUpdated(updated: RequirementRow) {
    setResult((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        requirements: prev.requirements.map((r) =>
          r.id === updated.id ? updated : r,
        ),
      };
      setEnrichStats(computeStatsFromJob(next));
      return next;
    });
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

      // Then fire cross-doc risk detection (29 tags × 1 LLM call each).
      // This is much faster than enrich but still ~10-20 seconds. The
      // endpoint returns `{ failed, errors, ... }` even on 200 OK — we
      // capture both so a partial sweep (some tags failed individually)
      // is visible to the user, not silently swallowed.
      if (initialState.tagRequirements.length > 0) {
        const riskRes = await fetch(`/api/jobs/${postBody.jobId}/risks`, {
          method: 'POST',
        });
        if (riskRes.ok) {
          setRiskStats((await riskRes.json()) as RiskStats);
        } else {
          // Non-200 from /risks is non-fatal — the job still has enrichment
          // results. Surface the warning but don't fail the whole flow.
          setRiskStats({
            tagsAnalysed: 0,
            risksDetected: 0,
            failed: initialState.tagRequirements.length,
            errors: [{ tagNo: '*', error: `risk endpoint HTTP ${riskRes.status}` }],
            bySeverity: {},
          });
        }
      }

      // Re-fetch full job state with enriched requirements + risk signals.
      const getRes2 = await fetch(`/api/jobs/${postBody.jobId}`);
      const finalState = (await getRes2.json()) as FullJob;
      setResult(finalState);
      setPhase('done');

      // Persist to localStorage so the user can resume without re-upload.
      setRecentJobs(
        saveRecentJob({
          jobId: finalState.job.id,
          savedAt: new Date().toISOString(),
          status: finalState.job.status,
          docCount: finalState.documents.length,
          reqCount: finalState.requirements.length,
          tagCount: finalState.tagRequirements.length,
          riskCount: finalState.risks.length,
          failedCount: finalState.job.riskRunSummary?.failed ?? 0,
        }),
      );
    } catch (e) {
      setError(String(e));
      setPhase('failed');
    }
  }

  // Status bar only renders when the page has something meaningful to
  // report (a job in flight, or completed, or failed). In pure idle we
  // hide it entirely — "Idle" as a status is visual noise.
  const phaseLabel =
    phase === 'uploading'
      ? 'Uploading + parsing…'
      : phase === 'enriching'
        ? `Enriching ${result?.requirements.length ?? 0} requirements…`
        : phase === 'failed'
          ? 'Failed'
          : phase === 'done'
            ? 'Done'
            : null;

  // Adaptive layout: when there's no work in flight and nothing to
  // show, render a centred single-column "landing" with the upload as
  // hero. Once a job exists (uploading / enriching / done / failed),
  // switch to the two-column sidebar layout that's useful for
  // navigating between runs.
  const showSidebar = phase !== 'idle' || result !== null;

  return (
    <main className="max-w-[1400px] mx-auto p-6 font-mono text-sm">
      <header className="mb-6 border-b pb-3 flex items-baseline justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold">Loonar RFQ Assistant</h1>
          <p className="text-zinc-500 mt-1 text-xs">
            Pre-fill the official Helios TCM with evidence-cited compliance
            suggestions and cross-document risk signals.
          </p>
        </div>
        {phaseLabel && (
          <StatusBar
            phase={phase}
            phaseLabel={phaseLabel}
            stats={enrichStats}
            riskStats={riskStats}
          />
        )}
      </header>

      {showSidebar ? (
        // ─── Active layout: sidebar (upload + recent jobs) + results ───
        <div className="grid grid-cols-12 gap-6">
          <div className="col-span-12 lg:col-span-4 space-y-4">
            <UploadSection
              files={files}
              phase={phase}
              hero={false}
              onPick={onPick}
              onUpload={onUpload}
              onClearFiles={clearFiles}
              onRemoveFile={removeFile}
              noTcmHint={
                phase === 'done' && result?.requirements.length === 0
              }
              error={error}
            />
            <RecentJobsPanel
              jobs={recentJobs}
              onRemove={(id) => setRecentJobs(removeRecentJob(id))}
              onClear={() => setRecentJobs(clearRecentJobs())}
            />
          </div>

          <div className="col-span-12 lg:col-span-8 space-y-4">
            {phase === 'done' && result && (
              <NoCorpusWarning data={result} stats={enrichStats} />
            )}
            {phase === 'done' && riskStats && riskStats.failed > 0 && (
              <PartialRiskWarning stats={riskStats} />
            )}
            {phase === 'done' &&
              result &&
              result.risks &&
              result.risks.length > 0 && <RiskPanel risks={result.risks} />}
            {enrichStats && phase === 'done' && (
              <EnrichSummary stats={enrichStats} riskStats={riskStats} />
            )}
            {phase === 'done' &&
              result &&
              result.requirements.length > 0 && (
                <ExportBar
                  jobId={result.job.id}
                  hasDeviations={result.requirements.some(
                    (r) => r.reviewStatus === 'deviation',
                  )}
                />
              )}
            {result && (
              <ResultView
                data={result}
                phase={phase}
                onRowUpdated={handleRequirementUpdated}
              />
            )}
          </div>
        </div>
      ) : (
        // ─── Idle layout: hero upload, recent jobs + info cards below ───
        <div className="max-w-3xl mx-auto space-y-8">
          <UploadSection
            files={files}
            phase={phase}
            hero={true}
            onPick={onPick}
            onUpload={onUpload}
            onClearFiles={clearFiles}
            onRemoveFile={removeFile}
            noTcmHint={false}
            error={error}
          />
          {recentJobs.length > 0 && (
            <RecentJobsPanel
              jobs={recentJobs}
              onRemove={(id) => setRecentJobs(removeRecentJob(id))}
              onClear={() => setRecentJobs(clearRecentJobs())}
            />
          )}
          <IdleWelcome />
        </div>
      )}
    </main>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

/**
 * Upload zone — same logic in both layouts, two visual variants:
 *   - `hero=true` (idle): big centered drop area, bigger button.
 *   - `hero=false` (sidebar): compact panel.
 */
function UploadSection({
  files,
  phase,
  hero,
  onPick,
  onUpload,
  onClearFiles,
  onRemoveFile,
  noTcmHint,
  error,
}: {
  files: File[];
  phase: Phase;
  hero: boolean;
  onPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onUpload: () => void;
  onClearFiles: () => void;
  onRemoveFile: (i: number) => void;
  noTcmHint: boolean;
  error: string | null;
}) {
  const dropPadding = hero ? 'p-10' : 'p-4';
  const inputText = hero ? 'text-sm' : 'text-xs';
  const buttonText = hero ? 'text-sm py-3' : 'text-xs py-2';
  const fileItemText = hero ? 'text-xs' : 'text-[11px]';
  return (
    <section>
      {hero && (
        <div className="mb-4 text-center">
          <h2 className="text-base font-semibold text-zinc-800">
            Drop the Helios RFQ package
          </h2>
          <p className="text-xs text-zinc-500 mt-1">
            13 binding documents + 1 noise PDF, processed in ~120 seconds.
          </p>
        </div>
      )}
      <div
        className={`border-2 border-dashed border-zinc-300 rounded ${dropPadding} bg-white`}
      >
        <input
          type="file"
          multiple
          onChange={onPick}
          className={`block w-full ${inputText} file:mr-3 file:py-2 file:px-4 file:rounded file:border-0 file:bg-black file:text-white hover:file:bg-zinc-800 cursor-pointer`}
        />
        <p className={`mt-2 ${hero ? 'text-xs' : 'text-[10px]'} text-zinc-500`}>
          Pick files across multiple clicks; × to remove one.
        </p>
        {files.length > 0 && (
          <div className="mt-3">
            <div className={`flex items-center justify-between mb-1 ${fileItemText}`}>
              <span className="text-zinc-600">
                {files.length} file{files.length === 1 ? '' : 's'} selected
              </span>
              <button
                onClick={onClearFiles}
                className="text-zinc-500 hover:text-zinc-900 underline"
              >
                clear all
              </button>
            </div>
            <ul className={`space-y-0.5 ${fileItemText}`}>
              {files.map((f, i) => (
                <li
                  key={`${f.name}:${f.size}`}
                  className="flex items-center justify-between bg-zinc-50 rounded px-2 py-0.5"
                >
                  <span className="text-zinc-700 truncate mr-2">
                    {f.name}{' '}
                    <span className="text-zinc-400">({humanSize(f.size)})</span>
                  </span>
                  <button
                    onClick={() => onRemoveFile(i)}
                    className="text-red-600 hover:text-red-800 text-sm leading-none px-0.5"
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
        disabled={
          phase === 'uploading' || phase === 'enriching' || files.length === 0
        }
        className={`mt-3 w-full px-4 rounded bg-black text-white disabled:bg-zinc-400 ${buttonText}`}
      >
        {phase === 'uploading'
          ? 'Uploading…'
          : phase === 'enriching'
            ? 'Enriching…'
            : 'Upload & process'}
      </button>
      {noTcmHint && (
        <p className="mt-3 p-2 bg-blue-50 border border-blue-200 rounded text-blue-900 text-[11px]">
          ℹ No TCM template detected. Include
          <code className="mx-1 px-1 bg-blue-100 rounded">
            HEL-AZ2-TCM-Template_RFQ-CV-0412.xlsx
          </code>
          in the upload to enable enrichment.
        </p>
      )}
      {error && (
        <pre className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-red-900 overflow-auto whitespace-pre-wrap text-[11px]">
          {error}
        </pre>
      )}
    </section>
  );
}

/**
 * Idle-state right column. Replaces the empty wireframe with information
 * the demo viewer can scan in under 15 seconds: what the pipeline does,
 * what the cross-document risk panel cross-checks, and what a typical
 * run looks like on cost/latency. No marketing — every number here is
 * one we can defend with the dry-run output.
 */
function IdleWelcome() {
  const stages = [
    { n: 1, title: 'Classify', body: 'filename + magic-byte sniffing identifies TCM / IDS / spec / RFQ / etc.' },
    { n: 2, title: 'Parse', body: 'TCM .xlsx → 108 requirements + 29 tag-level rows; PDFs → page-indexed chunks.' },
    { n: 3, title: 'Enrich', body: 'one LLM call per requirement; deterministic snippet validator drops ungrounded citations.' },
    { n: 4, title: 'Cross-check', body: 'tags scored against IDS (LLM) and SIS allocation table (deterministic regex).' },
    { n: 5, title: 'Export', body: 'fills the original Helios TCM .xlsx + populates the DEV Register template.' },
  ];
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-zinc-800 mb-3">Pipeline</h2>
        <ol className="space-y-2.5">
          {stages.map((s) => (
            <li key={s.n} className="flex gap-3 text-xs">
              <span className="shrink-0 w-5 h-5 rounded-full bg-zinc-900 text-white text-[10px] flex items-center justify-center font-semibold">
                {s.n}
              </span>
              <div>
                <span className="font-semibold text-zinc-800">{s.title}</span>
                <span className="text-zinc-600"> — {s.body}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-zinc-800 mb-2">
            Cross-document risk detection
          </h2>
          <p className="text-xs text-zinc-600 mb-3">
            Two independent evidence sources per tag, two different strategies:
          </p>
          <ul className="space-y-2 text-xs">
            <li className="flex gap-2">
              <Badge variant="outline" className="text-[9px] uppercase tracking-wide shrink-0">
                IDS
              </Badge>
              <span className="text-zinc-700">
                LLM extracts the IDS service description; validator confirms
                the snippet appears in the cited page before surfacing the
                mismatch.
              </span>
            </li>
            <li className="flex gap-2">
              <Badge variant="outline" className="text-[9px] uppercase tracking-wide shrink-0">
                SIS
              </Badge>
              <span className="text-zinc-700">
                Deterministic parser reads the SIL allocation table on page 4,
                expands paired (A/B) and range (7001 to 7006) notations,
                integer-compares against the TCM SIL.
              </span>
            </li>
          </ul>
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-zinc-800 mb-2">
            A typical run
          </h2>
          <p className="text-xs text-zinc-600 mb-3">
            Numbers from the dry-run against the 14-file Helios package
            (gpt-4o-mini, tier 1):
          </p>
          <dl className="space-y-1.5 text-xs">
            <Row label="Wall time" value="~120s (enrich 117s · risks 8s)" />
            <Row label="LLM cost" value="~$0.08 per job" />
            <Row label="Requirements enriched" value="108 / 108" />
            <Row label="Citation grounding" value="~76% verified" />
            <Row label="HIGH risk signals" value="22 (12 IDS + 10 SIS)" />
          </dl>
        </section>
      </div>

      <p className="text-[11px] text-zinc-500 text-center px-4">
        Drop the package on the left to kick off a fresh run, or open a
        previous job from <strong className="text-zinc-700">Recent jobs</strong>.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-zinc-100 pb-1 last:border-0">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="font-medium text-zinc-800">{value}</dd>
    </div>
  );
}

/**
 * Compact status bar shown in the header. Renders one of three modes:
 *   - phase indicator dot + label while uploading / enriching / failed
 *   - LLM cost + latency telemetry once enrichment has run at least once
 *   - risk severity counts once the risk sweep has run
 */
function StatusBar({
  phase,
  phaseLabel,
  stats,
  riskStats,
}: {
  phase: Phase;
  phaseLabel: string;
  stats: EnrichStats | null;
  riskStats: RiskStats | null;
}) {
  const enrichLlm = stats?.llm;
  const risksLlm = riskStats?.llm;
  const totalCost = (enrichLlm?.costUsd ?? 0) + (risksLlm?.costUsd ?? 0);
  const totalCalls = (enrichLlm?.calls ?? 0) + (risksLlm?.calls ?? 0);

  const phaseColor =
    phase === 'failed'
      ? 'bg-red-500'
      : phase === 'done'
        ? 'bg-emerald-500'
        : phase === 'idle'
          ? 'bg-zinc-300'
          : 'bg-amber-500 animate-pulse';

  return (
    <div className="flex items-center gap-4 text-[11px] text-zinc-600">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block w-2 h-2 rounded-full ${phaseColor}`} />
        <span>{phaseLabel}</span>
      </div>
      {totalCalls > 0 && (
        <>
          <span className="text-zinc-300">·</span>
          <span>
            <strong>{totalCalls}</strong> LLM calls
          </span>
          <span className="text-zinc-300">·</span>
          <span>
            <strong>${totalCost.toFixed(4)}</strong>
          </span>
        </>
      )}
      {riskStats && (
        <>
          <span className="text-zinc-300">·</span>
          <span className="text-rose-700">
            <strong>{riskStats.bySeverity?.high ?? 0}</strong> high
          </span>
          {(riskStats.bySeverity?.medium ?? 0) > 0 && (
            <span className="text-amber-700">
              <strong>{riskStats.bySeverity.medium}</strong> med
            </span>
          )}
          {(riskStats.bySeverity?.low ?? 0) > 0 && (
            <span className="text-zinc-500">
              <strong>{riskStats.bySeverity.low}</strong> low
            </span>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Local-only "recent jobs" panel. Reads/writes localStorage; lets the
 * user resume any previously-seen run by deep-link without re-uploading
 * the 14-doc package. No backend involvement — server remains the source
 * of truth for actual job data.
 */
function RecentJobsPanel({
  jobs,
  onRemove,
  onClear,
}: {
  jobs: RecentJob[];
  onRemove: (jobId: string) => void;
  onClear: () => void;
}) {
  if (jobs.length === 0) {
    return (
      <aside className="rounded border border-zinc-200 bg-zinc-50/40 p-3 text-xs">
        <div className="font-semibold text-zinc-700 mb-1">Recent jobs</div>
        <p className="text-zinc-500">
          Your uploads will appear here for one-click resume.
        </p>
      </aside>
    );
  }
  return (
    <aside className="rounded border border-zinc-200 bg-zinc-50/40 p-3 text-xs">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-zinc-700">
          Recent jobs ({jobs.length})
        </div>
        <button
          onClick={onClear}
          className="text-[10px] text-zinc-500 hover:text-zinc-900 underline"
          title="Remove every entry from localStorage. The server-side jobs are untouched."
        >
          clear all
        </button>
      </div>
      <ul className="space-y-1.5">
        {jobs.map((j) => (
          <li
            key={j.jobId}
            className="rounded border border-zinc-200 bg-white px-2 py-1.5 hover:border-zinc-300"
          >
            <div className="flex items-center justify-between gap-2">
              <a
                href={`/?job=${j.jobId}`}
                className="font-mono text-[11px] text-zinc-800 hover:underline truncate"
                title={j.jobId}
              >
                {j.jobId.slice(0, 8)}…
              </a>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(
                      `${window.location.origin}/?job=${j.jobId}`,
                    );
                  }}
                  className="text-[10px] text-zinc-500 hover:text-zinc-900"
                  title="Copy deep-link to clipboard"
                >
                  copy
                </button>
                <button
                  onClick={() => onRemove(j.jobId)}
                  className="text-red-600 hover:text-red-800 text-sm leading-none"
                  aria-label={`Remove ${j.jobId}`}
                  title="Remove from this list"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-500">
              <span>
                R: <strong className="text-zinc-700">{j.reqCount}</strong>
              </span>
              <span>
                T: <strong className="text-zinc-700">{j.tagCount}</strong>
              </span>
              <span>
                Risks: <strong className="text-zinc-700">{j.riskCount}</strong>
              </span>
              {j.failedCount > 0 && (
                <span className="text-amber-700">
                  ⚠ {j.failedCount} failed
                </span>
              )}
              <span className="text-zinc-400">{relativeTime(j.savedAt)}</span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const delta = Math.max(0, Date.now() - then);
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * Visible banner when the /risks endpoint reported per-tag failures. The
 * default flow proceeds even with partial failures (some tags missing is
 * better than no risks at all), but the user must see which tags didn't
 * get analysed so they don't assume "no signal = no risk".
 */
function PartialRiskWarning({ stats }: { stats: RiskStats }) {
  const sample = stats.errors.slice(0, 5).map((e) => e.tagNo).join(', ');
  const overflow = stats.errors.length > 5 ? `, +${stats.errors.length - 5} more` : '';
  return (
    <Alert className="border-amber-300 bg-amber-50 text-amber-900">
      <AlertTitle className="text-amber-900">
        ⚠ Partial risk sweep — {stats.failed} of {stats.tagsAnalysed} tag analyses failed
      </AlertTitle>
      <AlertDescription className="text-amber-900/90">
        Affected: {sample}{overflow}. The panel below covers{' '}
        {stats.risksDetected} signals from the tags that succeeded.
      </AlertDescription>
    </Alert>
  );
}

/**
 * Cross-document review-risk panel. Rendered FIRST in the demo flow:
 * "before autofilling the TCM, the system cross-checks the response
 * template against the technical evidence. It found N tag-level review
 * risks where binding documents disagree."
 *
 * Each row collapses to severity + tag + one-line reason. Click to expand
 * the TCM vs IDS side-by-side comparison with literal citations from
 * each source — no opinions, just surfaced evidence.
 */
function RiskPanel({ risks }: { risks: RiskRow[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Default filter set: high-only on first render. The 14 low-severity
  // SIS reminders make the panel noisy in demo; users opt in via toggle.
  const [sevFilter, setSevFilter] = useState<Set<'high' | 'medium' | 'low'>>(
    new Set(['high']),
  );
  const [scopeFilter, setScopeFilter] = useState<Set<string>>(new Set());

  const counts = risks.reduce<Record<string, number>>((acc, r) => {
    acc[r.severity] = (acc[r.severity] ?? 0) + 1;
    return acc;
  }, {});
  const scopeCounts = risks.reduce<Record<string, number>>((acc, r) => {
    acc[r.scope] = (acc[r.scope] ?? 0) + 1;
    return acc;
  }, {});

  const filtered = risks.filter((r) => {
    if (!sevFilter.has(r.severity)) return false;
    if (scopeFilter.size > 0 && !scopeFilter.has(r.scope)) return false;
    return true;
  });
  const sorted = [...filtered].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.severity] - order[b.severity] || a.tagNo.localeCompare(b.tagNo);
  });

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSev(sev: 'high' | 'medium' | 'low') {
    setSevFilter((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return next;
    });
  }

  function toggleScope(scope: string) {
    setScopeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  return (
    <section className="mb-4 border-2 border-rose-300 rounded overflow-hidden bg-white">
      <header className="px-4 py-3 bg-rose-50 border-b border-rose-200">
        <h2 className="text-sm font-semibold text-rose-900">
          ⚠ Cross-document review risks ({sorted.length}
          {filtered.length !== risks.length ? ` of ${risks.length}` : ''})
        </h2>
        <p className="text-[11px] text-rose-800 mt-1">
          Tag-level mismatches across binding documents (TCM vs IDS, TCM vs
          SIS). Filter to focus.
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-2 text-[10px]">
          <span className="text-zinc-500 uppercase tracking-wide mr-1">
            Severity:
          </span>
          {(['high', 'medium', 'low'] as const).map((sev) => {
            const active = sevFilter.has(sev);
            const c = counts[sev] ?? 0;
            if (c === 0) return null;
            return (
              <button
                key={sev}
                onClick={() => toggleSev(sev)}
                className={`px-2 py-0.5 rounded border uppercase tracking-wide font-medium ${
                  active
                    ? sev === 'high'
                      ? 'bg-rose-100 text-rose-800 border-rose-300'
                      : sev === 'medium'
                        ? 'bg-amber-100 text-amber-800 border-amber-300'
                        : 'bg-zinc-100 text-zinc-700 border-zinc-300'
                    : 'bg-white text-zinc-400 border-zinc-200 hover:border-zinc-400'
                }`}
              >
                {sev} ({c})
              </button>
            );
          })}
          <span className="text-zinc-300 mx-1">|</span>
          <span className="text-zinc-500 uppercase tracking-wide mr-1">
            Scope:
          </span>
          {Object.entries(scopeCounts).map(([scope, c]) => {
            const active = scopeFilter.has(scope);
            const label =
              scope === 'tag-sil-classification'
                ? 'SIL'
                : scope === 'tag-service-description'
                  ? 'service'
                  : scope;
            return (
              <button
                key={scope}
                onClick={() => toggleScope(scope)}
                className={`px-2 py-0.5 rounded border uppercase tracking-wide font-medium ${
                  active
                    ? 'bg-zinc-800 text-white border-zinc-800'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-400'
                }`}
              >
                {label} ({c})
              </button>
            );
          })}
          {(scopeFilter.size > 0 || sevFilter.size !== 1 || !sevFilter.has('high')) && (
            <button
              onClick={() => {
                setSevFilter(new Set(['high']));
                setScopeFilter(new Set());
              }}
              className="text-[10px] text-zinc-500 hover:text-zinc-900 underline ml-1"
            >
              reset
            </button>
          )}
        </div>
      </header>
      <ul className="divide-y divide-rose-100">
        {sorted.map((r) => {
          const isExpanded = expanded.has(r.id);
          const tcmSource = r.sources.find((s) => s.source === 'tcm');
          // Everything that isn't TCM is "evidence" — render in a stacked
          // column on the right. The scope field tells the demo viewer
          // whether the mismatch is a service-description disagreement
          // (IDS-driven) or a SIL allocation disagreement (SIS-driven).
          const evidenceSources = r.sources.filter((s) => s.source !== 'tcm');
          return (
            <li key={r.id}>
              <button
                onClick={() => toggle(r.id)}
                className="w-full text-left px-4 py-2 hover:bg-rose-50 flex items-center gap-3"
              >
                <SeverityPill severity={r.severity} />
                <span className="font-medium text-xs w-24 shrink-0">{r.tagNo}</span>
                <ScopeChip scope={r.scope} />
                <span className="text-xs text-zinc-700 flex-1">{r.reason}</span>
                <span className="text-zinc-400 text-xs">{isExpanded ? '▴' : '▾'}</span>
              </button>
              {isExpanded && (
                <div className="px-4 py-3 bg-rose-50/50 grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                      TCM Tag-Level Confirmation
                    </div>
                    <blockquote className="text-zinc-800 border-l-2 border-zinc-400 pl-2">
                      &ldquo;{tcmSource?.text ?? '(not provided)'}&rdquo;
                    </blockquote>
                    {tcmSource && (
                      <p className="text-[10px] text-zinc-500 mt-1">
                        Source: TCM column B, row matching {r.tagNo}
                      </p>
                    )}
                  </div>
                  <div className="space-y-3">
                    {evidenceSources.length === 0 && (
                      <blockquote className="text-zinc-500 italic text-xs">
                        (no evidence-side source recorded for this signal)
                      </blockquote>
                    )}
                    {evidenceSources.map((s, i) => (
                      <div key={`${s.source}-${i}`}>
                        <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                          {sourceLabel(s.source)}
                        </div>
                        <blockquote className="text-zinc-800 border-l-2 border-rose-400 pl-2">
                          &ldquo;{s.text || '(not located)'}&rdquo;
                        </blockquote>
                        {s.citation && (
                          <p className="text-[10px] text-zinc-500 mt-1">
                            Source: {sourceLabel(s.source)} page {s.citation.page}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'tcm':
      return 'TCM Tag-Level Confirmation';
    case 'ids':
      return 'IDS Attachment A';
    case 'sis_spec':
      return 'SIS / SIL Equipment Spec';
    case 'pid_register':
      return 'P&ID Drawing Register';
    case 'rfq_master':
      return 'Master RFQ';
    default:
      return source;
  }
}

function ScopeChip({ scope }: { scope: string }) {
  const label =
    scope === 'tag-sil-classification'
      ? 'SIL'
      : scope === 'tag-service-description'
        ? 'service'
        : scope;
  return (
    <Badge
      variant="outline"
      className="text-[9px] uppercase tracking-wide text-zinc-600"
    >
      {label}
    </Badge>
  );
}

function SeverityPill({ severity }: { severity: 'high' | 'medium' | 'low' }) {
  // Backed by shadcn Badge; per-severity colours stay tied to the domain
  // (rose = blocker, amber = caution, zinc = informational reminder).
  const tone = {
    high: 'bg-rose-100 text-rose-800 border-rose-300',
    medium: 'bg-amber-100 text-amber-800 border-amber-300',
    low: 'bg-zinc-100 text-zinc-700 border-zinc-300',
  }[severity];
  return (
    <Badge
      variant="outline"
      className={`uppercase tracking-wide font-medium ${tone}`}
    >
      {severity}
    </Badge>
  );
}

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
        {hasDeviations ? (
          <a
            href={`/api/jobs/${jobId}/export/dev-register`}
            download
            className="px-4 py-2 rounded bg-amber-400 text-zinc-900 font-medium text-xs hover:bg-amber-300"
            title="Download the populated Deviation/Exception Register"
          >
            ⬇ DEV Register.xlsx
          </a>
        ) : (
          <span
            className="px-4 py-2 rounded bg-zinc-700 text-zinc-400 font-medium text-xs opacity-50 cursor-not-allowed"
            title="No deviations marked yet — mark requirements as deviation to populate this file"
          >
            ⬇ DEV Register.xlsx
          </span>
        )}
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

function EnrichSummary({
  stats,
  riskStats,
}: {
  stats: EnrichStats;
  riskStats: RiskStats | null;
}) {
  const total = stats.enriched + stats.failed;
  const groundingRate =
    stats.citations.total > 0
      ? Math.round((100 * stats.citations.verified) / stats.citations.total)
      : 0;

  // Aggregate LLM telemetry across both sweeps (enrich + IDS risk). SIS pass
  // adds zero cost — it's deterministic. The numbers shown here are for the
  // run that just finished; deep-linked old jobs won't have llm fields.
  const enrichLlm = stats.llm;
  const risksLlm = riskStats?.llm ?? null;
  const totalCalls = (enrichLlm?.calls ?? 0) + (risksLlm?.calls ?? 0);
  const totalCost = (enrichLlm?.costUsd ?? 0) + (risksLlm?.costUsd ?? 0);
  const totalInTokens = (enrichLlm?.inputTokens ?? 0) + (risksLlm?.inputTokens ?? 0);
  const totalOutTokens = (enrichLlm?.outputTokens ?? 0) + (risksLlm?.outputTokens ?? 0);
  const avgLatency = (enrichLlm?.avgLatencyMs ?? 0) || (risksLlm?.avgLatencyMs ?? 0);
  const provider = enrichLlm?.provider ?? risksLlm?.provider ?? null;
  const model = enrichLlm?.model ?? risksLlm?.model ?? null;

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
      {totalCalls > 0 && (
        <div className="mt-3 pt-3 border-t border-zinc-200 flex flex-wrap gap-x-8 gap-y-2 text-zinc-700">
          <Stat
            label="LLM"
            value={`${provider ?? '?'} · ${model ?? '?'}`}
          />
          <Stat label="Calls" value={String(totalCalls)} />
          <Stat
            label="Tokens"
            value={`${formatTokens(totalInTokens)} in / ${formatTokens(totalOutTokens)} out`}
          />
          <Stat label="Estimated cost" value={`$${totalCost.toFixed(4)}`} />
          <Stat label="Avg call" value={`${avgLatency}ms`} />
        </div>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-zinc-500">{label}:</span>{' '}
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function ResultView({
  data,
  phase,
  onRowUpdated,
}: {
  data: FullJob;
  phase: Phase;
  onRowUpdated: (updated: RequirementRow) => void;
}) {
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
          <RequirementsTable
            rows={data.requirements}
            phase={phase}
            onRowUpdated={onRowUpdated}
          />
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

function RequirementsTable({
  rows,
  phase,
  onRowUpdated,
}: {
  rows: RequirementRow[];
  phase: Phase;
  onRowUpdated: (updated: RequirementRow) => void;
}) {
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
                  <td className="px-3 py-2 font-medium align-top">
                    <ReviewStatusDot status={r.reviewStatus} />
                    {r.reqId}
                  </td>
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
                {isExpanded && (
                  <tr className="bg-zinc-50">
                    <td colSpan={5} className="px-3 py-3 border-t border-zinc-200">
                      <ExpandedDetail row={r} onRowUpdated={onRowUpdated} />
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

function ExpandedDetail({
  row,
  onRowUpdated,
}: {
  row: RequirementRow;
  onRowUpdated: (updated: RequirementRow) => void;
}) {
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
      <ReviewActions row={row} onRowUpdated={onRowUpdated} />
    </div>
  );
}

/**
 * Inline vendor decision form. Lets the proposal engineer:
 *   - Override the LLM-suggested compliance (or use as-is).
 *   - Edit the auto-drafted vendor comment.
 *   - Add a deviation reference (Att. J row ID) for D-marked rows.
 *   - Set the row's reviewStatus via three actions:
 *       Approve         → vendorCompliance defaults to suggested (or current
 *                          override); status = 'approved'.
 *       Mark deviation  → vendorCompliance = 'D'; status = 'deviation'.
 *                          Surfaces the deviation-ref field.
 *       Reject          → status = 'rejected' (engineer flagged this LLM
 *                          output as wrong; row will not appear in the
 *                          filled TCM compliance column).
 *
 * Saves via PATCH /api/requirements/[id] and updates the row in place
 * (optimistic — the response payload replaces the cached row).
 */
function ReviewActions({
  row,
  onRowUpdated,
}: {
  row: RequirementRow;
  onRowUpdated: (updated: RequirementRow) => void;
}) {
  const [override, setOverride] = useState<'' | 'C' | 'D' | 'N/A'>(
    (row.vendorCompliance as 'C' | 'D' | 'N/A' | null) ?? '',
  );
  const [comment, setComment] = useState<string>(
    row.vendorComment ?? row.suggestedComment ?? '',
  );
  const [devRef, setDevRef] = useState<string>(row.deviationRef ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function patch(payload: Record<string, unknown>) {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/requirements/${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setSaveError(`HTTP ${res.status}`);
        return;
      }
      const updated = (await res.json()) as RequirementRow;
      onRowUpdated(updated);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function approve() {
    const effective = override || row.suggestedCompliance || 'C';
    patch({
      vendorCompliance: effective === 'Review' ? null : effective,
      vendorComment: comment,
      reviewStatus: 'approved',
    });
  }

  function markDeviation() {
    patch({
      vendorCompliance: 'D',
      vendorComment: comment,
      deviationRef: devRef || null,
      reviewStatus: 'deviation',
    });
  }

  function reject() {
    patch({
      vendorCompliance: null,
      reviewStatus: 'rejected',
    });
  }

  function reset() {
    patch({
      vendorCompliance: null,
      vendorComment: null,
      deviationRef: null,
      reviewStatus: 'pending',
    });
    setOverride('');
    setComment(row.suggestedComment ?? '');
    setDevRef('');
  }

  return (
    <Field label="Vendor decision">
      <div className="bg-white border border-zinc-200 rounded p-3 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-zinc-500 text-[10px] uppercase tracking-wide">
            Override compliance
          </label>
          <select
            value={override}
            onChange={(e) => setOverride(e.target.value as '' | 'C' | 'D' | 'N/A')}
            className="border border-zinc-300 rounded px-2 py-1 text-xs"
            disabled={saving}
          >
            <option value="">use suggestion ({row.suggestedCompliance ?? 'Review'})</option>
            <option value="C">C — Comply</option>
            <option value="D">D — Deviate</option>
            <option value="N/A">N/A — Not Applicable</option>
          </select>
          <span className="text-zinc-400 text-[10px]">
            current vendor pick: {row.vendorCompliance ?? '—'}
          </span>
        </div>

        <div>
          <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">
            Vendor comment (appears in TCM column F)
          </label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={saving}
            rows={2}
            className="w-full border border-zinc-300 rounded px-2 py-1 text-xs font-mono"
            placeholder="(no comment)"
          />
        </div>

        {(override === 'D' || row.reviewStatus === 'deviation') && (
          <div>
            <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">
              Deviation Ref (Att. J row ID)
            </label>
            <input
              value={devRef}
              onChange={(e) => setDevRef(e.target.value)}
              disabled={saving}
              className="border border-zinc-300 rounded px-2 py-1 text-xs font-mono"
              placeholder="e.g. DEV-007"
            />
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={approve}
            disabled={saving}
            className="px-3 py-1 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
          >
            ✓ Approve
          </button>
          <button
            onClick={markDeviation}
            disabled={saving}
            className="px-3 py-1 rounded bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 disabled:opacity-50"
          >
            ⚠ Mark deviation
          </button>
          <button
            onClick={reject}
            disabled={saving}
            className="px-3 py-1 rounded bg-zinc-200 text-zinc-700 text-xs font-medium hover:bg-zinc-300 disabled:opacity-50"
          >
            ✗ Reject
          </button>
          {row.reviewStatus !== 'pending' && (
            <button
              onClick={reset}
              disabled={saving}
              className="px-3 py-1 rounded text-zinc-500 text-xs underline hover:text-zinc-700"
            >
              reset
            </button>
          )}
          {saving && <span className="text-xs text-zinc-500">saving…</span>}
          {saveError && (
            <span className="text-xs text-red-700">error: {saveError}</span>
          )}
          {!saving && !saveError && row.reviewStatus !== 'pending' && (
            <span className="text-xs text-zinc-500">
              status: <strong>{row.reviewStatus}</strong>
            </span>
          )}
        </div>
      </div>
    </Field>
  );
}

/**
 * Tiny coloured dot next to the Req ID indicating where the row is in the
 * review workflow: pending / approved / edited / rejected / deviation.
 */
function ReviewStatusDot({ status }: { status: string }) {
  const styles: Record<string, { color: string; title: string }> = {
    pending: { color: 'bg-zinc-300', title: 'Pending review' },
    approved: { color: 'bg-emerald-500', title: 'Approved' },
    edited: { color: 'bg-blue-500', title: 'Edited' },
    rejected: { color: 'bg-zinc-500', title: 'Rejected' },
    deviation: { color: 'bg-amber-500', title: 'Marked as deviation' },
  };
  const s = styles[status] ?? styles['pending'];
  return (
    <span
      title={s.title}
      className={`inline-block w-2 h-2 rounded-full mr-2 align-middle ${s.color}`}
    />
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
