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

export const getHealth = () => get<Health>("/api/health");
export const getClients = () => get<Client[]>("/api/clients");
