import type { ComponentType } from "react";
import { CampaignPerformance } from "../screens/CampaignPerformance";
import { SearchTermsIntent } from "../screens/SearchTermsIntent";
import { GeoPerformance } from "../screens/GeoPerformance";
import { Overview } from "../screens/Overview";
import { MonthlyTrends } from "../screens/MonthlyTrends";
import { LpPerformance } from "../screens/LpPerformance";
import { RelevantTerms, CompetitorTerms, Triage } from "../screens/SearchTermTables";
import { NonBrandCategories } from "../screens/NonBrandCategories";
import { Regions } from "../screens/Regions";
import { KeywordDeepDive } from "../screens/KeywordDeepDive";
import { QualityScore } from "../screens/QualityScore";
import { QualityScoreComponents } from "../screens/QualityScoreComponents";
import { KwRegionCategory } from "../screens/KwRegionCategory";
import { AdCopy } from "../screens/AdCopy";
import { AdLpPairing } from "../screens/AdLpPairing";
import { LpCategoryGrid } from "../screens/LpCategoryGrid";
import { AuctionInsights } from "../screens/AuctionInsights";
import { Brief } from "../screens/Brief";
import { Actions } from "../screens/Actions";
import { Budget } from "../screens/Budget";
import { Pacing } from "../screens/Pacing";
import { Ledger } from "../screens/Ledger";
import { BudgetInput } from "../screens/BudgetInput";
import { BusinessContext } from "../screens/BusinessContext";
import { CampaignMapping } from "../screens/CampaignMapping";
import { Clients } from "../screens/Clients";
import { DataInventory } from "../screens/DataInventory";

// slug → screen component. Real screens register here as they're built; every slug not
// present falls back to the Placeholder.
export const SCREENS: Record<string, ComponentType> = {
  brief: Brief,
  actions: Actions,
  overview: Overview,
  "monthly-trends": MonthlyTrends,
  "nb-categories": NonBrandCategories,
  regions: Regions,
  "campaign-performance": CampaignPerformance,
  "keyword-deep-dive": KeywordDeepDive,
  "quality-score": QualityScore,
  "quality-score-components": QualityScoreComponents,
  "kw-region-category": KwRegionCategory,
  "intent-grades": SearchTermsIntent,
  "relevant-terms": RelevantTerms,
  "competitor-terms": CompetitorTerms,
  triage: Triage,
  "ad-copy": AdCopy,
  "ad-lp-pairing": AdLpPairing,
  "lp-performance": LpPerformance,
  "lp-category-grid": LpCategoryGrid,
  "geo-performance": GeoPerformance,
  "auction-insights": AuctionInsights,
  budget: Budget,
  pacing: Pacing,
  "budget-input": BudgetInput,
  ledger: Ledger,
  "business-context": BusinessContext,
  "campaign-mapping": CampaignMapping,
  "data-inventory": DataInventory,
  clients: Clients,
};
