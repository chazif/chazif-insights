import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle } from "../lib/api";
import type { KpiRow } from "../lib/types";
import { money, num, pct, signedPct, smart } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { TrendChart } from "../components/ui/TrendChart";
import { Panel } from "../components/ui/Panel";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const isCost = (m: string) => /CPA|CPC|Cost/i.test(m);

export function Overview() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const trend = data?.total_trend ?? [];
  if (!trend.length) return <Empty />;

  const tot = trend[trend.length - 1];
  const kpis = data?.kpis ?? [];
  const cmp = data?.meta?.compare?.label ?? "YoY";
  const priorLabel = data?.meta?.periods?.prior ?? "Prior";
  const curLabel = data?.meta?.periods?.current ?? "Current";
  const kget = (m: string) => kpis.find((k) => k.Metric === m)?.Change ?? null;
  const delta = (frac: number | null, betterUp = true) =>
    frac == null ? undefined : { text: `${signedPct(frac)} ${cmp}`, good: betterUp ? frac >= 0 : frac <= 0 };

  const scoreCols: Column<KpiRow>[] = [
    { key: "metric", header: "Metric", sort: (r) => r.Metric, render: (r) => <span className="font-medium">{r.Metric}</span> },
    { key: "prior", header: priorLabel, align: "right", render: (r) => smart(r.Metric, Number(r["Mar 2025"])) },
    { key: "cur", header: curLabel, align: "right", render: (r) => smart(r.Metric, Number(r["Mar 2026"])) },
    {
      key: "chg",
      header: cmp,
      align: "right",
      render: (r) =>
        r.Change == null ? (
          <span className="text-text-disabled">—</span>
        ) : (
          <span className={(isCost(r.Metric) ? r.Change <= 0 : r.Change >= 0) ? "text-positive" : "text-negative"}>{signedPct(r.Change)}</span>
        ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Spend", value: money(tot.Spend), delta: delta(kget("Total Spend")) },
          { label: "Main Conversions", value: num(tot["Main Conv"], 0), delta: delta(kget("Main Conversions")) },
          { label: "CPA", value: money(tot.CPA, 2), delta: delta(kget("CPA (Main Conv)"), false) },
          { label: "CVR", value: pct(tot.CVR, 2), delta: delta(kget("CVR (Main Conv)")) },
        ]}
      />
      <div className="mt-6 grid grid-cols-[1.5fr_1fr] items-start gap-5">
        <Panel title={`Spend & conversions — ${trend.length} months`}>
          <TrendChart data={trend} />
        </Panel>
        <Panel title="KPI scorecard" sub={cmp}>
          <DataTable rows={kpis} columns={scoreCols} rowKey={(r) => r.Metric} exportName={`kpis-${clientId}`} />
        </Panel>
      </div>
    </div>
  );
}
