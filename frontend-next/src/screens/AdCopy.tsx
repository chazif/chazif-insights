import { useState } from "react";
import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { AdRow, AdScale } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { gradeTone } from "../lib/grades";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { BarList } from "../components/ui/BarList";
import { Pill } from "../components/ui/Pill";
import { DataTable, type Column } from "../components/ui/DataTable";
import { FilterInput } from "../components/ui/FilterInput";
import { Loading, ErrorState, Empty } from "../components/ui/States";

function ScaleView({ scale, clientId, tag }: { scale: AdScale; clientId: string; tag: string }) {
  const [q, setQ] = useState("");
  const s = q.trim().toLowerCase();
  const rows = s ? scale.rows.filter((r) => `${r.headline} ${r.ad_group} ${r.category}`.toLowerCase().includes(s)) : scale.rows;

  const grades = scale.grades.map((g) => ({
    label: g.grade,
    meta: `${num(g.ads)} ads · ${pct(g.ctr, 1)} CTR · ${money(g.spend)}`,
    share: g.spend_share,
  }));

  const cols: Column<AdRow>[] = [
    { key: "hl", header: "Headline", sort: (r) => r.headline, render: (r) => <span className="font-medium" title={r.headline}>{r.headline}</span>, csv: (r) => r.headline },
    { key: "ag", header: "Ad group", sort: (r) => r.ad_group, render: (r) => <span className="text-text-tertiary">{r.ad_group}</span>, csv: (r) => r.ad_group },
    { key: "ctrg", header: "CTR grade", sort: (r) => r.ctr_grade, render: (r) => <Pill tone={gradeTone(r.ctr_grade)}>{r.ctr_grade.split(" — ")[0]}</Pill>, csv: (r) => r.ctr_grade },
    { key: "lpg", header: "LP grade", sort: (r) => r.lp_grade, render: (r) => <Pill tone={gradeTone(r.lp_grade)}>{r.lp_grade.split(" — ")[0]}</Pill>, csv: (r) => r.lp_grade },
    { key: "ctr", header: "CTR", align: "right", sort: (r) => r.ctr, render: (r) => pct(r.ctr, 2), agg: { kind: "rate", num: (r) => r.clicks, den: (r) => r.impr, fmt: (n) => pct(n, 2) }, csv: (r) => r.ctr },
    { key: "impr", header: "Impr", align: "right", sort: (r) => r.impr, render: (r) => num(r.impr), agg: { kind: "sum", get: (r) => r.impr, fmt: (n) => num(n) }, csv: (r) => r.impr },
    { key: "clicks", header: "Clicks", align: "right", sort: (r) => r.clicks, render: (r) => num(r.clicks), agg: { kind: "sum", get: (r) => r.clicks, fmt: (n) => num(n) }, csv: (r) => r.clicks },
    { key: "spend", header: "Spend", align: "right", sort: (r) => r.spend, render: (r) => money(r.spend), agg: { kind: "sum", get: (r) => r.spend, fmt: (n) => money(n) }, csv: (r) => r.spend },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
    { key: "cvr", header: "CVR", align: "right", sort: (r) => r.cvr, render: (r) => pct(r.cvr, 2), agg: { kind: "rate", num: (r) => r.conv, den: (r) => r.clicks, fmt: (n) => pct(n, 2) }, csv: (r) => r.cvr },
  ];

  const st = scale.stats;
  return (
    <>
      <StatStrip
        stats={[
          { label: "Ads graded", value: num(st.total) },
          { label: "Aligned (good ad + LP)", value: num(st.aligned), sub: pct(st.aligned_pct, 0) },
          { label: "Fix landing page", value: num(st.fix_lp), sub: "good ad, weak LP" },
          { label: "Low volume", value: num(st.low_vol), sub: "< 100 impr" },
        ]}
      />
      <div className="mt-6">
        <Panel title="Spend by CTR grade" sub="green = better, not up">
          <BarList items={grades} />
        </Panel>
      </div>
      <div className="mb-3 mt-6 flex items-center gap-3">
        <h2 className="text-[16px] font-semibold">Ads</h2>
        <span className="text-[12px] text-text-muted">{num(rows.length)} of {num(scale.rows.length)} shown</span>
        <div className="ml-auto"><FilterInput value={q} onChange={setQ} placeholder="Filter headline…" /></div>
      </div>
      <DataTable rows={rows} columns={cols} rowKey={(r, i) => r.headline + "|" + i} totalsLabel="Total (shown)" exportName={`ad-copy-${tag}-${clientId}`} />
    </>
  );
}

export function AdCopy() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  const [scaleKey, setScaleKey] = useState<"nonbranded" | "branded">("nonbranded");
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const ac = data?.ads_section?.ad_copy;
  const nb = ac?.nonbranded ?? null;
  const br = ac?.branded ?? null;
  if (!nb && !br) return <Empty what="No ad (RSA) export for this client." />;

  const active = scaleKey === "branded" && br ? br : nb ?? br!;
  const tag = scaleKey === "branded" && br ? "branded" : nb ? "nonbranded" : "branded";

  return (
    <div className="mx-auto max-w-[1320px] px-6 py-6">
      {nb && br && (
        <div className="mb-4 flex gap-1.5">
          {(["nonbranded", "branded"] as const).map((k) => (
            <button key={k} onClick={() => setScaleKey(k)} className={`rounded-[7px] border px-2.5 py-1 text-[12.5px] capitalize ${scaleKey === k ? "border-ink bg-ink text-white" : "border-border-strong hover:border-ink"}`}>
              {k}
            </button>
          ))}
        </div>
      )}
      <ScaleView scale={active} clientId={clientId} tag={tag} />
    </div>
  );
}
