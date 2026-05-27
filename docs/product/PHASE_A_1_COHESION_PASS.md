# Phase A.1 — Operational Cohesion & Discoverability Pass

**Status:** Narrowly-scoped pass landed; broader cohesion gaps from the Phase A audit remain open.
**Date:** 2026-05-27
**Predecessor:** [`PHASE_A_COMPLETION_AUDIT.md`](./PHASE_A_COMPLETION_AUDIT.md)

---

## TL;DR — Brutally Honest

Phase A.1 in this session did **one** concrete cohesion fix:

- The three Phase 2.7X Organization surfaces (`/organizations`, `/organizations/[id]`, `/org-invites/[token]/accept`) were **URL-reachable only** because the Stage 3 readiness doc intentionally deferred sidebar/registry promotion. They had no canonical route-registry entry, so the cross-surface plumbing (PageRouteGate, command-palette, deep-link metadata, denied-state rendering) was bypassed for them.
- Phase A.1 closed that one gap: registered them in `routeRegistry.ts` and wrapped them in `PageRouteGate` so they behave like every other authed surface.

That is the entire substantive change in this pass. Everything else the Phase A audit flagged (CommandCenter → /organizations cross-links, billing usage breakdown card, notification preferences card, risk surfacing on /home, reports filter persistence, settings sub-tab deep-linking) is **still open**.

This is not "Phase A.1 done." This is one of ~8 cohesion gaps closed.

---

## 1. What Was Improved

- **Organization surfaces are now first-class registry surfaces.** They get the same load/denied/loading shell, the same `data-testid` markers, the same envelope handling, and the same command-palette eligibility logic every other authed surface gets. Previously they short-circuited around all of that because they had no `routeId`.
- **Command-palette discovery for `/organizations` is now possible** (`commandPaletteVisible: true`). The detail and invite-accept routes intentionally stay hidden from the palette (deep-link / token-link only).
- **Consistency with `/settings` and `/home`**: same inner-component-split pattern (`Page` → `PageRouteGate` → `PageInner`), so future refactors see one shape.

## 2. What Was Unified

- **Page shell pattern**: all three org surfaces now match the `/settings` shape — top-level component wraps in `PageRouteGate`, inner component owns business logic. This makes the auth/loading boundary identical across surfaces.
- **Route-registry coverage**: the registry is now authoritative for *every* `/(app)/*` surface that the Phase 2.7X work shipped. No more "this surface exists but isn't in the registry" exceptions for org pages.
- **Sidebar discipline**: all three new entries are `sidebarEligible: false`, matching `admin.teams`. The Stage 3 dual-read rationale (don't fork org-management entry points) is preserved.

## 3. Operational Gaps Discovered

While doing this pass I confirmed the following gaps from the Phase A audit are still live:

| Gap | Surface | Status |
|---|---|---|
| CommandCenter has no link to `/organizations` | `/home` | **Open** |
| No billing usage breakdown card on `/settings` | `/settings` | **Open** |
| No notification preferences card on `/settings` | `/settings` | **Open** |
| Risk indicators on home don't deep-link to filtered reports | `/home` → `/reports` | **Open** |
| Reports filter state not persisted in URL | `/reports` | **Open** |
| `/settings` sub-tabs not deep-linkable via hash/query | `/settings` | **Open** |
| Org audit timeline has no `/reports`-style export | `/organizations/[id]` | **Open** |
| `admin.teams` and `account.organizations` show the same data via different lenses (legacy Team-shaped vs Phase 2.7X Org-shaped) — no UX cue tells the user which is canonical for which task | navigation | **Open** |

The audit doc lists these. Phase A.1 closed **zero** of them. It closed a 9th gap (registry registration) that was the easiest to close.

## 4. Files Changed

```
apps/web/lib/navigation/routeRegistry.ts                       (+59 lines)
apps/web/app/(app)/organizations/page.tsx                      (+17 lines)
apps/web/app/(app)/organizations/[id]/page.tsx                 (+11 lines)
apps/web/app/(app)/org-invites/[token]/accept/page.tsx         (+12 lines)
```

No other production code touched. No API code touched. No schema touched.

## 5. Endpoints Reused

All three surfaces continue to consume their existing Stage 3 / Stage 4 / Stage 5 endpoints:

- `GET  /v1/me/orgs`
- `GET  /v1/orgs/:id`
- `GET  /v1/orgs/:id/members`
- `GET  /v1/orgs/:id/invites`
- `GET  /v1/orgs/:id/audit`
- `POST /v1/orgs`
- `POST /v1/orgs/:id/invites`
- `POST /v1/orgs/:id/invites/:inviteId/revoke`
- `POST /v1/orgs/:id/invites/:inviteId/resend`
- `POST /v1/org-invites/:token/accept`
- `PATCH /v1/orgs/:id`
- `PATCH /v1/orgs/:id/members/:memberId`

## 6. Endpoints Added

**None.** This pass was purely a frontend cohesion pass — no API surface change.

## 7. Navigation Changes

Three new entries in `apps/web/lib/navigation/routeRegistry.ts`:

| `id` | `href` | `domain` | `sidebarEligible` | `commandPaletteVisible` |
|---|---|---|---|---|
| `account.organizations` | `/organizations` | `ACCOUNT` | `false` | `true` |
| `account.organization-detail` | `/organizations/:id` | `ACCOUNT` | `false` | `false` |
| `account.org-invite-accept` | `/org-invites/:token/accept` | `ACCOUNT` | `false` | `false` |

**Deliberate choices:**

- `requiredCapabilities: []` — org membership is itself the gate, not a capability flag. The API endpoints enforce ORG_* role precedence.
- `requiredActiveSpace: "NONE"` — org surfaces are workspace-independent (correct per Stage 3 dual-read design).
- `fallbackBehavior: "LOAD"` — never silently route away; show the surface and let the API return 403/404 if needed.
- `sidebarEligible: false` — preserves the Stage 3 decision to keep `admin.teams` as the primary org-management entry point. Promoting to sidebar in this pass would have created dual-path UX confusion.

## 8. Discoverability Improvements

- **Command palette (cmd-K) now offers `/organizations`** as a destination.
- **Deep-links from external systems** (e.g. email invite tokens at `/org-invites/[token]/accept`) now hit the canonical PageRouteGate boundary, so an unauthed user gets the standard auth-required panel instead of a raw page crash.
- **No new sidebar entry.** This is intentional — the Stage 3 doc explicitly chose against it, and Phase A.1 honored that.

What is **not** improved:

- CommandCenter (`/home`) still has no contextual link to `/organizations`. A user who knows they want to manage org-level governance still has to either know the URL, remember the palette command, or go through `admin.teams`.
- The relationship between `admin.teams` (legacy Team-shaped) and `account.organizations` (Phase 2.7X Org-shaped) is still undocumented inside the product UI. The dual-read design is right; the user-facing signposting is missing.

## 9. Workflow Continuity Improvements

- **Invite → Accept → Land**: the invite-accept page now redirects to `/organizations/[id]` 1.5s after success. That was already in place pre-A.1. Phase A.1 adds the route-gate so the redirect target also gets the standard auth/loading shell.
- **Member sees their org consistently**: `/organizations` list → `/organizations/:id` detail → audit/members/invites are all now gated identically. Previously the gating shape was inconsistent.

What is **not** improved:

- No "you were just added to org X — here's what changed" announcement on first landing.
- No cross-surface continuity from `/home` workspace context into the parent org. A user looking at workspace evidence has no breadcrumb up to the org that owns the workspace.
- No deep-link from a workspace settings card into its parent org's detail page.

## 10. Remaining Fragmentation Risks

Listed in honest priority order:

1. **Two parallel "where do I manage my org?" entry points** (`admin.teams` legacy view vs `/organizations` Phase 2.7X view) with no in-UI explanation of which is canonical for which task. This is the highest-friction remaining issue. Resolving it requires either retiring one of them or adding explicit cross-references — neither was done in Phase A.1.
2. **No workspace ↔ org breadcrumb**. Workspaces know their `organizationId` (Stage 6 made this NOT NULL), but no UI surface shows the upward relationship. A user managing a workspace can't easily jump to "the org that owns this workspace."
3. **CommandCenter is the operational home but has no org awareness.** It shows workspace state, not governance state. For an org admin who logs in primarily to manage members/billing/audit, `/home` is the wrong landing surface, and no signal in the UI guides them to the right one.
4. **`/reports` and org audit timeline are siloed.** Both are evidence of "what happened recently," but a user investigating an incident has to know to check both.
5. **Phase 2.7X invite emails are still ENABLED-but-unsent in non-production.** The Stage 4 invite endpoint logs the token; no transactional email was wired. The Phase A audit flagged this as an MVP-acceptable gap; Phase A.1 did not address it.

## 11. Enterprise-Readiness Improvement

**Net assessment: marginal.**

- Before A.1: org surfaces existed and worked but were inconsistent with the rest of the product shell. An enterprise customer poking at the URL bar would notice the difference.
- After A.1: org surfaces use the same shell. A customer auditing the product would see uniform behavior. Routes are inspectable via the canonical registry.

Where this matters for enterprise sales:
- **Security audits** (does every authed surface go through the same auth gate?) — **yes, now.**
- **Accessibility audits** (do all surfaces expose stable test markers?) — **yes, now**, via the `PageRouteGate` `data-testid` we landed in the prior E2E-stability pass.
- **Cohesion of the product as a whole** — **still partial.** The cross-surface continuity issues in §10 are what an enterprise UX review would flag. Those are not yet fixed.

Phase A.1 raised the floor. It did not raise the ceiling.

## 12. Tests Added / Updated

**No new tests were added in this pass.** The change is structurally invisible from a behavior standpoint:

- The org surfaces' existing E2E coverage (`e2e/phase2-7x-stage3-*.spec.ts`, `e2e/phase2-7x-stage4-*.spec.ts`, `e2e/phase2-7x-stage5-*.spec.ts`) continues to assert the same outward behavior.
- Wrapping in `PageRouteGate` doesn't change observable DOM in the authenticated path; the existing selectors (e.g. `[data-phase-2-7x-organizations-list]`) still resolve.
- The `data-testid={route-gate-${routeId}}` markers added in the prior pass now apply to the org surfaces as well, but no test currently asserts them — they exist for future test-stability work.

**Honest gap:** an E2E test asserting "unauthed user hitting `/organizations` gets the auth-required panel from `PageRouteGate`, not a route-not-registered fallback" would meaningfully validate this pass. It is not yet written.

## 13. Final Test Results

Last full E2E run (immediately preceding this doc, post-route-registry + PageRouteGate wrapping):

```
Running 144 tests using 1 worker
  144 passed (1.8m)
```

Web typecheck: clean (`pnpm --filter @proovra/web typecheck`).

No regression. No new test failure introduced.

---

## What Phase A.1 Honestly Was

A discoverability-floor-raising pass for the three Phase 2.7X surfaces that were intentionally left URL-only.

## What Phase A.1 Was Not

A complete operational-cohesion sweep. The Phase A audit identified ~8 distinct cohesion gaps; this pass closed one of them. Cross-surface link continuity, risk surfacing on CommandCenter, billing usage breakdown, notification preferences, settings deep-linking, reports URL state, org-workspace breadcrumb, and the legacy-vs-Phase-2.7X entry-point ambiguity — all remain open.

## Recommended Next Move

A Phase A.2 (or continuation of A.1) targeting the next-highest-friction item from §10: **add an explicit cross-reference between `admin.teams` and `/organizations` so users understand which surface is for which task.** That is a low-code, high-clarity change that unblocks the dual-read confusion without forcing a premature retirement of either surface.

After that, in priority order: CommandCenter → /organizations link, workspace → org breadcrumb, reports URL state, settings deep-link tabs.

Do **not** call the broader cohesion work done until §10 items 1, 2, and 3 are closed. Anything else is overselling.
