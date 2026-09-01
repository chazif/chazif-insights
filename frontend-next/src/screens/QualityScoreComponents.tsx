import { Fragment, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { QsGridCell } from "../lib/types";
import { money, num, pct, signedPct } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { ratingTone } from "../lib/grades";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const RATINGS = ["Above average", "Average", "Below average"];

// Rating pill via the shared React Pill (Above → green, Below → red, Average → grey).
function QsPill({ r }: { r: string }) {
  return <Pill tone={ratingTone(r)}>{r}</Pill>;
}

// green → yellow → red gradient (t in 0..1), matching the original heat map.
function heatBg(t: number) {
  t = Math.max(0, Math.min(1, t));
  const stops = [[226, 240, 217], [255, 229, 153], [229, 115, 115]];
  const seg = t < 0.5 ? 0 : 1;
  const u = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const a = stops[seg], b = stops[seg + 1];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * u));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const TH = "px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted";
const TD = "px-3 py-2 border-b border-rule";
const NUM = "text-right font-mono tabular-nums";
const vsAvg = (v: number | null) =>
  v == null ? <span className="text-text-disabled">—</span> : <span className={v <= 0 ? "text-positive" : "text-negative"}>{signedPct(v, 1)}</span>;

type Metric = "cpc" | "spend" | "qs";

export function QualityScoreComponents() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [metric, setMetric] = useState<Metric>("cpc");
  const [cat, setCat] = useState("all");
  const [reg, setReg] = useState("all");
  const [filter, setFilter] = useState("");

  const sec = data?.qs_breakdown_section;
  // Grid lookup + heat range (hooks must run before any early return).
  const grid = useMemo(() => {
    const G: Record<string, Record<string, Record<string, QsGridCell>>> = {};
    (sec?.grid ?? []).forEach((c) => {
      (G[c.ectr] ||= {});
      (G[c.ectr][c.lp_exp] ||= {});
      G[c.ectr][c.lp_exp][c.ad_rel] = c;
    });
    return G;
  }, [sec]);

  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  if (!sec?.components?.length) return <Empty what="No Quality Score component data for this client." />;

  const scope = sec.non_brand ? "non-brand" : "";
  const opt = sec.opt_keywords;
  const higherGood = metric === "qs";
  const vals = sec.grid.filter((c) => c.keywords > 0).map((c) => c[metric]);
  const mn = vals.length ? Math.min(...vals) : 0;
  const mx = vals.length ? Math.max(...vals) : 0;
  const fmtCell = (v: number) => (metric === "cpc" ? money(v, 2) : metric === "spend" ? money(v) : v.toFixed(1));

  // Component-analysis grand total (sums every rating row across all three components).
  const cTot = sec.components.reduce(
    (a, c) => { c.ratings.forEach((r) => { a.kw += r.keywords; a.sp += r.spend; a.cv += r.conv; }); return a; },
    { kw: 0, sp: 0, cv: 0 },
  );

  const svT = sec.savings_by_brand.reduce(
    (a, r) => { a.kws += r.kws_weak; a.sp += r.spend_weak; a.sav += r.savings; return a; },
    { kws: 0, sp: 0, sav: 0 },
  );

  const shown = opt.rows.filter((r) => {
    if (cat !== "all" && r.category !== cat) return false;
    if (reg !== "all" && r.region !== reg) return false;
    if (filter) {
      const f = filter.toLowerCase();
      if (`${r.keyword} ${r.region} ${r.category}`.toLowerCase().indexOf(f) < 0) return false;
    }
    return true;
  });

  const seg = (v: Metric, label: string) => (
    <button
      onClick={() => setMetric(v)}
      className={`px-3 py-1 text-[13px] font-medium ${metric === v ? "bg-ink text-accent" : "bg-surface text-text-muted hover:text-ink"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-5">
        <h2 className="text-[18px] font-semibold">Quality Score Breakdown</h2>
        <div className="text-[12.5px] text-text-muted">
          Component-level ratings (eCTR, Ad Relevance, LP Experience) and the top optimization opportunities{scope && ` · ${scope} keywords`}
        </div>
      </div>

      {/* ---- Component analysis ---- */}
      <Panel title="Quality Score Component Analysis" sub="portfolio total">
        <div className="mb-2 text-[12px] text-text-muted">
          All three Quality Score components stacked in one table. Each component breaks keywords into Above / Average / Below average ratings with performance context.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr>
                <th className={`${TH} text-left`}>Rating</th>
                {["Keywords", "% of KWs", "Spend", "Avg CPC", "CTR", "Conv Rate", "CPA", "Conversions", "CPC vs Avg"].map((h) => (
                  <th key={h} className={`${TH} text-right`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sec.components.map((c) => (
                <Fragment key={c.key}>
                  <tr className="bg-surface-alt">
                    <td colSpan={10} className="border-y border-border px-3 py-2 text-[11px] font-bold uppercase tracking-[0.04em] text-text-secondary">
                      <span className="mr-2 inline-block rounded-[4px] bg-rule px-1.5 font-extrabold text-text-secondary">{c.num}</span>
                      {c.label}
                    </td>
                  </tr>
                  {c.ratings.map((r) => (
                    <tr key={c.key + r.rating}>
                      <td className={TD}><QsPill r={r.rating} /></td>
                      <td className={`${TD} ${NUM}`}>{num(r.keywords)}</td>
                      <td className={`${TD} ${NUM}`}>{pct(r.kw_share, 1)}</td>
                      <td className={`${TD} ${NUM}`}>{money(r.spend)}</td>
                      <td className={`${TD} ${NUM}`}>{money(r.cpc, 2)}</td>
                      <td className={`${TD} ${NUM}`}>{pct(r.ctr, 2)}</td>
                      <td className={`${TD} ${NUM}`}>{pct(r.conv_rate, 2)}</td>
                      <td className={`${TD} ${NUM}`}>{r.cpa ? money(r.cpa, 2) : "—"}</td>
                      <td className={`${TD} ${NUM}`}>{num(r.conv, 0)}</td>
                      <td className={`${TD} ${NUM}`}>{vsAvg(r.cpc_vs_avg)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr className="font-semibold">
                <td className={`${TD} border-t-2 border-border`}>Total</td>
                <td className={`${TD} ${NUM} border-t-2 border-border`}>{num(cTot.kw)}</td>
                <td className={`${TD} border-t-2 border-border`}></td>
                <td className={`${TD} ${NUM} border-t-2 border-border`}>{money(cTot.sp)}</td>
                <td className={`${TD} border-t-2 border-border`} colSpan={4}></td>
                <td className={`${TD} ${NUM} border-t-2 border-border`}>{num(cTot.cv, 0)}</td>
                <td className={`${TD} border-t-2 border-border`}></td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ---- 27-combination grid ---- */}
      <div className="mt-6">
        <Panel title="All three components: Expected CTR × LP Experience × Ad Relevance">
          <div className="mb-3 text-[12px] text-text-muted">
            All 27 component combinations. Row-pairs group by Expected CTR; within each group rows are LP Experience and columns are Ad Relevance. Toggle the metric to see avg CPC, spend volume, or the resulting average Quality Score.
          </div>
          <div className="mb-3 inline-flex overflow-hidden rounded-[7px] border border-border-strong divide-x divide-border-strong">
            {seg("cpc", "Avg CPC")}
            {seg("spend", "Spend")}
            {seg("qs", "Avg Quality Score")}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-[12.5px]">
              <thead>
                <tr>
                  <th className="bg-surface-alt px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted">Expected CTR</th>
                  <th className="bg-surface-alt px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted">LP Experience</th>
                  <th className="bg-surface-alt px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted" colSpan={3}>Ad Relevance →</th>
                </tr>
                <tr>
                  <th className="border-b border-rule"></th>
                  <th className="border-b border-rule"></th>
                  {RATINGS.map((ad) => (
                    <th key={ad} className="border-b border-rule py-2 text-center"><QsPill r={ad} /></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {RATINGS.map((ectr) =>
                  RATINGS.map((lp, li) => (
                    <tr key={ectr + lp}>
                      {li === 0 && (
                        <td rowSpan={3} className="border-b border-r-2 border-rule bg-[#fafaf7] px-3 py-2 align-middle">
                          <strong>{ectr}</strong>
                          <div className="text-[11px] text-text-muted">{pct(sec.grid_meta.ectr_spend_share[ectr] ?? 0, 1)} of spend</div>
                        </td>
                      )}
                      <td className="border-b border-rule px-3 py-2"><QsPill r={lp} /></td>
                      {RATINGS.map((ad) => {
                        const cell = grid[ectr]?.[lp]?.[ad];
                        if (!cell || !cell.keywords) return <td key={ad} className="border-b border-rule px-3 py-2 text-center text-[#cbd0c7]">·</td>;
                        const v = cell[metric];
                        const t = mx > mn ? (higherGood ? 1 - (v - mn) / (mx - mn) : (v - mn) / (mx - mn)) : 0.5;
                        return (
                          <td key={ad} className="border-b border-rule px-3 py-2 text-center font-mono tabular-nums" style={{ background: heatBg(t) }} title={`${cell.keywords} kw`}>
                            {fmtCell(v)}
                          </td>
                        );
                      })}
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-right text-[11.5px] text-text-muted">
            {higherGood ? "Higher = better" : "Higher = more expensive"} &nbsp;
            <span className="ml-1 rounded-[4px] px-1.5 py-0.5" style={{ background: "#dcfce7" }}>Good</span>{" "}
            <span className="rounded-[4px] px-1.5 py-0.5" style={{ background: "#fef3c7" }}>Mid</span>{" "}
            <span className="rounded-[4px] px-1.5 py-0.5" style={{ background: "#f3c9bf" }}>Costly</span>
          </div>
        </Panel>
      </div>

      {/* ---- Savings by brand ---- */}
      <div className="mt-6">
        <Panel title="Estimated monthly savings by brand" sub="if QS ≤ 5 → QS 7">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>Brand</th>
                  {["KWs at QS ≤ 5", "Spend at QS ≤ 5", "Current CPC", "Target CPC (QS 7)", "Est. Savings", "% of Brand Spend"].map((h) => (
                    <th key={h} className={`${TH} text-right`}>{h}</th>
                  ))}
                  <th className={`${TH} text-left`}>Primary Component Gap</th>
                </tr>
              </thead>
              <tbody>
                {sec.savings_by_brand.map((r) => (
                  <tr key={r.brand}>
                    <td className={`${TD} font-medium`}>{r.brand}</td>
                    <td className={`${TD} ${NUM}`}>{num(r.kws_weak)}</td>
                    <td className={`${TD} ${NUM}`}>{money(r.spend_weak)}</td>
                    <td className={`${TD} ${NUM}`}>{money(r.cpc_current, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{money(r.cpc_target, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{money(r.savings)}</td>
                    <td className={`${TD} ${NUM}`}>{pct(r.pct_brand_spend, 2)}</td>
                    <td className={TD}>{r.primary_gap}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className={`${TD} border-t-2 border-border`}>Total</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{num(svT.kws)}</td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{money(svT.sp)}</td>
                  <td className={`${TD} border-t-2 border-border`} colSpan={2}></td>
                  <td className={`${TD} ${NUM} border-t-2 border-border`}>{money(svT.sav)}</td>
                  <td className={`${TD} border-t-2 border-border`} colSpan={2}></td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      {/* ---- Top optimization keywords ---- */}
      <div className="mt-6">
        <Panel title="Top optimization keywords" sub="QS ≤ 6, sorted by spend">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-text-secondary">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter keyword, region, category…"
              className="min-w-[240px] rounded-[7px] border border-border-strong px-2.5 py-1 text-[13px] focus:border-ink focus:outline-none"
            />
            <label>Category:</label>
            <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded-[7px] border border-border-strong bg-surface px-2.5 py-1 text-[13px]">
              <option value="all">All categories</option>
              {opt.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {opt.has_region && (
              <>
                <label>Region:</label>
                <select value={reg} onChange={(e) => setReg(e.target.value)} className="rounded-[7px] border border-border-strong bg-surface px-2.5 py-1 text-[13px]">
                  <option value="all">All regions</option>
                  {opt.regions.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </>
            )}
            <span className="ml-auto text-text-muted">Showing {num(shown.length)} of {num(opt.total)}{opt.total > opt.shown ? ` · top ${num(opt.shown)} loaded` : ""}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr>
                  {["Keyword", "Brand", "Region", "Category"].map((h) => <th key={h} className={`${TH} text-left`}>{h}</th>)}
                  <th className={`${TH} text-right`}>QS</th>
                  <th className={`${TH} text-right`}>Spend</th>
                  <th className={`${TH} text-right`}>CPC</th>
                  <th className={`${TH} text-right`}>Clicks</th>
                  {["eCTR", "Ad Rel", "LP Exp"].map((h) => <th key={h} className={`${TH} text-left`}>{h}</th>)}
                  <th className={`${TH} text-right`}>Conv</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={r.keyword + "|" + i}>
                    <td className={`${TD} font-medium`}>{r.keyword}</td>
                    <td className={TD}>{r.brand}</td>
                    <td className={TD}>{r.region === "—" ? <span className="text-text-disabled">—</span> : r.region}</td>
                    <td className={TD}>{r.category === "—" ? <span className="text-text-disabled">—</span> : <span className="rounded-[5px] bg-[#eef2ff] px-1.5 py-0.5 text-[12px] font-medium text-[#4338ca]">{r.category}</span>}</td>
                    <td className={`${TD} ${NUM}`}>{r.qs}</td>
                    <td className={`${TD} ${NUM}`}>{money(r.spend)}</td>
                    <td className={`${TD} ${NUM}`}>{money(r.cpc, 2)}</td>
                    <td className={`${TD} ${NUM}`}>{num(r.clicks)}</td>
                    <td className={TD}><QsPill r={r.ectr} /></td>
                    <td className={TD}><QsPill r={r.ad_rel} /></td>
                    <td className={TD}><QsPill r={r.lp_exp} /></td>
                    <td className={`${TD} ${NUM}`}>{num(r.conv, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
