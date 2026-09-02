import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { getBundle } from "../lib/api";
import type { BundleParams } from "../lib/types";

const KEYS = ["from", "to", "seg", "campaign", "region", "category", "brand", "type", "compare"] as const;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Active top-bar filters, read from the URL query string. Only non-default values are
// included, so the React-Query key stays stable until a filter actually changes.
// Defaults when nothing is set: date range = MTD (month-to-date), comparison = MoM.
export function useBundleParams(): BundleParams {
  const [sp] = useSearchParams();
  const p: BundleParams = {};
  for (const k of KEYS) {
    const v = sp.get(k);
    if (v && v !== "all") (p as Record<string, string>)[k] = v;
  }
  const rec = p as Record<string, string>;
  // Default date = MTD, unless the user picked an explicit range or "All time" (dp=all).
  if (!rec.from && !rec.to && sp.get("dp") !== "all") {
    const now = new Date();
    rec.from = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    rec.to = iso(now);
  }
  // Default comparison = MoM.
  if (!rec.compare) rec.compare = "mom";
  return p;
}

// The bundle fetch for the current client, keyed on (and re-fetched by) the URL filters.
// Every data screen uses this so the top-bar filters drive the whole app. `enabled` lets
// the ContextBar share the same query only on views that actually have data filters.
export function useBundle(clientId: string, enabled = true) {
  const params = useBundleParams();
  return useQuery({ queryKey: ["bundle", clientId, params], queryFn: () => getBundle(clientId, params), enabled });
}
