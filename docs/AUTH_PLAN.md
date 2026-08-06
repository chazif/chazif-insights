# Authentication & Access Control — Plan

> **Status:** proposal for review. This lays out the options, a recommended approach, the data model, the app changes required, a user-management checklist, and a phased rollout. Nothing here is built yet — decisions in §9 gate implementation.

## 0. What we're solving

We need to go from the current **demo login** (a client-side `sessionStorage` gate with a shared `demo` password and zero server-side enforcement — every `/api/*` endpoint currently trusts the `client` query param) to a real system where:

1. **Users log in** (authentication).
2. **Users see only the clients they're entitled to** — one or many, depending on the engagement (authorization / data scoping).
3. **Users get only the features they're entitled to** (feature access).
4. **The hierarchy supports agencies** — a client who is themselves an agency with many sub-clients, with their accounts kept segregated.
5. **Three role levels:** Super Admin (us — the owners), Admin (a client's own manager, who manages their team's access + some client settings), and regular users.
6. **One solution** covering all user types.

**Scale:** ~10–50 users within ~6 months. This is small — it means we should optimize for *low engineering effort and low ops burden*, not for scale. Subscription cost at this size is a rounding error for any good option (all the recommended choices are **free or ≤ ~$25–50/month**); the real cost is engineering time, so the plan is built around *buying the hard parts*.

## 1. The key insight: two separate problems

Authentication and authorization are different, and conflating them is the usual mistake.

| | **Authentication (AuthN)** — "who are you?" | **Authorization (AuthZ)** — "what can you touch?" |
|---|---|---|
| Examples | login, passwords, MFA, social login, "forgot password", sessions, invitations | which clients this user sees, which features, super-admin vs admin vs member, agency isolation |
| Best sourced from | **a managed provider** (commodity; don't build) | **our own database** (domain-specific; can't be outsourced) |
| Effort | small — wire up an SDK | this is the actual work, and it's modest |

**Buy AuthN, build AuthZ.** No provider knows what a "client" or an "agency engagement" means in our app — that scoping lives in our tables. But every provider handles login/MFA/invites/sessions far better than we would. So the recommendation is a managed identity provider for AuthN + org membership + the user-management UI, plus a **thin authorization layer in our app** for client- and feature-level access.

## 2. Options for authentication (the "buy" part)

All of these are viable at 10–50 users. Ranked for our situation (B2B, multi-tenant, agency hierarchy, want out-of-the-box, already on GCP + Postgres/Railway).

| Provider | Multi-tenant "Organizations" built in? | RBAC built in? | Embeddable user-mgmt UI? | Approx. cost at our scale | Notes |
|---|---|---|---|---|---|
| **Clerk** ⭐ | **Yes** (first-class) | Yes (org roles + permissions) | **Yes** (drop-in components) | Free tier covers our MAU; Pro ~$25/mo if we exceed free org features | Best DX; orgs + roles + invites + a prebuilt org/user management widget = the "add a user, checklist" mostly done for us |
| **WorkOS (AuthKit)** ⭐ (if enterprise SSO) | Yes (organizations) | Yes | Yes | Auth is **free** to very high MAU; **SSO/SAML billed per connection** (~$125/connection/mo) | Best if agency clients will demand "log in with our corporate identity provider" (SAML/SSO). Otherwise free and clean |
| **Supabase Auth** | Partial (you model orgs yourself) | Via Postgres RLS | No (build your own) | Free tier is generous; Pro ~$25/mo | Cheapest + open-source + Postgres-native. But it's happiest when it *is* your Postgres — we're on Railway, so more integration glue |
| **GCP Identity Platform / Firebase Auth** | Tenants exist (Identity Platform) | Build yourself | No | Free tier generous; ~$0.005/MAU after | GCP-native (we already use BigQuery). Cheap, solid, but RBAC + org UI are DIY |
| **Auth0** | Yes, but **Organizations/advanced RBAC are gated to paid B2B plans** | Yes (paid tiers) | Yes | Free MAU is high, but the B2B features we need push to paid, which gets pricey | Industry standard, but the multi-tenant pieces we specifically need aren't in the free tier — worse value here |
| **AWS Cognito** | Weak | Weak | No | Very cheap (50k MAU free) | Cheapest managed option, but notoriously poor DX; you'll build a lot around it |
| **Self-host: `fastapi-users`** | No (you build all of it) | No (you build) | No | $0 (just our infra) | Python library that gives login/JWT/cookies/password-reset in FastAPI. Full control, most portable, but *we* build orgs, roles, invites, MFA, the UI. More work, ongoing maintenance |
| **Self-host: Keycloak / Authentik** | Yes | Yes | Yes (their admin UI) | $0 + a server to run | Full IdPs. Powerful but **operationally heavy** — overkill for 50 users; we'd babysit another service |

### Recommendation

**Primary: Clerk.** It's the best fit because the two hardest parts of *our* requirement — **Organizations** (which map directly to our agencies/engagements) and a **prebuilt user-management UI with email invitations** (which is exactly the "add a user, give them access, checklist" the client asked for) — come out of the box. At 50 users it's free or ~$25/mo, and integration into a FastAPI + vanilla-JS app is a few days, not weeks.

**Choose WorkOS instead if** we expect to sell to larger agencies whose IT will require **SSO/SAML** ("log in with our Okta/Azure AD"). WorkOS is purpose-built for that and its base auth is free; you pay per SSO connection only when an enterprise client needs it.

**Choose Supabase Auth or `fastapi-users` if** we want to minimize subscription cost / avoid a third-party dependency and are willing to build the org + admin UI ourselves. This is the "no out-of-the-box, we do the work" path.

Everything below is written **provider-agnostic** — the authorization model and app changes are the same regardless of which one we pick. The provider only supplies identity + (optionally) the org-membership source of truth + the login/invite UI.

### 2.1 How hard is it to switch providers later? (avoiding lock-in)

Starting on a free tier is safe because switching is **low-to-moderate cost when designed for**, and at 10–50 users the only unavoidable friction is a one-time re-verify email per user (trivial).

**What moves vs. what stays:** the valuable, hard-to-rebuild part — the authorization model (orgs, memberships, client-access, roles, features, audit log) — lives in **our Postgres** and is provider-independent, so it never moves. Only a thin surface is coupled to the provider: the login UI, one token-verification function, the invite email, and (optionally) org-membership sync.

**Passwords are the one real friction:** providers generally won't export password hashes, so a migration means either the new provider bulk-imports users or users get a "set your password again" email on first login — a non-event at 50 users; SSO/social users don't notice at all.

**Five rules that keep the exit cheap (follow these regardless of provider):**
1. **Own the authorization model in our Postgres** — never let orgs/roles/access live *only* in the provider.
2. **Key the `users` table by email**; treat the provider's user ID (`auth_provider_id`) as a swappable pointer, re-mapped by email on a switch.
3. **Wrap the provider behind one thin `backend/auth.py` adapter** (`verify_token()`, `send_invite()`, a webhook handler). Switching = rewrite that one file.
4. **Use standard tokens (JWT/OIDC)**, not deep provider-specific SDK calls throughout the app.
5. Accept a one-time re-verify email as the switching cost.

With those in place, a future provider switch is roughly **a few days + one email blast**, not a rewrite. **Portability ranking:** self-host `fastapi-users` > Supabase > WorkOS/Auth0 > Clerk (proprietary but with migration support; rules 1–3 neutralize most of its lock-in). Given this, the recommendation is **Clerk on the free tier, built portable-by-design** — ship fast now, stay free to leave.

## 3. The authorization model (the "build" part — the core)

This is deliberately shaped after **Google Ads**, which solves the same problem (a manager account containing many ad accounts, with per-user access levels).

### 3.1 The hierarchy

```
Organization  (a tenant / engagement — e.g. "Chazif", "BrightSpark Agency", "Dakota Hardwoods")
   ├── owns many  Clients        (the SearchNex clients = Google Ads accounts we analyze)
   └── has many   Users (members) each with a Role in the org
                    └── each membership grants access to specific Clients (or "all clients in this org")
                    └── and optionally specific Feature modules
```

**Google Ads → our model:**

| Google Ads | Us |
|---|---|
| Manager account (MCC) | **Organization** (an agency org contains its clients) |
| Ad account | **Client** (existing `clients` table) |
| Access levels (Admin / Standard / Read-only / Email-only / Billing) | **Roles** (Admin / Analyst / Viewer) |
| Invite user by email | Provider invitation |
| Manager access cascades to sub-accounts | "All clients in org" grant |

The **agency case** falls out naturally: an agency is just an Organization whose `type = agency` that owns many Clients. The agency's Admin manages their own team and assigns each teammate access to a subset of the agency's clients. Segregation between agencies = row-level scoping (every query is filtered to "clients this user may access"). We (Chazif) are the `owner` org whose Super Admins can see across all orgs.

Sub-agency nesting (an agency with sub-agencies) is supported by a nullable `parent_org_id` but **we keep it flat for v1** — one level of org → clients covers everything we need for the next 6 months.

### 3.2 Roles

| Role | Scope | Can do |
|---|---|---|
| **Super Admin** | Global (Chazif owners) | Everything, across all orgs: create/delete orgs and clients, ingest/assign data, manage any user, impersonate for support, change any setting |
| **Admin** | One org | Manage users *within their org* (invite/remove, set roles, assign client + feature access), edit client-level settings (business context, budgets) for their org's clients, upload data. **Cannot** see other orgs or create new orgs/clients from scratch (adding a *new* client account is a Super-Admin action, since it involves onboarding data) |
| **Analyst** (member) | One org, granted clients | Use the app for the clients they're granted — dashboards, recommendations, run Budget Intelligence, upload data if that feature is granted. Cannot manage users |
| **Viewer** | One org, granted clients | Read-only dashboards for granted clients |

### 3.3 Feature access

Two layers, kept simple:
1. **Role defaults** — each role implies a baseline feature set (Viewer = read dashboards; Analyst = + run recs / upload; Admin = + manage settings/users). This covers most cases with zero per-user config.
2. **Per-membership feature toggles** (the "checklist" extras) — optional overrides for granular control, e.g. hide **Budget Intelligence** from a teammate, or allow **Data Upload** for one analyst but not others. Modules to toggle: `dashboards`, `recommendations`, `budget_intel`, `data_upload`, `business_context`.

Start role-based; add the per-membership toggles as a thin second layer (they're just checkboxes in the add-user flow).

### 3.4 Data model (new tables + one column)

```
organizations
  org_id            PK
  name
  type              'owner' | 'agency' | 'direct'
  parent_org_id     nullable (future nesting)
  created_at

users
  user_id           PK
  email             unique
  name
  auth_provider_id  link to Clerk/WorkOS user id
  is_super_admin    global flag (Chazif owners)
  status            'invited' | 'active' | 'disabled'
  created_at

memberships                     -- a user's role in an org
  membership_id     PK
  user_id           FK
  org_id            FK
  role              'admin' | 'analyst' | 'viewer'
  all_clients       bool   -- true = access to every client in the org (the MCC-style grant)
  unique (user_id, org_id)

client_access                   -- fine-grained per-client grants (when all_clients = false)
  membership_id     FK
  client_id         FK
  access_level      'edit' | 'view'
  unique (membership_id, client_id)

feature_grants                  -- optional per-membership feature toggles (checklist)
  membership_id     FK
  feature           'dashboards' | 'recommendations' | 'budget_intel' | 'data_upload' | 'business_context'
  unique (membership_id, feature)

clients   (existing — add one column)
  + org_id          FK  -- which org owns this client

audit_log            -- (aligns with ROADMAP_V2 Phase I "append-only actions_log")
  id, actor_user_id, org_id, action, target_type, target_id, meta JSON, at
```

All of these live in **Postgres** (small, transactional, config-like — same tier as `clients`/`uploads`/`term_relevance`, never BigQuery).

**Provider integration choice** (decide in §9): either (A) let the provider's Organizations be the source of truth for org + membership + role, synced into our tables via webhook, and we add only `client_access`/`feature_grants` — *less UI to build*; or (B) use the provider purely for AuthN (identity) and own the entire model above — *more portable*. Recommendation: **A with Clerk** (use their org/user widget), **B if self-hosting**.

## 4. Enforcing it in this app

The backend currently has **no auth** — this is the bulk of the work, and it's clean with FastAPI dependency injection.

### 4.1 Backend (`backend/main.py` + a new `backend/auth.py`)

Add reusable dependencies:
- `current_user(request)` — verify the provider's session token/JWT (or cookie) on every `/api/*` call; resolve the `users` row. Reject with 401 if absent/invalid.
- `require_super_admin` — 403 unless `is_super_admin`.
- `require_org_role(org_id, min_role)` — 403 unless the user's membership in that org meets the role.
- `require_client_access(client_id, level="view")` — 403 unless the user has access to that client (Super Admin bypasses; else check membership `all_clients` or a `client_access` row). This guards every endpoint that takes a `client` param.
- `require_feature(feature)` — 403 unless the role default or a `feature_grant` allows it.
- `accessible_client_ids(user)` — the set used to *filter* list endpoints.

Then wire them onto the existing endpoints:

| Endpoint | Guard |
|---|---|
| `GET /api/clients` | authenticated; **filter to `accessible_client_ids`** (this alone scopes the whole client switcher) |
| `GET /api/bundle?client=X`, `GET /api/inventory?client=X` | `require_client_access(X, "view")` |
| `GET/PUT /api/clients/X/config`, `POST /api/clients/X/budget` | `require_client_access(X, "edit")` + `require_feature("business_context")` |
| `POST /api/upload`, `/api/upload/mcc/*` | `require_feature("data_upload")` + client access (or Super Admin for MCC, which creates clients) |
| `POST /api/clients` (create client) | `require_super_admin` |
| `/api/clients/X/budget-intel/*` | `require_client_access(X)` + `require_feature("budget_intel")` |
| **new** `/api/admin/*` (orgs, users, invites, access) | `require_org_role(org, "admin")` or `require_super_admin` |

**Note on the bundle cache:** it's keyed by `(client, filters, date range, compare)` and access is checked *before* the cache is consulted, and the computed data is identical regardless of viewer — so there's **no cross-user leak**. No change needed beyond adding the access check ahead of it.

### 4.2 Frontend

- **Replace the demo gate** (`index.html` `chz_authed`) with the provider's hosted login (or an embedded widget). Store the session token; attach it to every `fetch` (Authorization header or secure cookie).
- The client switcher already renders whatever `/api/clients` returns — once that's scoped server-side, it's **automatically correct** with no frontend logic.
- Include the user's **role + granted features** in the bundle `meta` (e.g. `meta.permissions`) so the SPA hides nav items / actions the user can't use (e.g. hide **Business Context**, **Data Upload**, or **Budget Intelligence** when not granted). This is defense-in-depth; the server is the real gate.
- Add the **admin screens** (§5) — or, with Clerk/WorkOS, embed their org/user-management component and add just our client-access checklist on top.

## 5. The "add a user" checklist (concrete UX)

An Admin (for their org) or Super Admin (any org) opens **Team → Add user** and fills a short form — this is the checklist the client asked for:

```
Add user
─────────────────────────────────────────────
  Email        [ jane@brightspark.com        ]
  Name         [ Jane Okafor                 ]
  Organization [ BrightSpark Agency      ▼   ]   (Super Admin only; Admins are locked to their org)

  Role         ( ) Admin   (•) Analyst   ( ) Viewer

  Client access
     [x] All clients in this organization
     — or —
     [ ] Dakota Hardwoods            [ ] Reverent Films
     [ ] Chiarelli's Religious Goods [ ] …

  Feature access
     [x] Dashboards        [x] Recommendations
     [x] Budget Intelligence
     [ ] Data upload       [ ] Edit business context

           [ Send invite ]
─────────────────────────────────────────────
```

"Send invite" creates the `users`/`memberships`/`client_access`/`feature_grants` rows and triggers the provider's email invitation (set-password / magic-link). The invitee clicks through, sets a password (or uses SSO/social), and lands scoped to exactly what was checked. Editing a user reopens the same form. Everything is logged to `audit_log`.

## 6. Phased implementation plan

Each phase is shippable and low-risk; behavior for *us* doesn't change until the enforcement phase.

- **Phase 0 — Decisions (§9).** Pick the provider; confirm the hierarchy/feature-granularity choices. *(No code.)*
- **Phase 1 — Identity.** Integrate the provider; replace the demo gate with real login; create the `users`/`organizations`/`memberships` tables; seed a single `owner` org (Chazif) with us as Super Admins and one org per existing engagement. *No enforcement yet* — everyone still sees everything, so nothing breaks. Backfill `clients.org_id`.
- **Phase 2 — Enforcement.** Add the `current_user` + access dependencies; scope `/api/clients`; guard `client`-scoped endpoints; add role checks. This is where access actually takes effect. Add `client_access`/`feature_grants` tables.
- **Phase 3 — Multi-tenant / agency isolation.** Turn on org-based isolation (agency Admins see only their org); verify cross-org queries are impossible; add the audit log.
- **Phase 4 — Admin UI.** The user-management checklist (§5), org & client management for Super Admins, self-service for org Admins. (With Clerk/WorkOS, largely their embedded components + our client-access checklist.)
- **Phase 5 — Polish.** Feature-toggle overrides, MFA (free from the provider), session/idle timeout, password policies, and hooking auth events into the audit log.

Rough effort with a managed provider: **Phases 1–4 ≈ 2–4 weeks** of focused work; self-hosting adds meaningfully to that (you build invites, org UI, MFA, resets).

## 7. Cost summary

| Approach | Monthly subscription @ ~50 users | Engineering effort |
|---|---|---|
| **Clerk** | **$0–25** | Low (orgs + roles + user UI provided) |
| **WorkOS** | **$0** base (+ ~$125/SSO connection only if an agency needs SAML) | Low–medium |
| **Supabase Auth** | **$0–25** | Medium (build org + admin UI) |
| **GCP Identity Platform** | ~$0 (tiny at this scale) | Medium–high (build RBAC + UI) |
| **`fastapi-users` (self-host)** | **$0** | High + ongoing maintenance |

At 10–50 users the subscription is negligible for every good option — **optimize for engineering time and ops simplicity**, which is why a managed provider (Clerk) wins.

## 8. Security & compliance notes

- **Sessions:** prefer the provider's short-lived JWT + refresh (or secure, httpOnly, SameSite cookies). Never store tokens in `localStorage` for anything privileged.
- **Server is the gate:** frontend hiding is UX only; every check is enforced server-side.
- **PII:** we now store user emails/names — keep them in Postgres (not BigQuery), and the provider holds credentials (we never store passwords). Note GDPR/data-processing basics for EU users.
- **Audit log:** who changed access, who logged in, who edited a client — the `audit_log` table (already on the ROADMAP) covers this and is worth turning on from Phase 3.
- **Least privilege:** default new users to Viewer + no clients; access is added deliberately via the checklist.
- **Impersonation:** Super-Admin "view as" is invaluable for support — but log it explicitly.

## 9. Decisions to confirm (these gate the build)

1. **Provider:** Clerk (recommended default, built portable per §2.1) vs Supabase/self-host (max portability, more UI to build). *→ open; leaning Clerk-on-free-tier.*
2. **Enterprise SSO / SAML:** ~~decided~~ **treated as an optional add-on for later** — not driving the initial pick (SSO can be layered on Clerk, or is WorkOS's strength if it becomes a priority).
3. **Org source of truth:** use the provider's Organizations (less UI to build, some lock-in) vs own the whole model in our DB (more portable). *Recommendation: use the provider's if we pick Clerk, but keep client-access + roles mirrored in our DB per §2.1 rule 1.*
4. **Feature granularity:** ~~decided~~ **role-based only** at launch (per-user toggles deferred to the Phase-5 thin layer).
5. **"Add client" authority:** confirm that creating a *new* client account stays a **Super-Admin** action (since it involves data onboarding), while org Admins manage *access to existing* clients. *Recommendation: yes.*

**Settled so far:** feature access = role-based; SSO = optional/later; leaning Clerk-on-free-tier with the §2.1 portability rules. **Still open:** final provider pick (Clerk vs Supabase/self-host), and confirming decisions 3 & 5.

This plan aligns with and front-loads **ROADMAP_V2 Phase I** (auth + roles + append-only actions_log), so it's not a detour — it's the foundation the operator platform was already going to need.
