import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle } from "../lib/api";
import type { PacingMonth } from "../lib/types";
import { money, pct, signedPct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const statusOf = (p: number | null) => (p == null ? "n/a" : p > 1.05 ? "over" : p < 0.9 ? "under" : "on-track");
const statusTone = (s: string) => (s === "over" ? "neg" : s === "under" ? "warn" : s === "on-track" ? "pos" : "neutral") as "neg" | "warn" | "pos" | "neutral";

export function Pacing() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.budget_pacing;
  if (!sec?.months?.length) return <Empty what="No spend-vs-budget history for this client." />;

  const latest = sec.latest;
  const budget = sec.monthly_budget;

  const cols: Column<PacingMonth>[] = [
    { key: "month", header: "Month", sort: (r) => r.month, render: (r) => <span className="font-medium">{r.month}</span>, csv: (r) => r.month },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend },
    { key: "budget", header: "Budget", align: "right", sort: (r) => r.budget ?? 0, render: (r) => (r.budget != null ? money(r.budget) : "—"), csv: (r) => r.budget ?? "" },
    {
      key: "var", header: "Variance", align: "right", sort: (r) => r.variance ?? 0,
      render: (r) => (r.variance == null ? <span className="text-text-disabled">—</span> : <span className={r.variance > 0 ? "text-negative" : "text-positive"}>{r.variance > 0 ? "+" : ""}{money(r.variance)}</span>),
      csv: (r) => r.variance ?? "",
    },
    {
      key: "pct", header: "% of budget", align: "right", sort: (r) => r.pct ?? 0,
      render: (r) => (r.pct == null ? <span className="text-text-disabled">—</span> : <span className={r.pct > 1.05 ? "text-negative" : r.pct < 0.9 ? "text-warning" : "text-positive"}>{pct(r.pct, 0)}</span>),
      csv: (r) => r.pct ?? "",
    },
    { key: "st", header: "Status", render: (r) => <Pill tone={statusTone(statusOf(r.pct))}>{statusOf(r.pct)}</Pill>, csv: (r) => statusOf(r.pct) },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Monthly budget", value: budget != null ? money(budget) : "—" },
          ...(latest
            ? [
                { label: `Spend · ${latest.month}`, value: money(latest.spend) },
                {
                  label: "Pacing",
                  value: latest.pct != null ? pct(latest.pct, 0) : "—",
                  delta: latest.pct != null ? { text: `${signedPct(latest.pct - 1)} vs budget`, good: (latest.variance ?? 0) <= 0 } : undefined,
                },
              ]
            : []),
        ]}
      />
      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">Monthly spend vs budget</h2>
        <DataTable rows={sec.months} columns={cols} rowKey={(r) => r.month} exportName={`pacing-${clientId}`} />
        <p className="mt-2 text-[11.5px] text-text-muted">Monthly adherence. Intra-month (daily) pacing needs day-segmented exports.</p>
      </div>
    </div>
  );
}
