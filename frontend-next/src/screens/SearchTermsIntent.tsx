import { useParams } from "react-router-dom";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { useBundle } from "../hooks/useBundle";
import type { GradeRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const PALETTE = ["#cfff04", "#1a1a1a", "#2f7d4f", "#dc2626", "#9ca3af", "#6366f1", "#f59e0b", "#0ea5e9", "#a855f7", "#14b8a6"];

// Grade pill colours mirror the original: A/B green, C yellow, D orange, F red, else grey.
function GradePill({ g }: { g: string }) {
  const c = (g[0] || "").toUpperCase();
  const st =
    c === "A" || c === "B" ? { background: "#dcfce7", color: "#166534" }
    : c === "C" ? { background: "#fef3c7", color: "#92660a" }
    : c === "D" ? { background: "#fce7ce", color: "#9a5b1e" }
    : c === "F" ? { background: "#fee2e2", color: "#991b1b" }
    : { background: "#eee", color: "#555" };
  return <span className="inline-block rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium" style={st}>{g}</span>;
}

export function SearchTermsIntent() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const s = data?.search_terms_section;
  if (!s || !s.grades?.length) return <Empty what="No search-term data for this client." />;

  const svc = (s.service_categories ?? []).filter((c) => c.spend > 0);
  const pieData = svc.map((c) => ({ name: c.category, value: c.spend }));
  const comp = s.competitor_breakdown ?? [];
  const method = s.grade_method ?? [];
  const ignored = s.filters_ignored ?? [];

  const gradeCols: Column<GradeRow>[] = [
    { key: "grade", header: "Grade", render: (r) => <GradePill g={r.grade} />, sort: (r) => r.grade, csv: (r) => r.grade },
    { key: "terms", header: "Terms", align: "right", sort: (r) => r.terms, render: (r) => num(r.terms), agg: { kind: "sum", get: (r) => r.terms, fmt: (n) => num(n) }, csv: (r) => r.terms },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend },
    { key: "sh", header: "% of Spend", align: "right", sort: (r) => r.spend_share, render: (r) => pct(r.spend_share, 1), csv: (r) => r.spend_share },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 0), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 0) }, csv: (r) => r.conv },
    { key: "cpa", header: "CPA", align: "right", sort: (r) => r.cpa ?? Number.POSITIVE_INFINITY, render: (r) => (r.cpa ? money(r.cpa, 2) : "—"), csv: (r) => r.cpa ?? "" },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold">Search Term · Intent &amp; Grades</h2>
        <div className="text-[12.5px] text-text-muted">{num(s.total_terms)} terms · {money(s.total_spend)} spend</div>
      </div>

      {ignored.length > 0 && (
        <div className="mb-4 rounded-[10px] border border-border bg-[#fcfef0] px-4 py-3 text-[12.5px] text-text-secondary">
          The <strong className="text-ink">{ignored.join(" and ")}</strong> filter{ignored.length > 1 ? "s are" : " is"} not applied on this tab — the search-terms export carries no campaign or ad-group column. Segment, Category and Brand filters do apply.
        </div>
      )}

      <StatStrip
        stats={s.intent_segments.map((seg, i) => ({
          label: seg.name,
          value: num(seg.terms),
          highlight: i === 0,
          ...(seg.name === "Irrelevant"
            ? { delta: { text: `${pct(seg.spend_share, 1)} of spend`, good: false } }
            : { sub: `${pct(seg.spend_share, 1)} of spend` }),
        }))}
      />

      <div className="mt-6 grid grid-cols-2 items-start gap-5">
        <Panel title="Service categories by spend">
          <ResponsiveContainer width="100%" height={340}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="42%" cy="50%" innerRadius="55%" outerRadius="82%" startAngle={90} endAngle={pieData.length === 1 ? -269.99 : -270} stroke="#fff" strokeWidth={1} isAnimationActive={false}>
                {pieData.map((_, i) => (
                  <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v: number, n: string) => [money(v), n]} contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
              <Legend layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 11, fontFamily: "Instrument Sans" }} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Performance grades · term counts">
          <div className="mb-2 text-[12px] text-text-muted">Grades assigned by CVR thresholds on non-brand search terms.</div>
          <DataTable rows={s.grades} columns={gradeCols} rowKey={(r) => r.grade} totalsLabel="Total" exportName={`search-term-grades-${clientId}`} />
        </Panel>
      </div>

      {method.length > 0 && (
        <div className="mt-6">
          <Panel title="How grades are calculated">
            <div className="mb-2 text-[12px] text-text-muted">
              Non-brand search terms with $1+ spend are graded by conversion rate (CVR = conversions / clicks). Brand &amp; competitor terms are excluded.
            </div>
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted">Grade</th>
                  <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted">CVR Threshold</th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted">Interpretation</th>
                </tr>
              </thead>
              <tbody>
                {method.map((m) => (
                  <tr key={m.grade} className="border-t border-rule">
                    <td className="px-3 py-2"><GradePill g={m.grade} /></td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{m.threshold}</td>
                    <td className="px-3 py-2 text-text-secondary">{m.interpretation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}

      {comp.length > 0 && (
        <div className="mt-6">
          <Panel title="Competitor brand breakdown">
            <div className="mb-3 text-[12px] text-text-muted">Paid-search spend on queries that target named competitor brands.</div>
            <ResponsiveContainer width="100%" height={Math.max(140, comp.length * 44)}>
              <BarChart data={comp} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 20 }}>
                <XAxis type="number" tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} tickFormatter={(v: number) => `$${v}`} label={{ value: "Spend ($)", position: "insideBottom", offset: -8, style: { fontSize: 11, fill: "#6b7280" } }} />
                <YAxis type="category" dataKey="segment" width={110} tick={{ fontSize: 11, fill: "#374151", fontFamily: "Instrument Sans" }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v: number) => [money(v), "Spend"]} contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                <Bar dataKey="spend" fill="#1a1a1a" radius={[0, 3, 3, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      )}
    </div>
  );
}
