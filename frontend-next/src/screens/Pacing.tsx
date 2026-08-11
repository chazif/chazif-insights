import { useParams } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBundle } from "../hooks/useBundle";
import type { PacingMonth, PacingDaily, PacingDay } from "../lib/types";
import { money, moneyCompact, pct, signedPct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const statusOf = (p: number | null) => (p == null ? "n/a" : p > 1.05 ? "over" : p < 0.9 ? "under" : "on-track");
const statusTone = (s: string) => (s === "over" ? "neg" : s === "under" ? "warn" : s === "on-track" ? "pos" : "neutral") as "neg" | "warn" | "pos" | "neutral";
const paceColor = (p: number | null) => (p == null ? "text-text-disabled" : p > 1.05 ? "text-negative" : p < 0.9 ? "text-warning" : "text-positive");
const dayNo = (iso: string) => String(Number(iso.slice(8, 10)));

// Cumulative actual (ink) vs cumulative target (dashed grey). No lime — data series only.
function PacingChart({ days, budget }: { days: PacingDay[]; budget: number }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={days} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#f3f4f6" vertical={false} />
        <XAxis dataKey="date" tickFormatter={dayNo} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} minTickGap={14} />
        <YAxis width={52} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => moneyCompact(v)} />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12, fontFamily: "Instrument Sans" }}
          labelStyle={{ color: "#6b7280", fontSize: 11 }}
          labelFormatter={(l: string) => l}
          formatter={(value: number, name: string) => [money(value), name === "cum_spend" ? "Cumulative spend" : "Target"]}
        />
        <ReferenceLine y={budget} stroke="#d97706" strokeDasharray="2 3" strokeWidth={1} />
        <Line type="monotone" dataKey="cum_target" stroke="#9ca3af" strokeWidth={1.4} strokeDasharray="4 4" dot={false} />
        <Line type="monotone" dataKey="cum_spend" stroke="#1a1a1a" strokeWidth={1.8} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function DailyPacing({ clientId, d }: { clientId: string; d: PacingDaily }) {
  const proj = d.projection;
  const cols: Column<PacingDay>[] = [
    { key: "date", header: "Date", sort: (r) => r.date, render: (r) => <span className="font-medium">{r.date}</span>, csv: (r) => r.date },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend },
    { key: "cum", header: "Cumulative", align: "right", sort: (r) => r.cum_spend, render: (r) => money(r.cum_spend), csv: (r) => r.cum_spend },
    { key: "target", header: "Target", align: "right", sort: (r) => r.cum_target, render: (r) => <span className="text-text-tertiary">{money(r.cum_target)}</span>, csv: (r) => r.cum_target },
    { key: "pace", header: "Pace", align: "right", sort: (r) => r.pace_pct ?? 0, render: (r) => <span className={paceColor(r.pace_pct)}>{r.pace_pct == null ? "—" : pct(r.pace_pct, 0)}</span>, csv: (r) => r.pace_pct ?? "" },
    { key: "st", header: "Status", render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>, csv: (r) => r.status },
  ];
  return (
    <>
      <StatStrip
        stats={[
          { label: `MTD spend · ${d.month}`, value: money(d.mtd_spend), sub: `Target ${money(d.mtd_target)}` },
          { label: "Pace", value: d.pace_pct != null ? pct(d.pace_pct, 0) : "—", delta: d.pace_pct != null ? { text: `${signedPct(d.pace_pct - 1)} vs target`, good: d.status !== "over" } : undefined },
          { label: "Projected month-end", value: money(proj.spend), delta: proj.pct != null ? { text: `${signedPct(proj.variance / d.monthly_budget)} vs budget`, good: proj.status !== "over" } : undefined },
          { label: "Monthly budget", value: money(d.monthly_budget), sub: `${money(d.daily_budget)}/day` },
        ]}
      />
      <div className="mt-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[16px] font-semibold">Daily pacing · {d.month}</h2>
          <Pill tone={statusTone(d.status)}>{d.status}</Pill>
          <span className="ml-auto text-[11.5px] text-text-muted">through {d.data_through} · {d.days_with_data} day{d.days_with_data > 1 ? "s" : ""} of data</span>
        </div>
        <Panel>
          <PacingChart days={d.days} budget={d.monthly_budget} />
        </Panel>
        <p className="mt-2 text-[11.5px] text-text-muted">
          Solid = cumulative spend, dashed = flat daily-budget target, amber = monthly budget. Projection is a straight run-rate from the days with data.
        </p>
      </div>
      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">Day by day</h2>
        <DataTable rows={d.days} columns={cols} rowKey={(r) => r.date} exportName={`pacing-daily-${clientId}`} />
      </div>
    </>
  );
}

export function Pacing() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.budget_pacing;
  if (!sec?.months?.length) return <Empty what="No spend-vs-budget history for this client." />;

  const latest = sec.latest;
  const budget = sec.monthly_budget;
  const daily = sec.daily;

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
      render: (r) => (r.pct == null ? <span className="text-text-disabled">—</span> : <span className={paceColor(r.pct)}>{pct(r.pct, 0)}</span>),
      csv: (r) => r.pct ?? "",
    },
    { key: "st", header: "Status", render: (r) => <Pill tone={statusTone(statusOf(r.pct))}>{statusOf(r.pct)}</Pill>, csv: (r) => statusOf(r.pct) },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      {daily ? (
        <DailyPacing clientId={clientId} d={daily} />
      ) : (
        <StatStrip
          stats={[
            { label: "Monthly budget", value: budget != null ? money(budget) : "—" },
            ...(latest
              ? [
                  { label: `Spend · ${latest.month}`, value: money(latest.spend) },
                  { label: "Pacing", value: latest.pct != null ? pct(latest.pct, 0) : "—", delta: latest.pct != null ? { text: `${signedPct(latest.pct - 1)} vs budget`, good: (latest.variance ?? 0) <= 0 } : undefined },
                ]
              : []),
          ]}
        />
      )}

      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">Monthly spend vs budget</h2>
        <DataTable rows={sec.months} columns={cols} rowKey={(r) => r.month} exportName={`pacing-${clientId}`} />
        {!daily && <p className="mt-2 text-[11.5px] text-text-muted">Monthly adherence. Daily pacing unlocks with day-segmented campaign data and a monthly budget.</p>}
      </div>
    </div>
  );
}
