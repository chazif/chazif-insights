import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getInventory } from "../lib/api";
import type { InventoryReport } from "../lib/types";
import { num } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const pretty = (slug: string) => slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function DataInventory() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["inventory", clientId], queryFn: () => getInventory(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!data) return <Empty what="No inventory for this client." />;

  const reports = data.reports ?? [];
  const totalRows = reports.reduce((a, r) => a + (r.rows ?? 0), 0);

  const cols: Column<InventoryReport>[] = [
    { key: "report", header: "Report", sort: (r) => r.report_type, render: (r) => <span className="font-medium">{pretty(r.report_type)}</span>, csv: (r) => r.report_type },
    { key: "file", header: "Source file", render: (r) => <span className="text-text-tertiary">{r.source_file ?? "—"}</span>, csv: (r) => r.source_file ?? "" },
    { key: "window", header: "Window", render: (r) => <span className="text-text-tertiary">{r.window ?? "—"}</span>, csv: (r) => r.window ?? "" },
    { key: "rows", header: "Rows", align: "right", sort: (r) => r.rows ?? 0, render: (r) => num(r.rows ?? 0), agg: { kind: "sum", get: (r) => r.rows ?? 0, fmt: (n) => num(n) }, csv: (r) => r.rows ?? 0 },
    { key: "uploaded", header: "Uploaded", align: "right", sort: (r) => r.uploaded_at ?? "", render: (r) => <span className="text-text-tertiary">{r.uploaded_at ? new Date(r.uploaded_at).toLocaleDateString() : "—"}</span>, csv: (r) => r.uploaded_at ?? "" },
  ];

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6">
      <h1 className="mb-4 text-[19px] font-semibold tracking-[-0.01em]">Data Inventory</h1>

      <StatStrip
        stats={[
          { label: "Coverage", value: data.coverage },
          { label: "Reports loaded", value: num(data.present?.length ?? 0) },
          { label: "Total rows", value: num(totalRows) },
          { label: "Missing", value: num(data.missing?.length ?? 0) },
        ]}
      />

      {data.missing?.length > 0 && (
        <Panel title="Missing reports" sub="Expected but not yet uploaded" className="mt-6">
          <div className="flex flex-wrap gap-2">
            {data.missing.map((m) => <Pill key={m} tone="warn">{pretty(m)}</Pill>)}
          </div>
        </Panel>
      )}

      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">Loaded reports</h2>
        {reports.length ? (
          <DataTable rows={reports} columns={cols} rowKey={(r) => r.report_type} totalsLabel="Total" exportName={`inventory-${clientId}`} />
        ) : (
          <Empty what="No reports loaded — add data via Setup → Upload Data." />
        )}
      </div>
    </div>
  );
}
