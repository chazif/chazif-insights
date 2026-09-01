import { useState } from "react";
import { useParams } from "react-router-dom";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBundle } from "../hooks/useBundle";
import type { TrendPoint } from "../lib/types";
import { money, num, pct, moneyCompact } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

// Metric keys as they appear on a TrendPoint (Web Res / Phone Calls / CPC are only present
// for clients that track them — absent → "—" in the table and an empty line in the chart).
const METRICS: { value: string; label: string }[] = [
  { value: "Spend", label: "Spend" },
  { value: "Main Conv", label: "Main Conversions" },
  { value: "Clicks", label: "Clicks" },
  { value: "CPA", label: "CPA" },
  { value: "CVR", label: "CVR" },
  { value: "Web Res", label: "Web Reservations" },
  { value: "Phone Calls", label: "Phone Calls" },
];
const labelOf = (v: string) => METRICS.find((m) => m.value === v)?.label ?? v;
const kind = (m: string) => (/CVR|Rate/i.test(m) ? "pct" : /CPA|CPC|Spend|Cost/i.test(m) ? "money" : "num");
const fmtMetric = (m: string, v: number) => {
  const k = kind(m);
  return k === "pct" ? pct(v, 2) : k === "money" ? money(v, /Spend/i.test(m) ? 0 : 2) : num(v, 0);
};
const axisFmt = (m: string) => (v: number) => {
  const k = kind(m);
  return k === "money" ? moneyCompact(v) : k === "pct" ? pct(v, 0) : num(v, 0);
};
const ext = (r: TrendPoint, k: string) => (r as unknown as Record<string, number | undefined>)[k] as number;

const selectCls =
  "rounded-[7px] border border-border-strong bg-surface px-2.5 py-1 text-[13px] hover:border-ink focus:border-ink focus:outline-none";

export function MonthlyTrends() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [primary, setPrimary] = useState("Main Conv");
  const [secondary, setSecondary] = useState("");
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const trend = data?.total_trend ?? [];
  if (!trend.length) return <Empty />;
  const name = data?.meta?.name || "All brands combined";

  const cols: Column<TrendPoint>[] = [
    { key: "month", header: "Month", sort: (r) => r.Month, render: (r) => <span className="font-medium">{r.Month}</span>, csv: (r) => r.Month },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.Spend, render: (r) => money(r.Spend), agg: { kind: "sum", get: (r) => r.Spend, fmt: (n) => money(n) }, csv: (r) => r.Spend },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.Clicks, render: (r) => num(r.Clicks), agg: { kind: "sum", get: (r) => r.Clicks, fmt: (n) => num(n) }, csv: (r) => r.Clicks },
    { key: "conv", header: "Main Conv", align: "right", sort: (r) => r["Main Conv"], render: (r) => num(r["Main Conv"], 0), agg: { kind: "sum", get: (r) => r["Main Conv"], fmt: (n) => num(n, 0) }, csv: (r) => r["Main Conv"] },
    { key: "cpa", header: "CPA", align: "right", sort: (r) => r.CPA, render: (r) => money(r.CPA, 2), agg: { kind: "rate", num: (r) => r.Spend, den: (r) => r["Main Conv"], fmt: (n) => money(n, 2) }, csv: (r) => r.CPA },
    { key: "cvr", header: "CVR", align: "right", sort: (r) => r.CVR, render: (r) => pct(r.CVR, 2), agg: { kind: "rate", num: (r) => r["Main Conv"], den: (r) => r.Clicks, fmt: (n) => pct(n, 2) }, csv: (r) => r.CVR },
    { key: "cpc", header: "CPC", align: "right", sort: (r) => ext(r, "CPC") ?? 0, render: (r) => money(ext(r, "CPC"), 2), csv: (r) => ext(r, "CPC") },
    { key: "webres", header: "Web Res", align: "right", sort: (r) => ext(r, "Web Res") ?? 0, render: (r) => num(ext(r, "Web Res")), csv: (r) => ext(r, "Web Res") },
    { key: "calls", header: "Phone Calls", align: "right", sort: (r) => ext(r, "Phone Calls") ?? 0, render: (r) => num(ext(r, "Phone Calls")), csv: (r) => ext(r, "Phone Calls") },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold">Monthly Trends</h2>
        <div className="text-[12.5px] text-text-muted">{trend.length}-month view across all metrics · {name}</div>
      </div>

      <Panel>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-text-secondary">
          <label htmlFor="mt-primary">Primary (left axis):</label>
          <select id="mt-primary" className={selectCls} value={primary} onChange={(e) => setPrimary(e.target.value)}>
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <label htmlFor="mt-secondary" className="ml-3">Secondary (right axis):</label>
          <select id="mt-secondary" className={selectCls} value={secondary} onChange={(e) => setSecondary(e.target.value)}>
            <option value="">None</option>
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={trend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#f3f4f6" vertical={false} />
            <XAxis dataKey="Month" tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} minTickGap={16} />
            <YAxis yAxisId="left" width={56} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={axisFmt(primary)} />
            {secondary && (
              <YAxis yAxisId="right" orientation="right" width={52} tick={{ fontSize: 11, fill: "#b45309", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={axisFmt(secondary)} />
            )}
            <Tooltip
              contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12, fontFamily: "Instrument Sans" }}
              labelStyle={{ color: "#6b7280", fontSize: 11 }}
              formatter={(value: number, nm: string) => [fmtMetric(nm, value), nm]}
            />
            <Legend wrapperStyle={{ fontSize: 12, fontFamily: "Instrument Sans" }} />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey={primary}
              name={labelOf(primary)}
              stroke="#1a1a1a"
              strokeWidth={1.8}
              fill="rgba(26,26,26,0.05)"
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            {secondary && (
              <Line
                yAxisId="right"
                type="monotone"
                dataKey={secondary}
                name={labelOf(secondary)}
                stroke="#b45309"
                strokeWidth={1.8}
                strokeDasharray="6 3"
                fill="none"
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>

      <div className="mt-6">
        <Panel title="All months — data table">
          <DataTable rows={trend} columns={cols} rowKey={(r) => r.Month} totalsLabel="Total" exportName={`trends-${clientId}`} />
        </Panel>
      </div>
    </div>
  );
}
