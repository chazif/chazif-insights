const bad = (n: unknown): boolean => n == null || typeof n !== "number" || !isFinite(n);

export const money = (n: number, d = 0): string =>
  bad(n) ? "—" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export const num = (n: number, d = 0): string =>
  bad(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

// `frac` is a 0..1 fraction.
export const pct = (frac: number, d = 1): string => (bad(frac) ? "—" : (frac * 100).toFixed(d) + "%");

export const signedPct = (frac: number, d = 1): string =>
  bad(frac) ? "—" : (frac >= 0 ? "+" : "") + (frac * 100).toFixed(d) + "%";

export const moneyCompact = (n: number): string =>
  bad(n) ? "—" : "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

// Format a KPI value by its metric name (spend/CPA/cost → money, CVR/rate → pct, else num).
export const smart = (metric: string, v: number): string => {
  if (/CVR|rate/i.test(metric)) return pct(v, 2);
  if (/CPA|CPC|Cost|Spend/i.test(metric)) return money(v, /Spend/i.test(metric) ? 0 : 2);
  return num(v, 0);
};
