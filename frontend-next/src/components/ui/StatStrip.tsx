export interface StatCell {
  label: string;
  value: string;
  delta?: { text: string; good: boolean }; // green = better, not up
  sub?: string;
}

// The compact KPI strip: a bordered row of cells divided by 1px borders.
export function StatStrip({ stats }: { stats: StatCell[] }) {
  return (
    <div className="flex divide-x divide-border rounded-[10px] border border-border">
      {stats.map((s, i) => (
        <div key={i} className="min-w-0 flex-1 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-text-muted">{s.label}</div>
          <div className="mt-1 font-mono text-[20px] font-semibold tracking-[-0.02em]">{s.value}</div>
          {s.delta && (
            <div className={`mt-0.5 text-[11.5px] font-medium ${s.delta.good ? "text-positive" : "text-negative"}`}>
              {s.delta.text}
            </div>
          )}
          {s.sub && <div className="mt-0.5 text-[11.5px] text-text-muted">{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}
