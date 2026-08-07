import { useState } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { LpRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Pill } from "../components/ui/Pill";
import { FilterInput } from "../components/ui/FilterInput";
import { Loading, ErrorState, Empty } from "../components/ui/States";
import { scoreTone, shortUrl } from "../lib/grades";

export function LpPerformance() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [q, setQ] = useState("");
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const rows = data?.landing_pages_section?.performance ?? [];
  if (!rows.length) return <Empty what="No landing-page performance for this client." />;

  const s = q.trim().toLowerCase();
  const filtered = s ? rows.filter((r) => r.url.toLowerCase().includes(s)) : rows;

  const totalCost = rows.reduce((a, r) => a + r.cost, 0);
  const totalClicks = rows.reduce((a, r) => a + r.clicks, 0);
  const totalConv = rows.reduce((a, r) => a + r.conv, 0);

  const cols: Column<LpRow>[] = [
    { key: "url", header: "Landing page", sort: (r) => r.url, render: (r) => <span className="font-medium" title={r.url}>{shortUrl(r.url)}</span>, csv: (r) => r.url },
    { key: "score", header: "Score", sort: (r) => r.score, render: (r) => <Pill tone={scoreTone(r.score)}>{r.score}</Pill>, csv: (r) => r.score },
    { key: "cost", header: "Cost", align: "right", sort: (r) => r.cost, render: (r) => money(r.cost), agg: { kind: "sum", get: (r) => r.cost, fmt: (n) => money(n) }, csv: (r) => r.cost },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
    { key: "cvr", header: "CVR", align: "right", sort: (r) => r.cvr, render: (r) => pct(r.cvr, 2), agg: { kind: "rate", num: (r) => r.conv, den: (r) => r.clicks, fmt: (n) => pct(n, 2) }, csv: (r) => r.cvr },
    { key: "cpa", header: "CPA", align: "right", sort: (r) => r.cpa ?? Number.POSITIVE_INFINITY, render: (r) => (r.cpa ? money(r.cpa, 2) : "—"), agg: { kind: "rate", num: (r) => r.cost, den: (r) => r.conv, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa ?? "" },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Cost", value: money(totalCost) },
          { label: "Clicks", value: num(totalClicks) },
          { label: "Conversions", value: num(totalConv, 1) },
          { label: "Blended CVR", value: pct(totalClicks ? totalConv / totalClicks : 0, 2) },
        ]}
      />
      <div className="mb-3 mt-6 flex items-center gap-3">
        <h2 className="text-[16px] font-semibold">Landing pages</h2>
        <span className="text-[12px] text-text-muted">{num(filtered.length)} of {num(rows.length)}</span>
        <div className="ml-auto">
          <FilterInput value={q} onChange={setQ} placeholder="Filter URL…" />
        </div>
      </div>
      <DataTable rows={filtered} columns={cols} rowKey={(r, i) => r.url + "|" + i} totalsLabel="Total" exportName={`lp-performance-${clientId}`} />
    </div>
  );
}
