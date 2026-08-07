import { useMemo, useState, type ReactNode } from "react";

// The shared table. The totals-row aggregation rule is BAKED IN so no view can produce a
// nonsense total: `sum` columns sum; `rate` columns are Σnum/Σden (a weighted average, never
// a mean of per-row rates or a sum of percentages); everything else renders blank. Exactly
// one totals row. Plus click-to-sort, hover, sticky header, and CSV export.

export type Agg<T> =
  | { kind: "sum"; get: (r: T) => number; fmt: (n: number) => string }
  | { kind: "rate"; num: (r: T) => number; den: (r: T) => number; fmt: (n: number) => string }
  | { kind: "none" };

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (r: T) => ReactNode;
  sort?: (r: T) => number | string; // if set, header is clickable
  agg?: Agg<T>; // totals-row behaviour (default: blank)
  csv?: (r: T) => string | number; // CSV export value
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T, i: number) => string;
  totalsLabel?: string;
  onRowClick?: (r: T) => void;
  exportName?: string;
}

export function DataTable<T>({ rows, columns, rowKey, totalsLabel, onRowClick, exportName = "export" }: Props<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<1 | -1>(-1);

  const sorted = useMemo(() => {
    const col = sortKey ? columns.find((c) => c.key === sortKey) : undefined;
    if (!col?.sort) return rows;
    const s = col.sort;
    return [...rows].sort((a, b) => {
      const av = s(a);
      const bv = s(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, columns, sortKey, dir]);

  const onSort = (key: string) => {
    if (sortKey === key) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setDir(-1);
    }
  };

  const totalFor = (col: Column<T>): ReactNode => {
    const a = col.agg;
    if (!a || a.kind === "none") return "";
    if (a.kind === "sum") return a.fmt(rows.reduce((acc, r) => acc + (a.get(r) || 0), 0));
    const n = rows.reduce((acc, r) => acc + (a.num(r) || 0), 0);
    const d = rows.reduce((acc, r) => acc + (a.den(r) || 0), 0);
    return a.fmt(d ? n / d : 0);
  };

  const exportCsv = () => {
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = columns.map((c) => esc(c.header)).join(",");
    const body = sorted
      .map((r) => columns.map((c) => esc(c.csv ? c.csv(r) : c.sort ? c.sort(r) : "")).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([head + "\n" + body], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const showTotals = !!totalsLabel || columns.some((c) => c.agg && c.agg.kind !== "none");

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button onClick={exportCsv} className="rounded-[7px] border border-border-strong px-2.5 py-1 text-[12px] hover:border-ink">
          Export CSV
        </button>
      </div>
      <div className="overflow-auto rounded-[10px] border border-border">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-surface-alt">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={c.sort ? () => onSort(c.key) : undefined}
                  className={`whitespace-nowrap border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted ${
                    c.align === "right" ? "text-right" : "text-left"
                  } ${c.sort ? "cursor-pointer select-none hover:text-ink" : ""}`}
                >
                  {c.header}
                  {sortKey === c.key ? (dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr
                key={rowKey(r, i)}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={`border-b border-rule last:border-0 hover:bg-row-hover ${onRowClick ? "cursor-pointer" : ""}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2 align-middle ${c.align === "right" ? "text-right font-mono tabular-nums" : ""}`}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {showTotals && (
            <tfoot>
              <tr className="border-t-2 border-border bg-surface-alt font-semibold">
                {columns.map((c, idx) => (
                  <td key={c.key} className={`px-3 py-2 ${c.align === "right" ? "text-right font-mono tabular-nums" : ""}`}>
                    {idx === 0 ? totalsLabel ?? "Total" : totalFor(c)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
