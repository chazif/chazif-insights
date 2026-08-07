import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle } from "../lib/api";
import type { RegionCell } from "../lib/types";
import { money, num, signedPct } from "../lib/format";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const frac = (cur: number, prior: number) => (prior ? (cur - prior) / prior : null);

export function Regions() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.regions_section;
  if (!sec?.cells?.length) return <Empty what="No region breakdown for this client." />;

  const multiCat = sec.categories.length > 1;
  const cols: Column<RegionCell>[] = [
    { key: "region", header: "Region", sort: (r) => r.region, render: (r) => <span className="font-medium">{r.region}</span>, csv: (r) => r.region },
    ...(multiCat ? [{ key: "cat", header: "Category", sort: (r: RegionCell) => r.category, render: (r: RegionCell) => <span className="text-text-tertiary">{r.category}</span>, csv: (r: RegionCell) => r.category }] : []),
    { key: "sp", header: `Spend · ${sec.prior_label}`, align: "right", sort: (r) => r.spend_prior, render: (r) => money(r.spend_prior), agg: { kind: "sum", get: (r) => r.spend_prior, fmt: (n) => money(n) }, csv: (r) => r.spend_prior },
    { key: "sc", header: `Spend · ${sec.cur_label}`, align: "right", sort: (r) => r.spend_cur, render: (r) => money(r.spend_cur), agg: { kind: "sum", get: (r) => r.spend_cur, fmt: (n) => money(n) }, csv: (r) => r.spend_cur },
    {
      key: "schg", header: "Δ Spend", align: "right", sort: (r) => frac(r.spend_cur, r.spend_prior) ?? 0,
      render: (r) => { const f = frac(r.spend_cur, r.spend_prior); return f == null ? <span className="text-text-disabled">—</span> : <span className={f >= 0 ? "text-positive" : "text-negative"}>{signedPct(f)}</span>; },
      csv: (r) => frac(r.spend_cur, r.spend_prior) ?? "",
    },
    { key: "cp", header: `Conv · ${sec.prior_label}`, align: "right", sort: (r) => r.conv_prior, render: (r) => num(r.conv_prior, 1), agg: { kind: "sum", get: (r) => r.conv_prior, fmt: (n) => num(n, 1) }, csv: (r) => r.conv_prior },
    { key: "cc", header: `Conv · ${sec.cur_label}`, align: "right", sort: (r) => r.conv_cur, render: (r) => num(r.conv_cur, 1), agg: { kind: "sum", get: (r) => r.conv_cur, fmt: (n) => num(n, 1) }, csv: (r) => r.conv_cur },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <h2 className="mb-2 text-[16px] font-semibold">Regions <span className="text-[12px] font-normal text-text-muted">{sec.prior_label} → {sec.cur_label}</span></h2>
      <DataTable rows={sec.cells} columns={cols} rowKey={(r, i) => r.region + "|" + r.category + "|" + i} totalsLabel="All regions" exportName={`regions-${clientId}`} />
    </div>
  );
}
