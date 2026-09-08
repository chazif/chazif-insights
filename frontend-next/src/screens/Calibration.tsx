import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getCalibration, reconcileCalibration } from "../lib/api";
import type { CalCell, CalMetric } from "../lib/types";
import { pct, signedPct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const GOAL_LABELS: Record<string, string> = {
  main_conv: "Main conversions", all_conv: "All conversions", transactions: "Transactions",
  customers: "Customers", new_customers: "New customers", revenue: "Revenue",
};
const goalLabel = (v: string) => GOAL_LABELS[v] ?? v;

// MAPE: lower is better. Green ≤10%, muted ≤25%, else negative.
const mapeTone = (v: number | null) => (v == null ? "text-text-disabled" : v <= 0.1 ? "text-positive" : v <= 0.25 ? "text-text-secondary" : "text-negative");
const mapeCell = (m: CalMetric) => <span className={mapeTone(m?.mape ?? null)}>{m?.mape == null ? "—" : pct(m.mape, 0)}</span>;
const biasCell = (m: CalMetric) => (m?.bias == null ? <span className="text-text-disabled">—</span>
  : <span className={Math.abs(m.bias) <= 0.05 ? "text-text-muted" : m.bias > 0 ? "text-negative" : "text-warning"}>{signedPct(m.bias)}</span>);

export function Calibration() {
  const { clientId = "" } = useParams();
  const qc = useQueryClient();
  const cal = useQuery({ queryKey: ["calibration", clientId], queryFn: () => getCalibration(clientId) });
  const reconcile = useMutation({
    mutationFn: () => reconcileCalibration(clientId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calibration", clientId] }),
  });

  if (cal.isLoading) return <Loading />;
  if (cal.error) return <ErrorState msg={(cal.error as Error).message} />;

  const cells = cal.data?.cells ?? [];
  const sim = cal.data?.simulator_vs_actual;

  const cols: Column<CalCell>[] = [
    { key: "goal", header: "Goal", sort: (r) => r.goal, render: (r) => <span className="font-medium">{goalLabel(r.goal)}</span>, csv: (r) => r.goal },
    { key: "cell", header: "Cell", sort: (r) => `${r.brand}${r.region}${r.category}`, render: (r) => <span className="text-text-tertiary">{[r.brand, r.region, r.category].filter(Boolean).join(" · ") || "—"}</span>, csv: (r) => [r.brand, r.region, r.category].join("|") },
    { key: "n", header: "Samples", align: "right", sort: (r) => r.metrics.units.n, render: (r) => r.metrics.units.n, csv: (r) => r.metrics.units.n },
    { key: "cmape", header: "Conv MAPE", align: "right", sort: (r) => r.metrics.units.mape ?? 999, render: (r) => mapeCell(r.metrics.units), csv: (r) => r.metrics.units.mape ?? "" },
    { key: "cbias", header: "Conv bias", align: "right", sort: (r) => r.metrics.units.bias ?? 0, render: (r) => biasCell(r.metrics.units), csv: (r) => r.metrics.units.bias ?? "" },
    { key: "cpamape", header: "CPA MAPE", align: "right", sort: (r) => r.metrics.cpa.mape ?? 999, render: (r) => mapeCell(r.metrics.cpa), csv: (r) => r.metrics.cpa.mape ?? "" },
    { key: "spmape", header: "Spend MAPE", align: "right", sort: (r) => r.metrics.spend.mape ?? 999, render: (r) => mapeCell(r.metrics.spend), csv: (r) => r.metrics.spend.mape ?? "" },
  ];

  const optimism = sim?.units_bias;
  const optimismText = optimism == null ? "—"
    : Math.abs(optimism) <= 0.05 ? "on the mark"
    : `predicted ${signedPct(optimism)} ${optimism > 0 ? "high" : "low"}`;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em]">Calibration</h1>
        <span className="text-[12.5px] text-text-muted">predicted vs actual for finalized runs — is the model (and the simulator) calling the next period right?</span>
        <button onClick={() => reconcile.mutate()} disabled={reconcile.isPending}
          className="ml-auto rounded-[7px] border border-border-strong px-3 py-1.5 text-[12.5px] hover:border-ink disabled:opacity-50">
          {reconcile.isPending ? "Reconciling…" : "Reconcile now"}
        </button>
      </div>
      {reconcile.data && <p className="mb-3 text-[12px] text-text-muted">Reconciled — {reconcile.data.written} prediction{reconcile.data.written === 1 ? "" : "s"} matched to actuals.</p>}

      {cells.length === 0 ? (
        <Empty what="No calibration data yet. Finalize a run; when the next period's data is ingested, its actuals are matched to the predictions and appear here." />
      ) : (
        <>
          <StatStrip
            stats={[
              { label: "Simulator optimism · conversions", value: optimismText, sub: "Google's budget simulator vs measured actuals" },
              { label: "Conversions MAPE", value: sim?.units_mape == null ? "—" : pct(sim.units_mape, 0), sub: "mean absolute % error across cells" },
              { label: "Cells measured", value: String(cells.length) },
            ]}
          />
          <div className="mt-6">
            <h2 className="mb-2 text-[16px] font-semibold">By cell &amp; goal</h2>
            <DataTable rows={cells} columns={cols} rowKey={(r, i) => `${r.goal}|${r.brand}|${r.region}|${r.category}|${i}`} exportName={`calibration-${clientId}`} />
            <p className="mt-2 text-[11.5px] text-text-muted">
              <b>MAPE</b> = mean absolute % error (lower is better). <b>Bias</b> &gt; 0 means the prediction ran high (optimistic); &lt; 0 means it ran low. Conversions is the chosen goal's rung; the simulator-optimism figure above is the conversions bias, since the curve is fit from Google's simulator.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
