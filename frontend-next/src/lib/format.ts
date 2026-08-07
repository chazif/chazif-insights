const bad = (n: unknown): boolean => n == null || typeof n !== "number" || !isFinite(n);

export const money = (n: number, d = 0): string =>
  bad(n) ? "—" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export const num = (n: number, d = 0): string =>
  bad(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

// `frac` is a 0..1 fraction.
export const pct = (frac: number, d = 1): string => (bad(frac) ? "—" : (frac * 100).toFixed(d) + "%");

export const signedPct = (frac: number, d = 1): string =>
  bad(frac) ? "—" : (frac >= 0 ? "+" : "") + (frac * 100).toFixed(d) + "%";
