import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { NbCatRow } from "../lib/types";
import { money, num, signedPct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const chgCell = (v: number | null, betterUp = true) => {
  if (v == null) return <span className="text-text-disabled">—</span>;
  const good = betterUp ? v >= 0 : v <= 0;
  return <span className={good ? "text-positive" : "text-negative"}>{signedPct(v)}</span>;
};

export function NonBrandCategories() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.nb_categories_section;
  if (!sec?.rows?.length) return <Empty what="No non-brand category breakdown for this client." />;

  const t = sec.totals;
  const cols: Column<NbCatRow>[] = [
    { key: "category", header: "Category", sort: (r) => r.category, render: (r) => <span className="font-medium">{r.category}</span>, csv: (r) => r.category },
    { key: "sp", header: `Spend · ${sec.prior_label}`, align: "right", sort: (r) => r.spend_prior, render: (r) => money(r.spend_prior), agg: { kind: "sum", get: (r) => r.spend_prior, fmt: (n) => money(n) }, csv: (r) => r.spend_prior },
    { key: "sc", header: `Spend · ${sec.cur_label}`, align: "right", sort: (r) => r.spend_cur, render: (r) => money(r.spend_cur), agg: { kind: "sum", get: (r) => r.spend_cur, fmt: (n) => money(n) }, csv: (r) => r.spend_cur },
    { key: "schg", header: "Δ Spend", align: "right", sort: (r) => r.spend_chg ?? 0, render: (r) => chgCell(r.spend_chg), csv: (r) => r.spend_chg ?? "" },
    { key: "cc", header: `Conv · ${sec.cur_label}`, align: "right", sort: (r) => r.conv_cur, render: (r) => num(r.conv_cur, 1), agg: { kind: "sum", get: (r) => r.conv_cur, fmt: (n) => num(n, 1) }, csv: (r) => r.conv_cur },
    { key: "cchg", header: "Δ Conv", align: "right", sort: (r) => r.conv_chg ?? 0, render: (r) => chgCell(r.conv_chg), csv: (r) => r.conv_chg ?? "" },
    { key: "cpa", header: `CPA · ${sec.cur_label}`, align: "right", sort: (r) => r.cpa_cur, render: (r) => money(r.cpa_cur, 2), agg: { kind: "rate", num: (r) => r.spend_cur, den: (r) => r.conv_cur, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa_cur },
    { key: "cpachg", header: "Δ CPA", align: "right", sort: (r) => r.cpa_chg ?? 0, render: (r) => chgCell(r.cpa_chg, false), csv: (r) => r.cpa_chg ?? "" },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <StatStrip
        stats={[
          { label: `Non-brand spend · ${sec.cur_label}`, value: money(t.spend_cur), delta: t.spend_chg == null ? undefined : { text: `${signedPct(t.spend_chg)} vs ${sec.prior_label}`, good: t.spend_chg >= 0 } },
          { label: "Conversions", value: num(t.conv_cur, 1), delta: t.conv_chg == null ? undefined : { text: signedPct(t.conv_chg), good: t.conv_chg >= 0 } },
          { label: "Blended CPA", value: money(t.cpa_cur, 2), delta: t.cpa_chg == null ? undefined : { text: signedPct(t.cpa_chg), good: t.cpa_chg <= 0 } },
        ]}
      />
      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">By category</h2>
        <DataTable rows={sec.rows} columns={cols} rowKey={(r) => r.category} totalsLabel="Non-Brand Total" exportName={`nb-categories-${clientId}`} />
      </div>
    </div>
  );
}
