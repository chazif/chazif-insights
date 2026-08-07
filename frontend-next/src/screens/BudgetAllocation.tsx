import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getCurves, getMappings, getRuns, getRun, createRun, finalizeRun } from "../lib/api";
import type { AllocResult, RunInput } from "../lib/types";
import { money, num, signedPct } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState } from "../components/ui/States";

const GOALS = [
  { v: "main_conv", label: "Main conversions" },
  { v: "car_count", label: "Business conversions" },
  { v: "gp", label: "Gross profit" },
  { v: "revenue", label: "Revenue" },
  { v: "max_roi", label: "Max ROI" },
];
const MODES = [
  { v: "greedy_marginal", label: "Greedy marginal" },
  { v: "legacy_waterfall", label: "Legacy waterfall" },
];
const goalLabel = (v: string) => GOALS.find((g) => g.v === v)?.label ?? v;
// impression share may arrive as a fraction (0–1) or already as a percent — render robustly.
const isFmt = (v: number | null) => (v == null ? "—" : v <= 1.5 ? `${Math.round(v * 100)}%` : `${Math.round(v)}%`);
const deltaPct = (from: number, to: number) => (from ? (to - from) / from : null);

function ResultsTable({ rows }: { rows: AllocResult[] }) {
  const dim = (key: "brand" | "region" | "category", header: string): Column<AllocResult> => ({
    key, header, sort: (r) => r[key] ?? "", render: (r) => <span className={key === "brand" ? "font-medium" : "text-text-tertiary"}>{r[key] || "—"}</span>, csv: (r) => r[key] ?? "",
  });
  const cols: Column<AllocResult>[] = [
    dim("brand", "Brand"), dim("region", "Region"), dim("category", "Category"),
    { key: "lw_spend", header: "LW spend", align: "right", sort: (r) => r.lw_spend, render: (r) => money(r.lw_spend), agg: { kind: "sum", get: (r) => r.lw_spend, fmt: (n) => money(n) }, csv: (r) => r.lw_spend },
    { key: "rec_spend", header: "Rec spend", align: "right", sort: (r) => r.rec_spend, render: (r) => <span className="font-medium">{money(r.rec_spend)}</span>, agg: { kind: "sum", get: (r) => r.rec_spend, fmt: (n) => money(n) }, csv: (r) => r.rec_spend },
    {
      key: "delta", header: "Δ", align: "right", sort: (r) => deltaPct(r.lw_spend, r.rec_spend) ?? 0,
      render: (r) => { const d = deltaPct(r.lw_spend, r.rec_spend); return d == null ? <span className="text-text-disabled">—</span> : <span className={d > 0 ? "text-positive" : d < 0 ? "text-negative" : "text-text-muted"}>{signedPct(d)}</span>; },
      csv: (r) => deltaPct(r.lw_spend, r.rec_spend) ?? "",
    },
    { key: "lw_conv", header: "LW conv", align: "right", sort: (r) => r.lw_conv ?? 0, render: (r) => num(r.lw_conv ?? 0, 1), agg: { kind: "sum", get: (r) => r.lw_conv ?? 0, fmt: (n) => num(n, 1) }, csv: (r) => r.lw_conv ?? "" },
    { key: "exp_conv", header: "Exp conv", align: "right", sort: (r) => r.expected_conv ?? 0, render: (r) => <span className="font-medium">{num(r.expected_conv ?? 0, 1)}</span>, agg: { kind: "sum", get: (r) => r.expected_conv ?? 0, fmt: (n) => num(n, 1) }, csv: (r) => r.expected_conv ?? "" },
    { key: "exp_cpa", header: "Exp CPA", align: "right", sort: (r) => r.expected_cpa ?? 0, render: (r) => (r.expected_cpa ? money(r.expected_cpa, 2) : "—"), agg: { kind: "rate", num: (r) => r.rec_spend, den: (r) => r.expected_conv ?? 0, fmt: (n) => money(n, 2) }, csv: (r) => r.expected_cpa ?? "" },
    { key: "exp_is", header: "Exp IS", align: "right", sort: (r) => r.expected_is ?? 0, render: (r) => isFmt(r.expected_is), csv: (r) => r.expected_is ?? "" },
    { key: "opp", header: "Opp", align: "right", sort: (r) => r.opp_score ?? 0, render: (r) => (r.opp_score == null ? "—" : num(r.opp_score, 2)), csv: (r) => r.opp_score ?? "" },
  ];
  return <DataTable rows={rows} columns={cols} rowKey={(r, i) => `${r.brand}|${r.region}|${r.category}|${i}`} totalsLabel="Total" exportName="allocation" />;
}

export function BudgetAllocation() {
  const { clientId = "" } = useParams();
  const qc = useQueryClient();
  const curves = useQuery({ queryKey: ["curves", clientId], queryFn: () => getCurves(clientId) });
  const mappings = useQuery({ queryKey: ["mappings", clientId], queryFn: () => getMappings(clientId) });
  const runs = useQuery({ queryKey: ["bi-runs", clientId], queryFn: () => getRuns(clientId) });

  const [goal, setGoal] = useState("main_conv");
  const [budget, setBudget] = useState("");
  const [mode, setMode] = useState("greedy_marginal");
  const [maxChange, setMaxChange] = useState("30");
  const [runId, setRunId] = useState<number | null>(null);

  const runDetail = useQuery({ queryKey: ["run", clientId, runId], queryFn: () => getRun(clientId, runId as number), enabled: runId != null });

  const create = useMutation({
    mutationFn: (b: RunInput) => createRun(clientId, b),
    onSuccess: (r) => { setRunId(r.run_id); qc.invalidateQueries({ queryKey: ["bi-runs", clientId] }); },
  });
  const finalize = useMutation({
    mutationFn: (id: number) => finalizeRun(clientId, id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["run", clientId, runId] }); qc.invalidateQueries({ queryKey: ["bi-runs", clientId] }); },
  });

  if (curves.isLoading || mappings.isLoading) return <Loading />;
  if (curves.error) return <ErrorState msg={(curves.error as Error).message} />;

  const unmapped = mappings.data?.unmapped.length ?? 0;
  const curvesActive = !!curves.data?.active;
  const ready = unmapped === 0 && curvesActive;
  const canRun = ready && budget.trim() !== "" && Number(budget) > 0 && !create.isPending;

  const submit = () =>
    create.mutate({ goal, budget: Number(budget), mode, max_change_pct: maxChange ? Number(maxChange) / 100 : undefined, created_by: "web" });

  const active = runDetail.data;

  return (
    <div className="mx-auto max-w-[1240px] px-6 py-6">
      <h1 className="mb-4 text-[19px] font-semibold tracking-[-0.01em]">Budget Allocation</h1>

      {/* readiness */}
      {!ready && (
        <Panel title="Before you can run" className="mb-5">
          <ul className="flex flex-col gap-2 text-[12.5px]">
            <li className="flex items-center gap-2">
              <Pill tone={unmapped === 0 ? "pos" : "warn"}>{unmapped === 0 ? "✓" : unmapped}</Pill>
              {unmapped === 0 ? (
                <span>All campaigns mapped.</span>
              ) : (
                <span>{unmapped} unmapped campaign{unmapped > 1 ? "s" : ""} block the run — <Link to={`/c/${clientId}/campaign-mapping`} className="font-medium underline hover:opacity-70">map them</Link>.</span>
              )}
            </li>
            <li className="flex items-center gap-2">
              <Pill tone={curvesActive ? "pos" : "warn"}>{curvesActive ? "✓" : "!"}</Pill>
              {curvesActive ? <span>Response curves are fitted.</span> : <span>{curves.data?.detail ?? "Response curves are not fitted yet."}</span>}
            </li>
          </ul>
        </Panel>
      )}

      {/* run form */}
      <Panel title="Configure a run" sub="Allocates the budget across Brand × Region × Category cells to the chosen goal">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-[12px]">
            <div className="mb-1 text-text-muted">Goal</div>
            <select value={goal} onChange={(e) => setGoal(e.target.value)} className="rounded-[7px] border border-border px-2 py-1.5 text-[13px] outline-none focus:border-accent">
              {GOALS.map((g) => <option key={g.v} value={g.v}>{g.label}</option>)}
            </select>
          </label>
          <label className="text-[12px]">
            <div className="mb-1 text-text-muted">Monthly budget</div>
            <div className="flex items-center rounded-[7px] border border-border px-2 focus-within:border-accent">
              <span className="text-text-muted">$</span>
              <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="0" className="w-32 px-1.5 py-1.5 text-right font-mono text-[13px] outline-none" />
            </div>
          </label>
          <label className="text-[12px]">
            <div className="mb-1 text-text-muted">Mode</div>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className="rounded-[7px] border border-border px-2 py-1.5 text-[13px] outline-none focus:border-accent">
              {MODES.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
            </select>
          </label>
          <label className="text-[12px]">
            <div className="mb-1 text-text-muted">Max change %</div>
            <input type="number" value={maxChange} onChange={(e) => setMaxChange(e.target.value)} className="w-20 rounded-[7px] border border-border px-2 py-1.5 text-right font-mono text-[13px] outline-none focus:border-accent" />
          </label>
          <button onClick={submit} disabled={!canRun}
            className="rounded-[7px] bg-ink px-3.5 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {create.isPending ? "Running…" : "Run allocation"}
          </button>
        </div>
        {create.isError && <p className="mt-2 text-[12.5px] text-negative">{(create.error as Error).message}</p>}
      </Panel>

      {/* active run results */}
      {runId != null && (
        <div className="mt-6">
          {runDetail.isLoading ? (
            <Loading />
          ) : active ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <h2 className="text-[16px] font-semibold">Run #{active.id}</h2>
                <span className="text-[12.5px] text-text-muted">{goalLabel(active.goal)} · {money(active.budget)} · {active.mode.replace("_", " ")}</span>
                <Pill tone={active.status === "final" ? "pos" : "neutral"}>{active.status}</Pill>
                <div className="ml-auto">
                  {active.status !== "final" && (
                    <button onClick={() => finalize.mutate(active.id)} disabled={finalize.isPending}
                      className="rounded-[7px] border border-border-strong px-3 py-1.5 text-[12.5px] hover:border-ink disabled:opacity-50">
                      {finalize.isPending ? "Finalizing…" : "Finalize run"}
                    </button>
                  )}
                </div>
              </div>
              {active.results?.length ? <ResultsTable rows={active.results} /> : <p className="text-[12.5px] text-text-muted">No allocation cells in this run.</p>}
            </>
          ) : null}
        </div>
      )}

      {/* history */}
      {(runs.data?.length ?? 0) > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-[16px] font-semibold">Past runs</h2>
          <div className="overflow-auto rounded-[10px] border border-border">
            <table className="w-full border-collapse text-[12.5px]">
              <thead className="bg-surface-alt">
                <tr>
                  {["Run", "When", "Goal", "Budget", "Mode", "Status"].map((h, i) => (
                    <th key={h} className={`whitespace-nowrap border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted ${i === 3 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.data!.map((r) => (
                  <tr key={r.id} onClick={() => setRunId(r.id)} className={`cursor-pointer border-b border-rule last:border-0 hover:bg-row-hover ${r.id === runId ? "bg-row-hover" : ""}`}>
                    <td className="px-3 py-2 font-medium">#{r.id}</td>
                    <td className="px-3 py-2 text-text-tertiary">{r.run_at ? new Date(r.run_at).toLocaleString() : "—"}</td>
                    <td className="px-3 py-2">{goalLabel(r.goal)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{money(r.budget)}</td>
                    <td className="px-3 py-2 text-text-tertiary">{r.mode.replace("_", " ")}</td>
                    <td className="px-3 py-2"><Pill tone={r.status === "final" ? "pos" : "neutral"}>{r.status}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
