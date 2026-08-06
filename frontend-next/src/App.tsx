import { useQuery } from "@tanstack/react-query";
import { getClients, getHealth } from "./lib/api";

// Phase-0 scaffold shell. Proves the pipeline end to end: React 18 + TypeScript +
// Tailwind (tokens from the design handoff) + TanStack Query talking to the existing
// FastAPI API. The designed screens (Brief, Actions, ...) land on top of this.
export default function App() {
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
  const clients = useQuery({ queryKey: ["clients"], queryFn: getClients });

  return (
    <div className="flex h-screen overflow-hidden font-ui">
      {/* Rail */}
      <aside className="w-[248px] shrink-0 bg-rail text-text-disabled flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <div className="grid h-5 w-5 place-items-center rounded-[5px] bg-accent font-mono text-[11px] font-bold text-ink">
            N
          </div>
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-[#f9fafb]">SearchNex</span>
        </div>
        <div className="px-4 pb-3 text-[9.5px] font-semibold uppercase tracking-[0.1em]">Redesign · scaffold</div>
        <nav className="mt-2 flex-1 overflow-auto px-2 text-[12px]">
          {["Today", "Diagnose", "Plan", "Prove", "Setup"].map((g) => (
            <div key={g} className="px-[9px] py-1 text-[9.5px] font-semibold uppercase tracking-[0.1em]">
              {g}
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 px-4 py-3 text-[11.5px]">ci@chazif.com</div>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto">
        <div className="flex h-12 items-center border-b border-strip-border bg-strip-bg px-6">
          <span className="text-[13px] font-semibold">Brief</span>
          <span className="ml-2 text-[12px] text-text-muted">React + TypeScript foundation</span>
          <span className="ml-auto text-[11.5px] italic text-text-disabled">no filters apply on this screen</span>
        </div>

        <div className="max-w-[1180px] px-6 py-8">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">Phase 0</div>
          <h1 className="max-w-[620px] font-display text-[40px] leading-[1.05] tracking-[-0.015em]">
            The new frontend is wired up.
          </h1>
          <p className="mt-3 max-w-[620px] text-[13px] text-text-tertiary [text-wrap:pretty]">
            Vite · React 18 · TypeScript · Tailwind (design-handoff tokens), talking to the existing FastAPI API.
            The designed decision-system screens build on top of this scaffold.
          </p>

          <div className="mt-8 grid grid-cols-[1fr_1fr] items-start gap-5">
            <Card title="API check · /api/health">
              {health.isLoading && <Muted>Loading…</Muted>}
              {health.error && <Err>{(health.error as Error).message}</Err>}
              {health.data && (
                <ul className="text-[12.5px]">
                  <Row k="service" v={health.data.service} />
                  <Row k="version" v={health.data.version} />
                  <Row k="db" v={health.data.db} />
                  <Row k="persistent" v={String(health.data.persistent)} />
                </ul>
              )}
            </Card>

            <Card title="API check · /api/clients">
              {clients.isLoading && <Muted>Loading…</Muted>}
              {clients.error && <Err>{(clients.error as Error).message}</Err>}
              {clients.data && (
                <ul className="text-[12.5px]">
                  {clients.data.map((c) => (
                    <li
                      key={c.client_id}
                      className="flex justify-between border-b border-rule py-1 last:border-0"
                    >
                      <span>{c.name}</span>
                      <span className="font-mono text-text-muted">{c.reports_loaded ?? 0} reports</span>
                    </li>
                  ))}
                  {clients.data.length === 0 && <Muted>No clients yet.</Muted>}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[10px] border border-border p-4">
      <div className="mb-2 text-[10px] uppercase tracking-[0.07em] text-text-muted">{title}</div>
      {children}
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <li className="flex justify-between border-b border-rule py-1 last:border-0">
      <span className="text-text-tertiary">{k}</span>
      <span className="font-mono">{v}</span>
    </li>
  );
}
const Muted = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[12.5px] text-text-disabled">{children}</div>
);
const Err = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[12.5px] text-negative">Error: {children}</div>
);
