const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, LevelFormat, ShadingType, BorderStyle,
} = require("docx");
const fs = require("fs");

const INK = "1A1A1A";
const MUT = "6B7280";
const ACCENT_BG = "F4F6EE";
const HEAD_BG = "EFEFEA";
const CODE_BG = "F0F1EC";

const p = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: 140, line: 276 },
    ...opts.para,
    children: [new TextRun({ text, size: 22, color: INK, ...opts.run })],
  });

// paragraph built from mixed runs: pass array of [text, {bold,italics,...}]
const rich = (runs, opts = {}) =>
  new Paragraph({
    spacing: { after: 140, line: 276 },
    ...opts.para,
    children: runs.map(([t, r = {}]) => new TextRun({ text: t, size: 22, color: INK, ...r })),
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
    spacing: { after: 100, line: 276 },
    children: bold
      ? [new TextRun({ text: bold + " — ", bold: true, size: 22, color: INK }),
         new TextRun({ text, size: 22, color: INK })]
      : [new TextRun({ text, size: 22, color: INK })],
  });

const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 }, children: [new TextRun({ text: t, size: 30, bold: true, color: INK })] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 110 }, children: [new TextRun({ text: t, size: 24, bold: true, color: INK })] });

const note = (text) =>
  new Paragraph({
    spacing: { after: 160, line: 276 },
    shading: { type: ShadingType.CLEAR, fill: ACCENT_BG },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: "9CB44A" } },
    indent: { left: 160 },
    children: [new TextRun({ text, size: 21, color: INK, italics: true })],
  });

const code = (text) =>
  new Paragraph({
    spacing: { after: 120, line: 264 },
    shading: { type: ShadingType.CLEAR, fill: CODE_BG },
    indent: { left: 160, right: 160 },
    children: [new TextRun({ text, font: "Consolas", size: 20, color: INK })],
  });

function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (text, isHead, w) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      shading: isHead ? { type: ShadingType.CLEAR, fill: HEAD_BG } : undefined,
      margins: { top: 70, bottom: 70, left: 110, right: 110 },
      children: [new Paragraph({ spacing: { after: 0, line: 252 }, children: [new TextRun({ text, size: 20, bold: isHead, color: INK })] })],
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
        new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: "Google Ads API — Credential Setup Guide", size: 38, bold: true, color: INK })] }),
        new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: "Step-by-step: how to get the 5 values the app needs · August 2026", size: 21, color: MUT })] }),

        // ---- overview ------------------------------------------------------
        h1("What you're collecting"),
        p("To let the app pull data from Google Ads by itself, it needs 5 values. You gather them once, paste them into Railway, and never touch them again. This guide walks each one start to finish — no prior API experience assumed."),
        table(
          ["#", "Value", "Comes from", "Roughly"],
          [
            ["1", "Developer token", "Google Ads — manager (MCC) account → API Center", "2 min + 1-day approval"],
            ["2", "OAuth Client ID", "Google Cloud Console → Credentials", "10 min"],
            ["3", "OAuth Client Secret", "same screen as the Client ID", "(same step)"],
            ["4", "Refresh token", "a one-time login, using a helper script we provide", "5 min"],
            ["5", "MCC customer ID", "Google Ads — the number top-right", "30 sec"],
          ],
          [500, 2400, 4200, 2160]
        ),
        spacer(),
        note("Security rule, no exceptions: every value below goes ONLY into Railway's environment variables. Never paste them into chat, into the code, into email, or into Git. The AI assistant never sees them and never asks for them."),
        rich([
          ["Do it in this order — ", { bold: true }],
          ["Step 1 first, because its approval takes about a business day and can bake while you do the rest. Then Steps 2 → 3 → 4 → 5, then paste everything into Railway (Step 6)."],
        ]),

        // ---- step 0 --------------------------------------------------------
        h1("Step 0 — Make sure you have a Manager (MCC) account"),
        p("The developer token in Step 1 only exists on a Google Ads MANAGER account (also called an MCC — \"My Client Center\"). A manager account is the umbrella login that sits above your individual client accounts."),
        bullet("If you already sign in to one place and see several client accounts under it, you have a manager account — skip to Step 1.", "Already have one?"),
        bullet("Go to ads.google.com/home/tools/manager-accounts and click \"Create a manager account.\" It's free. Give it a name, pick your country/currency, finish.", "Don't have one?"),
        note("Your 3 current clients (Chiarelli's, Dakota, Reverent) should live UNDER this manager account. If they aren't linked yet, in the manager account go to Accounts → click the + → \"Link existing account,\" and enter each client's 10-digit customer ID. The client's admin approves the link request once."),

        // ---- step 1 --------------------------------------------------------
        h1("Step 1 — Developer token  (value #1)"),
        p("Sign in to your MANAGER account at ads.google.com, then:"),
        numbered("Click the Tools icon (the wrench, top-right)."),
        numbered("In the menu, under the \"Setup\" column, click \"API Center.\" (If you don't see API Center, you're probably in a client account, not the manager account — switch to the manager account first.)"),
        numbered("You'll see your Developer token on the page — a string like a long code. That's value #1. Copy it somewhere safe for now."),
        numbered("Right there, look at the access level. A brand-new token says \"Test account\" access, which can only read fake data. Click to apply for \"Basic access\" and fill the short form (it asks what you'll use the API for — say: \"Internal reporting dashboard that pulls our own managed accounts' performance data.\")."),
        note("The Basic-access approval usually lands within one business day by email. Kick it off NOW so it's approved by the time you finish the other steps. Until it's approved, the app can connect but real-account pulls will be refused by Google."),

        // ---- step 2 --------------------------------------------------------
        h1("Step 2 — OAuth Client ID + Secret  (values #2 and #3)"),
        p("These identify our app to Google. You create them in the Google Cloud Console (a separate site from Google Ads). Use the same Google login."),
        h2("2a. Create a project"),
        numbered("Go to console.cloud.google.com."),
        numbered("At the very top, click the project dropdown → \"New Project.\" Name it e.g. \"SearchNex Ads API\" and Create. Wait a few seconds, then make sure that new project is selected in the top dropdown."),
        h2("2b. Turn on the Google Ads API"),
        numbered("In the left menu (or the search bar at top), go to \"APIs & Services\" → \"Library.\""),
        numbered("Search for \"Google Ads API,\" click it, and click Enable."),
        h2("2c. Set up the consent screen (one-time)"),
        numbered("Go to \"APIs & Services\" → \"OAuth consent screen.\""),
        numbered("Choose User Type: External, and click Create."),
        numbered("Fill the required fields: App name (e.g. \"SearchNex Ads\"), your email as the support email, and your email again at the bottom as the developer contact. Save and continue."),
        numbered("On the \"Scopes\" step, just Save and continue (nothing to add)."),
        numbered("On the \"Test users\" step, click \"+ Add users\" and add YOUR OWN Google email (the one that manages the Ads accounts). Save and continue. (This lets you approve the app in Step 4 even while it's in \"testing\" mode — which is fine for our use.)"),
        h2("2d. Create the credentials"),
        numbered("Go to \"APIs & Services\" → \"Credentials.\""),
        numbered("Click \"+ Create Credentials\" → \"OAuth client ID.\""),
        numbered("Application type: choose \"Desktop app.\" Give it any name. Click Create."),
        numbered("A box pops up showing \"Client ID\" (value #2) and \"Client secret\" (value #3). Copy both. You can reopen them anytime from the Credentials list."),

        // ---- step 3 --------------------------------------------------------
        h1("Step 3 — Refresh token  (value #4)"),
        p("A refresh token is what lets the app log in as you forever after, without you re-entering a password. You generate it once with a small helper script we've included in the project. It runs on YOUR computer; you approve in YOUR browser; the token prints in your terminal."),
        h2("What you need first"),
        bullet("Python installed on your computer (python.org if not)."),
        bullet("Your Client ID and Client Secret from Step 2."),
        h2("Run it"),
        numbered("Open a terminal in the project folder."),
        numbered("Install the one dependency (first time only):"),
        code("pip install google-auth-oauthlib"),
        numbered("Run the helper:"),
        code("python scripts/get_refresh_token.py"),
        numbered("It asks you to paste your Client ID and Client Secret, then opens a browser."),
        numbered("Sign in with the Google account that manages your Ads accounts. You'll see a \"Google hasn't verified this app\" warning — that's expected because the app is in testing mode and you added yourself as a test user. Click \"Continue\" / \"Advanced\" → \"Go to (app) (unsafe)\" → Allow."),
        numbered("Back in the terminal it prints your refresh token (value #4). Copy it."),
        note("The \"unverified app\" screen is normal and safe here — it's your own app, approved by your own account, running on your own machine. Nothing is published to the public."),

        // ---- step 4 --------------------------------------------------------
        h1("Step 4 — MCC customer ID  (value #5)"),
        numbered("Go back to ads.google.com and make sure you're in the MANAGER account."),
        numbered("Look at the top-right corner: under the account name is a 10-digit number formatted like 123-456-7890."),
        numbered("That's value #5. You can copy it with or without the dashes — the app strips them either way."),

        // ---- step 5 --------------------------------------------------------
        h1("Step 5 — Put all 5 into Railway"),
        p("Railway is where the app is deployed. The values become \"environment variables\" on the environment that runs the API-sync branch."),
        numbered("Open your Railway project."),
        numbered("Select the environment/service that deploys the feature/ads-api branch (the new one, kept separate from redesign and main)."),
        numbered("Open the \"Variables\" tab."),
        numbered("Add these 5 variables — the NAME on the left must match exactly, the value is what you collected:"),
        table(
          ["Variable name (exact)", "Paste the value from"],
          [
            ["GOOGLE_ADS_DEVELOPER_TOKEN", "Step 1"],
            ["GOOGLE_ADS_CLIENT_ID", "Step 2 (value #2)"],
            ["GOOGLE_ADS_CLIENT_SECRET", "Step 2 (value #3)"],
            ["GOOGLE_ADS_REFRESH_TOKEN", "Step 3"],
            ["GOOGLE_ADS_LOGIN_CUSTOMER_ID", "Step 4 (MCC id, digits)"],
          ],
          [5200, 4060]
        ),
        spacer(),
        numbered("Save. Railway redeploys automatically."),
        p("To confirm it worked, the app has a status check: open /api/adsapi/status in the deployed app. It should show \"configured: true\" and list your clients as \"syncable.\" (It never shows the secret values — only whether each is present.)"),

        // ---- what happens next --------------------------------------------
        h1("What happens after that"),
        bullet("Come back and tell me it's connected. I run a one-time parity check for one client — pull a few days via the API and compare against a manual CSV export of the same days — to prove the numbers match Google exactly before we rely on them."),
        bullet("Then the nightly automatic pull is switched on: every client, every report, refreshed each night, covering the first day of last month through today."),
        bullet("From then on: no more monthly CSV exports (except Auction Insights, which Google doesn't offer via API). Data is fresh every morning."),

        // ---- quick checklist ----------------------------------------------
        h1("Quick checklist"),
        bullet("Manager (MCC) account exists, with the 3 clients linked under it."),
        bullet("Developer token copied; Basic-access application submitted."),
        bullet("Google Cloud project created; Google Ads API enabled; consent screen set with yourself as a test user."),
        bullet("OAuth Desktop Client ID + Secret copied."),
        bullet("Refresh token generated via the helper script."),
        bullet("MCC customer ID copied."),
        bullet("All 5 pasted into Railway variables on the feature/ads-api environment."),
        bullet("/api/adsapi/status shows configured: true."),
        spacer(),
        p("Stuck on any step? Tell me which number and what you see on screen — I'll walk you through it.", { run: { italics: true, color: MUT } }),
      ],
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("D:/Chazif/Claude Code/Google Ads App/docs/ADS_API_SETUP_GUIDE.docx", buf);
  console.log("written", buf.length, "bytes");
});
