const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, LevelFormat, ShadingType, BorderStyle,
} = require("docx");
const fs = require("fs");

const INK = "1A1A1A";
const MUT = "6B7280";
const ACCENT_BG = "F4F6EE";
const HEAD_BG = "EFEFEA";

const p = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: 140, line: 276 },
    ...opts.para,
    children: [new TextRun({ text, size: 22, color: INK, ...opts.run })],
  });

const bullet = (text, bold = null) =>
  new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 80, line: 276 },
    children: bold
      ? [new TextRun({ text: bold + " — ", bold: true, size: 22, color: INK }),
         new TextRun({ text, size: 22, color: INK })]
      : [new TextRun({ text, size: 22, color: INK })],
  });

const numbered = (text, bold = null) =>
  new Paragraph({
    numbering: { reference: "nums", level: 0 },
    spacing: { after: 80, line: 276 },
    children: bold
      ? [new TextRun({ text: bold + " — ", bold: true, size: 22, color: INK }),
         new TextRun({ text, size: 22, color: INK })]
      : [new TextRun({ text, size: 22, color: INK })],
  });

const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 160 }, children: [new TextRun({ text: t, size: 30, bold: true, color: INK })] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, size: 25, bold: true, color: INK })] });

const note = (text) =>
  new Paragraph({
    spacing: { after: 160, line: 276 },
    shading: { type: ShadingType.CLEAR, fill: ACCENT_BG },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: "9CB44A" } },
    indent: { left: 160 },
    children: [new TextRun({ text, size: 21, color: INK, italics: true })],
  });

function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (text, isHead, w) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      shading: isHead ? { type: ShadingType.CLEAR, fill: HEAD_BG } : undefined,
      margins: { top: 70, bottom: 70, left: 110, right: 110 },
      children: [new Paragraph({ spacing: { after: 0, line: 252 }, children: [new TextRun({ text, size: 20, bold: isHead, color: isHead ? INK : INK })] })],
    });
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, true, widths[i])) }),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, false, widths[i])) })),
    ],
  });
}

const spacer = () => new Paragraph({ spacing: { after: 160 }, children: [] });

const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 230 } } } }] },
      { reference: "nums", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 460, hanging: 230 } } } }] },
    ],
  },
  styles: { default: { document: { run: { font: "Calibri", size: 22, color: INK } } } },
  sections: [
    {
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children: [
        new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "SearchNex Ads", size: 22, color: MUT })] }),
        new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: "Google Ads API Integration Plan", size: 40, bold: true, color: INK })] }),
        new Paragraph({ spacing: { after: 320 }, children: [new TextRun({ text: "Automatic data pulling — plain-language plan · August 2026 · Draft for approval", size: 21, color: MUT })] }),

        h1("1. What this changes, in one paragraph"),
        p("Today, someone exports ~12 CSV reports from Google Ads every month and uploads them into the app. With the Google Ads API, the app will pull the same data by itself, every night, for every client — always fresh, always day-by-day, no manual exports. Everything you see in the app (all views, grades, pacing, mapping, actions) stays exactly the same, because the API data will flow into the exact same pipeline the CSV uploads use today. The CSV upload stays available as a fallback."),

        h1("2. Does this need BigQuery? (short answer: no)"),
        p("There are two different \"BigQuery\" things, and it's easy to mix them up:"),
        bullet("Google's own \"Ads → BigQuery transfer\" product. Google can dump raw Ads data into BigQuery on a schedule. We are NOT choosing this path: it delivers Google's huge raw table format (not our report shapes), which would force us to rewrite the app's whole analytics layer, and it requires a live BigQuery warehouse before anything works.", "Option we are NOT using"),
        bullet("Pull data with the Google Ads API inside our own app, convert it into the same report rows our CSV parser produces, and save it through our existing ingestion code. BigQuery is not needed for this at all — it works with our current Postgres database today.", "Option we ARE using"),
        note("Bonus: our codebase already has a prepared (currently switched-off) BigQuery warehouse mode. Because the API path writes through the same ingestion code, it will work unchanged before AND after any future BigQuery cutover. Nothing gets built twice."),

        h1("3. What you need to get from Google (one-time setup)"),
        p("Four credentials, all obtained once at the MCC (manager account) level:"),
        table(
          ["What", "Where it comes from", "Notes"],
          [
            ["Developer token", "Google Ads MCC → Admin → API Center", "You said you have this. \"Basic access\" level is enough for our volume."],
            ["OAuth Client ID + Secret", "A Google Cloud project → Credentials", "Identifies our app to Google. 10-minute setup."],
            ["Refresh token", "One-time consent screen approved by the MCC login", "Lets the app act as the MCC forever after, no re-login."],
            ["MCC customer ID", "The 10-digit MCC account number", "Used as login-customer-id on every call."],
          ],
          [2200, 3600, 3560]
        ),
        spacer(),
        p("Each client's own 10-digit customer ID is already stored in the app (the Clients screen shows them), so linking accounts is already done."),
        note("Security rule (unchanged from day one): these secrets are pasted ONLY into Railway environment variables — never into chat, never into code, never into Git. The AI assistant never sees them."),

        h1("4. Which reports the API replaces"),
        p("Every report we ingest today has an API equivalent, queried day-by-day. Two honest exceptions are flagged below."),
        table(
          ["Report in our app", "API source", "Notes"],
          [
            ["Campaign Performance", "campaign (daily)", "Drives trends, pacing, budgets"],
            ["Ad Group Performance", "ad_group (daily)", ""],
            ["Search Keywords + QS", "keyword_view (daily)", "Big upgrade: true DAILY Quality Score history instead of one snapshot per upload"],
            ["Search Terms", "search_term_view (daily)", ""],
            ["Ads (RSA)", "ad_group_ad (daily)", ""],
            ["Landing Pages", "landing_page_view (daily)", ""],
            ["Geographic", "geographic_view (daily)", ""],
            ["Audiences", "ad_group_audience_view", ""],
            ["Day / Hour schedule", "campaign + hour segments", ""],
            ["Distance", "distance_view", ""],
            ["Products (NEW)", "shopping_performance_view", "Unlocks Shopping Phase S2 (Product Performance, Advertised-vs-Sold, benchmarks) with NO client exports needed"],
            ["Products Sold", "verify at build time", "Exact API mapping confirmed during the build; CSV fallback stays"],
            ["Auction Insights", "NOT in the API", "Google does not expose this via API. Stays a manual CSV upload (it already works)"],
          ],
          [2600, 2900, 3860]
        ),

        h1("5. How the automatic pull works (simple picture)"),
        numbered("Every night, a small worker job wakes up on Railway (same code repo, separate schedule)."),
        numbered("For each client, it asks the API for every report from the FIRST DAY OF LAST MONTH through today, day by day. Re-pulling this rolling window every night keeps last month's final numbers correct as late conversions keep landing (Google restates recent days for a while), and keeps the current month always fresh. On the 1st of a new month, \"last month\" rolls forward automatically."),
        numbered("It converts the API rows into exactly the row format our CSV parser produces — same columns, same names."),
        numbered("It saves them through the merge-by-window ingestion: overlapping days get replaced with fresh numbers, older history is kept. Quality Score keeps its separate frozen daily history."),
        numbered("Everything downstream happens automatically, because it already hooks into ingestion: new campaigns get auto-mapped and flagged for review, caches refresh, Data Inventory shows freshness (\"last synced tonight\")."),
        p("Plus a \"Sync now\" button per client in Setup for on-demand refreshes."),
        note("One prerequisite before any nightly pull can run: the merge-by-window ingestion fix (already built and tested, waiting as a pull request into main) must be merged first. Without it, the old behavior would wipe history on every nightly pull. This is step zero on purpose."),

        h1("6. Build phases"),
        h2("Phase 0 — Prerequisites (mostly you)"),
        bullet("Merge the ingestion merge-by-window PR into main (and into the redesign branch)."),
        bullet("Create the OAuth credentials and refresh token; paste all four secrets into Railway variables."),
        bullet("Confirm all three current clients live under the MCC the developer token belongs to."),
        h2("Phase 1 — Plumbing (build)"),
        bullet("New engine module: API client wrapper, one query per report type, row converter to our format."),
        bullet("\"Test connection\" button in Setup → Clients showing \"API linked ✓\" per client."),
        h2("Phase 2 — First report, proven"),
        bullet("Campaign Performance pulled end-to-end for one pilot client (suggest Chiarelli's)."),
        bullet("Parity check: API numbers vs. a fresh CSV export of the same date range must match before we trust it."),
        h2("Phase 3 — Everything, nightly"),
        bullet("All mapped reports per client, scheduled nightly; freshness shown in Data Inventory."),
        bullet("A failed sync surfaces as an alert (Brief), never silently."),
        h2("Phase 4 — Shopping S2 unlock"),
        bullet("Product-level advertising data via the API → Product Performance, Advertised-vs-Sold, Benchmark views."),
        h2("Phase 5 — Later / optional"),
        bullet("Historical backfill beyond what CSVs covered; BigQuery cutover whenever we choose (no rework needed)."),

        h1("7. Costs, limits, and risks — honestly"),
        bullet("The Google Ads API is free. No per-call charges."),
        bullet("Quota: basic-access tokens allow ~15,000 operations/day. Our need (3 clients × ~12 reports × nightly) is a tiny fraction of that. Scaling to dozens of clients still fits; hundreds would need the free \"standard access\" application."),
        bullet("Auction Insights stays manual (Google's limitation, not ours)."),
        bullet("Two report mappings (Products Sold, and exact PMax placement detail) get verified against real API responses during Phase 1 — flagged now so nothing is over-promised."),
        bullet("The nightly pull writes into the shared production database — which is exactly why Phase 0 (merge-by-window in main) comes first."),

        h1("8. What changes for you day-to-day"),
        bullet("No more monthly CSV exports (except Auction Insights)."),
        bullet("Data is fresh every morning, day-segmented — daily pacing and trends always current."),
        bullet("New campaigns appear auto-mapped with a review notification, as they do today."),
        bullet("Onboarding a new client under the MCC = add their customer ID + approve mappings. No uploads."),

        h1("9. Decisions needed from you"),
        numbered("Green-light merging the ingestion PR into main (Phase 0 blocker)."),
        numbered("Confirm the three clients are under the developer token's MCC."),
        numbered("Confirm Chiarelli's as the pilot client for the parity test."),
        spacer(),
        p("Once those three are confirmed, Phases 1–2 are roughly one to two working sessions, Phase 3 one to two more, Phase 4 about one.", { run: { italics: true, color: MUT } }),
      ],
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("D:/Chazif/Claude Code/Google Ads App/docs/ADS_API_INTEGRATION_PLAN.docx", buf);
  console.log("written", buf.length, "bytes");
});
