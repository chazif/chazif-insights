/**
 * SearchNex Ads — design tokens
 * Sampled from the live application; these are existing brand values, not new inventions.
 * See README.md for the rules governing lime, green and contrast.
 */

export const color = {
  // surfaces
  rail: '#1f2937',
  surface: '#ffffff',
  surfaceAlt: '#f9fafb',      // table header fill
  rule: '#f3f4f6',            // row separators, progress tracks, neutral pill fill
  border: '#e5e7eb',
  borderStrong: '#d1d5db',    // inputs, secondary buttons
  stripBg: '#fafaf7',         // context bar
  stripBorder: '#e6e6e0',

  // ink + text
  ink: '#1a1a1a',
  textSecondary: '#374151',
  textTertiary: '#4b5563',
  textMuted: '#6b7280',       // column headers, micro-labels
  textDisabled: '#9ca3af',    // nav items, placeholders, empty values

  // accent — interactive only. Never text on light, never a fill on light,
  // never behind white text.
  accent: '#cfff04',

  // semantic
  positive: '#15803d',
  positiveFill: '#dcfce7',
  warning: '#b45309',
  warningFill: '#fef9c3',
  warningBannerText: '#92400e',
  warningBannerFill: '#fffbeb',
  warningBannerBorder: '#fcd34d',
  negative: '#dc2626',        // on white
  negativeOnFill: '#b91c1c',  // on negativeFill
  negativeFill: '#fee2e2',
  attention: '#d97706',       // freshness dots, below-floor bars

  // charts
  categorical: ['#166534', '#b45309', '#374151', '#dc2626'],
  barNeutral: '#374151',
  barFlagged: '#d97706',

  // tinted rows (campaign mapping)
  suggestFill: '#fbffe3',
  suggestBorder: '#e3ff7a',
  manualFill: '#fef2f2',
  manualBorder: '#fecaca',
  rowHover: '#fdfff5',
} as const;

export const font = {
  ui: "'Instrument Sans', system-ui, sans-serif",
  display: "'Instrument Serif', serif",   // screen headlines only
  mono: "'JetBrains Mono', monospace",    // all numerics; tabular-nums
} as const;

/** px */
export const fontSize = {
  micro: 9,
  navLabel: 9.5,
  caps: 10,
  pill: 11,
  meta: 11.5,
  small: 12,
  body: 12.5,     // table body, nav items, buttons
  base: 13,
  cardTitle: 13.5,
  lg: 14,
  xl: 15,
  drawerTitle: 16,
  figureSm: 17,
  figure: 20,
  figureLg: 22,
  figureXl: 24,
  figure2xl: 28,
  displaySm: 30,
  display: 32,
  displayMd: 34,
  displayLg: 40,
} as const;

export const tracking = {
  caps: '0.07em',
  navGroup: '0.1em',
  displayTight: '-0.015em',
  display: '-0.01em',
  figure: '-0.02em',
} as const;

export const radius = {
  xs: 4, sm: 5, md: 6, lg: 7, xl: 8,
  toast: 9, card: 10, modal: 12,
  pill: 20, round: '50%',
} as const;

export const shadow = {
  drawer: '-16px 0 48px rgba(26,26,26,0.14)',
  palette: '0 24px 64px rgba(26,26,26,0.28)',
  railOverlay: '8px 0 32px rgba(26,26,26,0.30)',
  toast: '0 8px 28px rgba(26,26,26,0.30)',
} as const;

export const scrim = {
  strong: 'rgba(26,26,26,0.34)',  // palette, rail overlay
  soft: 'rgba(26,26,26,0.28)',    // evidence drawer
} as const;

/** on the dark rail */
export const railOverlayTint = {
  fill: 'rgba(255,255,255,0.06)',
  border: 'rgba(255,255,255,0.10)',
  hover: 'rgba(255,255,255,0.12)',
  divider: 'rgba(255,255,255,0.08)',
  badge: 'rgba(255,255,255,0.12)',
  badgeOnAccent: 'rgba(0,0,0,0.16)',
} as const;

export const layout = {
  railExpanded: 248,
  railCollapsed: 56,
  railBreakpoint: 1100,   // below this, auto-collapse and overlay when opened
  contextBarHeight: 48,
  contentPaddingX: 24,
  maxWidth: {
    brief: 1180,
    actions: 1320,
    actionDetail: 1000,
    campaigns: 1320,
    terms: 1320,
    keywords: 1320,
    budget: 1240,
    mapping: 940,
    data: 1040,
    ledger: 1180,
    clientView: 900,
    placeholder: 640,
  },
} as const;

export const motion = {
  toastDuration: 2600,
} as const;

/** Column aggregation semantics for the shared DataTable totals row. */
export type Aggregation = 'sum' | 'weightedAvg' | 'none';

/** Collapsed-rail icons, single path, viewBox="0 0 24 24", stroke-width 1.8, fill none. */
export const railIconPath = {
  Today:    'M5 4h14v16H5zM9 3v3M15 3v3M8.5 13l2.5 2.5 4.5-5',
  Diagnose: 'M4 19V9M9 19V4M14 19v-7M19 19v-4M3 21h18',
  Plan:     'M4 6h16M4 6v13h16V6M8 3v4M16 3v4M8 11h3M8 15h3M14 11h3',
  Prove:    'M4 6l8-3 8 3v6c0 5-3.5 8.2-8 9.4C7.5 20.2 4 17 4 12zM8.7 12l2.4 2.4 4.4-5',
  Setup:    'M4 7h8M17 7h3M4 17h3M12 17h8M14.5 4.5v5M8.5 14.5v5',
} as const;

/** Navigation: job → category → view. Groups collapsed by default. */
export const nav = [
  { job: 'Today', views: ['Brief', 'Actions'] },
  {
    job: 'Diagnose',
    categories: [
      { name: 'Performance',   views: ['Overview', 'Monthly Trends', 'Non-Brand Categories', 'Regions'] },
      { name: 'Campaign',      views: ['Campaign Performance'] },
      { name: 'Keyword',       views: ['Keyword Deep Dive', 'Quality Score', 'Quality Score by Component', 'KW by Region & Category'] },
      { name: 'Search terms',  views: ['Intent & Grades', 'Relevant Terms', 'Competitor Terms', 'Triage'] },
      { name: 'Ad copy',       views: ['Ad Copy', 'Ad ↔ LP Pairing'] },
      { name: 'Landing pages', views: ['LP Performance', 'LP Category Grid'] },
      { name: 'Geo',           views: ['Geo Performance'] },
      { name: 'Competition',   views: ['Auction Insights'] },
    ],
  },
  { job: 'Plan',  views: ['Budget Input', 'Budget Allocation', 'Budget', 'Pacing'] },
  { job: 'Prove', views: ['Ledger', 'Client View'] },
  {
    job: 'Setup',
    categories: [
      { name: 'Data',     views: ['Upload Data', 'Data Inventory', 'Campaign Mapping'] },
      { name: 'Settings', views: ['Business Context', 'Clients'] },  // Clients: admin only
    ],
  },
] as const;
