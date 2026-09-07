import { useParams } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBundle } from "../hooks/useBundle";
import type { PacingMonth, PacingDaily, PacingDay, PacingGrid, PacingGridRow, PacingWindow } from "../lib/types";
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

// ---- Segment pacing board (the consistent 1..N-row view) --------------------
const SOURCE_LABEL: Record<PacingGrid["source"], string> = {
  allocation: "Allocation run", lines: "Budget lines", total: "Total budget", none: "No budget set",
};
const diffTone = (s: string) => (s === "over" ? "text-negative" : s === "under" ? "text-warning" : s === "on-track" ? "text-positive" : "text-text-disabled");

// Heat for a single day cell: spend vs the row's daily-average target. Green on/near pace,
// amber then red as it deviates in either direction; a zero-spend day reads as a miss.
// undefined spend = a future day (no data yet).
function heat(spend: number | undefined, daily: number | null): { bg: string; fg?: string } {
  if (spend === undefined) return { bg: "#f4f5f6", fg: "#c2c7cd" };
  if (!daily) return { bg: "#eef2f6" };
  if (spend === 0) return { bg: "#fbe0e0" };
  const dev = Math.abs(spend / daily - 1);
  if (dev <= 0.15) return { bg: "#dff0e4" };
  if (dev <= 0.40) return { bg: "#fdeede" };
  return { bg: "#fbe0e0" };
}

const NUM = "px-2 py-1 text-right tabular-nums whitespace-nowrap";

function WinCells({ w }: { w: PacingWindow | null }) {
  if (!w) return (<><td className={`${NUM} text-text-disabled`}>—</td><td className={`${NUM} text-text-disabled`}>—</td></>);
  return (
    <>
      <td className={NUM}>{money(w.spend)}</td>
      <td className={`${NUM} ${diffTone(w.status)}`} title={w.diff != null ? `${w.diff >= 0 ? "+" : ""}${money(w.diff)} vs pace` : ""}>
        {w.diff_pct != null ? signedPct(w.diff_pct) : "—"}
      </td>
    </>
  );
}

function BoardRow({ row, calendar, showDays, isTotal }: { row: PacingGridRow; calendar: string[]; showDays: boolean; isTotal?: boolean }) {
  const dayMap = new Map(row.days.map((d) => [d.date, d.spend]));
  const base = isTotal ? "border-t-2 border-border-strong font-semibold bg-surface-alt" : "";
  return (
    <tr className={`border-b border-border ${base}`}>
      <td className={`sticky left-0 z-10 px-3 py-1.5 whitespace-nowrap font-medium ${isTotal ? "bg-surface-alt" : "bg-surface"}`}>{row.label}</td>
      <td className={NUM}>{row.month_budget != null ? money(row.month_budget) : "—"}</td>
      <td className={`${NUM} text-text-muted`}>{row.daily_budget != null ? money(row.daily_budget) : "—"}</td>
      <WinCells w={row.mtd} /><WinCells w={row.yesterday} /><WinCells w={row.last3} /><WinCells w={row.last7} />
      <td className={NUM}>{row.rest.left != null ? money(row.rest.left) : "—"}</td>
      <td className={`${NUM} text-text-muted`}>{row.rest.daily_sugg != null ? money(row.rest.daily_sugg) : "—"}</td>
      {showDays && calendar.map((date) => {
        const spend = dayMap.get(date);
        const h = heat(spend, row.daily_budget);
        return (
          <td key={date} className="px-1 py-1 text-right tabular-nums text-[10.5px] border-l border-[rgba(0,0,0,0.03)]"
            style={{ background: h.bg, color: h.fg }} title={spend != null ? `${date} · ${money(spend)}` : date}>
            {spend != null ? moneyCompact(spend) : ""}
          </td>
        );
      })}
    </tr>
  );
}

function PacingBoard({ grid }: { grid: PacingGrid }) {
  const showDays = grid.has_daily && grid.calendar.length > 0;
  const through = grid.data_through ? Number(grid.data_through.slice(8, 10)) : null;
  const grp = "px-2 py-1 text-[10px] uppercase tracking-[0.05em] text-text-muted font-semibold text-center border-b border-border";
  const sub = "px-2 py-1 text-[10px] uppercase tracking-[0.04em] text-text-muted font-semibold text-right whitespace-nowrap border-b-2 border-border-strong";
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-[16px] font-semibold">Pacing · {grid.month}</h2>
        <Pill tone="neutral">{SOURCE_LABEL[grid.source]}</Pill>
        <Pill tone="stage">{grid.segmented ? `${grid.rows.length} segment${grid.rows.length > 1 ? "s" : ""}` : "Whole account"}</Pill>
        <span className="ml-auto text-[11.5px] text-text-muted">
          {grid.data_through ? `through ${grid.data_through} · ${grid.days_left} day${grid.days_left === 1 ? "" : "s"} left` : "month totals"}
        </span>
      </div>

      {!grid.has_daily && (
        <p className="mb-2 rounded-[7px] border border-border bg-surface-alt px-3 py-2 text-[12px] text-text-secondary">
          Day-level data isn't available for this client yet, so the heat calendar and short windows are hidden — the summary shows month totals. Upload day-segmented campaign data to unlock the full board.
        </p>
      )}

      <Panel className="overflow-x-auto p-0">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th rowSpan={2} className="sticky left-0 z-20 bg-surface px-3 py-1 text-left text-[10px] uppercase tracking-[0.05em] text-text-muted font-semibold border-b-2 border-border-strong">Segment</th>
              <th colSpan={2} className={grp}>Budget</th>
              <th colSpan={2} className={grp}>MTD</th>
              <th colSpan={2} className={grp}>Yesterday</th>
              <th colSpan={2} className={grp}>Last 3</th>
              <th colSpan={2} className={grp}>Last 7</th>
              <th colSpan={2} className={grp}>Rest of month</th>
              {showDays && <th colSpan={grid.calendar.length} className={grp}>Daily spend · {grid.month}</th>}
            </tr>
            <tr>
              <th className={sub}>Month</th><th className={sub}>Daily</th>
              <th className={sub}>Spend</th><th className={sub}>Δ%</th>
              <th className={sub}>Spend</th><th className={sub}>Δ%</th>
              <th className={sub}>Spend</th><th className={sub}>Δ%</th>
              <th className={sub}>Spend</th><th className={sub}>Δ%</th>
              <th className={sub}>Left</th><th className={sub}>/day</th>
              {showDays && grid.calendar.map((d) => {
                const n = Number(d.slice(8, 10));
                const future = through != null && n > through;
                return <th key={d} className={`px-1 py-1 text-[10px] text-right border-b-2 border-border-strong border-l border-[rgba(0,0,0,0.03)] ${future ? "text-text-disabled" : "text-text-muted"}`}>{n}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r, i) => <BoardRow key={`${r.label}:${i}`} row={r} calendar={grid.calendar} showDays={showDays} />)}
            {grid.totals && <BoardRow row={grid.totals} calendar={grid.calendar} showDays={showDays} isTotal />}
          </tbody>
        </table>
      </Panel>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-muted">
        <span>Δ% = spend vs daily-average pace (hover for $).</span>
        {showDays && (
          <>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: "#dff0e4" }} />on pace</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: "#fdeede" }} />off</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: "#fbe0e0" }} />way off / no spend</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-[3px]" style={{ background: "#f4f5f6" }} />future</span>
          </>
        )}
      </div>
    </div>
  );
}

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
  const grid = data?.pacing_grid;
  if (!grid && !sec?.months?.length) return <Empty what="No spend-vs-budget history for this client." />;

  const latest = sec?.latest;
  const budget = sec?.monthly_budget;
  const daily = sec?.daily;

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

  // The per-segment board is the primary view when present. Without it, fall back to the
  // account-level daily/monthly pacing that shipped before.
  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      {grid ? (
        <PacingBoard grid={grid} />
      ) : daily ? (
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

      {sec?.months?.length ? (
        <div className="mt-6">
          <h2 className="mb-2 text-[16px] font-semibold">Monthly spend vs budget</h2>
          <DataTable rows={sec.months} columns={cols} rowKey={(r) => r.month} exportName={`pacing-${clientId}`} />
          {!grid && !daily && <p className="mt-2 text-[11.5px] text-text-muted">Monthly adherence. Daily pacing unlocks with day-segmented campaign data and a monthly budget.</p>}
        </div>
      ) : null}
    </div>
  );
}
