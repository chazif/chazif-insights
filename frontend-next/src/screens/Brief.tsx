import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { Recommendation } from "../lib/types";
import { money, num, pct, signedPct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const priorityTone = (p: string) => (/high/i.test(p) ? "neg" : /med/i.test(p) ? "warn" : "neutral") as "neg" | "warn" | "neutral";

function RecCard({ rec }: { rec: Recommendation }) {
  const [open, setOpen] = useState(false);
  const ev = rec.evidence;
  const data = ev?.data;
  return (
    <div className="rounded-[10px] border border-border p-4">
      <div className="flex items-start gap-2">
        <Pill tone={priorityTone(rec.Priority)}>{rec.Priority}</Pill>
        <span className="mt-[3px] text-[11px] font-medium uppercase tracking-[0.05em] text-text-muted">{rec.Category}</span>
      </div>
      <h3 className="mt-2 text-[14px] font-semibold leading-snug">{rec.Recommendation}</h3>
      {rec.status === "accepted" && (
        <div className="mt-1 text-[11.5px] font-medium text-positive">Accepted{rec.owner ? ` · ${rec.owner}` : ""}</div>
      )}
      <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">{rec.Rationale}</p>
      <div className="mt-2 flex items-center gap-4 text-[11.5px] text-text-muted">
        <span>Impact: <span className="font-medium text-text-secondary">{rec["Expected Impact"]}</span></span>
        <span>Effort: <span className="font-medium text-text-secondary">{rec.Effort}</span></span>
        {data && data.rows.length > 0 && (
          <button onClick={() => setOpen((o) => !o)} className="ml-auto rounded-[6px] border border-border-strong px-2 py-0.5 text-[11.5px] hover:border-ink">
            {open ? "Hide data" : "See data"}
          </button>
        )}
      </div>
      {open && data && (
        <div className="mt-3 overflow-auto rounded-[8px] border border-border">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-surface-alt">
              <tr>
                {data.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap border-b border-border px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.05em] text-text-muted">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="border-b border-rule last:border-0">
                  {row.map((cell, j) => (
                    <td key={j} className={`px-2.5 py-1.5 ${j === 0 ? "" : "text-right font-mono tabular-nums"}`}>{String(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Brief() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!data) return <Empty />;

  const trend = data.total_trend ?? [];
  const tot = trend[trend.length - 1];
  const kpis = data.kpis ?? [];
  const cmp = data.meta?.compare?.label ?? "YoY";
  const kget = (m: string) => kpis.find((k) => k.Metric === m)?.Change ?? null;
  const delta = (frac: number | null, betterUp = true) =>
    frac == null ? undefined : { text: `${signedPct(frac)} ${cmp}`, good: betterUp ? frac >= 0 : frac <= 0 };

  const findings = data.findings ?? [];
  // Open only — hide dismissed/done/resolved (and not-yet-due snoozes) once acted on.
  const recs = (data.recommendations ?? []).filter((r) => !r.status || r.status === "proposed" || r.status === "accepted");

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <h1 className="mb-4 text-[19px] font-semibold tracking-[-0.01em]">{data.meta?.name ?? "Brief"}</h1>

      {(data.meta?.mapping?.pending ?? 0) > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-[10px] border border-[#fcd34d] bg-[#fffbeb] px-4 py-2.5 text-[12.5px] text-[#92400e]">
          <strong>{data.meta!.mapping!.pending}</strong> new campaign{data.meta!.mapping!.pending > 1 ? "s were" : " was"} auto-mapped and need{data.meta!.mapping!.pending > 1 ? "" : "s"} review —{" "}
          <Link to={`/c/${clientId}/campaign-mapping`} className="font-medium underline hover:opacity-70">review mappings</Link>
        </div>
      )}

      {tot && (
        <StatStrip
          stats={[
            { label: "Spend", value: money(tot.Spend), delta: delta(kget("Total Spend")) },
            { label: "Main Conversions", value: num(tot["Main Conv"], 0), delta: delta(kget("Main Conversions")) },
            { label: "CPA", value: money(tot.CPA, 2), delta: delta(kget("CPA (Main Conv)"), false) },
            { label: "CVR", value: pct(tot.CVR, 2), delta: delta(kget("CVR (Main Conv)")) },
          ]}
        />
      )}

      <div className="mt-6 grid grid-cols-[1fr_1.4fr] items-start gap-5 max-[900px]:grid-cols-1">
        <Panel title="What's happening" sub={`${findings.length}`}>
          {findings.length ? (
            <ul className="flex flex-col gap-3">
              {findings.map((f, i) => (
                <li key={i}>
                  <div className="text-[13px] font-semibold">{f.topic}</div>
                  <div className="text-[12.5px] leading-relaxed text-text-secondary">{f.detail}</div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[12.5px] text-text-muted">No findings surfaced for this period.</div>
          )}
        </Panel>

        <div>
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-[16px] font-semibold">Recommended actions</h2>
            <span className="text-[12px] text-text-muted">{recs.length}</span>
          </div>
          {recs.length ? (
            <div className="flex flex-col gap-3">
              {recs.map((r, i) => (
                <RecCard key={i} rec={r} />
              ))}
            </div>
          ) : (
            <div className="rounded-[10px] border border-border p-4 text-[12.5px] text-text-muted">Nothing needs action right now.</div>
          )}
        </div>
      </div>
    </div>
  );
}
