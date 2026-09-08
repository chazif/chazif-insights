import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getCurves, getMappings, getRuns, getRun, createRun, finalizeRun, overrideCell } from "../lib/api";
import type { AllocResult, CurveDiag, Disagreement, RunInput } from "../lib/types";
import { money, num, signedPct } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";
import { CurveFitter } from "../components/CurveFitter";
import { GuardEditor } from "../components/GuardEditor";
import { Loading, ErrorState } from "../components/ui/States";

// V2 goal ladder — the requested default VIEW; a run computes every available rung as a
// scenario regardless (data-derived), so this just sets which one opens first.
const GOALS = [
  { v: "main_conv", label: "Main conversions" },
  { v: "all_conv", label: "All conversions" },
  { v: "transactions", label: "Transactions" },
  { v: "customers", label: "Customers" },
  { v: "new_customers", label: "New customers" },
  { v: "revenue", label: "Revenue" },
];
const MODES = [
  { v: "greedy_marginal", label: "Greedy marginal" },
  { v: "legacy_waterfall", label: "Legacy waterfall" },
];
const GOAL_LABELS: Record<string, string> = {
  main_conv: "Main conversions", all_conv: "All conversions", transactions: "Transactions",
  customers: "Customers", new_customers: "New customers", revenue: "Revenue",
  gross_profit: "Gross profit", car_count: "Business conversions", gp: "Gross profit", max_roi: "Max ROI",
};
const goalLabel = (v: string) => GOAL_LABELS[v] ?? v;
const isFmt = (v: number | null) => (v == null ? "—" : v <= 1.5 ? `${Math.round(v * 100)}%` : `${Math.round(v)}%`);
const deltaPct = (from: number, to: number) => (from ? (to - from) / from : null);

function CurveBadge({ c }: { c?: CurveDiag | null }) {
  if (!c) return <span className="text-text-disabled">—</span>;
  const label = c.scope === "cell" ? `cell·${Math.round((c.w ?? 0) * 100)}%` : c.scope;
  return (
    <span title={`${c.scope} curve · ${c.source} · ${c.points} pts · pooling w=${c.w}`}
      className="rounded-[5px] bg-rule px-1.5 py-[2px] text-[10.5px] text-text-secondary">{label}</span>
  );
}

function ResultsTable({ rows, onOverride }: { rows: AllocResult[]; onOverride?: (r: AllocResult) => void }) {
  const dim = (key: "brand" | "region" | "category", header: string): Column<AllocResult> => ({
    key, header, sort: (r) => r[key] ?? "",
    render: (r) => (
      <span className={key === "brand" ? "font-medium" : "text-text-tertiary"}>
        {key === "region" && r.caution && (
          <span title={r.caution} className="mr-1 cursor-help text-warning">⚠</span>
        )}
        {r[key] || "—"}
      </span>
    ),
    csv: (r) => r[key] ?? "",
  });
  const cpaCell = (v: number | null) => (v ? money(v, 2) : "—");
  const cols: Column<AllocResult>[] = [
    dim("brand", "Brand"), dim("region", "Region"), dim("category", "Category"),
    { key: "lw_spend", header: "LW spend", align: "right", sort: (r) => r.lw_spend, render: (r) => money(r.lw_spend), agg: { kind: "sum", get: (r) => r.lw_spend, fmt: (n) => money(n) }, csv: (r) => r.lw_spend },
    { key: "rec_spend", header: "Rec spend", align: "right", sort: (r) => r.rec_spend, render: (r) => <span className="font-medium">{money(r.rec_spend)}</span>, agg: { kind: "sum", get: (r) => r.rec_spend, fmt: (n) => money(n) }, csv: (r) => r.rec_spend },
    {
      key: "delta", header: "Δ spend", align: "right", sort: (r) => deltaPct(r.lw_spend, r.rec_spend) ?? 0,
      render: (r) => { const d = deltaPct(r.lw_spend, r.rec_spend); return d == null ? <span className="text-text-disabled">—</span> : <span className={d > 0 ? "text-positive" : d < 0 ? "text-negative" : "text-text-muted"}>{signedPct(d)}</span>; },
      csv: (r) => deltaPct(r.lw_spend, r.rec_spend) ?? "",
    },
    {
      key: "held", header: "Held back", align: "right", sort: (r) => r.held_back ?? 0,
      render: (r) => {
        const h = r.held_back;
        if (h == null || Math.abs(h) < 0.5) return <span className="text-text-disabled">—</span>;
        // held_back = proposed − shipped: +ve clamped DOWN (money withheld), −ve clamped UP
        return <span className={h > 0 ? "text-warning" : "text-text-muted"}
          title={h > 0 ? "clamped down by the change limit — available next run" : "clamped up to the change limit"}>{money(h)}</span>;
      },
      agg: { kind: "sum", get: (r) => r.held_back ?? 0, fmt: (n) => (Math.abs(n) < 0.5 ? "—" : money(n)) }, csv: (r) => r.held_back ?? "",
    },
    { key: "exp_conv", header: "Exp conv", align: "right", sort: (r) => r.expected_conv ?? 0, render: (r) => <span className="font-medium">{num(r.expected_conv ?? 0, 1)}</span>, agg: { kind: "sum", get: (r) => r.expected_conv ?? 0, fmt: (n) => num(n, 1) }, csv: (r) => r.expected_conv ?? "" },
    { key: "exp_cpa", header: "Exp CPA", align: "right", sort: (r) => r.expected_cpa ?? 0, render: (r) => cpaCell(r.expected_cpa), agg: { kind: "rate", num: (r) => r.rec_spend, den: (r) => r.expected_conv ?? 0, fmt: (n) => money(n, 2) }, csv: (r) => r.expected_cpa ?? "" },
    { key: "exp_is", header: "Exp IS", align: "right", sort: (r) => r.expected_is ?? 0, render: (r) => isFmt(r.expected_is), csv: (r) => r.expected_is ?? "" },
    { key: "tcpa_now", header: "tCPA now", align: "right", sort: (r) => r.tcpa_current ?? 0, render: (r) => cpaCell(r.tcpa_current), csv: (r) => r.tcpa_current ?? "" },
    {
      key: "tcpa_delta", header: "tCPA Δ", align: "right",
      sort: (r) => (r.tcpa_recommended != null && r.tcpa_current != null ? r.tcpa_recommended - r.tcpa_current : 0),
      render: (r) => {
        if (r.tcpa_recommended == null || r.tcpa_current == null) return <span className="text-text-disabled">—</span>;
        const d = r.tcpa_recommended - r.tcpa_current;
        return <span className={d <= 0 ? "text-positive" : "text-negative"}>{(d >= 0 ? "+" : "") + money(d, 2)}</span>;
      },
      csv: (r) => (r.tcpa_recommended != null && r.tcpa_current != null ? r.tcpa_recommended - r.tcpa_current : ""),
    },
    { key: "profit", header: "Exp profit", align: "right", sort: (r) => r.expected_adroi ?? 0, render: (r) => (r.expected_adroi == null ? "—" : money(r.expected_adroi)), agg: { kind: "sum", get: (r) => r.expected_adroi ?? 0, fmt: (n) => money(n) }, csv: (r) => r.expected_adroi ?? "" },
    { key: "curve", header: "Curve", sort: (r) => r.curve?.scope ?? "", render: (r) => <CurveBadge c={r.curve} />, csv: (r) => r.curve?.scope ?? "" },
    { key: "opp", header: "Opp", align: "right", sort: (r) => r.opp_score ?? 0, render: (r) => (r.opp_score == null ? "—" : num(r.opp_score, 2)), csv: (r) => r.opp_score ?? "" },
    ...(onOverride ? [{
      key: "ov", header: "", sort: undefined,
      render: (r: AllocResult) => (Math.abs(r.held_back ?? 0) > 0.5
        ? <button onClick={() => onOverride(r)} className="whitespace-nowrap text-[11.5px] font-medium text-ink underline hover:opacity-70">Override</button>
        : null),
      csv: () => "",
    } as Column<AllocResult>] : []),
  ];
  return (
    <>
      <DataTable rows={rows} columns={cols} rowKey={(r, i) => `${r.brand}|${r.region}|${r.category}|${i}`} totalsLabel="Total" exportName="allocation" />
      <p className="mt-2 text-[11.5px] text-text-muted">
        Expected values are curve estimates. <b>Held back</b> = money the change limit withheld this run (available next run). <b>tCPA Δ</b> = expected CPA − current tCPA. <b>Curve</b> names the response curve behind each cell (cell·w% = pooled toward the cell fit; account = the account curve). ⚠ marks cells where budget alone won't buy the share.
      </p>
    </>
  );
}

function Disagreements({ rows }: { rows: Disagreement[] }) {
  const arrow = (d: number) => (d > 0 ? "↑" : d < 0 ? "↓" : "→");
  return (
    <Panel title="Goals disagree" sub="cells one goal would grow and another would cut" className="mt-4 border-warning/40">
      <ul className="space-y-1.5 text-[12.5px]">
        {rows.slice(0, 12).map((d, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{[d.brand, d.region, d.category].filter(Boolean).join(" · ") || "—"}</span>
            <span className="text-text-muted">
              {Object.entries(d.directions).map(([g, dir]) => (
                <span key={g} className="mr-2">{goalLabel(g)} <b className={dir > 0 ? "text-positive" : dir < 0 ? "text-negative" : ""}>{arrow(dir)}</b></span>
              ))}
            </span>
            <span className="ml-auto font-mono tabular-nums text-text-tertiary">±{money(d.magnitude)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
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
  const [selGoal, setSelGoal] = useState<string | null>(null);   // scenario the user is viewing

  const runDetail = useQuery({ queryKey: ["run", clientId, runId], queryFn: () => getRun(clientId, runId as number), enabled: runId != null });

  const create = useMutation({
    mutationFn: (b: RunInput) => createRun(clientId, b),
    onSuccess: (r) => { setRunId(r.run_id); setSelGoal(null); qc.invalidateQueries({ queryKey: ["bi-runs", clientId] }); },
  });
  const finalize = useMutation({
    mutationFn: (v: { id: number; goal: string }) => finalizeRun(clientId, v.id, v.goal),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["run", clientId, runId] }); qc.invalidateQueries({ queryKey: ["bi-runs", clientId] }); },
  });

  const [ovRow, setOvRow] = useState<AllocResult | null>(null);
  const [ovSpend, setOvSpend] = useState("");
  const [ovReason, setOvReason] = useState("");
  const override = useMutation({
    mutationFn: (v: { runId: number; cell: [string, string, string]; spend: number; reason: string; goal: string }) =>
      overrideCell(clientId, v.runId, { cell_key: v.cell, spend: v.spend, reason: v.reason, actor: "web", goal: v.goal }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["run", clientId, runId] }); setOvRow(null); },
  });
  const openOverride = (r: AllocResult) => { setOvRow(r); setOvSpend(String(Math.round(r.proposed_spend ?? r.rec_spend))); setOvReason(""); };

  if (curves.isLoading || mappings.isLoading) return <Loading />;
  if (curves.error) return <ErrorState msg={(curves.error as Error).message} />;

  const unmapped = mappings.data?.unmapped.length ?? 0;
  const curvesActive = !!curves.data?.active;
  const ready = unmapped === 0 && curvesActive;
  const canRun = ready && budget.trim() !== "" && Number(budget) > 0 && !create.isPending;

  const submit = () =>
    create.mutate({ goal, budget: Number(budget), mode, max_change_pct: maxChange ? Number(maxChange) / 100 : undefined, created_by: "web" });

  const active = runDetail.data;
  const scenarios = active?.scenarios ?? (active?.results ? { [active.goal]: active.results } : {});
  const goalsComputed = active?.goals_computed?.length ? active.goals_computed : Object.keys(scenarios);
  const viewGoal = (selGoal && goalsComputed.includes(selGoal) ? selGoal : (active?.chosen_goal || active?.goal || goalsComputed[0])) ?? "";
  const rows = scenarios[viewGoal] ?? active?.results ?? [];
  const heldBack = active?.held_back_total?.[viewGoal] ?? 0;
  const clamped = rows.filter((r) => (r.held_back ?? 0) > 0.5);

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <h1 className="mb-4 text-[19px] font-semibold tracking-[-0.01em]">Budget Allocation</h1>

      {unmapped > 0 && (
        <Panel title="Before you can run" className="mb-5">
          <div className="flex items-center gap-2 text-[12.5px]">
            <Pill tone="warn">{unmapped}</Pill>
            <span>{unmapped} unmapped campaign{unmapped > 1 ? "s" : ""} block the run — <Link to={`/c/${clientId}/campaign-mapping`} className="font-medium underline hover:opacity-70">map them</Link>.</span>
          </div>
        </Panel>
      )}
      <div className="mb-5">
        <CurveFitter clientId={clientId} active={curvesActive} detail={curves.data?.detail} />
      </div>

      <Panel title="Configure a run" sub="Allocates the budget across Brand × Region × Category cells; every available goal is computed as a scenario">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-[12px]">
            <div className="mb-1 text-text-muted">Default goal</div>
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

      <GuardEditor clientId={clientId} />

      {runId != null && (
        <div className="mt-6">
          {runDetail.isLoading ? (
            <Loading />
          ) : active ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <h2 className="text-[16px] font-semibold">Run #{active.id}</h2>
                <span className="text-[12.5px] text-text-muted">{money(active.budget)} · {active.mode.replace("_", " ")}</span>
                <Pill tone={active.status === "final" ? "pos" : "neutral"}>{active.status}</Pill>
                {active.chosen_goal && <Pill tone="stage">chose {goalLabel(active.chosen_goal)}</Pill>}
                <div className="ml-auto">
                  {active.status !== "final" && (
                    <button onClick={() => finalize.mutate({ id: active.id, goal: viewGoal })} disabled={finalize.isPending}
                      className="rounded-[7px] border border-border-strong px-3 py-1.5 text-[12.5px] hover:border-ink disabled:opacity-50">
                      {finalize.isPending ? "Finalizing…" : `Finalize as ${goalLabel(viewGoal)}`}
                    </button>
                  )}
                </div>
              </div>

              {/* scenario switcher — one allocation per available goal */}
              {goalsComputed.length > 1 && (
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">Scenario</span>
                  {goalsComputed.map((g) => (
                    <button key={g} onClick={() => setSelGoal(g)}
                      className={`rounded-[7px] border px-2.5 py-1 text-[12.5px] ${g === viewGoal ? "border-ink bg-ink text-accent" : "border-border-strong text-text-secondary hover:border-ink"}`}>
                      {goalLabel(g)}
                    </button>
                  ))}
                </div>
              )}

              {/* held-back callout */}
              {heldBack > 0.5 && (
                <div className="mb-3 rounded-[8px] border border-warning/40 bg-warning-fill px-3 py-2 text-[12.5px] text-text-secondary">
                  <b>{money(heldBack)}</b> held back by the change limit — available next run.
                  {clamped.length > 0 && (
                    <span className="text-text-muted"> Clamped: {clamped.slice(0, 6).map((r) => `${[r.region, r.category].filter(Boolean).join("·")} (${money(r.held_back ?? 0)})`).join(", ")}{clamped.length > 6 ? ` +${clamped.length - 6} more` : ""}.</span>
                  )}
                </div>
              )}

              {rows.length ? <ResultsTable rows={rows} onOverride={openOverride} /> : <p className="text-[12.5px] text-text-muted">No allocation cells in this run.</p>}

              {active.disagreements && active.disagreements.length > 0 && <Disagreements rows={active.disagreements} />}
            </>
          ) : null}
        </div>
      )}

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
                  <tr key={r.id} onClick={() => { setRunId(r.id); setSelGoal(null); }} className={`cursor-pointer border-b border-rule last:border-0 hover:bg-row-hover ${r.id === runId ? "bg-row-hover" : ""}`}>
                    <td className="px-3 py-2 font-medium">#{r.id}</td>
                    <td className="px-3 py-2 text-text-tertiary">{r.run_at ? new Date(r.run_at).toLocaleString() : "—"}</td>
                    <td className="px-3 py-2">{goalLabel(r.chosen_goal || r.goal)}</td>
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

      {/* override modal — push a clamped cell past the guard band (audited) */}
      {ovRow && active && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(26,26,26,0.34)]" onClick={() => setOvRow(null)}>
          <div className="w-[min(440px,92vw)] rounded-[12px] bg-surface p-5 shadow-[0_24px_64px_rgba(26,26,26,0.28)]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold">Override spend</h3>
            <p className="mt-1 text-[12.5px] text-text-muted">{[ovRow.brand, ovRow.region, ovRow.category].filter(Boolean).join(" · ") || "—"} · {goalLabel(viewGoal)}</p>
            <p className="mt-2 text-[12.5px]">
              Guarded to <b>{money(ovRow.rec_spend)}</b>
              {ovRow.proposed_spend != null && <> · engine proposed <b>{money(ovRow.proposed_spend)}</b></>}
              {ovRow.guard_band_pct != null && <> · band ±{Math.round(ovRow.guard_band_pct * 100)}%</>}
            </p>
            <label className="mt-3 block text-[12px]">
              <div className="mb-1 text-text-muted">New spend (past the change limit)</div>
              <div className="flex items-center rounded-[7px] border border-border px-2 focus-within:border-accent">
                <span className="text-text-muted">$</span>
                <input type="number" value={ovSpend} onChange={(e) => setOvSpend(e.target.value)} className="w-40 px-1.5 py-1.5 text-right font-mono text-[13px] outline-none" />
              </div>
            </label>
            <label className="mt-3 block text-[12px]">
              <div className="mb-1 text-text-muted">Reason (required — this is audited)</div>
              <input value={ovReason} onChange={(e) => setOvReason(e.target.value)} placeholder="why override the change limit?" className="w-full rounded-[7px] border border-border px-2 py-1.5 text-[13px] outline-none focus:border-accent" />
            </label>
            {override.isError && <p className="mt-2 text-[12px] text-negative">{(override.error as Error).message}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setOvRow(null)} className="rounded-[7px] border border-border-strong px-3 py-1.5 text-[12.5px] hover:border-ink">Cancel</button>
              <button
                disabled={override.isPending || !ovReason.trim() || ovSpend.trim() === "" || Number.isNaN(Number(ovSpend))}
                onClick={() => override.mutate({ runId: active.id, cell: [ovRow.brand, ovRow.region, ovRow.category], spend: Number(ovSpend), reason: ovReason.trim(), goal: viewGoal })}
                className="rounded-[7px] bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50">
                {override.isPending ? "Applying…" : "Apply override"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
