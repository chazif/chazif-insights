# Paid-Search Intelligence Platform — Build Roadmap

**Internal product, reusable across clients. Not client-specific.**
Horizon: next ~3 months. Build model: mostly you + AI-assisted coding, occasional specialist.
Goal for the 3 months: **one module, production-grade, end-to-end** — and the reusable spine underneath it.

---

## 1. The strategy: one thin vertical slice, not four half-modules

The temptation is to build a little of every layer. Don't. Build **one module all the way down through every layer** — ingestion → data model → intelligence → validation → activation → review app → governance. Doing that forces you to build the *reusable spine* once. When module #2 arrives, ~80% of the plumbing already exists and you only write new analysis logic and a new activation type.

So the 3-month output is two things at once:
1. **The spine** — the client-agnostic platform every future module plugs into.
2. **Module #1** — one capability running live, earning its keep.

This is also the honest answer to the "are we building a product or a project" question: the spine is the product; each module is a productized capability; each client is a config.

---

## 2. Which module to build first

**Recommendation: Keyword & Search-Term Intelligence (search-term mining + negative keywords + keyword hygiene).**

Why this one leads:

- **Zero first-party-data dependency.** It runs entirely on Google Ads data (search terms, keywords, campaigns). That makes it *maximally reusable* — it works on any search account on day one, no BigQuery, no sales data, no client-specific pipeline. The most client-agnostic module is the right first product.
- **Safest activation.** The first time your system writes to a live account, you want the lowest-blast-radius action possible. Adding a negative keyword or pausing a wasteful term is far safer than moving budgets or bids. You earn trust on the safe write, then extend.
- **Clear, defensible recommendations.** "This term spent $X over N days with zero conversions — exclude it" is evidence a client validates in seconds. Easy to demo, easy to trust.
- **You already have a prototype.** The audit dashboard covered this ground; you're productionizing understood logic, not inventing it.
- **It closes a live sales point.** It's the "ends the twice-a-year keyword debate" story in the deck — you'd be able to *show* it.

Budget Intelligence is higher dollar-impact but leans on first-party data (client-specific, slower) and higher-risk activation — better as module #2. Creative and Conversion Setup come after.

---

## 3. The reusable spine (architecture)

Seven layers. Build them generic; parameterize everything by `client_id`.

| Layer | What it does | Reused by every module? |
|---|---|---|
| **1. Connector / ingestion** | OAuth to a Google Ads account (via your MCC), scheduled pulls of the reports a module needs, into raw tables | Yes |
| **2. Data model / store** | Normalized, per-client-isolated tables; metrics by day; a stable internal schema decoupled from the API | Yes |
| **3. Intelligence** | Analysis + recommendation generation. Deterministic rules for the math; an LLM only for scoped classification tasks (e.g. "is this search term relevant to this business?") | Logic is per-module; the framework is reused |
| **4. Validation / guardrails** | Every recommendation emitted as a strict schema object; checked against hard bounds and safety rules before it can surface | Yes |
| **5. Activation** | Two-way Google Ads API: a staged-change queue, apply-on-approval, audit log, rollback | Yes (new *action types* per module) |
| **6. Review app** | The human-in-the-loop surface: list recommendations + evidence, filter, approve/reject, batch-approve | Yes |
| **7. Governance / multi-tenancy / security** | Per-client credential isolation, least-privilege, logging, monitoring, config management | Yes |

**Design rule that makes it a product, not a script:** the AI model never has account access and never sees raw account credentials. Application code retrieves scoped data → hands the model a clean, minimal payload → the model returns structured output → code validates it against hard bounds → a human approves → code executes the API write. The model proposes; code disposes. (This is the "application layer" discipline — bake it in from commit #1, not later.)

---

## 4. Tech stack (tuned for solo + AI-assisted)

Optimize for leverage: rent infrastructure, don't build it; keep the engine API-first so the UI is swappable.

- **Engine language: Python.** Best fit for the `google-ads` client library, data work, and AI SDKs. This is also the language AI coding assistants are strongest in.
- **Data store: Postgres (e.g. Supabase or Neon).** Holds the normalized ad data, recommendations, and the audit log at this scale. Add BigQuery *only* when a specific client already lives there (like Mavis) — abstract the data-access layer so it can target either.
- **Review app: start with Streamlit or Retool, keep the engine behind a clean API.** Do not sink three weeks into a bespoke React app now. Get a working approve/reject UI in days; graduate to Next.js later if it goes client-facing. The API-first boundary means the UI is throwaway, not load-bearing.
- **LLM: any frontier API behind a thin abstraction.** Used only for scoped classification/summarization. Swappable by design — never let one vendor's model become the system.
- **Scheduling: the simplest thing that works** (cloud scheduler / cron) now; Prefect or Dagster later if orchestration gets real.
- **Hosting: a single small cloud service + managed Postgres.** Secrets in a real secret manager from day one (you're storing OAuth refresh tokens — treat them like passwords).
- **Repo hygiene: config-driven from the start.** A client is a config object (credentials ref, business-context pack, thresholds). No client specifics in code, ever.

---

## 5. The 3-month plan

Six two-week sprints, plus a Sprint 0 you start **today** because of an external dependency (see §7).

### Sprint 0 — Access & scaffolding (start immediately, runs in parallel with Sprint 1)
- **Apply for a Google Ads API developer token (Basic access).** This needs an application and approval and can take days to weeks — it is the critical-path dependency. Start day one; develop against test accounts until it lands.
- Stand up repo, environments, secret management, Postgres, chosen hosting.
- Define the `client` config abstraction and the multi-tenant data-isolation pattern.

### Sprint 1 (Weeks 1–2) — Ingestion layer *(reusable)*
- OAuth connect flow for a Google Ads account via your MCC.
- Pull the reports Module #1 needs: search terms, keywords, ad groups, campaigns — with cost, clicks, conversions, conv value, by day.
- Scheduled incremental daily pulls into raw tables. Idempotent, re-runnable.
- **Milestone:** a real account's search-term data landing in your DB automatically each day.

### Sprint 2 (Weeks 3–4) — Data model + analysis logic
- Normalized schema; metrics-by-day; stable internal names decoupled from the API.
- Search-term & negatives analysis: spend-with-no-conversion detection, CPA-threshold breaches, n-gram / theme mining, irrelevant-term detection, duplicate/near-duplicate keywords, quality-score flags.
- Deterministic math for the thresholds; **LLM only** for the relevance-classification step, fed by the client's business-context config.
- **Milestone:** given an account, output a raw list of defensible findings.

### Sprint 3 (Weeks 5–6) — Recommendation engine + validation *(reusable framework)*
- Convert findings into **structured recommendation objects**: action, target level, rationale, supporting evidence, confidence.
- Guardrail layer: schema validation, hard bounds, dedupe, safety checks (e.g. never negate a brand term, never exceed N changes/run).
- **Milestone:** clean, validated, evidence-backed recommendations — still read-only.

### Sprint 4 (Weeks 7–8) — Review app *(reusable shell)*
- Internal web app: list recommendations with evidence, filter/sort, approve/reject, batch-approve, per-client view.
- Everything a human needs to say yes or no fast.
- **Milestone:** you can review and approve a real account's recommendations in a UI.

### Sprint 5 (Weeks 9–10) — Activation: two-way write + audit/rollback *(reusable)*
- Google Ads API mutate for approved actions — **negatives first** (safest write), then keyword pause/add.
- Staged-change queue → one-click deploy → full audit log → one-click rollback.
- Hard safety caps enforced in code at the point of execution.
- **Milestone:** the first supervised, approved change pushed live to a real account and reversible.

### Sprint 6 (Weeks 11–12) — Harden, multi-client, pilot
- Multi-tenant isolation, error handling, retries, logging, monitoring, rate-limit handling.
- Run end-to-end on a second account to prove client-agnosticism.
- Documentation + a lightweight security pass on credential handling.
- **Milestone:** Module #1 is production-grade and reusable across accounts.

---

## 6. Definition of done (end of 3 months)

Module #1 (Keyword & Search-Term / Negatives) running end-to-end on **at least two real accounts**:

> daily automated ingest → analysis → validated, evidence-backed recommendations → review app → human approval → guarded write to Google (negatives + keyword actions) → audit log + rollback — multi-tenant, config-driven, documented.

And the spine (layers 1, 2, 4, 5, 6, 7) built generic, so Module #2 starts at ~20% effort.

---

## 7. Critical dependencies & risks

- **Google Ads API developer-token approval is the #1 schedule risk.** It gates everything and is outside your control. Apply on day one; build against test accounts meanwhile. Do not let this slip to week 3.
- **OAuth token storage is a security surface.** You're holding refresh tokens for clients' ad accounts. Encrypt at rest, use a secret manager, least privilege. Get this right early — it's part of the diligence story later.
- **API rate limits and quotas.** Basic access has daily operation caps; design pulls to be economical and cache aggressively.
- **Scope creep is the silent killer of a solo build.** The pull to start Budget Intelligence "while you're in there" will be strong. Resist it until Module #1 is done end-to-end. One vertical slice.
- **AI-assisted coding is fast at code, weak at architecture and security judgment.** Use it to accelerate the layers, but you personally own the data model, the guardrail bounds, and the credential handling. Those are the parts that hurt if they're wrong.
- **Don't over-build infra.** No Kubernetes, no microservices, no custom orchestration this quarter. Managed Postgres + one service + a scheduler. Complexity is the enemy of a solo timeline.

---

## 8. Where AI assistance gives you the most leverage

- **High leverage:** boilerplate for the Google Ads API pulls, schema/ORM code, the Streamlit/Retool UI, transformation logic, test data, docstrings and docs.
- **Medium leverage:** the recommendation-object framework, validation rules (you specify the bounds, it writes the checks).
- **Low leverage / you own it:** the data model design, the guardrail thresholds, credential/security architecture, and deciding what counts as a good recommendation. These are judgment, and judgment is the thing you're selling.

---

## 9. Beyond the 3 months — module expansion order

Each new module reuses layers 1, 2, 4, 5, 6, 7 and adds only new analysis logic + a new activation action type.

1. **Budget Intelligence** — highest dollar-impact; introduces first-party/warehouse data and higher-risk (budget/bid) activation. Natural module #2 once the safe-write pattern is proven.
2. **Creative Automation** — RSA generation/testing/refresh; introduces brand-safety guardrails on the write path.
3. **Conversion Setup Intelligence** — diagnostic; monitors tracking health and data density; mostly read/alert, light activation.
4. **Value Signals (OCI)** — last, and only where a client is ready. Reuses the activation layer to push richer conversion values back to bidding.

Each module makes the platform more valuable and the next one cheaper. That compounding is the whole point of building the spine first.

---

*Companion docs in this folder: `PROJECT_NOTES.md` (Mavis specifics), the two pitch decks, and the engagement-model options.*
