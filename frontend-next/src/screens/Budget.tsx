import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { BudgetCatRecon, BudgetLine } from "../lib/types";
import { money, pct, signedPct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const statusTone = (s: string) => (s === "over" ? "neg" : s === "under" ? "warn" : s === "on-track" ? "pos" : "neutral") as "neg" | "warn" | "pos" | "neutral";
const SOURCE_LABEL: Record<string, string> = { file: "Uploaded budget file", manual: "Manually entered", none: "Not set" };

export function Budget() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.budget_section;
  if (!sec || sec.total_monthly == null) return <Empty what="No monthly budget set. Add one in Plan → Budget Input." />;

  const recon = sec.reconciliation;

  const catCols: Column<BudgetCatRecon>[] = [
    { key: "cat", header: "Category", sort: (r) => r.category, render: (r) => <span className="font-medium">{r.category}</span>, csv: (r) => r.category },
    { key: "bud", header: "Budget", align: "right", sort: (r) => r.budget, render: (r) => money(r.budget), agg: { kind: "sum", get: (r) => r.budget, fmt: (n) => money(n) }, csv: (r) => r.budget },
    { key: "act", header: "Actual", align: "right", sort: (r) => r.actual, render: (r) => money(r.actual), agg: { kind: "sum", get: (r) => r.actual, fmt: (n) => money(n) }, csv: (r) => r.actual },
    { key: "var", header: "Variance", align: "right", sort: (r) => r.variance, render: (r) => <span className={r.variance > 0 ? "text-negative" : "text-positive"}>{signedPct(r.pct != null ? r.pct - 1 : 0)}</span>, csv: (r) => r.variance },
    { key: "st", header: "Status", render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>, csv: (r) => r.status },
  ];

  const lineCols: Column<BudgetLine>[] = [
    { key: "brand", header: "Brand", render: (r) => r.brand ?? <span className="text-text-disabled">—</span>, csv: (r) => r.brand ?? "" },
    { key: "region", header: "Region", render: (r) => r.region ?? <span className="text-text-disabled">—</span>, csv: (r) => r.region ?? "" },
    { key: "cat", header: "Category", render: (r) => r.category ?? <span className="text-text-disabled">—</span>, csv: (r) => r.category ?? "" },
    { key: "mo", header: "Monthly", align: "right", sort: (r) => r.monthly, render: (r) => money(r.monthly), agg: { kind: "sum", get: (r) => r.monthly, fmt: (n) => money(n) }, csv: (r) => r.monthly },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Monthly budget", value: money(sec.total_monthly), sub: SOURCE_LABEL[sec.source] ?? sec.source },
          ...(recon
            ? [
                { label: `Actual · ${recon.month}`, value: money(recon.total_actual) },
                { label: "Pacing", value: recon.pct != null ? pct(recon.pct, 0) : "—", delta: { text: `${signedPct(recon.pct != null ? recon.pct - 1 : 0)} vs budget`, good: recon.variance <= 0 } },
              ]
            : []),
        ]}
      />

      {recon && (
        <Panel title={`Reconciliation · ${recon.month}`} className="mt-6">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-[13px]">
            <div>Budget <span className="ml-1 font-mono font-semibold">{money(recon.total_budget)}</span></div>
            <div>Actual <span className="ml-1 font-mono font-semibold">{money(recon.total_actual)}</span></div>
            <div>Variance <span className={`ml-1 font-mono font-semibold ${recon.variance > 0 ? "text-negative" : "text-positive"}`}>{recon.variance > 0 ? "+" : ""}{money(recon.variance)}</span></div>
            <Pill tone={statusTone(recon.status)}>{recon.status}</Pill>
          </div>
        </Panel>
      )}

      {recon?.by_category?.length ? (
        <div className="mt-6">
          <h2 className="mb-2 text-[16px] font-semibold">By category</h2>
          <DataTable rows={recon.by_category} columns={catCols} rowKey={(r) => r.category} totalsLabel="Total" exportName={`budget-recon-${clientId}`} />
        </div>
      ) : null}

      {sec.lines.length ? (
        <div className="mt-6">
          <h2 className="mb-2 text-[16px] font-semibold">Budget lines <span className="text-[12px] font-normal text-text-muted">{sec.line_count}</span></h2>
          <DataTable rows={sec.lines} columns={lineCols} rowKey={(r, i) => `${r.brand}|${r.region}|${r.category}|${i}`} totalsLabel="Total" exportName={`budget-lines-${clientId}`} />
        </div>
      ) : (
        <p className="mt-6 text-[12.5px] text-text-muted">Budget is a single manual monthly total — no dimensional (brand / region / category) lines uploaded.</p>
      )}
    </div>
  );
}
