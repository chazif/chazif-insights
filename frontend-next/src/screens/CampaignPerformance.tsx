import { useParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBundle } from "../hooks/useBundle";
import type { CampaignRow } from "../lib/types";
import { money, num, pct, moneyCompact, signedPct } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

export function CampaignPerformance() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const camp = data?.campaigns;
  if (!camp || camp.rows.length === 0) return <Empty />;

  const rows = camp.rows;
  const barData = rows.map((r) => ({ campaign: r.campaign, cost: r.cost }));

  const columns: Column<CampaignRow>[] = [
    { key: "campaign", header: "Campaign", sort: (r) => r.campaign, render: (r) => <span className="font-medium">{r.campaign}</span>, csv: (r) => r.campaign },
    { key: "type", header: "Type", sort: (r) => r.type, render: (r) => <span className="text-text-tertiary">{r.type || "—"}</span>, csv: (r) => r.type },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks },
    { key: "cost", header: "Cost", align: "right", sort: (r) => r.cost, render: (r) => money(r.cost), agg: { kind: "sum", get: (r) => r.cost, fmt: (n) => money(n) }, csv: (r) => r.cost },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
    // CPA/CVR are per-row only — the account-total row leaves them blank (matches the original).
    { key: "cpa", header: "CPA", align: "right", sort: (r) => r.cpa, render: (r) => money(r.cpa, 2), csv: (r) => r.cpa },
    { key: "cvr", header: "CVR", align: "right", sort: (r) => r.cvr, render: (r) => pct(r.cvr, 2), csv: (r) => r.cvr },
    { key: "share", header: "% Spend", align: "right", sort: (r) => r.share, render: (r) => `${(r.share * 100).toFixed(0)}%`, agg: { kind: "sum", get: (r) => r.share, fmt: (n) => `${(n * 100).toFixed(0)}%` }, csv: (r) => r.share },
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
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-5">
        <h2 className="text-[18px] font-semibold">Campaign Performance</h2>
        <div className="text-[12.5px] text-text-muted">{camp.month} snapshot · Δ Conv vs {camp.prior_month}</div>
      </div>

      <Panel title={`Spend by campaign · ${camp.month}`}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={barData} margin={{ top: 8, right: 12, left: 8, bottom: 8 }}>
            <CartesianGrid stroke="#f3f4f6" vertical={false} />
            <XAxis dataKey="campaign" tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "Instrument Sans" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} interval={0} height={44} />
            <YAxis
              width={64}
              tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => moneyCompact(v)}
              label={{ value: "Cost ($)", angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "#6b7280", fontFamily: "Instrument Sans" } }}
            />
            <Tooltip formatter={(v: number) => [money(v), "Cost"]} contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
            <Bar dataKey="cost" name="Cost" fill="#cfff04" stroke="#1a1a1a" strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <div className="mt-6">
        <Panel>
          <DataTable rows={rows} columns={columns} rowKey={(r) => r.campaign} totalsLabel="Account total" exportName={`campaigns-${clientId}`} />
        </Panel>
      </div>
    </div>
  );
}
