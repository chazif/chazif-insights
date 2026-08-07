import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle } from "../lib/api";
import type { CampaignRow } from "../lib/types";
import { money, num, pct, signedPct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { DataTable, type Column } from "../components/ui/DataTable";
import { InlineBarCell } from "../components/ui/InlineBarCell";
import { Pill } from "../components/ui/Pill";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const FLOOR = 30; // Smart Bidding conversions/month floor (below it a campaign can't bid efficiently)

export function CampaignPerformance() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const camp = data?.campaigns;
  if (!camp || camp.rows.length === 0) return <Empty />;

  const rows = camp.rows;
  const t = camp.totals;
  const belowFloor = rows.filter((r) => r.conv < FLOOR && r.cost > 0).length;
  const cmpLabel = data?.meta?.compare?.label ?? "YoY";
  const kget = (metric: string) => (data?.kpis ?? []).find((k) => k.Metric === metric)?.Change ?? null;
  const delta = (frac: number | null, betterWhenUp = true) =>
    frac == null ? undefined : { text: `${signedPct(frac)} ${cmpLabel}`, good: betterWhenUp ? frac >= 0 : frac <= 0 };

  const cpaTotal = t.conv ? t.cost / t.conv : 0;
  const cvrTotal = t.clicks ? t.conv / t.clicks : 0;

  const columns: Column<CampaignRow>[] = [
    { key: "campaign", header: "Campaign", sort: (r) => r.campaign, render: (r) => <span className="font-medium">{r.campaign}</span>, csv: (r) => r.campaign },
    { key: "type", header: "Type", sort: (r) => r.type, render: (r) => <span className="text-text-tertiary">{r.type || "—"}</span>, csv: (r) => r.type },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sort: (r) => r.cost,
      render: (r) => <InlineBarCell figure={money(r.cost)} share={r.share} flagged={r.conv < FLOOR && r.cost > 0} />,
      agg: { kind: "sum", get: (r) => r.cost, fmt: (n) => money(n) },
      csv: (r) => r.cost,
    },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
    {
      key: "cpa",
      header: "CPA",
      align: "right",
      sort: (r) => r.cpa,
      render: (r) => (r.cpa ? money(r.cpa, 2) : "—"),
      agg: { kind: "rate", num: (r) => r.cost, den: (r) => r.conv, fmt: (n) => money(n, 2) },
      csv: (r) => r.cpa,
    },
    {
      key: "cvr",
      header: "CVR",
      align: "right",
      sort: (r) => r.cvr,
      render: (r) => pct(r.cvr, 2),
      agg: { kind: "rate", num: (r) => r.conv, den: (r) => r.clicks, fmt: (n) => pct(n, 2) },
      csv: (r) => r.cvr,
    },
    {
      key: "dconv",
      header: "Δ Conv",
      align: "right",
      sort: (r) => r.d_conv ?? Number.NEGATIVE_INFINITY,
      render: (r) =>
        r.d_conv == null ? (
          <span className="text-text-disabled">—</span>
        ) : (
          <span className={r.d_conv >= 0 ? "text-positive" : "text-negative"}>{signedPct(r.d_conv, 0)}</span>
        ),
      csv: (r) => (r.d_conv == null ? "" : r.d_conv),
    },
    {
      key: "flag",
      header: "Flag",
      render: (r) =>
        r.cost <= 0 ? <Pill tone="warn">No delivery</Pill> : r.conv < FLOOR ? <Pill tone="warn">Below floor</Pill> : <span className="text-text-disabled">—</span>,
      csv: (r) => (r.cost <= 0 ? "No delivery" : r.conv < FLOOR ? "Below floor" : ""),
    },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Spend", value: money(t.cost), delta: delta(kget("Total Spend")) },
          { label: "Conversions", value: num(t.conv, 0), delta: delta(kget("Main Conversions")) },
          { label: "CPA", value: money(cpaTotal, 2), delta: delta(kget("CPA (Main Conv)"), false) },
          { label: "CVR", value: pct(cvrTotal, 2), delta: delta(kget("CVR (Main Conv)")) },
          { label: "Below bidding floor", value: `${belowFloor} of ${rows.length}`, sub: `campaigns < ${FLOOR} conv/mo` },
        ]}
      />

      <div className="mt-6">
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-[16px] font-semibold">Spend &amp; efficiency by campaign</h2>
          <span className="text-[12px] text-text-muted">{camp.month} · bar length = share of spend</span>
        </div>
        <DataTable rows={rows} columns={columns} rowKey={(r) => r.campaign} totalsLabel="Account total" exportName={`campaigns-${clientId}`} />
        <p className="mt-2 text-[11.5px] text-text-muted">
          One totals row, not two. Counts and currency sum; CPA and CVR are weighted averages; ratio columns that cannot be aggregated stay blank.
        </p>
      </div>
    </div>
  );
}
