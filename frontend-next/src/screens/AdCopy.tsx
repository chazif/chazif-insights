import { useState } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { AdRow, AdGradeRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { gradeTone } from "../lib/grades";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

// Grade pill via the shared React Pill (A/B green, C/D amber, F red, else grey).
function GradePill({ g }: { g: string }) {
  return <Pill tone={gradeTone(g)}>{g}</Pill>;
}

const selectCls = "rounded-[7px] border border-border-strong bg-surface px-2.5 py-1 text-[13px]";

export function AdCopy() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [group, setGroup] = useState<"nonbranded" | "branded">("nonbranded");
  const [cat, setCat] = useState("all");
  const [reg, setReg] = useState("all");
  const [grade, setGrade] = useState("all");
  const [filter, setFilter] = useState("");
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const ac = data?.ads_section?.ad_copy;
  if (!ac || (!ac.nonbranded && !ac.branded)) return <Empty what="No ad (RSA) export for this client." />;

  const g: "nonbranded" | "branded" = ac[group] ? group : ac.nonbranded ? "nonbranded" : "branded";
  const scale = ac[g]!;
  const label = g === "branded" ? "Branded" : "Non-Branded";

  const gradeCols: Column<AdGradeRow>[] = [
    { key: "grade", header: "Grade", render: (r) => <GradePill g={r.grade} />, sort: (r) => r.grade, csv: (r) => r.grade },
    { key: "ads", header: "Ads", align: "right", sort: (r) => r.ads, render: (r) => num(r.ads), agg: { kind: "sum", get: (r) => r.ads, fmt: (n) => num(n) }, csv: (r) => r.ads },
    { key: "impr", header: "Impressions", align: "right", sort: (r) => r.impr, render: (r) => num(r.impr), agg: { kind: "sum", get: (r) => r.impr, fmt: (n) => num(n) }, csv: (r) => r.impr },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks },
    { key: "ctr", header: "CTR", align: "right", sort: (r) => r.ctr, render: (r) => pct(r.ctr, 2), csv: (r) => r.ctr },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend },
    { key: "sh", header: "% of Spend", align: "right", sort: (r) => r.spend_share, render: (r) => pct(r.spend_share, 1), csv: (r) => r.spend_share },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 0), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 0) }, csv: (r) => r.conv },
    { key: "cvr", header: "CVR", align: "right", sort: (r) => r.cvr, render: (r) => pct(r.cvr, 2), csv: (r) => r.cvr },
  ];

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

  const shown = scale.rows.filter((r) => {
    if (cat !== "all" && r.category !== cat) return false;
    if (reg !== "all" && r.region !== reg) return false;
    if (grade !== "all" && r.grade !== grade) return false;
    if (filter) {
      const f = filter.toLowerCase();
      if (`${r.ad_group} ${r.headline} ${r.region} ${r.category}`.toLowerCase().indexOf(f) < 0) return false;
    }
    return true;
  });

  const toggle = (k: "nonbranded" | "branded", txt: string) => (
    <button
      onClick={() => { setGroup(k); setCat("all"); setReg("all"); setGrade("all"); }}
      className={`px-3 py-1 text-[13px] font-medium ${g === k ? "bg-ink text-accent" : "bg-surface text-text-muted hover:text-ink"}`}
    >
      {txt}
    </button>
  );

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-semibold">Ad Copy · {label}</h2>
          <div className="text-[12.5px] text-text-muted">
            Ad-level performance graded by CTR. Branded and non-branded are graded on different scales (branded CTRs are naturally much higher).
          </div>
        </div>
        {ac.nonbranded && ac.branded && (
          <div className="inline-flex shrink-0 overflow-hidden rounded-[7px] border border-border-strong divide-x divide-border-strong">
            {toggle("nonbranded", "Non-Branded")}
            {toggle("branded", "Branded")}
          </div>
        )}
      </div>

      <Panel title={`Performance grades · ad counts · ${label}`}>
        <div className="mb-2 text-[12px] text-text-muted">{ac.thresholds[g]}</div>
        <DataTable rows={scale.grades} columns={gradeCols} rowKey={(r) => r.grade} totalsLabel="Total" exportName={`ad-grades-${g}-${clientId}`} />
      </Panel>

      <div className="mt-6">
        <Panel>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-text-secondary">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter ad group / headline / region…"
              className="min-w-[240px] rounded-[7px] border border-border-strong px-2.5 py-1 text-[13px] focus:border-ink focus:outline-none"
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
            <label>Grade:</label>
            <select value={grade} onChange={(e) => setGrade(e.target.value)} className={selectCls}>
              <option value="all">All</option>
              {scale.grade_labels.map((gl) => <option key={gl} value={gl}>{gl}</option>)}
            </select>
            <span className="ml-auto text-text-muted">
              Showing {num(shown.length)} of {num(scale.count)}{scale.count > scale.rows.length ? ` · top ${num(scale.rows.length)} by spend` : ""}
            </span>
          </div>
          <DataTable rows={shown} columns={adCols} rowKey={(r, i) => r.headline + "|" + i} exportName={`ad-copy-${g}-${clientId}`} />
        </Panel>
      </div>
    </div>
  );
}
