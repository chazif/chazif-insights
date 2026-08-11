import { useState } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { ProductSoldRow } from "../lib/types";
import { money, num } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { DataTable, type Column } from "../components/ui/DataTable";
import { FilterInput } from "../components/ui/FilterInput";
import { Loading, ErrorState, Empty } from "../components/ui/States";

export function ProductsSold() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [q, setQ] = useState("");
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const p = data?.shopping_section?.products;
  if (!p?.rows?.length) return <Empty what="No Products Sold export for this client." />;

  const s = q.trim().toLowerCase();
  const rows = s ? p.rows.filter((r) => r.product.toLowerCase().includes(s)) : p.rows;
  const hasValue = p.totals.conv_value > 0;
  const hasConv = p.totals.conv > 0;

  const cols: Column<ProductSoldRow>[] = [
    { key: "product", header: "Product", sort: (r) => r.product, render: (r) => <span className="font-medium" title={r.product}>{r.product}</span>, csv: (r) => r.product },
    ...(p.has_units
      ? ([{ key: "units", header: "Units", align: "right", sort: (r: ProductSoldRow) => r.units, render: (r: ProductSoldRow) => num(r.units, 0), agg: { kind: "sum" as const, get: (r: ProductSoldRow) => r.units, fmt: (n: number) => num(n, 0) }, csv: (r: ProductSoldRow) => r.units }] as Column<ProductSoldRow>[])
      : []),
    ...(hasConv
      ? ([{ key: "conv", header: "Conversions", align: "right", sort: (r: ProductSoldRow) => r.conv, render: (r: ProductSoldRow) => num(r.conv, 1), agg: { kind: "sum" as const, get: (r: ProductSoldRow) => r.conv, fmt: (n: number) => num(n, 1) }, csv: (r: ProductSoldRow) => r.conv }] as Column<ProductSoldRow>[])
      : []),
    ...(hasValue
      ? ([{ key: "value", header: "Revenue", align: "right", sort: (r: ProductSoldRow) => r.conv_value, render: (r: ProductSoldRow) => money(r.conv_value), agg: { kind: "sum" as const, get: (r: ProductSoldRow) => r.conv_value, fmt: (n: number) => money(n) }, csv: (r: ProductSoldRow) => r.conv_value }] as Column<ProductSoldRow>[])
      : []),
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Products sold", value: num(p.total_products) },
          ...(p.has_units ? [{ label: "Units", value: num(p.totals.units, 0) }] : []),
          ...(hasConv ? [{ label: "Conversions", value: num(p.totals.conv, 1) }] : []),
          hasValue ? { label: "Revenue", value: money(p.totals.conv_value) } : { label: "Revenue", value: "—", sub: "value not tracked" },
        ]}
      />
      <div className="mb-3 mt-6 flex items-center gap-3">
        <h2 className="text-[16px] font-semibold">Top products</h2>
        <span className="text-[12px] text-text-muted">{num(rows.length)} of {num(p.rows.length)}</span>
        <div className="ml-auto"><FilterInput value={q} onChange={setQ} placeholder="Filter product…" /></div>
      </div>
      <DataTable rows={rows} columns={cols} rowKey={(r, i) => r.product + "|" + i} totalsLabel="Total (shown)" exportName={`products-sold-${clientId}`} />
      <p className="mt-2 text-[11.5px] text-text-muted">From the Products Sold report — what actually sold (Shopping / PMax cross-sell). Advertising-side product performance (impressions, clicks, ROAS per item) needs the Products report.</p>
    </div>
  );
}
