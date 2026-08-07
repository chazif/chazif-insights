// The three-layer navigation model (job → category → view) from the design handoff.
// Plan and Prove intentionally skip the category tier (a tier with one child buys nothing);
// Diagnose and Setup keep it. Every view declares the filters that actually apply to it —
// a view with none renders "no filters apply on this screen" in its context bar.

export type FilterName = "Segment" | "Dates" | "vs" | "Sort" | "Owner" | "Campaign" | "Goal" | "Budget";
export type JobKey = "today" | "diagnose" | "plan" | "prove" | "setup";

export interface ViewDef {
  slug: string;
  title: string;
  filters: FilterName[];
  admin?: boolean;
  built?: boolean; // false → routes to the placeholder screen (all false during the migration)
}
export interface CategoryDef {
  title: string;
  views: ViewDef[];
}
export interface JobDef {
  key: JobKey;
  title: string;
  categories?: CategoryDef[]; // nested (Diagnose, Setup)
  views?: ViewDef[]; // flat (Today, Plan, Prove)
}

const v = (slug: string, title: string, filters: FilterName[] = [], extra: Partial<ViewDef> = {}): ViewDef => ({
  slug,
  title,
  filters,
  built: false,
  ...extra,
});

export const NAV: JobDef[] = [
  {
    key: "today",
    title: "Today",
    views: [v("brief", "Brief", [], { built: true }), v("actions", "Actions", ["Sort", "Owner"], { built: true })],
  },
  {
    key: "diagnose",
    title: "Diagnose",
    categories: [
      {
        title: "Performance",
        views: [
          v("overview", "Overview", ["Segment", "Dates", "vs"], { built: true }),
          v("monthly-trends", "Monthly Trends", ["Dates"], { built: true }),
          v("nb-categories", "Non-Brand Categories", ["Dates", "vs"], { built: true }),
          v("regions", "Regions", ["Dates", "vs"], { built: true }),
        ],
      },
      { title: "Campaign", views: [v("campaign-performance", "Campaign Performance", ["Segment", "Dates", "vs"], { built: true })] },
      {
        title: "Keyword",
        views: [
          v("keyword-deep-dive", "Keyword Deep Dive", ["Campaign", "Dates"], { built: true }),
          v("quality-score", "Quality Score", ["Dates"], { built: true }),
          v("quality-score-components", "Quality Score by Component", ["Dates"], { built: true }),
          v("kw-region-category", "KW by Region & Category", ["Dates"], { built: true }),
        ],
      },
      {
        title: "Search terms",
        views: [
          v("intent-grades", "Intent & Grades", ["Segment", "Dates"], { built: true }),
          v("relevant-terms", "Relevant Terms", ["Segment", "Dates"], { built: true }),
          v("competitor-terms", "Competitor Terms", ["Segment", "Dates"], { built: true }),
          v("triage", "Triage", ["Segment", "Dates"], { built: true }),
        ],
      },
      { title: "Ad copy", views: [v("ad-copy", "Ad Copy", ["Segment", "Dates"], { built: true }), v("ad-lp-pairing", "Ad ↔ LP Pairing", ["Segment"], { built: true })] },
      { title: "Landing pages", views: [v("lp-performance", "LP Performance", ["Dates"], { built: true }), v("lp-category-grid", "LP Category Grid", ["Dates"], { built: true })] },
      { title: "Geo", views: [v("geo-performance", "Geo Performance", ["Dates"], { built: true })] },
      { title: "Competition", views: [v("auction-insights", "Auction Insights", ["Dates"], { built: true })] },
    ],
  },
  {
    key: "plan",
    title: "Plan",
    views: [
      v("budget-input", "Budget Input"),
      v("budget-allocation", "Budget Allocation", ["Goal", "Budget"]),
      v("budget", "Budget", [], { built: true }),
      v("pacing", "Pacing", ["Dates"], { built: true }),
    ],
  },
  {
    key: "prove",
    title: "Prove",
    views: [v("ledger", "Ledger", ["Dates"], { built: true }), v("client-view", "Client View")],
  },
  {
    key: "setup",
    title: "Setup",
    categories: [
      {
        title: "Data",
        views: [v("upload-data", "Upload Data"), v("data-inventory", "Data Inventory"), v("campaign-mapping", "Campaign Mapping")],
      },
      { title: "Settings", views: [v("business-context", "Business Context"), v("clients", "Clients", [], { admin: true })] },
    ],
  },
];

export interface ResolvedView extends ViewDef {
  job: JobDef;
  category?: CategoryDef;
}

// Flat slug → resolved view (with its job/category), for routing + breadcrumbs + the palette.
export const VIEW_INDEX: Record<string, ResolvedView> = {};
for (const job of NAV) {
  for (const view of job.views ?? []) VIEW_INDEX[view.slug] = { ...view, job };
  for (const cat of job.categories ?? []) for (const view of cat.views) VIEW_INDEX[view.slug] = { ...view, job, category: cat };
}

export const DEFAULT_VIEW = "brief";

export function breadcrumb(slug: string): string {
  const rv = VIEW_INDEX[slug];
  if (!rv) return "";
  return [rv.job.title, rv.category?.title].filter(Boolean).join(" › ");
}
