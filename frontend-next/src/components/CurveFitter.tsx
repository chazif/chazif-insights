import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addSnapshots } from "../lib/api";
import type { SnapshotPoint } from "../lib/types";
import { Panel } from "./ui/Panel";
import { Pill } from "./ui/Pill";

type Row = { is: string; spend: string; leads: string; cpl: string };
const blank = (): Row => ({ is: "", spend: "", leads: "", cpl: "" });
const filled = (r: Row) => r.is.trim() && r.spend.trim() && r.leads.trim();

// Fit + activate account-level response curves from >=4 simulator points. Once curves
// are active (and campaigns are mapped) Budget Allocation can run. The points typically
// come from the Google Ads bid simulator or the team's own scaling estimates.
export function CurveFitter({ clientId, active, detail }: { clientId: string; active: boolean; detail?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(!active);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: 4 }, blank));

  const fit = useMutation({
    mutationFn: () => {
      const points: SnapshotPoint[] = rows.filter(filled).map((r) => ({
        is_share: Number(r.is),
        spend_week: Number(r.spend),
        leads_week: Number(r.leads),
        ...(r.cpl.trim() ? { cpl: Number(r.cpl) } : {}),
      }));
      return addSnapshots(clientId, points, true);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["curves", clientId] }),
  });

  const set = (i: number, k: keyof Row, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const nFilled = rows.filter(filled).length;
  const diag = fit.data?.fit?.diagnostics;
  const inp = "w-full rounded-[5px] border border-border px-1.5 py-1 text-right font-mono text-[12px] outline-none focus:border-accent";

  if (active && !open) {
    return (
      <Panel title="Response curves">
        <div className="flex items-center gap-3 text-[12.5px]">
          <Pill tone="pos">✓ fitted</Pill>
          <span className="text-text-muted">Account-level curves are active.</span>
          <button onClick={() => setOpen(true)} className="ml-auto rounded-[6px] border border-border-strong px-2.5 py-1 text-[12px] hover:border-ink">Re-fit</button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Fit response curves" sub="≥4 points showing how weekly leads & spend scale with impression share (e.g. from the Google Ads bid simulator)">
      <div className="overflow-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {["IS %", "Weekly spend", "Weekly leads", "CPL (optional)"].map((h) => (
                <th key={h} className="border-b border-border px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.05em] text-text-muted first:text-left">{h}</th>
              ))}
              <th className="border-b border-border" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-rule last:border-0">
                <td className="px-2 py-1"><input className={inp} type="number" value={r.is} onChange={(e) => set(i, "is", e.target.value)} placeholder="e.g. 20" /></td>
                <td className="px-2 py-1"><input className={inp} type="number" value={r.spend} onChange={(e) => set(i, "spend", e.target.value)} placeholder="$" /></td>
                <td className="px-2 py-1"><input className={inp} type="number" value={r.leads} onChange={(e) => set(i, "leads", e.target.value)} /></td>
                <td className="px-2 py-1"><input className={inp} type="number" value={r.cpl} onChange={(e) => set(i, "cpl", e.target.value)} placeholder="auto" /></td>
                <td className="px-2 py-1 text-right">
                  {rows.length > 4 && <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-[12px] text-text-muted hover:text-negative">✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={() => setRows((rs) => [...rs, blank()])} className="rounded-[6px] border border-border-strong px-2.5 py-1 text-[12px] hover:border-ink">+ Add point</button>
        <button onClick={() => fit.mutate()} disabled={nFilled < 4 || fit.isPending}
          className="rounded-[7px] bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
          {fit.isPending ? "Fitting…" : "Fit & activate curves"}
        </button>
        <span className="text-[11.5px] text-text-muted">{nFilled}/4 points</span>
        {active && <button onClick={() => setOpen(false)} className="text-[12px] text-text-muted hover:text-ink">cancel</button>}
      </div>

      {diag && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12.5px]">
          <Pill tone="pos">✓ curves activated</Pill>
          <span className="text-text-muted">Fitted from {diag.n_points} points · leads R² {diag.r2_leads?.toFixed(2) ?? "—"} · CPL R² {diag.r2_cpl?.toFixed(2) ?? "—"}</span>
        </div>
      )}
      {fit.isError && <p className="mt-2 text-[12.5px] text-negative">{(fit.error as Error).message}</p>}
      {!diag && !fit.isError && detail && <p className="mt-2 text-[11.5px] text-text-muted">{detail}</p>}
    </Panel>
  );
}
