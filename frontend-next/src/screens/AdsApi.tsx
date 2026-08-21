import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAdsApiStatus, syncAdsApi, getAdsApiJob, previewAdsApi,
  type AdsApiClientStatus, type AdsApiReportResult, type AdsApiSyncResult,
} from "../lib/api";
import { num } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { Loading, ErrorState } from "../components/ui/States";

const pretty = (slug: string) => slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const btn = "rounded-[7px] px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50";

function Reports({ reports }: { reports?: AdsApiReportResult[] }) {
  if (!reports?.length) return null;
  return (
    <div className="mt-2 divide-y divide-border">
      {reports.map((r) => (
        <div key={r.report_type} className="flex items-center gap-3 py-1 text-[12px]">
          <span className="w-[190px] shrink-0 font-medium">{pretty(r.report_type)}</span>
          {r.error ? (
            <>
              <Pill tone="neg">error</Pill>
              <span className="truncate text-[11px] text-negative" title={r.error}>{r.error}</span>
            </>
          ) : (
            <span className="text-text-tertiary">
              {num(r.rows ?? 0)} rows
              {r.totals ? ` · cost ${num(Math.round(r.totals.cost ?? 0))} · clicks ${num(r.totals.clicks ?? 0)} · conv ${num(r.totals.conversions ?? 0)}` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function ResultBlock({ res }: { res: AdsApiSyncResult }) {
  if (res.error) return <div className="mt-2 text-[12px] text-negative">{res.error}</div>;
  if (res.skipped) return <div className="mt-2 text-[12px] text-warning">Skipped: {res.skipped}</div>;
  return (
    <div className="mt-2">
      {res.window && (
        <div className="text-[11.5px] text-text-muted">
          Window {res.window[0]} → {res.window[1]}
          {res.wrote_to_db === false ? " · preview only (nothing written)" : ""}
        </div>
      )}
      <Reports reports={res.reports} />
    </div>
  );
}

function ClientRow({ c }: { c: AdsApiClientStatus }) {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [preview, setPreview] = useState<AdsApiSyncResult | null>(null);

  const sync = useMutation({ mutationFn: () => syncAdsApi(c.client_id), onSuccess: (r) => { setPreview(null); setJobId(r.job_id); } });
  const job = useQuery({
    queryKey: ["adsapi-job", jobId], queryFn: () => getAdsApiJob(jobId as string),
    enabled: !!jobId, refetchInterval: (q) => (q.state.data?.status === "processing" ? 1500 : false),
  });
  const done = job.data?.status === "done";
  useEffect(() => {
    if (done) {
      qc.invalidateQueries({ queryKey: ["inventory", c.client_id] });
      qc.invalidateQueries({ queryKey: ["bundle", c.client_id] });
      qc.invalidateQueries({ queryKey: ["adsapi-status"] });
    }
  }, [done, c.client_id, qc]);

  const previewM = useMutation({ mutationFn: () => previewAdsApi(c.client_id, "core"), onSuccess: (r) => { setJobId(null); setPreview(r); } });

  const syncing = sync.isPending || job.data?.status === "processing";
  const syncResult = done ? job.data?.result : undefined;
  const jobFailed = job.data?.status === "error";

  return (
    <div className="rounded-[9px] border border-border p-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[190px]">
          <div className="text-[13.5px] font-semibold">{c.name}</div>
          <div className="font-mono text-[11px] text-text-muted">{c.customer_id ?? "no customer id"}</div>
        </div>
        {c.syncable ? <Pill tone="pos">syncable</Pill> : <Pill tone="warn">no customer id</Pill>}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => previewM.mutate()}
            disabled={!c.syncable || previewM.isPending || syncing}
            className={`${btn} border border-border-strong hover:border-ink`}
          >
            {previewM.isPending ? "Previewing…" : "Preview"}
          </button>
          <button
            onClick={() => sync.mutate()}
            disabled={!c.syncable || syncing || previewM.isPending}
            className={`${btn} bg-ink text-white hover:opacity-90`}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>

      {sync.isError && <div className="mt-2 text-[12px] text-negative">{(sync.error as Error).message}</div>}
      {previewM.isError && <div className="mt-2 text-[12px] text-negative">{(previewM.error as Error).message}</div>}
      {jobFailed && <div className="mt-2 text-[12px] text-negative">{job.data?.error ?? "sync failed"}</div>}
      {syncResult && <ResultBlock res={syncResult} />}
      {preview && <ResultBlock res={preview} />}
    </div>
  );
}

export function AdsApi() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["adsapi-status"], queryFn: getAdsApiStatus });

  const syncAll = useMutation({ mutationFn: () => syncAdsApi(), onSuccess: () => qc.invalidateQueries({ queryKey: ["adsapi-status"] }) });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!data) return <ErrorState msg="No status" />;

  const syncableCount = data.clients.filter((c) => c.syncable).length;

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em]">Google Ads API</h1>
        {data.configured ? <Pill tone="pos">connected</Pill> : <Pill tone="neg">not configured</Pill>}
      </div>

      <Panel
        title="Connection"
        sub={data.configured ? "Credentials present in this environment" : "Missing environment variables"}
      >
        {data.configured ? (
          <p className="text-[12.5px] text-text-tertiary">
            All Google Ads API credentials are set. {syncableCount} of {data.clients.length} client(s) have a customer id and can be pulled.
            The rolling window is the first day of last month through today.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.missing_env.map((e) => <Pill key={e} tone="warn">{e}</Pill>)}
          </div>
        )}
      </Panel>

      <div className="mt-6 flex items-center gap-3">
        <h2 className="text-[16px] font-semibold">Clients</h2>
        <button
          onClick={() => syncAll.mutate()}
          disabled={!data.configured || !syncableCount || syncAll.isPending}
          className={`${btn} ml-auto bg-ink text-white hover:opacity-90`}
        >
          {syncAll.isPending ? "Starting…" : "Sync all"}
        </button>
      </div>
      {syncAll.isError && <div className="mt-2 text-[12px] text-negative">{(syncAll.error as Error).message}</div>}
      {syncAll.data && <div className="mt-2 text-[12px] text-text-muted">Started background sync for all syncable clients.</div>}

      <div className="mt-3 space-y-2.5">
        {data.clients.map((c) => <ClientRow key={c.client_id} c={c} />)}
      </div>

      <p className="mt-6 text-[11.5px] text-text-muted">
        “Sync now” pulls each report over the window and merges it into this project’s database by date.
        “Preview” pulls the same data but writes nothing — use it to check numbers against Google first.
      </p>
    </div>
  );
}
