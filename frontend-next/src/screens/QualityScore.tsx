import {
  Area, Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import { money, num, pct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { Loading, ErrorState, Empty } from "../components/ui/States";

// Bucket colour ramp by QS band (mirrors the original app): poor red, below-avg orange,
// average grey, strong green.
const qsColor = (qs: number) => (qs <= 3 ? "#dc2626" : qs <= 5 ? "#f59e0b" : qs <= 7 ? "#9ca3af" : "#2f7d4f");

const TH = "px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted";
const TD = "px-3 py-2 border-t border-rule";
const NUM = "text-right font-mono tabular-nums";

export function QualityScore() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.quality_score;
  if (!sec?.per_qs?.length) return <Empty what="No Quality Score data for this client." />;

  const scope = sec.non_brand ? "non-brand" : "";
  const t = sec.totals;
  const distData = sec.per_qs.map((r) => ({ qs: `QS ${r.qs}`, keywords: r.keywords, spendPct: +(r.spend_share * 100).toFixed(2), _qs: r.qs }));
  const cpcData = sec.per_qs.map((r) => ({ qs: `QS ${r.qs}`, cpc: r.cpc, ctr: +(r.ctr * 100).toFixed(2) }));

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-6">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-[18px] font-semibold">Quality Score Overview{scope && " · Non-Brand Portfolio"}</h2>
          <div className="text-[12.5px] text-text-muted">
            {sec.month && `${sec.month} · `}Distribution of QS across {num(sec.total_keywords)} {scope && `${scope} `}keywords and the CPC differential each score carries
          </div>
        </div>
        <span className="rounded-full bg-accent px-2.5 py-1 text-[12px] font-semibold text-ink">Avg QS {sec.avg_qs.toFixed(1)}</span>
      </div>

      <StatStrip
        stats={[
          { label: "Avg Quality Score", value: sec.avg_qs.toFixed(1), sub: `${scope || "graded"} keywords`, highlight: true },
          { label: `${scope ? "NB " : ""}Keywords`, value: num(sec.total_keywords), sub: `graded${sec.month ? ` in ${sec.month}` : ""}` },
          { label: "QS ≤ 5 (Weak)", value: pct(sec.pct_weak, 0), delta: { text: "of portfolio", good: false } },
          { label: "QS ≥ 7 (Strong)", value: pct(sec.pct_strong, 0), delta: { text: "of portfolio", good: true } },
          { label: "Est. Monthly Savings", value: money(sec.savings.amount), sub: "if QS ≤ 5 → QS 7" },
        ]}
      />

      <div className="mt-4 rounded-[10px] border border-border bg-[#fcfef0] px-4 py-3 text-[13px] text-text-secondary">
        If keywords at QS ≤ 5 could be improved to QS 7, the portfolio would save an estimated{" "}
        <strong className="text-ink">{money(sec.savings.amount)}/mo</strong> based on the CPC differential ({money(sec.savings.cpc_weak, 2)} → {money(sec.savings.cpc_qs7, 2)}).
      </div>

      {sec.trend.length >= 2 && (
        <div className="mt-6">
          <Panel title="Average Quality Score over time" sub={`${scope ? `${scope} ` : ""}portfolio · monthly`}>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={sec.trend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#f3f4f6" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} minTickGap={16} />
                <YAxis domain={[0, 10]} ticks={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} width={40} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} label={{ value: "Avg QS", angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "#6b7280" } }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} formatter={(v: number) => [v.toFixed(1), "Avg QS"]} />
                <Area type="monotone" dataKey="avg_qs" stroke="#2f7d4f" strokeWidth={2} fill="rgba(47,125,79,0.12)" dot={{ r: 3, fill: "#2f7d4f", stroke: "#2f7d4f" }} activeDot={{ r: 4 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 items-start gap-5">
        <Panel title="QS distribution — keywords & spend share">
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={distData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
              <CartesianGrid stroke="#f3f4f6" vertical={false} />
              <XAxis dataKey="qs" tick={{ fontSize: 10.5, fill: "#6b7280", fontFamily: "Instrument Sans" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} interval={0} />
              <YAxis yAxisId="left" width={36} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} label={{ value: "Keywords", angle: -90, position: "insideLeft", style: { fontSize: 10.5, fill: "#6b7280" } }} />
              <YAxis yAxisId="right" orientation="right" width={44} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} formatter={(v: number, n: string) => (n === "% of Spend" ? [`${v}%`, n] : [num(v), n])} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "Instrument Sans" }} />
              <Bar yAxisId="left" dataKey="keywords" name="Keywords" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {distData.map((d, i) => (
                  <Cell key={i} fill={qsColor(d._qs)} />
                ))}
              </Bar>
              <Line yAxisId="right" type="monotone" dataKey="spendPct" name="% of Spend" stroke="#1a1a1a" strokeWidth={2} dot={{ r: 2, fill: "#1a1a1a" }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Avg CPC & CTR by QS">
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={cpcData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
              <CartesianGrid stroke="#f3f4f6" vertical={false} />
              <XAxis dataKey="qs" tick={{ fontSize: 10.5, fill: "#6b7280", fontFamily: "Instrument Sans" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} interval={0} />
              <YAxis yAxisId="left" width={46} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${v}`} label={{ value: "Avg CPC ($)", angle: -90, position: "insideLeft", style: { fontSize: 10.5, fill: "#6b7280" } }} />
              <YAxis yAxisId="right" orientation="right" width={44} tick={{ fontSize: 11, fill: "#6b7280", fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} formatter={(v: number, n: string) => (n === "CTR" ? [`${v}%`, n] : [money(v, 2), n])} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "Instrument Sans" }} />
              <Line yAxisId="left" type="monotone" dataKey="cpc" name="Avg CPC" stroke="#1a1a1a" strokeWidth={2} dot={{ r: 2, fill: "#1a1a1a" }} isAnimationActive={false} />
              <Line yAxisId="right" type="monotone" dataKey="ctr" name="CTR" stroke="#cfff04" strokeWidth={2.5} dot={{ r: 2, fill: "#cfff04", stroke: "#1a1a1a" }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="QS bucket summary">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>Bucket</th>
                  {["Keywords", "% of KWs", "Spend", "% of Spend", "Avg CPC", "CTR", "Conv Rate", "Avg CPA", "Conversions"].map((h) => (
                    <th key={h} className={`${TH} text-right`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sec.buckets.map((b) => (
                  <tr key={b.label}>
                    <td className={`${TD} font-medium`}><span style={{ borderLeft: `4px solid ${b.color}`, paddingLeft: 10 }}>{b.label}</span></td>
                    <td className={`${TD} ${NUM}`}>{num(b.keywords)}</td>
                    <td className={`${TD} ${NUM}`}>{pct(b.kw_share, 1)}</td>
                    <td className={`${TD} ${NUM}`}>{money(b.cost)}</td>
                    <td className={`${TD} ${NUM}`}>{pct(b.spend_share, 1)}</td>
                    <td className={`${TD} ${NUM}`}>{money(b.cpc, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{pct(b.ctr, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{pct(b.conv_rate, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{b.cpa ? money(b.cpa, 2) : "—"}</td>
                    <td className={`${TD} ${NUM}`}>{num(b.conv, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="QS vs CPC detail (QS 1 – QS 10)">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>QS</th>
                  {["Keywords", "% of Total", "Spend", "% of Spend", "Clicks", "Avg CPC", "CTR", "Conv Rate", "CPA", "Conversions"].map((h) => (
                    <th key={h} className={`${TH} text-right`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sec.per_qs.map((r) => (
                  <tr key={r.qs}>
                    <td className={`${TD} font-medium`}>QS {r.qs}</td>
                    <td className={`${TD} ${NUM}`}>{num(r.keywords)}</td>
                    <td className={`${TD} ${NUM}`}>{pct(r.kw_share, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{money(r.cost)}</td>
                    <td className={`${TD} ${NUM}`}>{pct(r.spend_share, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{num(r.clicks)}</td>
                    <td className={`${TD} ${NUM}`}>{money(r.cpc, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{pct(r.ctr, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{pct(r.conv_rate, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{r.cpa ? money(r.cpa, 2) : "—"}</td>
                    <td className={`${TD} ${NUM}`}>{num(r.conv, 0)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className={`${TD} border-t-2 border-border`}>Total</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{num(t.keywords)}</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>100%</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{money(t.cost)}</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>100%</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{num(t.clicks)}</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{money(t.cpc, 2)}</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{pct(t.ctr, 2)}</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{pct(t.conv_rate, 2)}</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{money(t.cpa, 2)}</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{num(t.conv, 0)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
