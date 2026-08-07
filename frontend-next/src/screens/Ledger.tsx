import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getLedger } from "../lib/api";
import type { LedgerEvent } from "../lib/types";
import { Pill } from "../components/ui/Pill";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const KIND_TONE: Record<string, "pos" | "warn" | "neg" | "neutral"> = {
  accepted: "pos", done: "pos", resolved: "pos", regressed: "warn", snoozed: "warn",
  dismissed: "neutral", reopened: "neutral", created: "neutral", assigned: "neutral", note: "neutral",
};

const fmtTs = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

function EventRow({ e }: { e: LedgerEvent }) {
  return (
    <li className="flex gap-3 border-b border-rule py-3 last:border-0">
      <div className="mt-0.5 w-[130px] shrink-0 font-mono text-[11.5px] text-text-muted">{fmtTs(e.ts)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={KIND_TONE[e.kind] ?? "neutral"}>{e.kind}</Pill>
          {e.from_status && e.to_status && (
            <span className="font-mono text-[11.5px] text-text-muted">{e.from_status} → {e.to_status}</span>
          )}
          <span className="text-[11.5px] text-text-muted">by {e.actor ?? "system"}</span>
        </div>
        <div className="mt-1 text-[13px] font-medium leading-snug">{e.title ?? e.action_key}</div>
        {e.note && <div className="mt-0.5 text-[12.5px] text-text-secondary">“{e.note}”</div>}
      </div>
    </li>
  );
}

export function Ledger() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["ledger", clientId], queryFn: () => getLedger(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const events = data?.events ?? [];
  const actions = data?.actions ?? [];

  const counts = actions.reduce<Record<string, number>>((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {});
  const order = ["accepted", "proposed", "snoozed", "done", "dismissed", "resolved"];

  return (
    <div className="mx-auto max-w-[820px] px-6 py-6">
      <h1 className="mb-4 text-[19px] font-semibold tracking-[-0.01em]">Ledger</h1>

      {actions.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-4 rounded-[10px] border border-border px-4 py-3 text-[12.5px]">
          {order.filter((s) => counts[s]).map((s) => (
            <div key={s}>
              <span className="font-mono text-[16px] font-semibold">{counts[s]}</span>{" "}
              <span className="text-text-muted">{s}</span>
            </div>
          ))}
        </div>
      )}

      {!events.length ? (
        <Empty what="No decisions recorded yet. Act on a recommendation to start the ledger." />
      ) : (
        <ul className="rounded-[10px] border border-border px-4">
          {events.map((e) => <EventRow key={e.event_id} e={e} />)}
        </ul>
      )}
    </div>
  );
}
