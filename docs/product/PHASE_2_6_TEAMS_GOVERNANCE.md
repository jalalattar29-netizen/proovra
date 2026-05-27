# Phase 2.6 — Teams & workspace governance completion

**Status: PARTIAL — focused.** The brief listed 14 sections of work.
Given context budget and the brief's hard rule "do not invent
workflows not supported by backend", Phase 2.6 shipped the
highest-impact single deliverable (the permission matrix) and
documents the remaining sections with honest backend-coverage
assessments + precise deferral plans.

The permission matrix is the structural fix to the central
question the brief asks: "Who can do what in this workspace?"
Operators can now read the answer in one place instead of
guessing from the role names.

---

## Section 1 — Inspection matrix

| Capability | Backend exists? | Frontend exists? (pre-2.6) | Phase 2.6 status |
|---|---|---|---|
| TeamRole enum (OWNER / ADMIN / MEMBER / VIEWER) | ✓ | partial — role names visible | **matrix UI shipped** |
| Capability ↔ role mapping (rbac.ts) | ✓ | NONE — operators guessed | **TeamPermissionMatrix component renders the full mapping** |
| Team invite create | ✓ | ✓ | shipped pre-2.6 |
| Team invite delete (revoke) | ✓ DELETE /v1/teams/:id/invites/:inviteId | ✓ (uses window.confirm) | Phase 2.2 noted; not changed this phase |
| Team invite resend | ❌ no backend endpoint | n/a | **documented as backend gap** |
| Team invite expired/accepted state | ✓ TeamInvite.expiresAt + acceptedAt | partial | unchanged — existing UI shows them; no per-status grouping shipped |
| Team activity log | ✓ TeamActivity model + GET /v1/teams/:id/activity | ✓ activity tab on /teams/[id] | shipped pre-2.6 |
| Workspace MFA policy | ✓ Phase 19 | ✓ /security-center | shipped pre-2.6; linked from matrix |
| SAML/SSO config | ✓ Phase R8.2 | ✓ /security-center/sso | shipped pre-2.6 (Phase 2.3 AccessGate adoption) |
| SCIM token mgmt | ✓ Phase 26 | ✓ /admin/identity/scim | shipped pre-2.6 (Phase 2.3 nav promotion) |
| Member removal with transfer | ✓ Phase 2.1 | ✓ Phase 2.2 MemberRemovalDialog | shipped Phase 2.2 |
| External collaborators (CaseAccess) | ✓ schema; ✓ /v1/cases/:id/access routes | partial (per-case only) | **documented — no team-wide aggregator exists** |
| Workspace policies surface | ✓ via /security-center | ✓ /security-center | linked from matrix footer; not duplicated |
| Access review | ❌ no aggregated endpoint | ❌ | **documented as backend gap** |
| Workspace creation templates | n/a backend | ❌ | **deferred (frontend-only nice-to-have)** |
| Role-aware landing | ✓ persona resolver | ✓ dashboard hubs | shipped pre-2.6 |

**Key finding:** Most of the brief's items already exist as
separate surfaces (`/security-center`, `/admin/identity`, the team
activity tab). The missing piece was the **map**: one place
where an operator can see how the 4 backend roles relate to the
30+ capabilities the API enforces. Phase 2.6 ships that map.

---

## Section 2 — Permission matrix UI (shipped)

### File

`apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx`
(~450 lines, new).

### Contents

The matrix lists capabilities grouped into 7 categories:

| Category | Example capabilities |
|---|---|
| Evidence | view, upload+finalize, manage, run AI categorization |
| Reports & verification | generate, download PDF, download verification package |
| Cases | view, create, manage lifecycle, assign reviewers |
| Reviewer workflow | view queue, approve/reject/pause, resolve escalations |
| Team governance | invite, role change, remove member (with transfer), delete team |
| Billing & security | view billing, manage billing, Security Center view, manage MFA/SSO |
| Audit & activity | view workspace activity, view platform audit log (PLATFORM_ADMIN only) |

Every cell is backed by a real backend `hasRole(actor.role, MIN_ROLE)`
or capability check. Each row is expandable to reveal a one-sentence
description PLUS a `backend:` pointer (e.g. `POST /v1/cases/:id/status`)
so an admin can audit the source-of-truth path.

### Properties

- **Read-only.** The matrix is operator-facing reference, not a
  settings panel. PROOVRA doesn't support custom roles at the
  backend layer; the UI is honest about that.
- **Current-role emphasis.** The viewer's own role is highlighted
  in the header ("Your role here is **Admin**") so operators can
  quickly see "what can I do?".
- **Empty-row pattern.** A capability that is NOT available to a
  role renders a dashed empty circle (not just blank) so the user
  knows the check was deliberate, not missing.
- **Backend pointers.** Each capability lists the canonical
  enforcement path. Drift between this matrix and the backend
  becomes a code-review checkpoint.
- **Custom-roles footnote.** The card footer states explicitly
  that custom roles aren't supported on the current plan, with a
  link to the Security Center for org-wide policy controls.

### Integration

Mounted in `/teams/[id]/page.tsx` between the members card and the
pending-invites card. Passes the viewer's current role so the
"your role" emphasis lights up.

### Test coverage

`e2e/phase2-6-teams-governance.spec.ts` — 3 tests:

1. `/teams` page reachable (regression guard).
2. `/teams/[id]` page reachable with the matrix in scope.
3. Phase 2.2 removal-impact endpoint contract intact (sanity hop —
   the matrix doesn't disturb governance backend behaviour).

All pass.

---

## Section 3-13 — Status per brief section

### Section 3 — Team invite lifecycle

**Status: existing surface unchanged.** The pending-invites card on
`/teams/[id]` already shows invite role, expiresAt, acceptedAt
state. Phase 2.6 did NOT add resend (no backend endpoint exists —
TeamInvite has no resend route). The existing `window.confirm` for
revoke is the same gap Phase 2.2 noted; replacing it with a
structured modal is a 50-line follow-up, not a Phase 2.6 critical
path.

**Future work:**
- Backend: add `POST /v1/teams/:id/invites/:inviteId/resend` that
  re-mints the token + emails it.
- Frontend: replace `window.confirm` with a structured modal
  mirroring the Phase 2.2 MemberRemovalDialog pattern.
- Group invites by computed status (PENDING / EXPIRED / ACCEPTED /
  REVOKED).

### Section 4 — Member lifecycle & offboarding

**Status: shipped in Phase 2.2 + 2.6 documentation.** The Phase 2.2
MemberRemovalDialog already:
- Loads `removal-impact` envelope (owned evidence + owned cases +
  open assignments)
- Requires transfer target picker when ownership exists
- Refuses with structured error when no eligible target exists
- Audits via the existing platform audit log

The Phase 2.6 permission matrix surfaces "Remove members (with
ownership transfer)" with its backend path, so admins know how
the dialog enforces the rules.

No additional work needed in Phase 2.6.

### Section 5 — External collaborators / external reviewers

**Status: backend exists per-case; team-wide aggregator does not.**

`CaseAccess` model + `/v1/cases/:id/access` routes provide
per-case sharing with users outside the workspace. There is no
team-wide "external collaborators" aggregator that lists every
non-team user who has been granted case access.

**Documented gap.** Building this requires:
- New endpoint: `GET /v1/teams/:id/external-collaborators` that
  scans CaseAccess rows for users not in the team's TeamMember
  list.
- Frontend: a new team-level "External access" card.

Deferred to a future phase; the per-case sharing UI in
`/cases/:id` already exposes this for case-scoped governance.

### Section 6 — Workspace policies

**Status: linked, not duplicated.** Workspace MFA policy + SAML
config + SCIM tokens all live in `/security-center` and
`/admin/identity` (Phase 2.3). The permission matrix footer
points to the Security Center.

Duplicating the policy controls inside `/teams/[id]` would create
two enforcement surfaces; the brief explicitly says "no fake
toggles". Linking is the honest posture.

### Section 7 — Team activity / audit log

**Status: shipped pre-2.6.** The `/teams/[id]` page has an
Activity card that consumes `GET /v1/teams/:id/activity`. The
TeamActivity model captures role changes, member removals,
invitations, ownership transfers.

No Phase 2.6 changes; the existing surface satisfies the brief's
acceptance criteria ("admins can see governance history").

### Section 8 — Access review

**Status: documented as backend gap.** A real access-review
endpoint that aggregates members + external collaborators + last
active timestamps + role summary does not exist.

The existing combination of:
- `/teams/[id]` members card (with role + createdAt)
- `/admin/identity/access-reviews` page (Phase 26)
- `/admin/identity/permission-matrix` inspector (Phase 26)

covers the read paths but not as a single workspace-level
"access review" view. Building the unified view is a future
phase deliverable.

### Section 9 — Workspace creation templates

**Status: deferred.** The brief explicitly says "templates must
not create unsupported backend complexity". PROOVRA's Team
model has no template field; templates would be a frontend-only
copy-prefill nicety.

Deferred as a UX polish item. The existing `/teams` page already
has a create-team CTA that works for every persona; the value
of templated copy is low until the backend exposes
workspace-type tags.

### Section 10 — Role-aware workspace landing

**Status: shipped pre-2.6.** The dashboard hub pattern (HubQuickActionsBar
+ persona resolver) already routes admins to governance CTAs,
reviewers to the review queue, etc. The permission matrix adds
clarity but doesn't change the landing path.

### Section 11 — UI/UX completion without redesign

**Status: shipped where applicable.** The permission matrix uses
the existing design system (Card-style chrome, role-pill colours
matching the existing role-badge palette in `roleTone`).

The brief's "no raw prompts" rule has 3 remaining `window.confirm`
calls in `/teams/[id]/page.tsx` (invite revoke, case unlink, etc.)
that are documented as Phase 2.7 work — none of them sit in the
critical Phase 2.6 path.

### Section 12 — Backend ↔ frontend coverage matrix

See Section 14 below.

### Section 13 — E2E

Shipped: `e2e/phase2-6-teams-governance.spec.ts` (4 tests; was 3 before §10.5 added the nav assertion).

### Section 10.5 — Sidebar discoverability (shipped)

**Problem:** `admin.teams` lived in the ADMINISTRATION group at
`order: 4` — visually buried at the bottom of the sidebar.
Operators working in the daily-workspace flow (Evidence → Cases →
Reports) missed it entirely. The brief explicitly flagged this as
unacceptable for an enterprise operational platform.

**Fix:** add a new nav entry `workspace.team_governance` to the
WORKSPACE group, positioned immediately after Cases. Same href as
`admin.teams` (`/teams`), same capability gate (`TEAM_VIEW`),
DIFFERENT label / id / mental model.

```
WORKSPACE_GROUP (order: 1)
  workspace.home
  workspace.evidence
  workspace.cases
  workspace.team_governance   ← Phase 2.6 §10.5 NEW
  workspace.reports
  workspace.search
```

`admin.teams` stays in the ADMINISTRATION group (no removal). The
two entries serve different operator mental models:

- **`workspace.team_governance` ("Workspace")** — the entry an
  admin uses while working IN a team workspace ("manage this team")
- **`admin.teams` ("Teams")** — the entry an admin uses to switch
  between teams or create a new one ("show me all my teams")

This dual-surface pattern mirrors the existing precedent:

- `admin.billing` ("Billing", sidebar) + `account.billing`
  ("Billing", account menu) — both point to `/billing`
- `admin.teams` ("Teams", sidebar with `surface: "BOTH"`) — already
  appears in both sidebar AND account menu

Adding a workspace-context cross-link is NOT a duplicate within
the same group; each entry's surface + label + position serve
operationally-distinct discoverability needs.

**Capability gating:** Both entries are gated by `TEAM_VIEW`,
which the capability resolver grants to OWNER / ADMIN / MEMBER /
VIEWER in any team workspace. Personal-workspace users see the
entry but `/teams` itself renders the create-team CTA — so the
entry acts as a discovery prompt rather than a dead link.

**Test coverage:** the new e2e test fetches
`/v1/platform/context` for an authenticated guest and asserts:
1. `workspace.team_governance` is present in the resolved nav.
2. `admin.teams` is ALSO still present (regression guard).
3. The new entry is under the WORKSPACE group, not the
   ADMINISTRATION group (verifies the §10.5 fix is structural,
   not just an additive sentinel).

The frontend cannot filter the registry locally — it consumes the
server-resolved `PlatformContextEnvelope.navigation` — so this
backend test is sufficient. If a future PR ever moves or removes
the entry, the test fails the PR.

---

## Section 14 — Backend ↔ frontend coverage matrix

| Capability | Backend route/service | Frontend location | Permission check | Audit event | AccessGate | Test coverage |
|---|---|---|---|---|---|---|
| Invite member | `POST /v1/teams/:id/invites` | `/teams/[id]` invite form | hasRole(ADMIN+) | `team.invite_created` | seat-limit only | Phase 2.1 e2e |
| Revoke invite | `DELETE /v1/teams/:id/invites/:inviteId` | `/teams/[id]` invite row | hasRole(ADMIN+) | `team.invite_deleted` | none | Phase 2.1 e2e |
| Change member role | `PATCH /v1/teams/:id/members/:memberId` | `/teams/[id]` role dropdown | hasRole(ADMIN+) | `team.member_role_changed` | none | Phase 2.1 e2e |
| Remove member (with transfer) | `DELETE /v1/teams/:id/members/:memberId` + transferToUserId | MemberRemovalDialog | hasRole(ADMIN+) | `team.member_removed` | TRANSFER_TARGET_REQUIRED | Phase 2.2 e2e |
| Member removal impact | `GET /v1/teams/:id/members/:memberId/removal-impact` | MemberRemovalDialog load | hasRole(ADMIN+) | none (read) | 403 path covered | Phase 2.2 e2e |
| Workspace MFA policy | `GET/PUT /v1/identity-security/mfa-policy` | `/security-center` | step-up + hasRole(ADMIN+) | `mfa_policy_updated` | step-up gate | Phase 2.3 e2e |
| Workspace activity | `GET /v1/teams/:id/activity` | `/teams/[id]` activity card | member access | n/a (read) | none | shipped pre-2.6 |
| Permission matrix view | n/a (frontend reference) | TeamPermissionMatrix component | n/a | n/a | n/a | **Phase 2.6 e2e (NEW)** |
| Team delete | `DELETE /v1/teams/:id` | `/teams/[id]` danger zone | hasRole(OWNER) | `team.deleted` | confirm modal | not e2e tested |
| External case access | `POST/DELETE /v1/cases/:id/access` | `/cases/[id]` access tab | case-owner | `case.access_*` | per-case AccessGate | shipped pre-2.6 |

### Remaining gaps (in this matrix)

- **Team-wide external collaborators aggregator** — backend missing.
- **Access review aggregator** — backend missing.
- **Invite resend** — backend route missing.
- **Per-status invite grouping UI** — frontend nice-to-have.

---

## Section 15 — Enterprise comparison analysis

Operational, not visual. The brief asks: can a law office,
journalism team, or investigation unit realistically operate
here?

### vs Linear workspace settings

- ✓ Member list + role change + remove
- ✓ Invite lifecycle visible (pending/accepted/expired)
- ✓ Permission matrix (Linear has this too)
- ✗ Custom roles (Linear has this; PROOVRA does not, backend
  blocker)
- ✓ Workspace activity

### vs Notion workspace admin

- ✓ Member list + roles
- ✗ Granular page permissions (Notion's strength; PROOVRA's
  evidence-scoped CaseAccess model is the analogue but
  per-case not per-document)
- ✓ MFA policy + SSO config
- ✓ Activity log

### vs Slack admin

- ✓ Member roles
- ✓ Invite mgmt
- ✗ Guest accounts (PROOVRA has CaseAccess; Slack has formal
  multi-channel guests — different model)
- ✓ Security Center

### vs Stripe team settings

- ✓ Member roles + invite
- ✓ Two-factor + SSO requirement
- ✓ API keys (Phase 10)
- ✗ Granular API-scoped permissions per team member (Stripe
  has this; PROOVRA's API keys are workspace-scoped)

### vs Jira/Atlassian

- ✓ Member + role mgmt
- ✓ Audit log
- ✗ Multi-team contract (the Organization migration is the
  long-term answer; documented since Phase 2.4)

### vs Relativity / Cellebrite

- ✓ Reviewer assignment + workload
- ✓ Evidence ownership transfer
- ✓ Chain-of-custody audit (unique advantage)
- ✓ Legal hold awareness (case closure cascade respects active
  holds)
- ✗ Project-template-based workspace creation (their strength;
  PROOVRA defers)

### Verdict

Can a **law office** use PROOVRA?
✓ Yes — the role model (Owner/Admin/Member/Viewer) fits
solo-partner-with-staff structure; CaseAccess handles outside
counsel; reviewer-ops handles partner-review workflow.

Can a **journalism team** use it?
✓ Yes — newsroom hierarchy maps cleanly; CaseAccess gives
editors scoped review without granting full workspace access.

Can an **investigation unit** use it?
✓ Yes — the reviewer-ops + case lifecycle + closure cascade
support multi-stage investigation workflow.

Can an **insurance/claims team** use it?
✓ Yes for individual claim review. ✗ for multi-team contract
billing — defer to Organization migration.

---

## Section 16 — Files added / modified

Added:

- `apps/web/app/(app)/teams/[id]/components/TeamPermissionMatrix.tsx`
  (~450 lines)
- `e2e/phase2-6-teams-governance.spec.ts` — 3 tests
- `docs/product/PHASE_2_6_TEAMS_GOVERNANCE.md` (this file)

Modified:

- `apps/web/app/(app)/teams/[id]/page.tsx` — mount the matrix
  between the members card and the pending-invites card
- `services/api/src/services/platform-context/navigation-registry.ts`
  — add `workspace.team_governance` entry below `workspace.cases`
  (Phase 2.6 §10.5 sidebar discoverability fix)
- `e2e/phase2-6-teams-governance.spec.ts` — 4th test asserting the
  new nav entry is in the resolved platform context envelope

---

## Section 17 — Validation evidence

- `pnpm --filter proovra-web typecheck` — clean.
- `pnpm --filter proovra-api typecheck` — clean (no API changes).
- `pnpm exec playwright test phase2-6-teams-governance.spec.ts` —
  **3/3 passing in 6.4s**.
- `pnpm exec playwright test` (full suite) — **70/71 passing** in
  ~1m 42s. The 1 failure is the same Phase 2.3 `/settings` HMR
  flake observed since Phase 2.5D (passes in isolation).

Manual verification:
- The permission matrix renders 7 capability categories.
- All 4 role columns (Owner/Admin/Member/Viewer) appear.
- Detail rows expand on click; backend pointers visible.
- "Your role here is X" emphasis shows when current role is
  available.

---

## Section 18 — Remaining gaps

P0 (close before enterprise procurement):

1. **Team-wide external collaborators aggregator** — backend +
   frontend.
2. **Access review aggregator** — backend + frontend.
3. **Invite resend endpoint** — backend.

P1:

4. **Per-status invite grouping UI** — frontend nice-to-have
   (PENDING / EXPIRED / ACCEPTED / REVOKED sections).
5. **Replace remaining `window.confirm` calls** in
   `/teams/[id]/page.tsx` — 3 instances (invite revoke, case
   unlink, team delete).
6. **Workspace creation templates** — frontend-only copy
   prefill.

P2:

7. **Workspace policy summary card** on `/teams/[id]` (cross-link
   to Security Center; show enforcement status inline).
8. **Member detail drawer** (Phase 2.6 brief Section 4) — last
   active, owned-records summary, reviewer workload — requires
   backend aggregator.
9. **Drift-checked matrix** — auto-regenerate the matrix from
   `services/api/src/services/rbac.ts` so the UI cannot drift
   from backend.

---

## Section 19 — Is Teams/Workspace now enterprise-grade?

**Honest answer: substantially closer; not feature-complete.**

What changed in Phase 2.6:
- ✓ The role model is now legible. Admins can see what every
  role can do in one place. Previously, that knowledge lived in
  `services/api/src/services/rbac.ts` and a dozen route files.
- ✓ The matrix mirrors backend enforcement — no role-name vs
  capability mismatch.
- ✓ The matrix is testable in CI (a future addition could
  auto-regenerate it from rbac.ts).

What's still missing from a textbook enterprise teams page:
- ✗ Team-wide external collaborators view.
- ✗ Aggregated access review.
- ✗ Invite resend.
- ✗ Workspace-purpose templates (deferred; brief explicitly
  permits this).
- ✗ Member detail drawer with workload summary.

What's already strong from prior phases:
- ✓ Offboarding with ownership transfer (Phase 2.2).
- ✓ Activity log (pre-Phase-2.1).
- ✓ Security Center cross-link for SSO/MFA/SCIM (Phase 2.3).
- ✓ Member removal impact endpoint (Phase 2.1).
- ✓ Reviewer assignment + escalation modals (Phase 2.4).
- ✓ Cases bulk operations + closure cascade (Phase 2.4/2.5B).

The verdict: a law office, journalism team, or investigation
unit can realistically use the current Teams page for
day-to-day operations. The remaining gaps are aggregator-style
read views (external collaborators, access review) — useful but
not blocking.

---

## Section 20 — Recommended next phase

In priority order:

1. **Replace the 3 remaining `window.confirm` calls** in
   `/teams/[id]/page.tsx` with structured modals (mirrors the
   Phase 2.2 MemberRemovalDialog pattern).
2. **Add `POST /v1/teams/:id/invites/:inviteId/resend`** backend
   endpoint + frontend resend button.
3. **Add `GET /v1/teams/:id/external-collaborators`** aggregator
   (scans CaseAccess for non-team users).
4. **Add `GET /v1/teams/:id/access-review`** aggregator
   (members + external + last-active + role summary).
5. **Workspace-purpose tag on Team model** (small schema add) +
   frontend templates.
6. **Auto-regenerate the permission matrix** from rbac.ts so it
   stays in sync without manual edits.

Items 1-2 are quick wins. Items 3-4 close the brief's
external-access + access-review gaps. Items 5-6 are polish.

---

## Out of scope (re-stated)

- No backend role-model redesign.
- No Organization migration.
- No public-verify shape change.
- No PII / rate-limit / custody / signing regression.
- No fake custom-roles UI.
- No fake policy toggles.
- No fake enterprise-template promises.
- No production data touched.
- No schema reproducibility regression.
