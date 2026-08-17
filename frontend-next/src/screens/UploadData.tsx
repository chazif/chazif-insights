import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { uploadFiles, getUploadStatus, mccPreview, mccCommit, getMccStatus, getClients } from "../lib/api";
import type { UploadLoaded, MccPreview, MccCommitEntry } from "../lib/types";
import { num } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";

const pretty = (slug: string) => slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

const loadedCols: Column<UploadLoaded>[] = [
  { key: "report", header: "Report", sort: (r) => r.report_type, render: (r) => <span className="font-medium">{pretty(r.report_type)}</span>, csv: (r) => r.report_type },
  { key: "file", header: "Source file", render: (r) => <span className="text-text-tertiary">{r.source_file ?? "—"}</span>, csv: (r) => r.source_file ?? "" },
  { key: "window", header: "Window", render: (r) => <span className="text-text-tertiary">{r.window ?? "—"}</span>, csv: (r) => r.window ?? "" },
  { key: "rows", header: "Rows", align: "right", sort: (r) => r.rows ?? 0, render: (r) => num(r.rows ?? 0), agg: { kind: "sum", get: (r) => r.rows ?? 0, fmt: (n) => num(n) }, csv: (r) => r.rows ?? 0 },
];

const fileInput = "text-[12.5px] file:mr-3 file:rounded-[6px] file:border file:border-border-strong file:bg-surface-alt file:px-2.5 file:py-1 file:text-[12px] hover:file:border-ink";

// ---- single-client upload (unchanged behaviour) ----
function SingleUpload({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const upload = useMutation({ mutationFn: (files: File[]) => uploadFiles(clientId, stamp(), files), onSuccess: (r) => setJobId(r.job_id) });
  const status = useQuery({
    queryKey: ["upload-status", jobId], queryFn: () => getUploadStatus(jobId as string),
    enabled: !!jobId, refetchInterval: (q) => (q.state.data?.status === "processing" ? 1500 : false),
  });
  const done = status.data?.status === "done";
  useEffect(() => {
    if (done) {
      qc.invalidateQueries({ queryKey: ["inventory", clientId] });
      qc.invalidateQueries({ queryKey: ["bundle", clientId] });
      qc.invalidateQueries({ queryKey: ["clients"] });
    }
  }, [done, clientId, qc]);

  const processing = upload.isPending || status.data?.status === "processing";
  const result = status.data?.status === "done" ? status.data.result : undefined;
  const submit = () => {
    const files = Array.from(fileRef.current?.files ?? []);
    if (files.length) { setJobId(null); upload.mutate(files); }
  };

  return (
    <>
      <Panel title="Add Google Ads report exports" sub="CSV or gzipped CSV. Each report merges into this client's data by date window.">
        <div className="flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" multiple accept=".csv,.csv.gz,.gz" onChange={(e) => setPicked(Array.from(e.target.files ?? []).map((f) => f.name))} className={fileInput} />
          <button onClick={submit} disabled={processing || !picked.length} className="rounded-[7px] bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {processing ? "Ingesting…" : `Upload${picked.length ? ` ${picked.length}` : ""}`}
          </button>
          {upload.isError && <span className="text-[12.5px] text-negative">{(upload.error as Error).message}</span>}
        </div>
        {picked.length > 0 && !processing && !result && <p className="mt-2 text-[11.5px] text-text-muted">{picked.length} file{picked.length > 1 ? "s" : ""} selected</p>}
        {processing && <p className="mt-3 text-[12.5px] text-text-secondary">Parsing and loading — this can take a moment for large exports…</p>}
        {status.data?.status === "error" && <p className="mt-3 text-[12.5px] text-negative">Ingest failed: {status.data.error}</p>}
      </Panel>

      {result && (
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-3">
            <h2 className="text-[16px] font-semibold">Loaded</h2>
            <Pill tone="pos">Coverage {result.inventory?.coverage}</Pill>
          </div>
          {result.loaded.length ? (
            <DataTable rows={result.loaded} columns={loadedCols} rowKey={(r, i) => r.report_type + "|" + i} totalsLabel="Total" exportName={`upload-${clientId}`} />
          ) : (
            <p className="text-[12.5px] text-text-muted">No recognized reports in that upload.</p>
          )}
          {result.unmapped?.length > 0 && (
            <Panel title="Unrecognized files" sub="Not matched to a known Google Ads report type" className="mt-4">
              <div className="flex flex-wrap gap-2">{result.unmapped.map((f) => <Pill key={f} tone="warn">{f}</Pill>)}</div>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}

// ---- MCC (manager account) bulk upload: one export split into per-account rows ----
function MccUpload() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<MccPreview | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({}); // account key -> "skip" | "create" | client_id
  const [jobId, setJobId] = useState<string | null>(null);
  const clients = useQuery({ queryKey: ["clients"], queryFn: getClients });

  const doPreview = useMutation({
    mutationFn: (files: File[]) => mccPreview(files),
    onSuccess: (p) => {
      setPreview(p);
      setTargets(Object.fromEntries(p.accounts.map((a) => [a.key, a.client_id ?? "create"])));
      setJobId(null);
    },
  });
  const commit = useMutation({
    mutationFn: () => {
      const mapping: Record<string, MccCommitEntry> = {};
      for (const a of preview!.accounts) {
        const t = targets[a.key];
        if (!t || t === "skip") continue;
        mapping[a.key] = t === "create"
          ? { create: true, name: a.account_name ?? a.suggested_slug, slug: a.suggested_slug, customer_id: a.customer_id }
          : { client_id: t, customer_id: a.customer_id };
      }
      return mccCommit(preview!.batch_id, mapping);
    },
    onSuccess: (r) => setJobId(r.job_id),
  });
  const status = useQuery({
    queryKey: ["mcc-status", jobId], queryFn: () => getMccStatus(jobId as string),
    enabled: !!jobId, refetchInterval: (q) => (q.state.data?.status === "processing" ? 1500 : false),
  });
  const done = status.data?.status === "done";
  useEffect(() => {
    if (done) {
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["bundle"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    }
  }, [done, qc]);

  const processing = commit.isPending || status.data?.status === "processing";
  const result = status.data?.status === "done" ? status.data.result : undefined;
  const toIngest = preview?.accounts.filter((a) => targets[a.key] && targets[a.key] !== "skip").length ?? 0;
  const runPreview = () => {
    const files = Array.from(fileRef.current?.files ?? []);
    if (files.length) { setJobId(null); doPreview.mutate(files); }
  };

  return (
    <>
      <Panel title="Upload a manager-account (MCC) export" sub="One export covering multiple accounts. We detect each account and you map it to a client — new clients can be created on the fly.">
        <div className="flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" multiple accept=".csv,.csv.gz,.gz" className={fileInput} />
          <button onClick={runPreview} disabled={doPreview.isPending} className="rounded-[7px] border border-border-strong px-3 py-1.5 text-[13px] hover:border-ink disabled:opacity-50">
            {doPreview.isPending ? "Reading…" : "Preview accounts"}
          </button>
          {doPreview.isError && <span className="text-[12.5px] text-negative">{(doPreview.error as Error).message}</span>}
        </div>
      </Panel>

      {preview && (
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-3">
            <h2 className="text-[16px] font-semibold">Accounts found</h2>
            <span className="text-[12px] text-text-muted">{preview.accounts.length} · {toIngest} to ingest</span>
            <div className="ml-auto flex items-center gap-3">
              {commit.isError && <span className="text-[12.5px] text-negative">{(commit.error as Error).message}</span>}
              <button onClick={() => commit.mutate()} disabled={processing || !toIngest}
                className="rounded-[7px] bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
                {processing ? "Ingesting…" : `Ingest ${toIngest} account${toIngest === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
          <div className="overflow-auto rounded-[10px] border border-border">
            <table className="w-full border-collapse text-[12.5px]">
              <thead className="bg-surface-alt">
                <tr>
                  {["Account", "Customer ID", "Reports", "Rows", "Map to"].map((h, i) => (
                    <th key={h} className={`whitespace-nowrap border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted ${i === 3 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.accounts.map((a) => (
                  <tr key={a.key} className="border-b border-rule last:border-0">
                    <td className="px-3 py-2 font-medium">
                      {a.account_name ?? "(unnamed)"}
                      {a.status === "matched" ? <Pill tone="pos"><span className="ml-1">matched</span></Pill> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-text-tertiary">{a.customer_id ?? "—"}</td>
                    <td className="px-3 py-2 text-text-tertiary">{Object.keys(a.reports).length}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{num(a.rows)}</td>
                    <td className="px-3 py-2">
                      <select
                        value={targets[a.key] ?? "skip"}
                        onChange={(e) => setTargets((s) => ({ ...s, [a.key]: e.target.value }))}
                        className="min-w-[200px] rounded-[6px] border border-border-strong bg-surface px-2 py-1 text-[12px] outline-none focus:border-accent"
                      >
                        <option value="skip">— Skip —</option>
                        <option value="create">Create new: {a.suggested_slug}</option>
                        {(clients.data ?? []).map((c) => (
                          <option key={c.client_id} value={c.client_id}>{c.name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.unknown_files.length > 0 && (
            <Panel title="Unrecognized files" className="mt-4">
              <div className="flex flex-wrap gap-2">{preview.unknown_files.map((f) => <Pill key={f} tone="warn">{f}</Pill>)}</div>
            </Panel>
          )}
        </div>
      )}

      {processing && <p className="mt-4 text-[12.5px] text-text-secondary">Splitting by account and loading — this can take a moment…</p>}
      {status.data?.status === "error" && <p className="mt-4 text-[12.5px] text-negative">Ingest failed: {status.data.error}</p>}
      {result && (
        <Panel title="Ingested" sub={`${result.ingested.length} report loads · ${result.skipped.length} skipped`} className="mt-6">
          <div className="flex flex-wrap gap-2">
            {[...new Set(result.ingested.map((r) => r.client_id))].map((c) => (
              <Pill key={c} tone="pos">{c} · {result.ingested.filter((r) => r.client_id === c).length} reports</Pill>
            ))}
            {!result.ingested.length && <span className="text-[12.5px] text-text-muted">Nothing ingested — every account was skipped.</span>}
          </div>
        </Panel>
      )}
    </>
  );
}

export function UploadData() {
  const { clientId = "" } = useParams();
  const [mode, setMode] = useState<"client" | "mcc">("client");

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em]">Upload Data</h1>
        <div className="ml-auto flex overflow-hidden rounded-[7px] border border-border-strong">
          {([["client", "This client"], ["mcc", "MCC (multi-account)"]] as const).map(([m, label], i) => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-3 py-1.5 text-[12.5px] ${i > 0 ? "border-l border-border-strong" : ""} ${mode === m ? "bg-ink font-medium text-white" : "bg-surface hover:bg-row-hover"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {mode === "client" ? <SingleUpload clientId={clientId} /> : <MccUpload />}
    </div>
  );
}
