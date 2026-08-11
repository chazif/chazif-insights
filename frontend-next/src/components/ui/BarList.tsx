export interface BarItem {
  label: string;
  meta: string; // right-aligned figures, e.g. "12 terms · $1,234 · 34%"
  share: number; // 0..1, part-to-whole
}

// Self-labeling horizontal bars, sorted descending. Replaces a legend'd donut: each bar
// labels itself, so there's no eye-travel to a legend and part-to-whole reads directly.
// Bar length is normalized to the largest item for good use of space; the exact % is in `meta`.
export function BarList({ items }: { items: BarItem[] }) {
  const max = Math.max(0.0001, ...items.map((i) => i.share));
  return (
    <div className="flex flex-col gap-3">
      {items.map((it, i) => (
        <div key={i}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="text-[12.5px] font-medium">{it.label}</span>
            <span className="whitespace-nowrap font-mono text-[12px] tabular-nums text-text-muted">{it.meta}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-rule">
            <div className="h-full rounded-full bg-[#374151]" style={{ width: `${(it.share / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
