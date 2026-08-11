import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { GradeRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { BarList } from "../components/ui/BarList";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Pill } from "../components/ui/Pill";
import { GradingNote } from "../components/ui/GradingNote";
import { Loading, ErrorState, Empty } from "../components/ui/States";

type Tone = "pos" | "warn" | "neg" | "neutral";
const gradeTone = (g: string): Tone => {
  const c = (g[0] || "").toUpperCase();
  if (c === "A" || c === "B") return "pos";
  if (c === "C" || c === "D") return "warn";
  if (c === "F") return "neg";
  return "neutral"; // Low volume
};

export function SearchTermsIntent() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);

  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const s = data?.search_terms_section;
  if (!s || !s.grades?.length) return <Empty what="No search-term data for this client." />;

  const intents = [...s.intent_segments].filter((i) => i.spend > 0).sort((a, b) => b.spend - a.spend);
  const fRow = s.grades.find((g) => (g.grade[0] || "").toUpperCase() === "F");

  const gradeCols: Column<GradeRow>[] = [
    { key: "grade", header: "Grade", render: (r) => <Pill tone={gradeTone(r.grade)}>{r.grade}</Pill>, sort: (r) => r.grade, csv: (r) => r.grade },
    { key: "terms", header: "Terms", align: "right", sort: (r) => r.terms, render: (r) => num(r.terms), agg: { kind: "sum", get: (r) => r.terms, fmt: (n) => num(n) }, csv: (r) => r.terms },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 0), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 0) }, csv: (r) => r.conv },
    {
      key: "cpa",
      header: "CPA",
      align: "right",
      sort: (r) => r.cpa ?? Number.POSITIVE_INFINITY,
      render: (r) => (r.cpa ? money(r.cpa, 2) : "—"),
      agg: { kind: "rate", num: (r) => r.spend, den: (r) => r.conv, fmt: (n) => money(n, 2) },
      csv: (r) => r.cpa ?? "",
    },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="grid grid-cols-[1fr_1fr] items-start gap-5">
        <Panel title="Where the money goes" sub="non-brand search-term spend by intent">
          {intents.length ? (
            <BarList items={intents.map((i) => ({ label: i.name, meta: `${num(i.terms)} terms · ${money(i.spend)} · ${pct(i.spend_share, 0)}`, share: i.spend_share }))} />
          ) : (
            <div className="text-[12.5px] text-text-disabled">No intent breakdown.</div>
          )}
        </Panel>

        <Panel title="Performance grades" sub="by conversion rate">
          <DataTable rows={s.grades} columns={gradeCols} rowKey={(r) => r.grade} totalsLabel="All non-brand" exportName={`search-term-grades-${clientId}`} />
          <GradingNote className="mt-2" meta={s.grades_grading} metric="CVR" />
        </Panel>
      </div>

      {fRow && fRow.spend > 0 && (
        <div className="mt-5 rounded-[10px] border border-[#fcd34d] bg-[#fffbeb] p-4 text-[12.5px] text-[#92400e]">
          <strong>{money(fRow.spend)}</strong> sits on <strong>{num(fRow.terms)}</strong> F-graded terms that converted essentially nothing — the exact spend a{" "}
          <span className="underline">negative keyword shield</span> removes.
        </div>
      )}
    </div>
  );
}
