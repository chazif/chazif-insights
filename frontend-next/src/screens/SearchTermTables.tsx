import { useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { RelevantTerm, CompetitorTerm, FlaggedTerm } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Pill } from "../components/ui/Pill";
import { FilterInput } from "../components/ui/FilterInput";
import { Loading, ErrorState, Empty } from "../components/ui/States";

type Dim = { term: string; campaign: string | null; ad_group: string | null; search_keyword: string | null };

const gradeTone = (g: string): "pos" | "warn" | "neg" | "neutral" => {
  const c = (g[0] || "").toUpperCase();
  return c === "A" || c === "B" ? "pos" : c === "C" || c === "D" ? "warn" : c === "F" ? "neg" : "neutral";
};

// The term / campaign / ad group / search-keyword columns every search-term table shares —
// so "church goods" appearing under several campaigns is never ambiguous.
function dimCols<T extends Dim>(): Column<T>[] {
  const col = (key: string, header: string, get: (r: T) => string | null): Column<T> => ({
    key,
    header,
    sort: (r) => get(r) ?? "",
    render: (r) => (get(r) ? <span className={key === "term" ? "font-medium" : "text-text-tertiary"}>{get(r)}</span> : <span className="text-text-disabled">—</span>),
    csv: (r) => get(r) ?? "",
  });
  return [col("term", "Search Term", (r) => r.term), col("campaign", "Campaign", (r) => r.campaign), col("ad_group", "Ad Group", (r) => r.ad_group), col("search_keyword", "Search Keyword", (r) => r.search_keyword)];
}

const spendCol = <T extends { spend: number }>(): Column<T> => ({ key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend });
const clicksCol = <T extends { clicks: number }>(): Column<T> => ({ key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks });
const convCol = <T extends { conv: number }>(): Column<T> => ({ key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv });
const cvrCol = <T extends { conv: number; clicks: number }>(): Column<T> => ({ key: "cvr", header: "CVR", align: "right", sort: (r) => (r.clicks ? r.conv / r.clicks : 0), render: (r) => pct(r.clicks ? r.conv / r.clicks : 0, 2), agg: { kind: "rate", num: (r) => r.conv, den: (r) => r.clicks, fmt: (n) => pct(n, 2) }, csv: (r) => (r.clicks ? r.conv / r.clicks : 0) });
const cpaCol = <T extends { spend: number; conv: number; cpa: number | null }>(): Column<T> => ({ key: "cpa", header: "CPA", align: "right", sort: (r) => r.cpa ?? Number.POSITIVE_INFINITY, render: (r) => (r.cpa ? money(r.cpa, 2) : "—"), agg: { kind: "rate", num: (r) => r.spend, den: (r) => r.conv, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa ?? "" });

function useFiltered<T extends Dim>(rows: T[]) {
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const filtered = s ? rows.filter((r) => `${r.term} ${r.campaign ?? ""} ${r.ad_group ?? ""} ${r.search_keyword ?? ""}`.toLowerCase().includes(s)) : rows;
  return { q, setQ, filtered };
}

function Shell({ title, sub, q, setQ, children }: { title: string; sub: string; q: string; setQ: (v: string) => void; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        <span className="text-[12px] text-text-muted">{sub}</span>
        <div className="ml-auto">
          <FilterInput value={q} onChange={setQ} placeholder="Filter term…" />
        </div>
      </div>
      {children}
    </div>
  );
}

function useTerms() {
  const { clientId = "" } = useParams();
  const query = useBundle(clientId);
  return { clientId, ...query };
}

export function RelevantTerms() {
  const { clientId, data, isLoading, error } = useTerms();
  const rows = data?.search_terms_section?.relevant_terms ?? [];
  const f = useFiltered(rows);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!rows.length) return <Empty what="No relevant terms for this client." />;
  const cols: Column<RelevantTerm>[] = [
    ...dimCols<RelevantTerm>(),
    { key: "category", header: "Category", sort: (r) => r.category, render: (r) => <span className="text-text-tertiary">{r.category}</span>, csv: (r) => r.category },
    { key: "grade", header: "Grade", sort: (r) => r.grade, render: (r) => <Pill tone={gradeTone(r.grade)}>{r.grade}</Pill>, csv: (r) => r.grade },
    spendCol(),
    clicksCol(),
    convCol(),
    cvrCol(),
    { key: "cpc", header: "CPC", align: "right", sort: (r) => r.cpc, render: (r) => money(r.cpc, 2), agg: { kind: "rate", num: (r) => r.spend, den: (r) => r.clicks, fmt: (n) => money(n, 2) }, csv: (r) => r.cpc },
  ];
  return (
    <Shell title="Relevant Terms" sub={`${num(f.filtered.length)} of ${num(rows.length)}`} q={f.q} setQ={f.setQ}>
      <DataTable rows={f.filtered} columns={cols} rowKey={(r, i) => r.term + "|" + i} totalsLabel="Total" exportName={`relevant-terms-${clientId}`} />
    </Shell>
  );
}

export function CompetitorTerms() {
  const { clientId, data, isLoading, error } = useTerms();
  const rows = data?.search_terms_section?.competitor_terms ?? [];
  const f = useFiltered(rows);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!rows.length) return <Empty what="No competitor terms — add competitors in Business Context." />;
  const cols: Column<CompetitorTerm>[] = [
    ...dimCols<CompetitorTerm>(),
    { key: "competitor", header: "Competitor", sort: (r) => r.competitor, render: (r) => <Pill tone="neutral">{r.competitor}</Pill>, csv: (r) => r.competitor },
    spendCol(),
    clicksCol(),
    convCol(),
    cvrCol(),
    cpaCol(),
  ];
  return (
    <Shell title="Competitor Terms" sub={`${num(f.filtered.length)} of ${num(rows.length)}`} q={f.q} setQ={f.setQ}>
      <DataTable rows={f.filtered} columns={cols} rowKey={(r, i) => r.term + "|" + i} totalsLabel="Total" exportName={`competitor-terms-${clientId}`} />
    </Shell>
  );
}

export function Triage() {
  const { clientId, data, isLoading, error } = useTerms();
  const rows = data?.search_terms_section?.flagged_terms ?? [];
  const f = useFiltered(rows);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!rows.length) return <Empty what="Nothing needs review." />;
  const cols: Column<FlaggedTerm>[] = [
    ...dimCols<FlaggedTerm>(),
    { key: "intent", header: "Intent", sort: (r) => r.intent, render: (r) => <Pill tone="neutral">{r.intent}</Pill>, csv: (r) => r.intent },
    { key: "status", header: "Status", sort: (r) => r.status, render: (r) => <span className="text-text-tertiary">{r.status}</span>, csv: (r) => r.status },
    spendCol(),
    clicksCol(),
    convCol(),
    cvrCol(),
    cpaCol(),
  ];
  return (
    <Shell title="Triage" sub={`${num(f.filtered.length)} of ${num(rows.length)} flagged for review`} q={f.q} setQ={f.setQ}>
      <DataTable rows={f.filtered} columns={cols} rowKey={(r, i) => r.term + "|" + i} totalsLabel="Total" exportName={`triage-${clientId}`} />
    </Shell>
  );
}
