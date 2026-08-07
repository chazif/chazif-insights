import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBundle } from "../lib/api";
import { money, num } from "../lib/format";
import { Loading, ErrorState, Empty } from "../components/ui/States";

const short = (g: string) => g.split(" — ")[0];

export function AdLpPairing() {
  const { clientId = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["bundle", clientId], queryFn: () => getBundle(clientId) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState msg={(error as Error).message} />;
  const ac = data?.ads_section?.ad_copy;
  const scale = ac?.nonbranded ?? ac?.branded ?? null;
  const p = scale?.pairing;
  if (!p?.rows?.length) return <Empty what="No ad ↔ landing-page pairing data for this client." />;

  const maxPct = Math.max(0.0001, ...p.rows.flatMap((r) => r.cols.map((c) => c.pct)));
  const cell = (ads: number, spend: number, pctv: number, diag: boolean) => (
    <div
      className={`rounded-[6px] px-2 py-1.5 ${diag ? "ring-1 ring-inset ring-ink/30" : ""}`}
      style={{ background: `rgba(55,65,81,${(pctv / maxPct) * 0.16})` }}
    >
      <div className="font-mono text-[12.5px] font-semibold tabular-nums">{num(ads)}</div>
      <div className="font-mono text-[10.5px] tabular-nums text-text-muted">{money(spend)}</div>
    </div>
  );

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <h2 className="mb-1 text-[16px] font-semibold">Ad ↔ LP Pairing</h2>
      <p className="mb-4 text-[12.5px] text-text-muted">
        Ads by <b>CTR grade</b> (rows) × <b>landing-page CVR grade</b> (columns). The diagonal is aligned — a great ad on a great page.
        Cells above the diagonal are strong ads let down by the page; below, weak ads on strong pages. Count on top, spend below.
      </p>
      <div className="overflow-auto rounded-[10px] border border-border">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-surface-alt">
              <th className="sticky left-0 bg-surface-alt px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">CTR ↓ / CVR →</th>
              {p.grades.map((g) => (
                <th key={g} className="px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">{short(g)}</th>
              ))}
              <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">Row total</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((row) => (
              <tr key={row.ctr_grade} className="border-t border-rule">
                <td className="sticky left-0 whitespace-nowrap bg-surface px-3 py-2 font-medium">{short(row.ctr_grade)}</td>
                {row.cols.map((c) => (
                  <td key={c.cvr_grade} className="px-1.5 py-1.5">{cell(c.ads, c.spend, c.pct, short(row.ctr_grade) === short(c.cvr_grade))}</td>
                ))}
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  <div className="font-semibold">{num(row.total_ads)}</div>
                  <div className="text-[10.5px] text-text-muted">{money(row.total_spend)}</div>
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-border bg-surface-alt font-semibold">
              <td className="sticky left-0 bg-surface-alt px-3 py-2">Col total</td>
              {p.col_totals.map((c) => (
                <td key={c.cvr_grade} className="px-3 py-2 text-center font-mono tabular-nums">
                  <div>{num(c.ads)}</div>
                  <div className="text-[10.5px] font-normal text-text-muted">{money(c.spend)}</div>
                </td>
              ))}
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                <div>{num(p.grand_ads)}</div>
                <div className="text-[10.5px] font-normal text-text-muted">{money(p.grand_spend)}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11.5px] text-text-muted">Cell shading is proportional to each cell's share of the {num(p.grand_ads)} graded ads.</p>
    </div>
  );
}
