// Track-plus-figure cell that replaces standalone bar charts: a share bar (neutral #374151,
// or attention #d97706 when flagged) with the figure right-aligned beside it.
export function InlineBarCell({ figure, share, flagged }: { figure: string; share: number; flagged?: boolean }) {
  const w = Math.max(0, Math.min(100, (share || 0) * 100));
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-full max-w-[110px] overflow-hidden rounded-full bg-rule">
        <div className="h-full rounded-full" style={{ width: `${w}%`, backgroundColor: flagged ? "#d97706" : "#374151" }} />
      </div>
      <span className="min-w-[62px] text-right font-mono tabular-nums">{figure}</span>
    </div>
  );
}
