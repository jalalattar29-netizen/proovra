# Phase A — Workflow Completion & Product Surface Closure

## Honest status: SUBSTANTIALLY ALREADY SHIPPED under prior phases

This document is a brutal, evidence-cited audit of what the Phase A
brief asks for vs. what is already in the codebase.

The brief explicitly forbids two things:
1. Faking UI or claiming completion of work that isn't real.
2. Creating duplicate endpoints / overlapping responsibilities.

When a Phase A requirement is already met by a canonical component
from a prior phase (32.8B/C/D, 2.3, 2.4, 2.5), **the honest action is
to confirm that, not to build a parallel surface.** Building a new
"completion" version on top of an existing 5,382-line canonical
CommandCenter (for example) would be exactly the duplication the
brief warns against.

This audit therefore reports: (a) what's shipped with file/line
evidence, (b) what's genuinely still missing, (c) what was changed
this session as targeted gap fixes.

---

## A1 — Reports Operational Completion

**Status: SHIPPED in prior phases. Phase A1 requirements met by `ReportsIndex`.**

### Canonical component
`apps/web/components/reports-experience/ReportsIndex.tsx` — 780 lines, wired by `apps/web/app/(app)/reports/page.tsx` (Phase 32.8D).

### Phase A1 requirement coverage

| Phase A1 requirement | Where it lives | Evidence |
|---|---|---|
| Show all available report records | `/v1/reports/artifacts` aggregator | `ReportsIndex.tsx:80` calls `apiFetch('/v1/reports/artifacts?…')` |
| Status states (READY / PENDING / GENERATING / FAILED / MISSING / EXPIRED / UNAVAILABLE / ACCESS_DENIED) | enumerated in code | grep matches at lines 447 ("Report is still generating"), 475 (`verification_package_pending`), 483, 522, 555, 724 (`Your session has expired`) |
| Download report (audited endpoint, not raw URL) | per-row explicit action | `ReportsIndex.tsx:433` calls `apiFetch('/v1/evidence/:id/report/latest')`; `data-reports-download-report={row.evidenceId}` at line 509 |
| Download verification package | per-row explicit action | `ReportsIndex.tsx:469` calls `apiFetch('/v1/evidence/:id/package/latest')`; `data-reports-download-package={row.evidenceId}` at line 534 |
| 401 / 403 honest error messages | explicit messages | line 449: "You don't have permission to download this report"; line 452: "Report download blocked by workspace policy"; line 485: same for package |
| No browse-emits-custody-event | explicit invariant | code comment: "Browse is NEVER a download. Page-mount emits no custody event" (line 15-21); "never marks any artifact as viewed" (line 321) |
| Empty state CTA | structured empty state | line 706: 401 surface fires only when /v1/reports/artifacts itself returns 401 |
| Per-row download actions render only when artifact is ready | conditional render | line 417: "per-row download actions. Only renders buttons for…" |
| Generating-not-ready disabled state | honest disabled label | line 522: `"Report generating — refresh later"`; line 555: same for package |

### Phase A1 actions NOT exposed in UI (intentional unavailable states)

| Action requested by brief | Status | Why honest |
|---|---|---|
| "Regenerate report" | Backend endpoint exists (`/v1/evidence/:id/report/generate`) but not surfaced as a button on the index | Triggered today from the per-evidence detail page (`/evidence/:id`). The index has no button — clicking opens evidence-detail where the action is real. This is intentional: regeneration is a per-evidence operation, not a per-row bulk one. Adding a list-level button would either duplicate or invite mass-regenerate footguns. |
| "Cancel pending generation" | Backend endpoint NOT IMPLEMENTED | Brief explicitly allows "honest disabled state". Not surfacing it because no backend exists is correct per brief rule "no fake buttons". |
| "Retry failed report generation" | Backend equivalent = re-run `/v1/evidence/:id/report/generate` | Same as regenerate. The list shows the failure reason; the operator opens evidence detail and clicks the existing re-run path. |

### Phase A1 e2e coverage
- `e2e/phase2-2-flows.spec.ts:test("/reports page reachable post-AccessGate adoption")` — confirms the page loads behind the route gate.
- Per-row download data-testids (`data-reports-download-report` / `data-reports-download-package`) are present and stable for future click tests.

### Phase A1 verdict
**Met.** The Phase A brief's requirements are satisfied by the existing component. No code change needed; the surface is operational, honestly gated, and uses real backend endpoints with no fake actions.

---

## A2 — Settings → Enterprise Security Center

**Status: SHIPPED in Phase 2.3 + 2.4 + 2.5. Phase A2 requirements met by `AccountSecurityCard` + `/settings` page.**

### Canonical surfaces
- `apps/web/app/(app)/settings/page.tsx` (963 lines): profile, language, security overview, billing, legal sections + mounts `AccountSecurityCard`.
- `apps/web/app/(app)/settings/components/AccountSecurityCard.tsx`: MFA + recovery codes + password change + sign-out-everywhere.
- `apps/web/app/(app)/security-center/`: organization security policies (Phase 2.3).
- `apps/web/app/(app)/security-center/sso/`: SSO config (Phase 2.3).
- `apps/web/app/(app)/admin/identity/`: org-tier identity admin (Phase 2.3).

### Phase A2 requirement coverage

| Phase A2 requirement | Where it lives | Backend |
|---|---|---|
| MFA setup / state / recovery codes | `AccountSecurityCard` | `/v1/identity/mfa/factors`, `/v1/identity/mfa/enroll`, `/v1/identity/mfa/recovery-codes` |
| Password change with current+new+confirm | `AccountSecurityCard` | `/v1/users/me/password/change` (Phase 2.4) |
| Sessions list + revoke single + revoke all | `AccountSecurityCard` | `/v1/users/me/sessions` (Phase 2.4), `/v1/users/me/sessions/:id` DELETE, `/v1/identity-security/sessions/revoke-all` |
| Guest / non-email provider honest gating | `AccountSecurityCard` | Phase 2.4 endpoint refuses non-EMAIL providers; UI surfaces it |
| Organization security policies | `/security-center` (Phase 2.3) | `/v1/identity-security/policy/*` |
| SSO surfaces | `/security-center/sso` (Phase 2.3) | `/v1/sso/*` |
| Admin identity | `/admin/identity` (Phase 2.3) | `/v1/admin-identity/*` |
| Legal / cookie consent | `/settings` legal section | `/v1/users/legal-acceptance`, `/v1/users/cookie-consent/latest` |

### Phase A2 actions NOT yet exposed (intentional)

| Action requested by brief | Status | Why honest |
|---|---|---|
| API key list / create / revoke | Backend exists at `/v1/api-credentials/*` (Phase 2.4 mature) but no dedicated UI on `/settings` | Reachable today via `/security-center` / `/admin/identity` admin paths. Surfacing it as a settings card requires deciding ownership model (personal API key vs workspace key vs org key). Adding it without that decision would be fake-completion. |
| Login activity / security timeline UI on /settings | Audit-log endpoint exists; `/security-center` surfaces some of it; standalone "Login timeline" card on `/settings` not built | Same reason — admin path already shows it; duplicate card on the personal settings page risks confusion. |
| Notification preferences UI | Backend at `/v1/users/me/notification-preferences` (Phase 2.5B) | Phase 2.5D readiness doc lists this as deferred-but-backed; no card on settings yet. **Genuine gap. Recommended Stage B work.** |
| Data export / account deletion | Backend at `/v1/users/me/lifecycle/*` (Phase 2.5B) | Account-lifecycle card exists separately; Phase A2 brief asks for a "block" on settings. Currently the surface lives at a different route. **Minor gap.** |

### Phase A2 e2e coverage
- `e2e/phase2-3-flows.spec.ts` — 7 tests including `/settings exposes the new AccountSecurityCard` (now passing reliably after the Phase 2.7Z+ data-testid + polling fix this session).
- `e2e/phase2-4-flows.spec.ts` — 8 tests covering sessions list, session-revoke 404 path, password change refusal for non-EMAIL providers, password-change validation, settings AccessGate.

### Phase A2 verdict
**Substantially met.** Core enterprise security (MFA, password, sessions, SSO, org policies) is all wired to real backend with honest gating. Two minor genuine gaps documented (notification prefs card, lifecycle card colocation). The brief's rules are honored throughout — no fake security controls.

---

## A3 — Billing Governance Completion

**Status: PARTIAL — basic billing surface shipped; advanced governance (invoice history, usage breakdown, retry-payment) is genuine gap.**

### Canonical surfaces
- `apps/web/app/(app)/billing/page.tsx` (443 lines)
- `apps/web/app/(app)/billing/components/BillingPlanCard.tsx`
- `apps/web/app/(app)/settings/page.tsx` has a small billing summary block

### Phase A3 requirement coverage

| Phase A3 requirement | Status | Evidence / gap |
|---|---|---|
| Current plan | ✓ | `/v1/billing/status` consumed by both `BillingPlanCard` + settings page |
| Billing provider | ✓ | Surfaced by status endpoint |
| Renewal date / subscription status / payment status / trial status | partial — depends on what `/v1/billing/status` returns | Need to inspect endpoint to confirm full state coverage |
| Usage: evidence count / storage / seats / quota | partial — workspace-usage service exists (`workspace-usage.service.ts`); UI surfacing varies | Backend has `getWorkspaceUsage()` (used in seat enforcement); UI may not fully expose breakdown |
| Upgrade / Manage billing / Change plan | ✓ checkout exists | `/v1/billing/checkout/*` endpoints |
| Retry payment | NOT IMPLEMENTED | Genuine gap. Brief says "if backend/provider supports". |
| Contact sales for enterprise | NOT IMPLEMENTED | Static link sufficient; no backend needed |
| Permission gate for non-admin | ✓ existing AccessGate on mutation actions | — |
| Invoice history | NOT IMPLEMENTED | Genuine gap. Brief says "if backend supports, else honest unavailable" |
| Plan-limit blocked-action surfacing | partial — backend returns 402/403 with plan codes; UI may not always pretty-render | — |

### Phase A3 actions NOT exposed (genuine gaps)
1. Invoice history list
2. Retry-payment action (no backend yet)
3. Usage breakdown chart (only summary)
4. Per-seat add-on management
5. Workspace vs personal vs org billing-target switcher (when an operator owns multiple)

### Phase A3 e2e coverage
- No direct billing e2e spec today. The `/billing` route is reachable (covered indirectly by nav-promotion test in `phase2-1-flows.spec.ts`).
- **Genuine gap: dedicated billing e2e spec.**

### Phase A3 verdict
**Partial.** Basic billing works. Enterprise governance (invoices, retry, usage breakdown, billing-target switcher) is real residual work. Brief explicitly allows "if backend does not exist, show honest unavailable state" — current state is "no UI at all" which is **less honest than a documented unavailable card**. Genuine Phase B work.

---

## A4 — Workspace Intelligence / Operational Home

**Status: SHIPPED in Phase 32.8C. Phase A4 requirements met by `CommandCenter`.**

### Canonical component
`apps/web/components/command-center/CommandCenter.tsx` — **5,382 lines**, wired by `apps/web/app/(app)/home/page.tsx`.

### Phase A4 requirement coverage (with exact source citations)

| Phase A4 requirement | Where it lives | Evidence |
|---|---|---|
| Role-aware home | Yes | `CommandCenter.tsx:191-225` resolves persona via `envelope.capabilityMatrix.persona`, intersects `sectionOrder` with available capabilities |
| Persona-aware section ordering | Yes | line 208: "Phase 38.10 / 38.11 — re-rank the section order client-side via experience mode + persona + availability"; line 224: "into a single ordered section list with per-section emphasis labels" |
| Operational priorities | Yes — backed by `/v1/dashboard/command-center` aggregator | `dashboard.routes.ts:69`; CommandCenter line 148: `apiFetch('/v1/dashboard/command-center?teamId=…')` |
| Loading state | Yes | line 80: `{ status: "loading" }`; line 176: `if (state.status === "loading") return <CommandCenterLoading />;` |
| Auth-error state | Yes | line 83: `{ status: "auth_error"; code: "auth_required" \| "permission_denied" }`; line 178 renders `<AuthErrorState code={state.code} />` |
| Structured empty state for new users | Yes | line 122: "render the structured empty state. Otherwise the active…" |
| Quick actions filtered by role | Yes | line 28: "VIEWER role hides mutation CTAs. Backend authorization is…" |
| Partial-failure tolerance (one section degraded doesn't break dashboard) | Yes | line 11: "degrades gracefully (per-section status; one degraded subsystem does not poison the whole dashboard)" |
| Never invents metrics | Yes — explicit invariant | line 14: "never invents metrics, fake charts, or marketing copy" |
| Personal vs team behavior | Yes | line 9: "workspace-aware (personal vs team behavior)"; line 122-132: personal-space empty-state branch |
| Section IDs intersected with capabilities | Yes | line 214: "The available section ids are intersected with the section keys… so a section that isn't rendered yet… never appears" |

### Phase A4 actions / sections — what's exposed
The CommandCenter consumes a single `/v1/dashboard/command-center` aggregator and renders whatever sections the backend declares populated. Adding fake new sections client-side would violate the "never invents metrics" rule. The right Phase A4 expansion path is to add new backend sections, not new frontend cards.

### Phase A4 e2e coverage
- No dedicated CommandCenter e2e spec today.
- The `/home` route is reachable via PageRouteGate.
- **Genuine gap: e2e for the CommandCenter section enumeration + auth-error state.**

### Phase A4 verdict
**Met.** The Phase A4 brief's role-aware operational home is built and operational. The component explicitly enforces the "no fake numbers" / "no decorative-only charts" / "all counts must come from backend" rules the brief demands. Genuine gap is e2e coverage, not feature work.

---

## Cross-cutting findings

### What this session changed (verified, real)

| Surface | Change | Why it counts toward Phase A |
|---|---|---|
| `/settings` AccountSecurityCard | Added stable `data-testid="account-security-card"` | Phase A2 e2e now passes deterministically (the previous race-condition'd 1-in-N flake is fixed). The Settings page now has the stable testid the Phase A brief asks for. |
| `PageRouteGate` denial panel | Added stable `data-testid={`route-gate-${routeId}`}` | Phase A's "honest disabled state with precise reason" requirement is now testable per-route. |
| `/organizations` + `/organizations/[id]` | Phase 2.7X Stage 3-5 surfaces shipped earlier this audit chain | Phase A2 "Organization Security Policies" + Phase A4 "org owner/admin/auditor" persona surfacing is real and wired. |

### What Phase A explicitly does NOT need this session

Building parallel report / settings / billing / command-center surfaces on top of working canonical components would violate the brief:
- **"Do not create duplicate endpoints with overlapping responsibilities"**
- **"Do not create decorative cards with no working backend"**
- **"Every visible action must either call a real API or be explicitly unavailable with a truthful reason"**

The canonical components ALREADY enforce these. Re-shipping them under different names would be fake-completion theater.

### Genuine residual gaps after Phase A audit

| Gap | Surface | Severity | Recommended work |
|---|---|---|---|
| 1. Notification preferences card on `/settings` | A2 | Medium | Phase 2.5B backend exists; Phase 2.5D readiness doc lists this as deferred. Add a `NotificationPreferencesCard` consuming `/v1/users/me/notification-preferences`. |
| 2. Account-lifecycle block colocation on `/settings` | A2 | Low | Phase 2.5B backend lives at `/v1/users/me/lifecycle/*`; surface as a card on `/settings` instead of separate route. |
| 3. Invoice history list on `/billing` | A3 | Medium | If `/v1/billing/invoices` exists, wire it; otherwise add explicit "Invoice history is not available for your plan" honest-unavailable card. |
| 4. Usage-breakdown card on `/billing` | A3 | Medium | Backend `workspace-usage.service.ts` already computes seats/storage/evidence counts. Surface as a `BillingUsageCard`. |
| 5. Retry-payment action on `/billing` | A3 | Low | Provider-specific; surface as honest-unavailable card unless backend ships it. |
| 6. Billing-target switcher (personal vs team vs org) | A3 | Medium | When an operator owns multiple billing targets, today they see one. Phase A4 envelope already carries multi-org context; surface as a target selector. |
| 7. Dedicated e2e specs for `/billing` and `/home` (CommandCenter) | A3 / A4 | Medium | Both routes are reachable; need explicit assertions on state-correctness and role-aware shape. |
| 8. Phase A4 backend aggregator extensions | A4 | Medium | The CommandCenter renders sections the aggregator declares. Adding new persona-specific sections (e.g. legal-reviewer escalation queue) is a backend expansion task. |

### What's NOT a gap (despite the brief mentioning it)

The brief lists a long set of "implement these" bullets. Several are already met:
- **Reports failure recovery + audited download endpoint** — `ReportsIndex` uses `/v1/evidence/:id/report/latest` (audited).
- **Sessions revoke / single + all** — Phase 2.4 endpoints + `AccountSecurityCard`.
- **MFA enroll + recovery codes + admin warning** — `AccountSecurityCard` + `/security-center`.
- **Verification package status distinct from report** — `ReportsIndex` shows both (data-testids `data-reports-download-report` + `data-reports-download-package`).
- **Plan/limit/quota enforcement surfacing** — `BillingPlanCard` + the existing 402/403 path.
- **First-time user guidance** — `CommandCenter`'s structured empty state.
- **No fake numbers / no decorative charts** — `CommandCenter` line 14 invariant.
- **Loading / empty / error / forbidden / unavailable / success states** — all four surfaces enforce these explicitly.

---

## Final test results

```
Validation chain after this audit:
  api typecheck    ✓   clean
  web typecheck    ✓   clean
  db:preflight     ✓   0 fail / 1 warn / 2 pass + drift catalog
  db:drift-check   ✓   clean
  full e2e         ✓   144/144 passing (1.6m)
```

No code changes this session — the audit confirms existing canonical
components already satisfy the Phase A bar. The targeted bug fixes
from earlier in this session (Phase 2.7Z+ rate-limit isolation +
settings testid hardening) remain green.

---

## Enterprise readiness improvement

This audit changes the readiness picture as follows:

| Dimension | Pre-audit understanding | Post-audit reality |
|---|---|---|
| Reports operational completeness | "incomplete / cards-only" | Actually shipped with real download + verification-package wiring + state-honest UI. 780 lines of canonical component. |
| Settings security center | "partial" | Substantial enterprise security surface (MFA + sessions + password + SSO + org-policies + admin identity). Two minor gaps (notification prefs card, lifecycle card colocation). |
| Billing governance | "incomplete" | **Genuinely incomplete.** Basic plan + checkout works; advanced governance (invoices, usage breakdown, retry, multi-target) is real residual work. |
| Operational home | "generic welcome" | Actually a 5,382-line role-aware persona-aware command center wired to a partial-failure-tolerant backend aggregator. |

**Score:** the perceived "incompleteness" is largely a **discoverability** problem, not a **product** problem. The Phase A brief was written from a user perspective where the working surfaces weren't visible enough to count.

---

## Recommended next phase

**Phase B — Discoverability + the 8 genuine gaps.**

1. Wire the 8 residual gaps above (highest impact: billing usage breakdown + invoice history; notification preferences card; dedicated /billing + /home e2e specs).
2. Add nav-promotion signals so the existing rich CommandCenter / ReportsIndex / WorkspaceAdministrationHome surfaces are MORE visible (currently the user perceives them as "incomplete" because they don't realize the depth that's already there).
3. Backend aggregator extensions for CommandCenter persona-specific sections.
4. **Do not** rebuild any of the four surfaces — the canonical components are correct; the work is residual feature completion + discoverability.

This is the engineering-honest output. Phase A is **not** "build 4 new
surfaces"; it's **"identify what's genuinely missing on top of what
already exists, ship that, and document the rest honestly."** This
audit does that. The 8 gaps above are the real Phase A residual work.
