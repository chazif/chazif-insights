import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { ShoppingCampaignRow } from "../lib/types";
import { money, num, pct } from "../lib/format";
import { StatStrip } from "../components/ui/StatStrip";
import { Panel } from "../components/ui/Panel";
import { Pill } from "../components/ui/Pill";
import { TrendChart } from "../components/ui/TrendChart";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const typeTone = (t: string) => (/pmax|performance/i.test(t) ? "stage" : "neutral") as "stage" | "neutral";

export function ShoppingOverview() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.shopping_section;
  if (!sec?.overview?.rows) return <Empty what="No Shopping or Performance Max campaigns for this client." />;

  const { totals, share, trend, month } = sec.overview;
  const hasValue = totals.conv_value > 0;

  const cols: Column<ShoppingCampaignRow>[] = [
    { key: "campaign", header: "Campaign", sort: (r) => r.campaign, render: (r) => <span className="font-medium">{r.campaign}</span>, csv: (r) => r.campaign },
    { key: "type", header: "Type", sort: (r) => r.type, render: (r) => <Pill tone={typeTone(r.type)}>{r.type}</Pill>, csv: (r) => r.type },
    { key: "cost", header: "Spend", align: "right", sort: (r) => r.cost, render: (r) => money(r.cost), agg: { kind: "sum", get: (r) => r.cost, fmt: (n) => money(n) }, csv: (r) => r.cost },
    { key: "conv", header: "Conv", align: "right", sort: (r) => r.conv, render: (r) => num(r.conv, 1), agg: { kind: "sum", get: (r) => r.conv, fmt: (n) => num(n, 1) }, csv: (r) => r.conv },
    { key: "cpa", header: "CPA", align: "right", sort: (r) => r.cpa, render: (r) => (r.cpa ? money(r.cpa, 2) : "—"), agg: { kind: "rate", num: (r) => r.cost, den: (r) => r.conv, fmt: (n) => money(n, 2) }, csv: (r) => r.cpa },
    ...(hasValue
      ? ([
          { key: "value", header: "Conv value", align: "right", sort: (r: ShoppingCampaignRow) => r.conv_value, render: (r: ShoppingCampaignRow) => money(r.conv_value), agg: { kind: "sum" as const, get: (r: ShoppingCampaignRow) => r.conv_value, fmt: (n: number) => money(n) }, csv: (r: ShoppingCampaignRow) => r.conv_value },
          { key: "roas", header: "ROAS", align: "right", sort: (r: ShoppingCampaignRow) => r.roas, render: (r: ShoppingCampaignRow) => (r.roas ? `${num(r.roas, 2)}×` : "—"), agg: { kind: "rate" as const, num: (r: ShoppingCampaignRow) => r.conv_value, den: (r: ShoppingCampaignRow) => r.cost, fmt: (n: number) => `${num(n, 2)}×` }, csv: (r: ShoppingCampaignRow) => r.roas },
        ] as Column<ShoppingCampaignRow>[])
      : []),
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <StatStrip
        stats={[
          { label: `Shopping + PMax spend · ${month}`, value: money(totals.cost), sub: `${pct(share, 0)} of account` },
          { label: "Conversions", value: num(totals.conv, 1) },
          { label: "CPA", value: totals.cpa ? money(totals.cpa, 2) : "—" },
          hasValue
            ? { label: "ROAS", value: totals.roas ? `${num(totals.roas, 2)}×` : "—", sub: money(totals.conv_value) + " value" }
            : { label: "Conv value", value: "—", sub: "not tracked" },
        ]}
      />

      {trend.length > 1 && (
        <Panel title="Shopping + PMax spend & conversions" className="mt-6">
          <TrendChart data={trend} />
        </Panel>
      )}

      <div className="mt-6">
        <h2 className="mb-2 text-[16px] font-semibold">By campaign</h2>
        <DataTable rows={sec.overview.rows} columns={cols} rowKey={(r, i) => r.campaign + "|" + i} totalsLabel="Total" exportName={`shopping-${clientId}`} />
        {!hasValue && (
          <p className="mt-2 text-[11.5px] text-text-muted">This account isn't passing conversion value to Google Ads, so ROAS can't be computed — add a value on the conversion action to unlock it.</p>
        )}
      </div>
    </div>
  );
}
