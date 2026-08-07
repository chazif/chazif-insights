import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle } from "../lib/api";
import type { KeywordRow } from "../lib/types";
import { money, num } from "../lib/format";
import { ratingTone } from "../lib/grades";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const qsTone = (q: number | null) => (q == null ? "neutral" : q >= 7 ? "pos" : q >= 4 ? "warn" : "neg");

export function KeywordDeepDive() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.keyword_section;
  if (!sec?.deep_dive?.length) return <Empty what="No keyword (Quality Score) export for this client." />;

  const cols: Column<KeywordRow>[] = [
    { key: "kw", header: "Keyword", sort: (r) => r.keyword, render: (r) => <span className="font-medium">{r.keyword}</span>, csv: (r) => r.keyword },
    { key: "match", header: "Match", sort: (r) => r.match, render: (r) => <span className="text-text-tertiary">{r.match}</span>, csv: (r) => r.match },
    { key: "qs", header: "QS", align: "right", sort: (r) => r.qs ?? -1, render: (r) => (r.qs == null ? <span className="text-text-disabled">—</span> : <Pill tone={qsTone(r.qs)}>{r.qs}</Pill>), csv: (r) => r.qs ?? "" },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks },
    { key: "cost", header: "Cost", align: "right", sort: (r) => r.cost, render: (r) => money(r.cost), agg: { kind: "sum", get: (r) => r.cost, fmt: (n) => money(n) }, csv: (r) => r.cost },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
    { key: "cpa", header: "CPA", align: "right", sort: (r) => r.cpa, render: (r) => (r.cpa ? money(r.cpa, 2) : "—"), agg: { kind: "rate", num: (r) => r.cost, den: (r) => r.conv, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa },
  ];

  const compEntries = Object.entries(sec.components);

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-6">
      <StatStrip
        stats={[
          { label: "Top keywords shown", value: num(sec.deep_dive.length) },
          { label: "Spend on below-avg CTR", value: money(sec.below_ctr_spend) },
          { label: "Est. savings if fixed", value: money(sec.savings_estimate), sub: "modeled CPC penalty" },
        ]}
      />
      <div className="mt-6 grid grid-cols-3 gap-4">
        {compEntries.map(([label, rows]) => (
          <Panel key={label} title={label}>
            <table className="w-full text-[12px]">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.rating} className="border-b border-rule last:border-0">
                    <td className="py-1.5"><Pill tone={ratingTone(r.rating)}>{r.rating}</Pill></td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{num(r.keywords)} kw</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-text-muted">{money(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>
      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">Top keywords by spend</h2>
        <DataTable rows={sec.deep_dive} columns={cols} rowKey={(r, i) => r.keyword + "|" + r.match + "|" + i} totalsLabel="Total (shown)" exportName={`keywords-${clientId}`} />
      </div>
    </div>
  );
}
