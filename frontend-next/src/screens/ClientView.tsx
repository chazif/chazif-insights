import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle, getActions } from "../lib/api";
import type { KpiRow, ActionItem } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { Loading, ErrorState } from "../components/ui/States";

const kget = (kpis: KpiRow[], metric: string) => {
  const r = kpis.find((k) => k.Metric === metric);
  return r ? { cur: Number(r["Mar 2026"]), prior: Number(r["Mar 2025"]), chg: r.Change } : null;
};
const pctAbs = (v: number) => pct(Math.abs(v), 0);

// A cell in the four-up KPI grid. `betterUp` decides the green/red on the change;
// pass null for a metric with no inherent good direction (spend), shown muted.
function Kpi({ label, value, chg, betterUp }: { label: string; value: string; chg: number | null; betterUp: boolean | null }) {
  const good = chg == null || betterUp == null ? null : betterUp ? chg >= 0 : chg <= 0;
  return (
    <div className="bg-white px-5 py-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-text-muted">{label}</div>
      <div className="mt-1 font-mono text-[22px] font-semibold tracking-[-0.02em]">{value}</div>
      {chg != null && (
        <div className={`mt-0.5 text-[12px] font-medium ${good == null ? "text-text-muted" : good ? "text-[#15803d]" : "text-negative"}`}>
          {chg >= 0 ? "+" : ""}{pct(chg, 0)} YoY
        </div>
      )}
    </div>
  );
}

export function ClientView() {
  const { clientId = "" } = useParams();
  const bundle = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });
  const actions = useQuery({ queryKey: ["actions", clientId, "all"], queryFn: () => getActions(clientId, "all") });

  if (bundle.isLoading) return <Loading />;
  if (bundle.error) return <ErrorState msg={(bundle.error as Error).message} />;
  const b = bundle.data;
  if (!b) return <ErrorState msg="No data for this client." />;

  const kpis = b.kpis ?? [];
  const conv = kget(kpis, "Main Conversions");
  const spend = kget(kpis, "Total Spend");
  const cpa = kget(kpis, "CPA (Main Conv)");
  const cvr = kget(kpis, "CVR (Main Conv)");
  const curLabel = b.meta?.periods?.current ?? "this period";

  const headline =
    conv?.chg == null
      ? `Your ${curLabel} performance at a glance.`
      : conv.chg >= 0.02
      ? `Conversions grew ${pctAbs(conv.chg)} year over year.`
      : conv.chg <= -0.02
      ? `Conversions softened ${pctAbs(conv.chg)} — here's the plan.`
      : `A steady quarter, holding results year over year.`;

  const para =
    conv && spend && cpa
      ? `In ${curLabel}, the account drove ${num(conv.cur, 0)} conversions on ${money(spend.cur)} of spend, at ${money(cpa.cur, 2)} per conversion.`
      : `A summary of your account's recent performance.`;

  const done = (actions.data ?? []).filter((a: ActionItem) => a.status === "done");

  const now = new Date();
  const nextReview = new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="min-h-full bg-rule px-6 py-8">
      <div className="mx-auto max-w-[900px] rounded-[12px] bg-white px-10 py-9 shadow-[0_1px_3px_rgba(26,26,26,0.06)]">
        {/* identity */}
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div className="text-[15px] font-semibold">{b.meta?.name ?? clientId}</div>
          <div className="text-[12.5px] text-text-muted">Performance summary · {curLabel}</div>
        </div>

        {/* headline */}
        <h1 className="mt-6 font-display text-[30px] leading-tight tracking-[-0.01em]">{headline}</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">{para}</p>

        {/* KPI grid */}
        <div className="mt-6 grid grid-cols-4 gap-px overflow-hidden rounded-[10px] bg-border max-[640px]:grid-cols-2">
          <Kpi label="Spend" value={money(spend?.cur ?? 0)} chg={spend?.chg ?? null} betterUp={null} />
          <Kpi label="Conversions" value={num(conv?.cur ?? 0, 0)} chg={conv?.chg ?? null} betterUp={true} />
          <Kpi label="Cost / conv." value={money(cpa?.cur ?? 0, 2)} chg={cpa?.chg ?? null} betterUp={false} />
          <Kpi label="Conv. rate" value={pct(cvr?.cur ?? 0, 2)} chg={cvr?.chg ?? null} betterUp={true} />
        </div>

        {/* what we did */}
        <h2 className="mt-8 text-[15px] font-semibold">What we did</h2>
        {done.length ? (
          <ul className="mt-3 flex flex-col gap-4">
            {done.map((a) => (
              <li key={a.action_key} className="flex gap-4 border-b border-rule pb-4 last:border-0">
                <div className="w-[92px] shrink-0 text-[12px] text-text-muted">
                  {a.updated_at ? new Date(a.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold leading-snug">{a.title}</div>
                  {a.rationale && <div className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">{a.rationale}</div>}
                </div>
                {a.evidence && "magnitude" in a.evidence && a.evidence.magnitude && (
                  <div className="shrink-0 self-center font-mono text-[14px] font-semibold text-[#15803d]">{a.evidence.magnitude}</div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[13px] text-text-muted">Completed optimizations will appear here after your next review.</p>
        )}

        {/* footer */}
        <div className="mt-8 border-t border-border pt-4 text-[12px] text-text-muted">
          Next review: {nextReview}. Questions about your account? Reach out to your SearchNex team.
        </div>
      </div>
    </div>
  );
}
