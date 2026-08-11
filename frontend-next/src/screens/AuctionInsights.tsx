import { useParams } from "react-router-dom";
import { useBundle } from "../hooks/useBundle";
import type { AuctionRow } from "../lib/types";
import { pct } from "../lib/format";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Loading, ErrorState, Empty } from "../components/ui/States";

export function AuctionInsights() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useBundle(clientId);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const sec = data?.auction_insights_section;
  if (!sec?.rows?.length) return <Empty what="No auction-insights export for this client." />;

  const cols: Column<AuctionRow>[] = [
    { key: "domain", header: "Competitor", sort: (r) => r.domain, render: (r) => <span className="font-medium">{r.domain}</span>, csv: (r) => r.domain },
    { key: "is", header: "Impr. share", align: "right", sort: (r) => r.impr_share, render: (r) => pct(r.impr_share, 1), csv: (r) => r.impr_share },
    { key: "ov", header: "Overlap rate", align: "right", sort: (r) => r.overlap_rate, render: (r) => pct(r.overlap_rate, 1), csv: (r) => r.overlap_rate },
    { key: "pa", header: "Position above", align: "right", sort: (r) => r.position_above, render: (r) => pct(r.position_above, 1), csv: (r) => r.position_above },
    { key: "top", header: "Top of page", align: "right", sort: (r) => r.top_of_page, render: (r) => pct(r.top_of_page, 1), csv: (r) => r.top_of_page },
    { key: "or", header: "Outranking", align: "right", sort: (r) => r.outranking, render: (r) => pct(r.outranking, 1), csv: (r) => r.outranking },
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <h2 className="mb-1 text-[16px] font-semibold">Auction Insights</h2>
      <p className="mb-3 text-[12.5px] text-text-muted">
        {sec.count} competing domains, sorted by impression share. Rates are click-weighted across the window — no totals row, since each metric is already a share.
      </p>
      <DataTable rows={sec.rows} columns={cols} rowKey={(r, i) => r.domain + "|" + i} exportName={`auction-insights-${clientId}`} />
    </div>
  );
}
