export interface StatCell {
  label: string;
  value: string;
  delta?: { text: string; good: boolean }; // green = better, not up
  sub?: string;
  highlight?: boolean; // dark card with a lime value (the leading KPI, mirrors the original app)
}

// The compact KPI strip: a bordered row of cells divided by 1px borders.
export function StatStrip({ stats }: { stats: StatCell[] }) {
  return (
    <div className="flex divide-x divide-border overflow-hidden rounded-[10px] border border-border">
      {stats.map((s, i) => (
        <div key={i} className={`min-w-0 flex-1 px-4 py-3 ${s.highlight ? "bg-ink" : ""}`}>
          <div className={`text-[10px] font-semibold uppercase tracking-[0.07em] ${s.highlight ? "text-white/55" : "text-text-muted"}`}>{s.label}</div>
          <div className={`mt-1 font-mono text-[20px] font-semibold tracking-[-0.02em] ${s.highlight ? "text-accent" : ""}`}>{s.value}</div>
          {s.delta && (
            <div
              className={`mt-0.5 text-[11.5px] font-medium ${
                s.highlight
                  ? s.delta.good
                    ? "text-[#4ade80]"
                    : "text-[#f87171]"
                  : s.delta.good
                    ? "text-positive"
                    : "text-negative"
              }`}
            >
              {s.delta.text}
            </div>
          )}
          {s.sub && <div className={`mt-0.5 text-[11.5px] ${s.highlight ? "text-white/50" : "text-text-muted"}`}>{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}
