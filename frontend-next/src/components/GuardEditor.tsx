import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getGuard, putGuard } from "../lib/api";
import { Panel } from "./ui/Panel";

type Row = { brand: string; region: string; category: string; pct: string };
const inp = "rounded-[6px] border border-border px-2 py-1 text-[12.5px] outline-none focus:border-accent";

export function GuardEditor({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const guard = useQuery({ queryKey: ["guard", clientId], queryFn: () => getGuard(clientId) });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (guard.data) {
      setRows(guard.data.map((r) => ({
        brand: r.brand || "", region: r.region || "", category: r.category || "",
        pct: r.max_change_pct == null ? "" : String(Math.round(r.max_change_pct * 100)),
      })));
    }
  }, [guard.data]);

  const save = useMutation({
    mutationFn: () => putGuard(clientId, (rows || [])
      .filter((r) => r.pct.trim() !== "" && !Number.isNaN(Number(r.pct)))
      .map((r) => ({
        brand: r.brand.trim() || undefined, region: r.region.trim() || undefined,
        category: r.category.trim() || undefined, max_change_pct: Number(r.pct) / 100,
      }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["guard", clientId] }),
  });

  const ruleCount = guard.data?.length ?? 0;
  const upd = (i: number, k: keyof Row, v: string) => setRows((rs) => (rs || []).map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const del = (i: number) => setRows((rs) => (rs || []).filter((_, j) => j !== i));
  const add = () => setRows((rs) => [...(rs || []), { brand: "", region: "", category: "", pct: "30" }]);

  return (
    <Panel
      title="Change-limit guard"
      sub={`cap week-over-week spend change per cell; most-specific rule wins (category > region > brand > client), default 30%${ruleCount ? ` · ${ruleCount} rule${ruleCount > 1 ? "s" : ""}` : " · using default"}`}
      className="mt-5"
    >
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-[12.5px] font-medium text-ink underline hover:opacity-70">
          {ruleCount ? "Edit rules" : "Add a rule"}
        </button>
      ) : rows ? (
        <div>
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                {["Brand", "Region", "Category", "Max change %", ""].map((h, i) => (
                  <th key={h} className={`border-b border-border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted ${i === 3 ? "text-right" : "text-left"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-3 text-center text-[12px] text-text-muted">No rules — every cell uses the default 30%.</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-rule last:border-0">
                  <td className="px-2 py-1.5"><input value={r.brand} onChange={(e) => upd(i, "brand", e.target.value)} placeholder="any" className={`${inp} w-28`} /></td>
                  <td className="px-2 py-1.5"><input value={r.region} onChange={(e) => upd(i, "region", e.target.value)} placeholder="any" className={`${inp} w-28`} /></td>
                  <td className="px-2 py-1.5"><input value={r.category} onChange={(e) => upd(i, "category", e.target.value)} placeholder="any" className={`${inp} w-28`} /></td>
                  <td className="px-2 py-1.5 text-right"><input type="number" value={r.pct} onChange={(e) => upd(i, "pct", e.target.value)} className={`${inp} w-20 text-right font-mono`} /></td>
                  <td className="px-2 py-1.5 text-right"><button onClick={() => del(i)} title="Remove rule" className="text-text-muted hover:text-negative">✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={add} className="rounded-[7px] border border-border-strong px-3 py-1.5 text-[12.5px] hover:border-ink">+ Add rule</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-[7px] bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50">
              {save.isPending ? "Saving…" : "Save rules"}
            </button>
            <button onClick={() => setOpen(false)} className="text-[12.5px] text-text-muted hover:text-ink">Close</button>
            {save.isSuccess && <span className="text-[12px] text-positive">Saved {save.data.saved} rule{save.data.saved === 1 ? "" : "s"}.</span>}
            {save.isError && <span className="text-[12px] text-negative">{(save.error as Error).message}</span>}
          </div>
          <p className="mt-2 text-[11px] text-text-muted">Leave a dimension blank for “any”. A cell picks the most specific matching rule; with none, ±30%. The guard clamps each cell and reports the held-back amount — it never re-runs the allocator.</p>
        </div>
      ) : null}
    </Panel>
  );
}
