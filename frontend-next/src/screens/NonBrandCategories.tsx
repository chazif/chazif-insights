import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useBundle } from "../hooks/useBundle";
import type { NbCatRow } from "../lib/types";
import { money, num, moneyCompact, signedPct } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

// Category slice colours — neutral qualitative ramp (no lime; lime is reserved for interactive elements).
const PALETTE = ["#1a1a1a", "#6b7280", "#b45309", "#2563eb", "#15803d", "#9333ea", "#0891b2", "#dc2626", "#ca8a04"];

const chgCell = (v: number | null, betterUp = true) => {
  if (v == null) return <span className="text-text-disabled">—</span>;
  const good = betterUp ? v >= 0 : v <= 0;
  return <span className={good ? "text-positive" : "text-negative"}>{signedPct(v)}</span>;
};

export function NonBrandCategories() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [metric, setMetric] = useState<"spend" | "conv">("spend");
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.nb_categories_section;
  if (!sec?.rows?.length) return <Empty what="No non-brand category breakdown for this client." />;

  const isMoney = metric === "spend";
  // Charts exclude any embedded "NB TOTAL" summary row — it's a total, not a category.
  const catRows = sec.rows.filter((r) => !/\bNB\s*TOTAL\b/i.test(r.category));
  const val = (r: NbCatRow) => (isMoney ? r.spend_cur : r.conv_cur);
  const pieData = catRows.map((r) => ({ name: r.category, value: val(r) }));
  const barData = catRows.map((r) => ({
    category: r.category,
    prior: isMoney ? r.spend_prior : r.conv_prior,
    cur: isMoney ? r.spend_cur : r.conv_cur,
  }));
  const fmtVal = (v: number) => (isMoney ? money(v) : num(v, 1));
  const axisFmt = (v: number) => (isMoney ? moneyCompact(v) : num(v, 0));

  const cols: Column<NbCatRow>[] = [
    { key: "category", header: "Category", sort: (r) => r.category, render: (r) => <span className="rounded-[5px] bg-[#eef2ff] px-1.5 py-0.5 text-[12px] font-medium text-[#4338ca]">{r.category}</span>, csv: (r) => r.category },
    { key: "sp", header: `${sec.prior_label} Spend`, align: "right", sort: (r) => r.spend_prior, render: (r) => money(r.spend_prior), agg: { kind: "sum", get: (r) => r.spend_prior, fmt: (n) => money(n) }, csv: (r) => r.spend_prior },
    { key: "sc", header: `${sec.cur_label} Spend`, align: "right", sort: (r) => r.spend_cur, render: (r) => money(r.spend_cur), agg: { kind: "sum", get: (r) => r.spend_cur, fmt: (n) => money(n) }, csv: (r) => r.spend_cur },
    { key: "schg", header: "Chg", align: "right", sort: (r) => r.spend_chg ?? 0, render: (r) => chgCell(r.spend_chg), csv: (r) => r.spend_chg ?? "" },
    { key: "cp", header: `${sec.prior_label} Conv`, align: "right", sort: (r) => r.conv_prior, render: (r) => num(r.conv_prior, 1), agg: { kind: "sum", get: (r) => r.conv_prior, fmt: (n) => num(n, 1) }, csv: (r) => r.conv_prior },
    { key: "cc", header: `${sec.cur_label} Conv`, align: "right", sort: (r) => r.conv_cur, render: (r) => num(r.conv_cur, 1), agg: { kind: "sum", get: (r) => r.conv_cur, fmt: (n) => num(n, 1) }, csv: (r) => r.conv_cur },
    { key: "cchg", header: "Chg", align: "right", sort: (r) => r.conv_chg ?? 0, render: (r) => chgCell(r.conv_chg), csv: (r) => r.conv_chg ?? "" },
    { key: "pcpa", header: `${sec.prior_label} CPA`, align: "right", sort: (r) => r.cpa_prior, render: (r) => money(r.cpa_prior, 2), agg: { kind: "rate", num: (r) => r.spend_prior, den: (r) => r.conv_prior, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa_prior },
    { key: "cpa", header: `${sec.cur_label} CPA`, align: "right", sort: (r) => r.cpa_cur, render: (r) => money(r.cpa_cur, 2), agg: { kind: "rate", num: (r) => r.spend_cur, den: (r) => r.conv_cur, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa_cur },
    { key: "cpachg", header: "Chg", align: "right", sort: (r) => r.cpa_chg ?? 0, render: (r) => chgCell(r.cpa_chg, false), csv: (r) => r.cpa_chg ?? "" },
  ];

  const metricLabel = isMoney ? "Spend" : "Conversions";
  const toggle = (v: "spend" | "conv", label: string) => (
    <button
      onClick={() => setMetric(v)}
      className={`px-3 py-1 text-[13px] font-medium ${metric === v ? "bg-ink text-accent" : "bg-surface text-text-muted hover:text-ink"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-[18px] font-semibold">Non-Brand Categories</h2>
          <div className="text-[12.5px] text-text-muted">
            YoY by non-brand category · {sec.prior_label} vs {sec.cur_label} · bucketed from campaign structure
          </div>
        </div>
        <div>
          <div className="mb-1 text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">Chart metric</div>
          <div className="inline-flex overflow-hidden rounded-[7px] border border-border-strong divide-x divide-border-strong">
            {toggle("spend", "Spend")}
            {toggle("conv", "Conversions")}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 items-start gap-5">
        <Panel title={`${sec.cur_label} ${isMoney ? "spend" : "conversions"} share`}>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="42%"
                cy="50%"
                innerRadius="55%"
                outerRadius="82%"
                startAngle={90}
                /* A single 100% slice is exactly 360° — recharts fails to draw that sector,
                   so sweep 359.99° for one category (imperceptible gap, but it renders). */
                endAngle={pieData.length === 1 ? -269.99 : -270}
                paddingAngle={pieData.length > 1 ? 1 : 0}
                stroke="#fff"
                strokeWidth={2}
                isAnimationActive={false}
              >
                {pieData.map((_, i) => (
                  <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v: number, n: string) => [fmtVal(v), n]} contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
              <Legend layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 12, fontFamily: "Instrument Sans" }} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title={`YoY ${metricLabel}`}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={barData} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#f3f4f6" vertical={false} />
              <XAxis dataKey="category" tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "Instrument Sans" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} />
              <YAxis width={56} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={axisFmt} />
              <Tooltip formatter={(v: number, n: string) => [fmtVal(v), n]} contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
              <Legend wrapperStyle={{ fontSize: 12, fontFamily: "Instrument Sans" }} />
              <Bar dataKey="prior" name={sec.prior_label} fill="#9ca3af" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="cur" name={sec.cur_label} fill="#1a1a1a" radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="Category YoY detail">
          <DataTable rows={sec.rows} columns={cols} rowKey={(r) => r.category} totalsLabel="Non-Brand Total" exportName={`nb-categories-${clientId}`} />
        </Panel>
      </div>
    </div>
  );
}
