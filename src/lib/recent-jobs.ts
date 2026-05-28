/**
 * Client-side persistence of recent jobs in localStorage. Pure UX layer
 * — the server is the source of truth for job data, this just remembers
 * which jobs the user has seen so we can offer one-click resumption
 * instead of forcing a re-upload.
 *
 * Why localStorage and not cookies / IndexedDB: simplest possible layer,
 * synchronous read, no quota concerns at this size (10 entries × ~200B
 * = 2KB), and the user can wipe it from devtools if needed.
 */

const STORAGE_KEY = 'loonar:recentJobs';
const MAX_ENTRIES = 10;

export type RecentJob = {
  jobId: string;
  /** ISO timestamp of when this entry was last touched. */
  savedAt: string;
  /** Snapshot counts the user can scan without opening the job. */
  docCount: number;
  reqCount: number;
  tagCount: number;
  riskCount: number;
  failedCount: number;
  /** Last known job.status — informational. */
  status: string;
};

/**
 * Human label for a job. UUIDs are unfriendly to scan, so we derive a
 * short readable string from the savedAt timestamp ("Run · 5:23 PM").
 * The label is for display only; the jobId remains the source of truth
 * when actually opening a job.
 */
export function labelForJob(job: RecentJob): string {
  const d = new Date(job.savedAt);
  if (!Number.isFinite(d.getTime())) return `Run · ${job.jobId.slice(0, 8)}`;
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `Run · ${time} · ${date}`;
}

export function loadRecentJobs(): RecentJob[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentJob);
  } catch {
    return [];
  }
}

/**
 * Upsert by jobId. The newest entry floats to the top; we cap at
 * MAX_ENTRIES so the list doesn't grow without bound.
 */
export function saveRecentJob(entry: RecentJob): RecentJob[] {
  if (typeof window === 'undefined') return [];
  const current = loadRecentJobs().filter((j) => j.jobId !== entry.jobId);
  const next = [entry, ...current].slice(0, MAX_ENTRIES);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded or storage disabled — fail silently, UX layer.
  }
  return next;
}

export function removeRecentJob(jobId: string): RecentJob[] {
  if (typeof window === 'undefined') return [];
  const next = loadRecentJobs().filter((j) => j.jobId !== jobId);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function clearRecentJobs(): RecentJob[] {
  if (typeof window === 'undefined') return [];
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return [];
}

function isRecentJob(x: unknown): x is RecentJob {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.jobId === 'string' &&
    typeof r.savedAt === 'string' &&
    typeof r.docCount === 'number' &&
    typeof r.reqCount === 'number' &&
    typeof r.tagCount === 'number' &&
    typeof r.riskCount === 'number' &&
    typeof r.failedCount === 'number' &&
    typeof r.status === 'string'
  );
}
