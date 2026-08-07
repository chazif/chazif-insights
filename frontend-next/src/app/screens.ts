import type { ComponentType } from "react";
import { CampaignPerformance } from "../screens/CampaignPerformance";
import { SearchTermsIntent } from "../screens/SearchTermsIntent";
import { GeoPerformance } from "../screens/GeoPerformance";
import { Overview } from "../screens/Overview";
import { MonthlyTrends } from "../screens/MonthlyTrends";
import { LpPerformance } from "../screens/LpPerformance";
import { RelevantTerms, CompetitorTerms, Triage } from "../screens/SearchTermTables";

// slug → screen component. Real screens register here as they're built; every slug not
// present falls back to the Placeholder.
export const SCREENS: Record<string, ComponentType> = {
  overview: Overview,
  "monthly-trends": MonthlyTrends,
  "campaign-performance": CampaignPerformance,
  "intent-grades": SearchTermsIntent,
  "relevant-terms": RelevantTerms,
  "competitor-terms": CompetitorTerms,
  triage: Triage,
  "lp-performance": LpPerformance,
  "geo-performance": GeoPerformance,
};
