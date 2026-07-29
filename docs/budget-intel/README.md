# Budget Intelligence — Development Package

Everything needed to build the Budget Intelligence module (Module 2) of
SearchNex Ads. Self-contained: no access to the source spreadsheet or any prior
conversation is required.

## What's in this package

| File | Purpose |
|---|---|
| `FEATURE_SPEC.md` | The build contract: schema, engine layout, endpoints, UI, playbook guards, acceptance criteria, build order |
| `MODEL_SPEC.md` | The authoritative math, reverse-engineered from the production workbook, with cell-level provenance |
| `fixtures/` | Real input data + expected outputs from one full production run (Mavis, week of 2026-02-22) — powers the golden test |
| `fixtures/curve_params.json` | The fitted curve parameters + run context for that week |

## How to use with Claude Code

Suggested kickoff prompt from the repo root:

> Read docs/budget-intel/README.md, FEATURE_SPEC.md and MODEL_SPEC.md, then
> ROADMAP_V2.md §8 for platform context. Build Stage B1 per the spec, following
> the existing conventions in engine/ingest/store.py and backend/main.py.
> Write tests as you go; the golden test in MODEL_SPEC §7 is the acceptance gate
> for Stage B2+B3 — set up tests/test_budget_intel_golden.py against the
> fixtures directory early, marked xfail until the stages land.

Build stages in order (B1 data foundation → B2 curve service → B3 allocator →
B4 API/UI → B5 calibration); each is independently mergeable. Details and
dependency notes are in FEATURE_SPEC §Build order.

## The one-paragraph mental model

The module answers: *"given this weekly budget and this goal, how should spend be
distributed across Brand × Region × Category, and what tCPA changes does that
imply?"* It works by modeling each cell's response to impression share (a fitted
logistic for lead volume, a quadratic for cost-per-lead), projecting six surfaces
(leads, CPL, spend, business conversions, revenue, gross-profit-after-ad-spend)
across IS 1–100, scoring each cell's opportunity for the chosen goal, then
allocating budget proportionally with per-cell profit-max caps and min-spend
floors. Output: recommended spend + tCPA adjustment per cell, with expected
outcomes — consumed as recommendation objects by the platform's review workflow.

## Fixture provenance & sensitivity

Fixtures are exported values from `DRM - All Accounts - Revenue & AdROI -
V5.2.xlsx` (internal, Mavis account, week of 2026-02-22). They contain real
client performance and margin data — this repo must stay private; do not copy
fixtures into issues, external tools, or public artifacts.

## Explicitly out of scope for this module

- Google Ads API connectivity (Phase IV of ROADMAP_V2). Everything here runs on
  CSV-ingested data + manually pasted simulator points. When Phase IV lands, API
  simulator pulls write into the same `simulator_snapshots` table (`source="api"`)
  and nothing else changes.
- Auth/roles and the recommendation work-queue lifecycle (Phases I–II). The spec
  names the fallback seams to build against if those aren't merged yet.
- Any LLM usage. This module is deterministic end to end.
