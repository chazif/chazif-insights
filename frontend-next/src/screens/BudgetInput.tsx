import { useState, useRef } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getConfig, updateConfig, uploadBudget } from "../lib/api";
import type { ClientConfig, BudgetLine } from "../lib/types";
import { money } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState } from "../components/ui/States";

function Form({ clientId, initial }: { clientId: string; initial: ClientConfig }) {
  const qc = useQueryClient();
  const [budget, setBudget] = useState(String(initial.thresholds?.monthly_budget ?? ""));
  const fileRef = useRef<HTMLInputElement>(null);
  const lines = initial.budget_lines ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["config", clientId] });
    qc.invalidateQueries({ queryKey: ["bundle", clientId] });
  };
  const saveManual = useMutation({
    mutationFn: () => updateConfig(clientId, { thresholds: { monthly_budget: budget.trim() === "" ? null : Number(budget) } as never }),
    onSuccess: invalidate,
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadBudget(clientId, file),
    onSuccess: invalidate,
  });

  const lineCols: Column<BudgetLine>[] = [
    { key: "brand", header: "Brand", render: (r) => r.brand ?? <span className="text-text-disabled">—</span>, csv: (r) => r.brand ?? "" },
    { key: "region", header: "Region", render: (r) => r.region ?? <span className="text-text-disabled">—</span>, csv: (r) => r.region ?? "" },
    { key: "category", header: "Category", render: (r) => r.category ?? <span className="text-text-disabled">—</span>, csv: (r) => r.category ?? "" },
    { key: "monthly", header: "Monthly", align: "right", sort: (r) => r.monthly, render: (r) => money(r.monthly), agg: { kind: "sum", get: (r) => r.monthly, fmt: (n) => money(n) }, csv: (r) => r.monthly },
  ];

  return (
    <div className="mx-auto max-w-[820px] px-6 py-6">
      <h1 className="mb-4 text-[19px] font-semibold tracking-[-0.01em]">Budget Input</h1>

      <Panel title="Monthly budget" sub="The target monthly spend Budget & Pacing reconcile against">
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-[7px] border border-border px-2.5 focus-within:border-accent">
            <span className="text-text-muted">$</span>
            <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="0"
              className="w-40 px-1.5 py-1.5 text-right font-mono text-[14px] outline-none" />
          </div>
          <button onClick={() => saveManual.mutate()} disabled={saveManual.isPending}
            className="rounded-[7px] bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {saveManual.isPending ? "Saving…" : "Save"}
          </button>
          {saveManual.isSuccess && !saveManual.isPending && <span className="text-[12.5px] text-positive">Saved</span>}
          {saveManual.isError && <span className="text-[12.5px] text-negative">{(saveManual.error as Error).message}</span>}
        </div>
        {lines.length > 0 && (
          <p className="mt-2 text-[11.5px] text-text-muted">
            A dimensional budget file is active ({lines.length} lines, {money(lines.reduce((a, l) => a + l.monthly, 0))}/mo) — it overrides this manual total.
          </p>
        )}
      </Panel>

      <Panel title="Dimensional budget file" sub="Brand / Region / Category × monthly amount — overrides the manual total" className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls"
            className="text-[12.5px] file:mr-3 file:rounded-[6px] file:border file:border-border-strong file:bg-surface-alt file:px-2.5 file:py-1 file:text-[12px] hover:file:border-ink" />
          <button
            onClick={() => { const f = fileRef.current?.files?.[0]; if (f) upload.mutate(f); }}
            disabled={upload.isPending}
            className="rounded-[7px] border border-border-strong px-3 py-1.5 text-[13px] hover:border-ink disabled:opacity-50">
            {upload.isPending ? "Uploading…" : "Upload"}
          </button>
          {upload.isSuccess && <span className="text-[12.5px] text-positive">Parsed {upload.data.lines.length} lines</span>}
          {upload.isError && <span className="text-[12.5px] text-negative">{(upload.error as Error).message}</span>}
        </div>
        {lines.length > 0 && (
          <div className="mt-4">
            <DataTable rows={lines} columns={lineCols} rowKey={(r, i) => `${r.brand}|${r.region}|${r.category}|${i}`} totalsLabel="Total" exportName={`budget-lines-${clientId}`} />
          </div>
        )}
      </Panel>
    </div>
  );
}

export function BudgetInput() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["config", clientId], queryFn: () => getConfig(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!data) return <ErrorState msg="No config for this client." />;
  return <Form key={clientId} clientId={clientId} initial={data} />;
}
