# How the Ad Copy & Landing Page grades work (plain English)

This explains four things you see in the app and exactly how each is decided:

1. **CTR grade** (Ad Copy tab)
2. **LP grade** (Ad Copy tab)
3. **Score** column (LP Performance tab)
4. **LP Category Grid** tab

All of it is deterministic — fixed rules, same input → same output, no AI. The rules live in
`engine/bundle/assemble.py`.

---

## First, two numbers everything is built on

| Term | Formula | Plain meaning |
|---|---|---|
| **CTR** (Click-Through Rate) | clicks ÷ impressions | Of the people who **saw** the ad, how many **clicked**. Measures how good the **ad copy** is at earning the click. |
| **CVR** (Conversion Rate) | conversions ÷ clicks | Of the people who **clicked**, how many **converted**. Measures how good the **landing page** (and offer) is at closing. |

**Where the data comes from:** all four use the Google Ads **"Ads" report** (`ads_performance`).
That's the only report that has *both* the landing-page URL *and* conversions. (The dedicated
Landing Pages report has clicks but **no** conversions, so anything conversion-based has to come
from the Ads report — the ad's conversion rate is used as a stand-in for the page it points to.)

**"Low Volume" / "—" is not a bad grade.** It means *not enough data to judge yet* — too few
impressions or clicks to trust the number.

---

## 1. CTR grade (Ad Copy tab) — is the ad copy good?

Graded on **CTR**. Higher CTR = the headline/description is pulling people in.

**Step 1 — enough data?** If the ad has **fewer than 100 impressions** → **Low Volume** (stop, can't judge).

**Step 2 — pick the scale.** Branded searches naturally get *much* higher CTR (someone searching
your brand name is already ready to click), so branded and non-branded ads are graded on
**separate scales** — otherwise every brand ad would look like an A and every prospecting ad like an F.

- An ad is **Branded** if its **campaign or ad-group name contains one of your brand terms**
  (from Business Context). Otherwise it's **Non-Branded**.

**Step 3 — grade by CTR:**

| Grade | Non-Branded CTR | Branded CTR |
|---|---|---|
| **A — Top Performer** | ≥ 10% | ≥ 30% |
| **B — Good** | 6% – 10% | 20% – 30% |
| **C — Average** | 4% – 6% | 10% – 20% |
| **D — Below Average** | 2% – 4% | 5% – 10% |
| **F — Poor** | < 2% | < 5% |
| **Low Volume** | < 100 impressions | < 100 impressions |

*Example:* a non-branded ad with 5,000 impressions and 350 clicks → CTR 7% → **B — Good**.
The same 7% on a *branded* ad → only **D**, because branded ads are expected to do much better.

---

## 2. LP grade (Ad Copy tab) — is the landing page good?

Same table row, second grade. Graded on **CVR** (the ad's conversion rate, used as a proxy for
the page it sends traffic to).

**Step 1 — enough data?** Needs **≥ 100 impressions AND ≥ 5 clicks** → otherwise **Low Volume**.
(It needs clicks, not just impressions, because CVR is per-click.)

**Step 2 — grade by CVR (one scale, branded or not):**

| Grade | Conversion Rate (CVR) |
|---|---|
| **A — Top Performer** | ≥ 40% |
| **B — Good** | 25% – 40% |
| **C — Average** | 15% – 25% |
| **D — Below Average** | 5% – 15% |
| **F — Poor** | < 5% |
| **Low Volume** | < 100 impr or < 5 clicks |

### Why two grades side by side (and the Ad ↔ LP Pairing grid)

- **CTR grade** = how good the ad is at getting the *click*.
- **LP grade** = how good the page is at converting the *click*.

Crossing them tells you *where the problem is*:

| Ad (CTR) | Page (LP) | Verdict |
|---|---|---|
| Strong (A/B) | Strong (A/B) | **Aligned** — leave it alone, scale it. |
| Strong (A/B) | Weak (D/F) | **Fix the landing page** — you're paying for clicks that don't convert. |
| Weak (D/F) | Strong (A/B) | **Fix the ad** — the page converts, but the copy isn't earning enough clicks. |
| either Low Volume | | **Not enough data** — leave it running to gather more. |

That's exactly what the **Ad ↔ LP Pairing** grid and its summary counts (aligned / fix-LP /
fix-ad / low-volume) show.

---

## 3. Score column (LP Performance tab) — a simpler quality label

This tab lists each **landing-page URL** (ads grouped by their final URL) with its own **Score**.
It's the **same idea** as the LP grade (based on **CVR**) but uses **simpler labels** and a
**looser data gate**, because here you're comparing whole pages, not individual ads.

**Step 1 — enough data?** Needs **≥ 5 clicks** → otherwise **"—"** (dash, can't score).
*(No impression floor here — the LP-grade in Ad Copy is stricter.)*

**Step 2 — score by CVR:**

| Score | Conversion Rate (CVR) |
|---|---|
| **Excellent** | ≥ 45% |
| **Strong** | 30% – 45% |
| **Average** | 20% – 30% |
| **Below Avg** | < 20% |
| **—** | fewer than 5 clicks |

> **Heads-up — two different scales on purpose.** The Ad Copy **LP grade** (A–F) and the LP
> Performance **Score** (Excellent/Strong/Average/Below Avg) both come from CVR but use
> *different cutoffs and different volume gates*. So the same page can read "B" in Ad Copy and
> "Strong" in LP Performance. That's expected — Ad Copy grades each *ad*, LP Performance grades
> the whole *page*.

---

## 4. LP Category Grid tab — which pages serve which categories, and how well?

This answers: **"For each landing page, which product categories does it get traffic for, and how
well does it convert for each one?"** It's a matrix (pages down the side, categories across the top).

**How a page's category is decided** (per ad, from the Ads report):

1. If the ad is **branded** (campaign/ad-group name matches a brand term) → category **"BR"**.
2. Otherwise, match the **ad group + headline text** against your configured **product categories**
   (Business Context) → e.g. "Candles", "Rosaries".
3. No match → **"Other"**.

**What it builds:**

- Each **landing page (URL)** becomes a row showing: cost, clicks, conversions, its **overall CVR**,
  how many categories it serves (**n_cats**), and its **CVR broken out per category**.
- Each **category** gets a summary: how many pages run it, total spend, the **min / median / max
  CVR** across pages, and the **best** and **worst** page for that category.
- Bottom-line stats: number of landing pages, total spend/clicks/conversions, the
  **weighted overall CVR** (total conversions ÷ total clicks), and the average number of
  categories per page.

**Why it's useful:** it surfaces pages that convert well for *one* category but poorly for
*another*. Example: one page might convert great for "Candles" but badly for "Rosaries" — a signal
that "Rosaries" traffic deserves its own dedicated landing page instead of sharing a generic one.

---

## Good to know (limitations)

- **Conversion grading is a proxy.** Because the Landing Pages report has no conversions, all
  CVR-based grades/scores use the **ad's** conversions from the Ads report, attributed to the URL
  the ad points to. It reflects the ad+page combination, not the page in perfect isolation.
- **Thresholds are fixed industry-style heuristics**, the same for every client (not
  auto-calibrated per account). They're meant as a consistent triage signal, not a precise verdict.
- **Branded vs non-branded** depends on your **brand terms** being set in Business Context — if
  those are missing, everything is treated as non-branded.
- **Categories** depend on your **product categories** being set in Business Context (and now, for
  campaign-level views, on the central campaign mapping).
