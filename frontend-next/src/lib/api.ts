// Typed fetch layer over the existing FastAPI backend. Same-origin in production
// (FastAPI serves this app at /next); Vite proxies /api to the backend in dev.

export interface Client {
  client_id: string;
  name: string;
  created_at?: string | null;
  google_customer_id?: string | null;
  reports_loaded?: number;
  last_upload?: string | null;
}

export interface Health {
  ok: boolean;
  service: string;
  version: string;
  db: string;
  persistent: boolean;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

async function send<T>(path: string, method: "POST" | "PATCH" | "PUT", body: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      detail = (await r.json())?.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

export const getHealth = () => get<Health>("/api/health");
export const getClients = () => get<Client[]>("/api/clients");

export function getBundle(clientId: string, params: import("./types").BundleParams = {}) {
  const sp = new URLSearchParams({ client: clientId });
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.seg && params.seg !== "all") sp.set("seg", params.seg);
  if (params.campaign && params.campaign !== "all") sp.set("campaign", params.campaign);
  if (params.region && params.region !== "all") sp.set("region", params.region);
  if (params.category && params.category !== "all") sp.set("category", params.category);
  if (params.brand && params.brand !== "all") sp.set("brand", params.brand);
  if (params.type && params.type !== "all") sp.set("type", params.type);
  if (params.compare && params.compare !== "yoy") sp.set("compare", params.compare);
  return get<import("./types").Bundle>(`/api/bundle?${sp.toString()}`);
}

// ---- decision system ----
import type { ActionItem, TransitionBody, LedgerResponse } from "./types";

const cid = (c: string) => `/api/clients/${encodeURIComponent(c)}`;

export const getActions = (clientId: string, status = "open") =>
  get<{ actions: ActionItem[] }>(`${cid(clientId)}/actions?status=${status}`).then((r) => r.actions);

export const transitionAction = (clientId: string, key: string, body: TransitionBody) =>
  send<ActionItem>(`${cid(clientId)}/actions/${key}/transition`, "POST", body);

export const assignAction = (clientId: string, key: string, body: { owner?: string; note?: string }) =>
  send<ActionItem>(`${cid(clientId)}/actions/${key}`, "PATCH", body);

export const getLedger = (clientId: string) => get<LedgerResponse>(`${cid(clientId)}/ledger`);

// ---- setup / admin ----
import type { ClientConfig, MappingsResponse, CampaignMapping, Inventory, JobStatus } from "./types";

export const getInventory = (clientId: string) =>
  get<Inventory>(`/api/inventory?client=${encodeURIComponent(clientId)}`);

// ---- Google Ads API auto-pull ----
export interface AdsApiClientStatus {
  client_id: string;
  name: string;
  customer_id?: string | null;
  syncable: boolean;
}
export interface AdsApiStatus {
  configured: boolean;
  missing_env: string[];
  clients: AdsApiClientStatus[];
}
export interface AdsApiReportResult {
  report_type: string;
  rows?: number;
  totals?: Record<string, number>;
  error?: string;
}
export interface AdsApiSyncResult {
  client_id?: string;
  customer_id?: string;
  window?: string[];
  wrote_to_db?: boolean;
  skipped?: string;
  error?: string;
  reports?: AdsApiReportResult[];
  synced?: AdsApiSyncResult[];
}
export interface AdsApiJob {
  status: "processing" | "done" | "error";
  result?: AdsApiSyncResult;
  error?: string;
}

export const getAdsApiStatus = () => get<AdsApiStatus>("/api/adsapi/status");
export const syncAdsApi = (clientId?: string) =>
  send<{ job_id: string; status: string }>("/api/adsapi/sync", "POST", clientId ? { client_id: clientId } : {});
export const getAdsApiJob = (jobId: string) => get<AdsApiJob>(`/api/adsapi/sync/status/${jobId}`);
export const previewAdsApi = (clientId: string, report = "core") =>
  get<AdsApiSyncResult>(`/api/adsapi/preview?client=${encodeURIComponent(clientId)}&report=${report}`);

export async function uploadFiles(clientId: string, period: string, files: File[]): Promise<{ job_id: string; status: string }> {
  const fd = new FormData();
  fd.append("client", clientId);
  fd.append("period", period);
  for (const f of files) fd.append("files", f);
  const r = await fetch("/api/upload", { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      detail = (await r.json())?.detail ?? detail;
    } catch {
      /* non-JSON */
    }
    throw new Error(detail);
  }
  return r.json();
}

export const getUploadStatus = (jobId: string) => get<JobStatus>(`/api/upload/status/${jobId}`);

// ---- MCC (manager account) bulk upload ----
import type { MccPreview, MccCommitEntry, MccStatus } from "./types";

async function multipart<T>(path: string, files: File[]): Promise<T> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const r = await fetch(path, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      detail = (await r.json())?.detail ?? detail;
    } catch {
      /* non-JSON */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

export const mccPreview = (files: File[]) => multipart<MccPreview>("/api/upload/mcc/preview", files);
export const mccCommit = (batchId: string, mapping: Record<string, MccCommitEntry>) =>
  send<{ job_id: string; status: string }>("/api/upload/mcc/commit", "POST", { batch_id: batchId, mapping });
export const getMccStatus = (jobId: string) => get<MccStatus>(`/api/upload/status/${jobId}`);

// ---- budget intelligence: allocation ----
import type { CurvesStatus, AllocRun, AllocResult, RunInput, SnapshotPoint, FitResult } from "./types";

const bi = (c: string) => `${cid(c)}/budget-intel`;

export const addSnapshots = (clientId: string, points: SnapshotPoint[], fit = true) =>
  send<FitResult>(`${bi(clientId)}/simulator-snapshots`, "POST", { points, source: "manual", fit });

export const getCurves = (clientId: string) => get<CurvesStatus>(`${bi(clientId)}/curves`);
export const getRuns = (clientId: string) => get<{ runs: AllocRun[] }>(`${bi(clientId)}/runs`).then((r) => r.runs);
export const getRun = (clientId: string, runId: number) => get<AllocRun>(`${bi(clientId)}/runs/${runId}`);
export const createRun = (clientId: string, body: RunInput) =>
  send<{ run_id: number; results: AllocResult[] }>(`${bi(clientId)}/runs`, "POST", body);
export const finalizeRun = (clientId: string, runId: number) =>
  send<AllocRun>(`${bi(clientId)}/runs/${runId}/finalize`, "POST", {});

export const createClient = (name: string) => send<Client>("/api/clients", "POST", { name });
export const getConfig = (clientId: string) => get<ClientConfig>(`${cid(clientId)}/config`);
export const updateConfig = (clientId: string, patch: Partial<ClientConfig>) =>
  send<ClientConfig>(`${cid(clientId)}/config`, "PUT", patch);
export const getMappings = (clientId: string) => get<MappingsResponse>(`${cid(clientId)}/budget-intel/mappings`);
export const putMappings = (clientId: string, rows: CampaignMapping[]) =>
  send<{ saved: number; unmapped: string[] }>(`${cid(clientId)}/budget-intel/mappings`, "PUT", rows);
export const approveMappings = (clientId: string, campaigns?: string[]) =>
  send<{ approved: number; pending: number }>(`${cid(clientId)}/budget-intel/mappings/approve`, "POST", { campaigns: campaigns ?? null });

export async function uploadMappingFile(clientId: string, file: File): Promise<{ saved: number; pending?: number }> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`${cid(clientId)}/budget-intel/mappings/upload`, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      detail = (await r.json())?.detail ?? detail;
    } catch {
      /* non-JSON */
    }
    throw new Error(detail);
  }
  return r.json();
}

export async function uploadBudget(clientId: string, file: File): Promise<{ lines: unknown[]; [k: string]: unknown }> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`${cid(clientId)}/budget`, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      detail = (await r.json())?.detail ?? detail;
    } catch {
      /* non-JSON */
    }
    throw new Error(detail);
  }
  return r.json();
}
