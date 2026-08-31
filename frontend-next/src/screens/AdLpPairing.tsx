import { useState } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { AdRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

function GradePill({ g }: { g: string }) {
  const c = (g[0] || "").toUpperCase();
  const st =
    c === "A" || c === "B" ? { background: "#dcfce7", color: "#166534" }
    : c === "C" ? { background: "#fef3c7", color: "#92660a" }
    : c === "D" ? { background: "#fce7ce", color: "#9a5b1e" }
    : c === "F" ? { background: "#fee2e2", color: "#991b1b" }
    : { background: "#eee", color: "#555" };
  return <span className="inline-block whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium" style={st}>{g}</span>;
}

const short = (g: string) => g.split(" ")[0];
const kmoney = (v: number) => {
  const n = Math.round(v || 0);
  return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n}`;
};
// green = aligned (strong ad + strong LP), red = fix LP (strong ad, weak LP), yellow = fix ad.
function pairBg(ctr: string, cvr: string) {
  const cS = ctr[0] === "A" || ctr[0] === "B", cW = ctr[0] === "D" || ctr[0] === "F";
  const vS = cvr[0] === "A" || cvr[0] === "B", vW = cvr[0] === "D" || cvr[0] === "F";
  if (cS && vS) return "#dcfce7";
  if (cS && vW) return "#fee2e2";
  if (cW && vS) return "#fef3c7";
  return "";
}
const selectCls = "rounded-[7px] border border-border-strong bg-surface px-2.5 py-1 text-[13px]";
const TH = "px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted";

export function AdLpPairing() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [group, setGroup] = useState<"nonbranded" | "branded">("nonbranded");
  const [cell, setCell] = useState<[string, string] | null>(null);
  const [cat, setCat] = useState("all");
  const [reg, setReg] = useState("all");
  const [filter, setFilter] = useState("");
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const ac = data?.ads_section?.ad_copy;
  if (!ac || (!ac.nonbranded && !ac.branded)) return <Empty what="No ad ↔ landing-page pairing data for this client." />;

  const g: "nonbranded" | "branded" = ac[group] ? group : ac.nonbranded ? "nonbranded" : "branded";
  const scale = ac[g]!;
  const P = scale.pairing;
  const S = scale.stats;
  const label = g === "branded" ? "Branded" : "Non-Branded";

  const shown = scale.rows.filter((r) => {
    if (cell && (r.ctr_grade !== cell[0] || r.lp_grade !== cell[1])) return false;
    if (cat !== "all" && r.category !== cat) return false;
    if (reg !== "all" && r.region !== reg) return false;
    if (filter) {
      const f = filter.toLowerCase();
      if (`${r.ad_group} ${r.headline} ${r.region} ${r.category}`.toLowerCase().indexOf(f) < 0) return false;
    }
    return true;
  });

  const adCols: Column<AdRow>[] = [
    { key: "brand", header: "Brand", sort: (r) => r.brand, render: (r) => <span className="font-medium">{r.brand}</span>, csv: (r) => r.brand },
    { key: "cat", header: "Category", sort: (r) => r.category, render: (r) => (r.category === "Uncategorized" ? <span className="text-text-disabled">Uncategorized</span> : <span className="rounded-[5px] bg-[#eef2ff] px-1.5 py-0.5 text-[12px] font-medium text-[#4338ca]">{r.category}</span>), csv: (r) => r.category },
    { key: "region", header: "Region", sort: (r) => r.region, render: (r) => (r.region === "—" ? <span className="text-text-disabled">—</span> : r.region), csv: (r) => r.region },
    { key: "ag", header: "Ad Group", sort: (r) => r.ad_group, render: (r) => <span className="block max-w-[200px] truncate" title={r.ad_group}>{r.ad_group}</span>, csv: (r) => r.ad_group },
    { key: "hl", header: "Headline", sort: (r) => r.headline, render: (r) => <span className="block max-w-[280px] truncate text-text-tertiary" title={r.headline}>{r.headline}</span>, csv: (r) => r.headline },
    { key: "grade", header: "Grade", sort: (r) => r.grade, render: (r) => <GradePill g={r.grade} />, csv: (r) => r.grade },
    { key: "ctr", header: "CTR", align: "right", sort: (r) => r.ctr, render: (r) => pct(r.ctr, 2), csv: (r) => r.ctr },
    { key: "impr", header: "Impr", align: "right", sort: (r) => r.impr, render: (r) => num(r.impr), csv: (r) => r.impr },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), csv: (r) => r.clicks },
    { key: "cpc", header: "CPC", align: "right", sort: (r) => r.cpc, render: (r) => money(r.cpc, 2), csv: (r) => r.cpc },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), csv: (r) => r.spend },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), csv: (r) => r.conv },
    { key: "cvr", header: "CVR", align: "right", sort: (r) => r.cvr, render: (r) => pct(r.cvr, 2), csv: (r) => r.cvr },
  ];

  const toggle = (k: "nonbranded" | "branded", txt: string) => (
    <button
      onClick={() => { setGroup(k); setCell(null); setCat("all"); setReg("all"); }}
      className={`px-3 py-1 text-[13px] font-medium ${g === k ? "bg-ink text-accent" : "bg-surface text-text-muted hover:text-ink"}`}
    >
      {txt}
    </button>
  );
  const legendTag = (bg: string, txt: string) => <span className="rounded-[4px] px-1.5 py-0.5" style={{ background: bg }}>{txt}</span>;

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-semibold">Ad ↔ LP Pairing · {label}</h2>
          <div className="text-[12.5px] text-text-muted">
            Ad performance graded by CTR × landing-page performance graded by CVR (from ad-level conversion). Click any grid cell to filter the ad list below.
          </div>
        </div>
        {ac.nonbranded && ac.branded && (
          <div className="inline-flex shrink-0 overflow-hidden rounded-[7px] border border-border-strong divide-x divide-border-strong">
            {toggle("nonbranded", "Non-Branded")}
            {toggle("branded", "Branded")}
          </div>
        )}
      </div>

      <StatStrip
        stats={[
          { label: "Total ads", value: num(S.total) },
          { label: "Aligned · A/B ad + A/B LP", value: num(S.aligned), sub: `${pct(S.aligned_pct, 1)} of ads`, highlight: true },
          { label: <>Good ad · weak LP <span className="ml-1 rounded-[4px] px-1 text-[9px] font-bold" style={{ background: "#fee2e2", color: "#991b1b" }}>FIX LP</span></>, value: num(S.fix_lp), sub: "A/B ad CTR → D/F LP CVR" },
          { label: <>Weak ad · good LP <span className="ml-1 rounded-[4px] px-1 text-[9px] font-bold" style={{ background: "#fef3c7", color: "#92660a" }}>FIX AD</span></>, value: num(S.fix_ad), sub: "D/F ad CTR · A/B LP CVR" },
          { label: "Low Volume", value: num(S.low_vol), sub: "< 100 imp or < 5 clicks" },
        ]}
      />

      <div className="mt-6">
        <Panel title={`Pairing grid · ads by Ad-CTR grade (rows) × LP-CVR grade (cols) · ${label}`}>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-[12px]">
              <thead>
                <tr>
                  <th className="whitespace-nowrap bg-[#fafaf7] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.04em] text-text-muted">AD CTR ↓ &nbsp; LP CVR →</th>
                  {P.grades.map((c) => (
                    <th key={c} className="border-b border-rule px-2 py-2 text-center"><GradePill g={c} /></th>
                  ))}
                  <th className={`${TH} border-b border-rule text-right`}>Total</th>
                </tr>
              </thead>
              <tbody>
                {P.rows.map((row) => (
                  <tr key={row.ctr_grade}>
                    <td className="border-b border-rule bg-[#fafaf7] px-3 py-2"><GradePill g={row.ctr_grade} /></td>
                    {row.cols.map((c) => {
                      if (!c.ads) return <td key={c.cvr_grade} className="border-b border-rule px-2 py-2 text-center text-[#cbd0c7]">·</td>;
                      const sel = cell && cell[0] === row.ctr_grade && cell[1] === c.cvr_grade;
                      return (
                        <td
                          key={c.cvr_grade}
                          onClick={() => setCell([row.ctr_grade, c.cvr_grade])}
                          className="cursor-pointer border-b border-rule px-2 py-1.5 text-center"
                          style={{ background: pairBg(row.ctr_grade, c.cvr_grade), outline: sel ? "2px solid #1a1a1a" : undefined, outlineOffset: sel ? "-2px" : undefined }}
                        >
                          <span className="font-mono text-[12px] font-semibold tabular-nums">{num(c.ads)}</span>{" "}
                          <span className="font-mono text-[11px] text-text-muted">({kmoney(c.spend)})</span>
                          <div className="text-[10px] text-text-muted">{(c.pct * 100).toFixed(1)}% of ads</div>
                        </td>
                      );
                    })}
                    <td className="border-b border-rule px-3 py-2 text-right font-mono tabular-nums font-semibold">
                      {num(row.total_ads)}
                      <div className="text-[10px] font-normal text-text-muted">{kmoney(row.total_spend)}</div>
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="border-t-2 border-border px-3 py-2">Total</td>
                  {P.col_totals.map((c) => (
                    <td key={c.cvr_grade} className="border-t-2 border-border px-2 py-2 text-center font-mono tabular-nums">
                      {num(c.ads)}
                      <div className="text-[10px] font-normal text-text-muted">{kmoney(c.spend)}</div>
                    </td>
                  ))}
                  <td className="border-t-2 border-border px-3 py-2 text-right font-mono tabular-nums">
                    {num(P.grand_ads)}
                    <div className="text-[10px] font-normal text-text-muted">{kmoney(P.grand_spend)}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-text-muted">
            <span>{legendTag("#dcfce7", "Aligned")} both strong</span>
            <span>{legendTag("#fee2e2", "Fix LP")} high-CTR ad on low-converting LP</span>
            <span>{legendTag("#fef3c7", "Fix Ad")} good LP, weak ad copy</span>
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-text-secondary">
            <button
              onClick={() => setCell(null)}
              className={`rounded-[7px] border px-2.5 py-1 text-[13px] ${cell ? "border-ink bg-ink text-accent" : "border-border-strong text-text-muted"}`}
            >
              {cell ? `${short(cell[0])} ad × ${short(cell[1])} LP ✕` : "All cells"}
            </button>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter ad group / headline / region…"
              className="min-w-[220px] rounded-[7px] border border-border-strong px-2.5 py-1 text-[13px] focus:border-ink focus:outline-none"
            />
            <label>Category:</label>
            <select value={cat} onChange={(e) => setCat(e.target.value)} className={selectCls}>
              <option value="all">All</option>
              {scale.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {scale.has_region && (
              <>
                <label>Region:</label>
                <select value={reg} onChange={(e) => setReg(e.target.value)} className={selectCls}>
                  <option value="all">All</option>
                  {scale.regions.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </>
            )}
            <span className="ml-auto text-text-muted">
              Showing {num(shown.length)} of {num(scale.count)}{scale.count > scale.rows.length ? ` · top ${num(scale.rows.length)} by spend` : ""}
            </span>
          </div>
          <DataTable rows={shown} columns={adCols} rowKey={(r, i) => r.headline + "|" + i} exportName={`ad-lp-${g}-${clientId}`} />
        </Panel>
      </div>
    </div>
  );
}
