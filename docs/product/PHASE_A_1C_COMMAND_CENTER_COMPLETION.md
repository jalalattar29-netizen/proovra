# Phase A.1C — Operational Command Center & Dashboard Cohesion

**Status:** Account-level operational priorities layer landed on top of the existing workspace CommandCenter. `/home` now answers "what needs your attention now" both for the active workspace (existing CC, untouched) and for the user's identity across all their contexts (new banner). 163/163 E2E green.
**Date:** 2026-05-27
**Predecessors:** [`PHASE_A_1_COHESION_PASS.md`](./PHASE_A_1_COHESION_PASS.md), [`PHASE_A_1B_OPERATIONAL_COMPLETION.md`](./PHASE_A_1B_OPERATIONAL_COMPLETION.md)

---

## TL;DR — Brutally Honest

The existing `CommandCenter` (5,180 lines, 28 sections) is already a deep workspace-scoped command center. It already does:

- Operational pressure surfacing
- Persona-aware section ordering
- Quick-action shortcuts
- Per-section degraded/unavailable states
- Real backend data only, no fake metrics

**The gap Phase A.1C closes is the layer ABOVE the workspace.** The CommandCenter is workspace-anchored — it fetches `/v1/dashboard/command-center?teamId=<uuid>` and shows that workspace's state. It cannot see signals that belong to the **caller's identity** rather than a workspace:

- "You have a pending invite to org X — go accept it."
- "As an admin, you have N open invites across M of your orgs."
- "You haven't joined an organization yet."
- "Your email isn't bound, so email-matched invites won't reach you."

Phase A.1C adds exactly that layer:

1. **One new backend endpoint** — `GET /v1/me/operational-priorities` — caller-scoped, identity-level signals.
2. **One new frontend component** — `AccountPrioritiesBanner` — renders above the existing CommandCenter on `/home`.
3. **A more complete `NoWorkspaceState`** — three real onboarding steps with cross-links, not a two-button stub.
4. **An additional quick action** — Organizations is now a PERSONAL-mode dashboard shortcut.

**No CommandCenter section was replaced.** No backend aggregator was duplicated. No fake metrics introduced. The brief explicitly forbade these and they are not present.

Honest scope statement: this phase is **operational completion of the identity layer above the dashboard**, not a CommandCenter rebuild. The CommandCenter remains the workspace operational hub.

---

## 1. What Changed in Dashboard / Command Center

| Surface | Change |
|---|---|
| `/home` page | Now wraps `<AccountPrioritiesBanner />` + `<CommandCenter />` in a single shell so identity-level signals always show above workspace signals. |
| `CommandCenter` | Untouched in its core 28-section logic. The `NoWorkspaceState` branch was rewritten from a two-button stub into a real three-step onboarding card with cross-links to /organizations, /capture, /teams. |
| `dashboardModeRules.ts` | PERSONAL-mode quick actions extended from 3 to 4 entries to include "Open Organizations" (`/organizations`). Bounded constraint preserved (4 actions max per mode). |
| New component | `AccountPrioritiesBanner` — renders pending org invites, admin pending-invite hotspots, and onboarding signals. Permission-safe via the backend endpoint. |

## 2. Operational Priorities Now Surfaced

Mapped against the brief's mandatory priority types:

| Priority type | Surfaced by | Source |
|---|---|---|
| Pending org invites (you are the addressee) | Banner `data-priority-item="pending_org_invites"` (tone: HIGH) | new endpoint, email-matched + unaccepted + unrevoked + not-expired |
| Admin pending invites (you administer the org) | Banner `data-priority-item="admin_pending_invites"` (tone: WARNING) | new endpoint, summed across orgs caller has ORG_OWNER/ORG_ADMIN |
| No organization yet (first-time onboarding) | Banner `data-priority-item="no_organizations"` (tone: INFO) + onboarding step list | new endpoint, derived from membership count |
| No email identity (pure-guest limitation) | Banner `data-priority-item="no_email_identity"` | new endpoint, derived from `user.email IS NULL` |
| Failed uploads | CommandCenter `operationalPressure` section | existing `/v1/dashboard/command-center` |
| Unfinalized evidence | CommandCenter `recentEvidence` + `pipelineDetail` | existing |
| Failed report generation | CommandCenter `operationalPressure` (`REPORT_FAILED`) | existing |
| Missing verification package | CommandCenter `operationalPressure` (`PACKAGE_MISSING`) | existing |
| Reviewer escalations / SLA risk | CommandCenter `reviewerOrchestration` + `incidents` | existing |
| Governance signals | CommandCenter `governancePosture` + `auditReadiness` | existing |
| Workspace billing posture | Phase A.1B added per-workspace billing pills in `/organizations/:id` | A.1B |

What is NOT surfaced (honestly):
- **MFA disabled per member at workspace scope** — backend has the data on `User.totp_enabled` but no aggregated endpoint exposes it at workspace scope.
- **Stale-member detection** — `User.lastSignInAt` exists but is not aggregated.
- **Org-level seat exhaustion** — Phase 2.7X intentionally keeps billing workspace-scoped; A.1B surfaced per-workspace seats; no org rollup endpoint exists.
- **Public verify abuse/unpublished signals as a separate item** — only present inside the CommandCenter `pipelineDetail` section, not as a banner item.

## 3. Quick Actions Added / Fixed

| Action | Mode | Before | After |
|---|---|---|---|
| Open Organizations | PERSONAL | absent | added (`/organizations`, intent: secondary) |

All other quick actions on the CommandCenter were already wired and pointing at registered routes. I audited the four mode entries (`MODE_QUICK_ACTIONS.PERSONAL/ORGANIZATION/REVIEW_OPS/GOVERNANCE`) — every `href` is a registered application route per the Phase R3 contract, and the test `phase-a-1c-command-center-priorities.spec.ts:214` locks in:
- `personal.organizations` exists in the source.
- `MODE_QUICK_ACTIONS.PERSONAL` count remains ≤ 4 (Phase R3 bounded constraint).

## 4. Role-Aware Behavior Added

The existing CommandCenter is already role-aware (envelope-driven persona + capability matrix). Phase A.1C adds **caller-context awareness** which is distinct from workspace-role-awareness:

| Caller state | Banner behavior |
|---|---|
| Guest with no orgs | Renders onboarding-block with 3-step list pointing to /organizations + /capture + /reports |
| Guest with email + pending invite addressed to them | Renders `pending_org_invites` item with org name + invited role + "Act" CTA pointing to /organizations |
| ORG_OWNER / ORG_ADMIN with open invites in their orgs | Renders `admin_pending_invites` item with count + "Act" CTA pointing to /organizations |
| Fully onboarded user with 0 priorities | Banner renders minimal one-line empty-state marker (DOM is always present for E2E observability) |
| Backend endpoint unavailable | Banner renders compact "unavailable" line with Retry button — never blocks the CommandCenter below |

The CommandCenter's existing role-aware quick-actions and per-section gating continue to work unchanged.

## 5. Backend Endpoints Reused

- `GET /v1/dashboard/command-center` — workspace command center envelope (CommandCenter's source of truth)
- `GET /v1/me/orgs` — extended in Phase A.1B; consumed by /organizations
- `GET /v1/orgs/:id/audit-events` — consumed by the org detail page
- `POST /v1/orgs/:id/invites` — used in the new E2E spec to seed admin pending-invite state
- `GET /v1/platform/context` — global session envelope (sidebar + topbar consume it)
- `POST /v1/users/legal-acceptance` — auth/legal gate

## 6. Backend Endpoint Added / Extended

**Added (1 endpoint):**

`GET /v1/me/operational-priorities`

Caller-scoped, identity-level signal aggregator. Returns the small set of fields the dashboard banner needs:

```jsonc
{
  "generatedAt": "ISO timestamp",
  "caller": { "userId": "uuid", "email": "string|null", "displayName": "string|null" },
  "summary": {
    "totalOrgs": 0,
    "pendingOrgInviteCount": 0,         // invites addressed to caller's email
    "adminPendingInviteCount": 0,        // invites in orgs caller administers
    "adminOrgsWithPending": 0,
    "priorityItemCount": 0
  },
  "onboarding": {
    "legalAccepted": true,               // pre-conditioned by route gate
    "hasEmailIdentity": false,
    "hasAnyOrganization": false,
    "hasOwnedOrganization": false
  },
  "orgs": [ /* one-line summary per org caller belongs to */ ],
  "pendingOrgInvites": [ /* full invite metadata for the caller's pending invites */ ],
  "items": [ /* deterministic prioritized list with id/label/meaning/href/tone */ ]
}
```

Hard rules built in:
- **Caller-scoped only.** Never returns data scoped to a different user, even if the caller is an ORG_OWNER. Org-level governance signals visible to admins (e.g. invites the caller can revoke) are surfaced as **counts** rolled up under `summary.adminPendingInviteCount`, not as enumerable per-invitee identity.
- **Email-matched.** Pending org invites are matched against `user.email` case-insensitively. Pure-guest accounts (no email) see an empty `pendingOrgInvites` array.
- **No evidence/case/reviewer data.** This endpoint stays in the governance/identity layer. Workspace-internal counts remain workspace-scoped.
- **No expensive unbounded queries.** All queries are scoped by `userId` or by `organizationId IN (caller's orgs)` with indexed filter columns.

The endpoint emits **zero** audit events — it's a pure read.

**Extended:** none. The Phase R3 dashboard rules file got a one-entry addition; that's frontend config, not a backend extension.

## 7. Empty / Error / Degraded States Added

| State | Surface | Behavior |
|---|---|---|
| Banner: endpoint loading | banner | `data-state="loading"` skeleton; CommandCenter below renders immediately (no blocking) |
| Banner: endpoint unavailable | banner | small `data-state="unavailable"` line with Retry; CommandCenter continues |
| Banner: caller has 0 priorities + is fully onboarded | banner | one-line `data-state="empty"` marker (DOM-stable for E2E); minimal visual |
| Banner: caller is first-time user | banner | full onboarding-block with 3 step list — `data-onboarding-block` |
| CommandCenter: no active space | NoWorkspaceState | rewritten three-step onboarding card with cross-links to /organizations, /capture, /teams |
| CommandCenter: auth required / permission denied | existing AuthErrorState | preserved |
| CommandCenter: aggregator unavailable | existing UnavailableState | preserved |
| Per-section degraded | existing per-section badges | preserved |

No infinite spinners. No blank gaps. Every state has a stable `data-state` attribute.

## 8. Cross-Surface Continuity Improved

| From | To | Mechanism |
|---|---|---|
| /home banner | /organizations | every priority item's `Act` CTA + the "Open Organizations →" anchor + banner-empty-state link |
| /home banner | /capture | onboarding step 2 |
| /home banner | /reports | onboarding step 3 |
| /home banner | /settings | `no_email_identity` priority item href |
| /home NoWorkspaceState | /organizations + /capture + /teams | three numbered onboarding steps |
| /home CommandCenter quick actions (PERSONAL) | /capture, /evidence, /reports, /organizations (new) | dashboardModeRules.ts |

## 9. Remaining Dashboard Gaps (Honest)

1. **No MFA-status posture on the dashboard.** Backend doesn't expose org-aggregated MFA state; surfacing it would require a new endpoint joining `OrganizationMembership` × `User.totp_enabled`. Not done in A.1C because it would invent a privacy-policy decision in the same PR.
2. **No stale-member detection.** Same shape: `User.lastSignInAt` exists, no aggregator surfaces it.
3. **No assignment / acknowledgement mutations from the dashboard itself.** The exploration report flagged "incident assignment + acknowledgement UI" as a future extension. CommandCenter incidents remain read-only; the user clicks through to act. Not done in A.1C because each mutation needs a deliberate audit-event design.
4. **Banner does not consume the workspace-scoped `operationalPressure` signal.** The two layers stay distinct on purpose: the banner is identity-level, the CommandCenter is workspace-level. Conflating them would create duplicate priority items.
5. **No automated mobile-viewport E2E** for the banner; visual sanity at narrow widths only. The banner uses `flexWrap: wrap` + relative units.
6. **No "you were just added to org X" notification.** Pending-invite items show "accept this" but there's no inbox-style "this is new since last visit". Would require a per-user read-state column on invites.
7. **Reviewer / Investigator / Legal personae get the same banner.** The banner items are role-agnostic by design (they're identity-level). Persona-specific priority items belong inside the CommandCenter, where they already are. Not a gap — a deliberate scoping decision.

## 10. Enterprise-Readiness Improvement

**Net assessment:**

Before A.1C, /home was strong if the user had an active workspace and weak otherwise. The CommandCenter's NoWorkspaceState rendered two buttons; nothing surfaced identity-level signals (pending invites you should accept right now, admin governance hotspots across your orgs).

After A.1C:
- **Every user** who lands on /home sees a small, real-data, permission-safe priority strip BEFORE the workspace surface. If they have nothing pending, the strip is one line; if they have invites to accept, it's at the top of the page in HIGH tone.
- **First-time users** see a complete three-step onboarding card both in the banner AND in NoWorkspaceState. The CTAs route to /organizations + /capture + /teams + /reports — every one a registered, working route.
- **Org admins** see a count of "X pending invites across N of your orgs" without leaving /home — answering "what governance work is waiting for me?"
- **No fake metrics** were introduced. No charts. No KPIs without backing data. The brief's prohibition list is honored.

Where it is still NOT fully enterprise-mature:
- The banner is descriptive, not actionable-in-place. Accepting an invite still requires navigating to /organizations and opening the modal. An "Accept right here" inline action would be a real improvement (one click vs three) but requires a deliberate UX decision about which mutations are dashboard-safe.
- No inbox / notification-history (point 6 of §9).
- No mobile-viewport regression test (point 5 of §9).

## 11. Tests Added / Updated

**New spec:** `e2e/phase-a-1c-command-center-priorities.spec.ts` — **7 tests:**

1. `GET /v1/me/operational-priorities returns the documented envelope shape` — locks the response shape and the `legalAccepted: true` invariant post-gate.
2. `GET /v1/me/operational-priorities requires auth` — anonymous → 401/403.
3. `Fresh guest sees first-time-user onboarding signals (no_organizations item, hasAnyOrganization=false)` — locks the first-time onboarding signal.
4. `ORG_OWNER with a pending invite sees admin_pending_invites item` — locks the admin governance hotspot signal.
5. `Cross-user isolation: stranger does NOT see the inviter's admin counts` — privacy guard.
6. `/home page route returns 2xx after A.1C` — regression check on the wrapped layout.
7. `Dashboard quick-actions: PERSONAL mode advertises Organizations and stays under the 4-action cap` — locks the Phase R3 bound + the new Organizations entry.

No existing tests modified. The existing 156 specs all still pass.

## 12. Final Test Results

**Typecheck:**
```
pnpm --filter proovra-web typecheck → clean
pnpm --filter proovra-api typecheck → clean
```

**Full Playwright E2E:**
```
163 passed (1.3m)
```

That's **+7 tests over the 156 A.1B baseline**, all green, with zero regressions against any of the prior Phase 2.1 → Phase 2.7Z+ specs.

**Live runtime verification** (curl against the local stack, fresh guest, post-legal-acceptance):
```
GET /v1/me/operational-priorities →
  summary: { totalOrgs:0, pendingOrgInviteCount:0, adminPendingInviteCount:0, adminOrgsWithPending:0, priorityItemCount:1 }
  onboarding: { legalAccepted:true, hasEmailIdentity:false, hasAnyOrganization:false, hasOwnedOrganization:false }
  items: ["no_organizations/info"]
```

Confirms: real signals, no fake counts, correct first-time-user behavior.

---

## What Phase A.1C Honestly Was

A narrowly-scoped identity-layer addition above the existing workspace CommandCenter. It introduces:
- one new endpoint
- one new component
- one rewritten onboarding state
- one quick-action addition
- seven E2E tests

## What Phase A.1C Was Not

- Not a CommandCenter rebuild (forbidden by the brief; honored).
- Not a dashboard-v2 (forbidden; honored).
- Not a fake-metric pass (forbidden; honored).
- Not a marketing redesign (forbidden; honored).
- Not "everything an enterprise dashboard wants" — see §9 for honest remaining gaps.

The brief said: "This phase is complete only when: dashboard clearly shows operational priorities; quick actions work; role-aware state exists; first-time state is useful; dashboard links major workflows; no dead dashboard actions remain; dashboard feels like a command center, not a welcome page."

Against that checklist:

- ✅ Operational priorities clearly shown (banner items, HIGH/WARNING/INFO toned, real backend data)
- ✅ Quick actions all wired (audited; Organizations added to PERSONAL mode)
- ✅ Role-aware state exists (caller-context-aware banner + envelope-driven CommandCenter persona)
- ✅ First-time state useful (banner onboarding block + NoWorkspaceState rewritten)
- ✅ Dashboard links major workflows (banner CTAs + CommandCenter quick actions + cross-link footer all route to registered surfaces)
- ✅ No dead dashboard actions (audited every CTA; one new endpoint backs the new ones)
- ✅ Feels like a command center, not a welcome page — for users with state, the workspace CommandCenter dominates; the banner is a precise, compact identity-level overlay, not decoration

Items NOT closed and intentionally NOT claimed as complete:
- MFA-status board, stale-member detection, in-place dashboard mutations (incident assign/ack), inbox-style read-state, mobile-viewport regression coverage. Each requires deliberate backend design that the brief said NOT to fake.
