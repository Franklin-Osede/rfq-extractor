'use client';

/**
 * Minimal Day-1 UI for the Loonar RFQ Assistant.
 *
 * Intentionally ugly. This is the smoke-test surface for the parse pipeline:
 * drop the 13 documents, see them classified, see the 108 requirements +
 * 29 tag-level rows that came out of the TCM template.
 *
 * Day 2 layers on shadcn DataTable, side panel with evidence, PDF viewer,
 * review actions, risk panel. None of that lives here yet.
 */

import { useState } from 'react';

type DocOut = {
  id: string;
  filename: string;
  role: string;
  mimeType: string;
  sizeBytes: number;
  scanned: boolean;
  language: string;
};

type RequirementRow = {
  id: string;
  reqId: string;
  rfqSectionRef: string;
  description: string;
  reviewStatus: string;
};

type TagRow = {
  id: string;
  tagNo: string;
  heliosServiceDescription: string;
  reviewStatus: string;
};

type JobResult = {
  jobId: string;
  status: string;
  documents: DocOut[];
  tcm: {
    requirements?: number;
    tags?: number;
    metadata?: Record<string, string | null>;
    error?: string;
  } | null;
};

type FullJob = {
  job: { id: string; status: string };
  documents: DocOut[];
  requirements: RequirementRow[];
  tagRequirements: TagRow[];
};

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<FullJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setFiles(e.target.files ? Array.from(e.target.files) : []);
    setResult(null);
    setError(null);
  }

  async function onUpload() {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      const postRes = await fetch('/api/jobs', { method: 'POST', body: form });
      const postBody = (await postRes.json()) as JobResult;
      if (!postRes.ok) {
        setError(JSON.stringify(postBody, null, 2));
        return;
      }
      const getRes = await fetch(`/api/jobs/${postBody.jobId}`);
      const getBody = (await getRes.json()) as FullJob;
      setResult(getBody);
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <main className="max-w-6xl mx-auto p-6 font-mono text-sm">
      <header className="mb-6 border-b pb-4">
        <h1 className="text-xl font-semibold">Loonar RFQ Assistant — Day 1 smoke UI</h1>
        <p className="text-zinc-500 mt-1">
          Drop the Helios RFQ package below. The system classifies each file,
          parses the TCM template, and surfaces the 108 requirements + 29 tag-level
          rows from Helios&apos;s official response format.
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
          {files.length > 0 && (
            <div className="mt-3 text-zinc-600">
              {files.length} file{files.length === 1 ? '' : 's'} selected:{' '}
              {files.map((f) => f.name).join(', ')}
            </div>
          )}
        </div>
        <button
          onClick={onUpload}
          disabled={uploading || files.length === 0}
          className="mt-3 px-4 py-2 rounded bg-black text-white disabled:bg-zinc-400"
        >
          {uploading ? 'Processing…' : 'Upload & parse'}
        </button>
        {error && (
          <pre className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-red-900 overflow-auto">
            {error}
          </pre>
        )}
      </section>

      {result && <Result data={result} />}
    </main>
  );
}

function Result({ data }: { data: FullJob }) {
  return (
    <div className="space-y-8">
      <Section title={`Documents classified (${data.documents.length})`}>
        <Table
          headers={['Filename', 'Role', 'MIME', 'Size', 'Scanned', 'Lang']}
          rows={data.documents.map((d) => [
            d.filename,
            d.role,
            d.mimeType.replace('application/', ''),
            humanSize(d.sizeBytes),
            d.scanned ? 'yes' : 'no',
            d.language,
          ])}
        />
      </Section>

      <Section title={`Requirements (${data.requirements.length})`}>
        {data.requirements.length === 0 ? (
          <Note>No TCM template was detected in the upload, so no requirements were loaded.</Note>
        ) : (
          <Table
            headers={['Req ID', 'Section', 'Description', 'Status']}
            rows={data.requirements.map((r) => [
              r.reqId,
              r.rfqSectionRef,
              r.description,
              r.reviewStatus,
            ])}
            descriptionCol={2}
          />
        )}
      </Section>

      <Section title={`Tag-Level Confirmation (${data.tagRequirements.length})`}>
        {data.tagRequirements.length === 0 ? (
          <Note>No tags loaded — TCM Tag-Level Confirmation sheet was empty or missing.</Note>
        ) : (
          <Table
            headers={['Tag', 'Helios service description', 'Status']}
            rows={data.tagRequirements.map((t) => [
              t.tagNo,
              t.heliosServiceDescription,
              t.reviewStatus,
            ])}
            descriptionCol={1}
          />
        )}
      </Section>
    </div>
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

function Table({
  headers,
  rows,
  descriptionCol,
}: {
  headers: string[];
  rows: (string | number)[][];
  /** Column index whose text can wrap; everything else stays single-line. */
  descriptionCol?: number;
}) {
  return (
    <div className="overflow-auto border rounded">
      <table className="w-full text-xs">
        <thead className="bg-zinc-100">
          <tr>
            {headers.map((h) => (
              <th key={h} className="text-left px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t hover:bg-zinc-50">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={
                    j === descriptionCol
                      ? 'px-3 py-2 align-top'
                      : 'px-3 py-2 whitespace-nowrap align-top'
                  }
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
