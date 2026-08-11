import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { QsPerRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { BarList } from "../components/ui/BarList";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

export function QualityScore() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.quality_score;
  if (!sec?.per_qs?.length) return <Empty what="No Quality Score data for this client." />;

  const t = sec.totals;
  const perCols: Column<QsPerRow>[] = [
    { key: "qs", header: "QS", align: "right", sort: (r) => r.qs, render: (r) => <span className="font-mono font-semibold">{r.qs}</span>, csv: (r) => r.qs },
    { key: "kw", header: "Keywords", align: "right", sort: (r) => r.keywords, render: (r) => num(r.keywords), agg: { kind: "sum", get: (r) => r.keywords, fmt: (n) => num(n) }, csv: (r) => r.keywords },
    { key: "kwsh", header: "KW share", align: "right", sort: (r) => r.kw_share, render: (r) => pct(r.kw_share, 1), csv: (r) => r.kw_share },
    { key: "cost", header: "Cost", align: "right", sort: (r) => r.cost, render: (r) => money(r.cost), agg: { kind: "sum", get: (r) => r.cost, fmt: (n) => money(n) }, csv: (r) => r.cost },
    { key: "spsh", header: "Spend share", align: "right", sort: (r) => r.spend_share, render: (r) => pct(r.spend_share, 1), csv: (r) => r.spend_share },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
    { key: "cpc", header: "CPC", align: "right", sort: (r) => r.cpc, render: (r) => money(r.cpc, 2), agg: { kind: "rate", num: (r) => r.cost, den: (r) => r.clicks, fmt: (n) => money(n, 2) }, csv: (r) => r.cpc },
    { key: "cvr", header: "CVR", align: "right", sort: (r) => r.conv_rate, render: (r) => pct(r.conv_rate, 2), agg: { kind: "rate", num: (r) => r.conv, den: (r) => r.clicks, fmt: (n) => pct(n, 2) }, csv: (r) => r.conv_rate },
    { key: "cpa", header: "CPA", align: "right", sort: (r) => r.cpa, render: (r) => (r.cpa ? money(r.cpa, 2) : "—"), agg: { kind: "rate", num: (r) => r.cost, den: (r) => r.conv, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa },
  ];

  const buckets = sec.buckets.map((b) => ({
    label: b.label,
    meta: `${num(b.keywords)} kw · ${money(b.cost)} · ${pct(b.spend_share, 0)} spend`,
    share: b.spend_share,
  }));

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Avg QS (non-brand)", value: sec.avg_qs.toFixed(1), sub: `${num(sec.total_keywords)} keywords` },
          { label: "Weak (QS ≤ 5)", value: pct(sec.pct_weak, 0) },
          { label: "Strong (QS ≥ 7)", value: pct(sec.pct_strong, 0) },
          { label: "Est. QS savings", value: money(sec.savings.amount), sub: `CPC ${money(sec.savings.cpc_weak, 2)} → ${money(sec.savings.cpc_qs7, 2)}` },
        ]}
      />
      <div className="mt-6 grid grid-cols-[1fr_1fr] items-start gap-5">
        <Panel title="Spend by QS bucket" sub="green = better, not up">
          <BarList items={buckets} />
        </Panel>
        <Panel title="Avg QS trend" sub="frozen from QS history">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.06em] text-text-muted">
                <th className="pb-2 text-left">Month</th>
                <th className="pb-2 text-right">Avg QS</th>
                <th className="pb-2 text-right">Keywords</th>
              </tr>
            </thead>
            <tbody>
              {sec.trend.map((p) => (
                <tr key={p.month} className="border-t border-rule">
                  <td className="py-1.5">{p.month}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums font-semibold">{p.avg_qs.toFixed(1)}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-text-muted">{num(p.keywords)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">Keywords by Quality Score</h2>
        <DataTable rows={sec.per_qs} columns={perCols} rowKey={(r) => String(r.qs)} totalsLabel={`Portfolio (${num(t.keywords)} kw)`} exportName={`quality-score-${clientId}`} />
      </div>
    </div>
  );
}
