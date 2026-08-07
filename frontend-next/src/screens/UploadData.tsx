import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { uploadFiles, getUploadStatus } from "../lib/api";
import type { UploadLoaded } from "../lib/types";
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

export function UploadData() {
  const { clientId = "" } = useParams();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const upload = useMutation({
    mutationFn: (files: File[]) => uploadFiles(clientId, stamp(), files),
    onSuccess: (r) => setJobId(r.job_id),
  });

  const status = useQuery({
    queryKey: ["upload-status", jobId],
    queryFn: () => getUploadStatus(jobId as string),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === "processing" ? 1500 : false),
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
    if (files.length) {
      setJobId(null);
      upload.mutate(files);
    }
  };

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-6">
      <h1 className="mb-4 text-[19px] font-semibold tracking-[-0.01em]">Upload Data</h1>

      <Panel title="Add Google Ads report exports" sub="CSV or gzipped CSV. Each report snapshot-replaces the same report type for this client.">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".csv,.csv.gz,.gz"
            onChange={(e) => setPicked(Array.from(e.target.files ?? []).map((f) => f.name))}
            className="text-[12.5px] file:mr-3 file:rounded-[6px] file:border file:border-border-strong file:bg-surface-alt file:px-2.5 file:py-1 file:text-[12px] hover:file:border-ink"
          />
          <button onClick={submit} disabled={processing || !picked.length}
            className="rounded-[7px] bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {processing ? "Ingesting…" : `Upload${picked.length ? ` ${picked.length}` : ""}`}
          </button>
          {upload.isError && <span className="text-[12.5px] text-negative">{(upload.error as Error).message}</span>}
        </div>
        {picked.length > 0 && !processing && !result && (
          <p className="mt-2 text-[11.5px] text-text-muted">{picked.length} file{picked.length > 1 ? "s" : ""} selected</p>
        )}
        {processing && (
          <p className="mt-3 text-[12.5px] text-text-secondary">Parsing and loading — this can take a moment for large exports…</p>
        )}
        {status.data?.status === "error" && (
          <p className="mt-3 text-[12.5px] text-negative">Ingest failed: {status.data.error}</p>
        )}
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
              <div className="flex flex-wrap gap-2">
                {result.unmapped.map((f) => <Pill key={f} tone="warn">{f}</Pill>)}
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
