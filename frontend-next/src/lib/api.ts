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
export const getBundle = (clientId: string) =>
  get<import("./types").Bundle>(`/api/bundle?client=${encodeURIComponent(clientId)}`);

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
import type { ClientConfig, MappingsResponse, CampaignMapping } from "./types";

export const createClient = (name: string) => send<Client>("/api/clients", "POST", { name });
export const getConfig = (clientId: string) => get<ClientConfig>(`${cid(clientId)}/config`);
export const updateConfig = (clientId: string, patch: Partial<ClientConfig>) =>
  send<ClientConfig>(`${cid(clientId)}/config`, "PUT", patch);
export const getMappings = (clientId: string) => get<MappingsResponse>(`${cid(clientId)}/budget-intel/mappings`);
export const putMappings = (clientId: string, rows: CampaignMapping[]) =>
  send<{ saved: number; unmapped: string[] }>(`${cid(clientId)}/budget-intel/mappings`, "PUT", rows);

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
