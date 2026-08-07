import type { ComponentType } from "react";
import { CampaignPerformance } from "../screens/CampaignPerformance";
import { SearchTermsIntent } from "../screens/SearchTermsIntent";
import { GeoPerformance } from "../screens/GeoPerformance";

// slug → screen component. Real screens register here as they're built; every slug not
// present falls back to the Placeholder.
export const SCREENS: Record<string, ComponentType> = {
  "campaign-performance": CampaignPerformance,
  "intent-grades": SearchTermsIntent,
  "geo-performance": GeoPerformance,
};
