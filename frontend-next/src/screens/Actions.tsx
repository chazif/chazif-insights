import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getActions, transitionAction, assignAction } from "../lib/api";
import type { ActionItem, TransitionBody } from "../lib/types";
import { Pill } from "../components/ui/Pill";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const priorityTone = (p: string | null) => (/high/i.test(p ?? "") ? "neg" : /med/i.test(p ?? "") ? "warn" : "neutral") as "neg" | "warn" | "neutral";
const statusTone = (s: string) =>
  ({ proposed: "neutral", accepted: "pos", snoozed: "warn", dismissed: "neutral", done: "pos", resolved: "pos" }[s] ?? "neutral") as
    | "pos" | "warn" | "neg" | "neutral";

const FILTERS: { key: string; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "all", label: "All" },
  { key: "dismissed", label: "Dismissed" },
  { key: "done", label: "Done" },
];

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
const addDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

function ActionCard({ clientId, a }: { clientId: string; a: ActionItem }) {
  const qc = useQueryClient();
  const [showEvidence, setShowEvidence] = useState(false);
  const [mode, setMode] = useState<null | "snooze" | "dismiss">(null);
  const [note, setNote] = useState("");
  const [owner, setOwner] = useState(a.owner ?? "");
  const [err, setErr] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["actions", clientId] });
    qc.invalidateQueries({ queryKey: ["bundle", clientId] });
  };
  const trans = useMutation({
    mutationFn: (body: TransitionBody) => transitionAction(clientId, a.action_key, body),
    onSuccess: () => { setErr(null); setMode(null); setNote(""); invalidate(); },
    onError: (e: Error) => setErr(e.message),
  });
  const assign = useMutation({
    mutationFn: (o: string) => assignAction(clientId, a.action_key, { owner: o }),
    onSuccess: invalidate,
    onError: (e: Error) => setErr(e.message),
  });

  const ev = a.evidence && "data" in a.evidence ? a.evidence : null;
  const data = ev?.data ?? null;
  const busy = trans.isPending;
  const btn = "rounded-[6px] border border-border-strong px-2.5 py-1 text-[12px] hover:border-ink disabled:opacity-50";
  const primary = "rounded-[6px] bg-ink px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50";

  const terminal = a.status === "dismissed" || a.status === "done" || a.status === "resolved";

  return (
    <div className="rounded-[10px] border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={priorityTone(a.priority)}>{a.priority ?? "—"}</Pill>
        <Pill tone={statusTone(a.status)}>{a.status}</Pill>
        {a.status === "snoozed" && a.snooze_until && <span className="text-[11.5px] text-text-muted">until {fmtDate(a.snooze_until)}</span>}
        {!a.still_detected && a.status !== "resolved" && <span className="text-[11.5px] text-text-muted">· no longer detected</span>}
        <span className="ml-auto text-[11px] uppercase tracking-[0.05em] text-text-muted">{a.category}</span>
      </div>

      <h3 className="mt-2 text-[14px] font-semibold leading-snug">{a.title}</h3>
      {a.rationale && <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">{a.rationale}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-text-muted">
        {a.expected_impact && <span>Impact: <span className="font-medium text-text-secondary">{a.expected_impact}</span></span>}
        {a.effort && <span>Effort: <span className="font-medium text-text-secondary">{a.effort}</span></span>}
        <span className="flex items-center gap-1">
          Owner:
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            onBlur={() => owner !== (a.owner ?? "") && assign.mutate(owner)}
            placeholder="unassigned"
            className="w-24 rounded-[5px] border border-border px-1.5 py-0.5 text-[11.5px] outline-none focus:border-accent"
          />
        </span>
        {data && data.rows.length > 0 && (
          <button onClick={() => setShowEvidence((s) => !s)} className="ml-auto underline decoration-dotted underline-offset-2 hover:text-ink">
            {showEvidence ? "Hide data" : "See data"}
          </button>
        )}
      </div>

      {showEvidence && data && (
        <div className="mt-3 overflow-auto rounded-[8px] border border-border">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-surface-alt">
              <tr>{data.columns.map((c) => <th key={c} className="whitespace-nowrap border-b border-border px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.05em] text-text-muted">{c}</th>)}</tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="border-b border-rule last:border-0">
                  {row.map((cell, j) => <td key={j} className={`px-2.5 py-1.5 ${j === 0 ? "" : "text-right font-mono tabular-nums"}`}>{String(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!terminal && (
          <>
            {a.status !== "accepted" && <button className={primary} disabled={busy} onClick={() => trans.mutate({ to: "accepted" })}>Accept</button>}
            <button className={btn} disabled={busy} onClick={() => trans.mutate({ to: "done" })}>Done</button>
            <button className={btn} disabled={busy} onClick={() => setMode(mode === "snooze" ? null : "snooze")}>Snooze</button>
            <button className={btn} disabled={busy} onClick={() => setMode(mode === "dismiss" ? null : "dismiss")}>Dismiss</button>
          </>
        )}
        {terminal && <button className={btn} disabled={busy} onClick={() => trans.mutate({ to: "reopened" })}>Reopen</button>}
      </div>

      {mode === "snooze" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-text-muted">Snooze for</span>
          {[7, 14, 30].map((n) => (
            <button key={n} className={btn} disabled={busy} onClick={() => trans.mutate({ to: "snoozed", snooze_until: addDays(n) })}>{n}d</button>
          ))}
          <input type="date" className="rounded-[5px] border border-border px-1.5 py-0.5 text-[12px] outline-none focus:border-accent"
            onChange={(e) => e.target.value && trans.mutate({ to: "snoozed", snooze_until: e.target.value })} />
        </div>
      )}
      {mode === "dismiss" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (optional)"
            className="min-w-[220px] flex-1 rounded-[6px] border border-border px-2 py-1 text-[12.5px] outline-none focus:border-accent" />
          <button className={primary} disabled={busy} onClick={() => trans.mutate({ to: "dismissed", note: note || undefined })}>Dismiss</button>
        </div>
      )}
      {err && <p className="mt-2 text-[12px] text-negative">{err}</p>}
    </div>
  );
}

export function Actions() {
  const { clientId = "" } = useParams();
  const [filter, setFilter] = useState("open");
  const { data, isLoading, error } = useQuery({ queryKey: ["actions", clientId, filter], queryFn: () => getActions(clientId, filter) });

  return (
    <div className="mx-auto max-w-[900px] px-6 py-6">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em]">Actions</h1>
        <div className="ml-auto flex gap-1">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`rounded-[7px] px-2.5 py-1 text-[12.5px] ${filter === f.key ? "bg-ink text-white" : "border border-border-strong hover:border-ink"}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState msg={(error as Error).message} />
      ) : !data?.length ? (
        <Empty what={filter === "open" ? "No open actions — you're all caught up." : "Nothing here."} />
      ) : (
        <div className="flex flex-col gap-3">
          {data.map((a) => <ActionCard key={a.action_key} clientId={clientId} a={a} />)}
        </div>
      )}
    </div>
  );
}
