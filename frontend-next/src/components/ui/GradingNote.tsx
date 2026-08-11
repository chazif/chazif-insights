import type { GradingMeta } from "../../lib/types";
import { pct } from "../../lib/format";

// The honest caption under every graded surface: what the grade is measured against.
// Relative → the account's own cohort median; benchmark → a manual industry number;
// static → the old fixed bands (small cohort or static mode).
export function GradingNote({ meta, metric, className = "" }: { meta?: GradingMeta | null; metric: string; className?: string }) {
  if (!meta) return null;
  const base = `text-[11.5px] text-text-muted ${className}`;
  if (meta.mode === "static") {
    return (
      <p className={base}>
        {metric} graded on fixed bands{meta.reason === "small_cohort" ? " — too few here to compare against your account yet" : ""}.
      </p>
    );
  }
  const src = meta.mode === "benchmark" ? "your benchmark" : "your account median";
  const a = meta.anchor != null ? pct(meta.anchor, 1) : "—";
  const aMin = meta.a_min != null ? pct(meta.a_min, 1) : "—";
  const band = meta.c_lo != null && meta.c_hi != null ? `, C ≈ ${pct(meta.c_lo, 1)}–${pct(meta.c_hi, 1)}` : "";
  return (
    <p className={base}>
      Graded vs {src} {metric} <span className="font-medium text-text-secondary">{a}</span> · A ≥ {aMin}
      {band}
    </p>
  );
}
