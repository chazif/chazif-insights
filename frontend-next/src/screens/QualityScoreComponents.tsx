import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle } from "../lib/api";
import type { QsOptKeyword } from "../lib/types";
import { money, num, signedPct } from "../lib/format";
import { ratingTone } from "../lib/grades";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const qsTone = (q: number) => (q >= 7 ? "pos" : q >= 4 ? "warn" : "neg");

export function QualityScoreComponents() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.qs_breakdown_section;
  if (!sec?.components?.length) return <Empty what="No Quality Score component data for this client." />;

  const sv = sec.savings_by_brand[0];
  const opt = sec.opt_keywords;

  const cols: Column<QsOptKeyword>[] = [
    { key: "kw", header: "Keyword", sort: (r) => r.keyword, render: (r) => <span className="font-medium">{r.keyword}</span>, csv: (r) => r.keyword },
    { key: "cat", header: "Category", sort: (r) => r.category, render: (r) => <span className="text-text-tertiary">{r.category}</span>, csv: (r) => r.category },
    { key: "qs", header: "QS", align: "right", sort: (r) => r.qs, render: (r) => <Pill tone={qsTone(r.qs)}>{r.qs}</Pill>, csv: (r) => r.qs },
    { key: "ectr", header: "Exp. CTR", sort: (r) => r.ectr, render: (r) => <Pill tone={ratingTone(r.ectr)}>{r.ectr}</Pill>, csv: (r) => r.ectr },
    { key: "adrel", header: "Ad rel.", sort: (r) => r.ad_rel, render: (r) => <Pill tone={ratingTone(r.ad_rel)}>{r.ad_rel}</Pill>, csv: (r) => r.ad_rel },
    { key: "lp", header: "LP exp.", sort: (r) => r.lp_exp, render: (r) => <Pill tone={ratingTone(r.lp_exp)}>{r.lp_exp}</Pill>, csv: (r) => r.lp_exp },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks },
    { key: "cpc", header: "CPC", align: "right", sort: (r) => r.cpc, render: (r) => money(r.cpc, 2), agg: { kind: "rate", num: (r) => r.spend, den: (r) => r.clicks, fmt: (n) => money(n, 2) }, csv: (r) => r.cpc },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Avg CPC (non-brand)", value: money(sec.avg_cpc, 2) },
          { label: "Keywords to optimize", value: num(opt.total), sub: "QS ≤ 6" },
          ...(sv ? [{ label: "Est. savings", value: money(sv.savings), sub: sv.primary_gap }] : []),
        ]}
      />

      <div className="mt-6 grid grid-cols-3 gap-4">
        {sec.components.map((comp) => (
          <Panel key={comp.key} title={comp.label}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.05em] text-text-muted">
                  <th className="pb-1.5 text-left">Rating</th>
                  <th className="pb-1.5 text-right">KW</th>
                  <th className="pb-1.5 text-right">CPC</th>
                  <th className="pb-1.5 text-right">vs avg</th>
                </tr>
              </thead>
              <tbody>
                {comp.ratings.map((r) => (
                  <tr key={r.rating} className="border-t border-rule">
                    <td className="py-1.5"><Pill tone={ratingTone(r.rating)}>{r.rating}</Pill></td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{num(r.keywords)}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{money(r.cpc, 2)}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {r.cpc_vs_avg == null ? <span className="text-text-disabled">—</span> : <span className={r.cpc_vs_avg <= 0 ? "text-positive" : "text-negative"}>{signedPct(r.cpc_vs_avg)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">
          Optimization candidates <span className="text-[12px] font-normal text-text-muted">showing {num(opt.shown)} of {num(opt.total)}</span>
        </h2>
        <DataTable rows={opt.rows} columns={cols} rowKey={(r, i) => r.keyword + "|" + i} totalsLabel="Total (shown)" exportName={`qs-components-${clientId}`} />
      </div>
    </div>
  );
}
