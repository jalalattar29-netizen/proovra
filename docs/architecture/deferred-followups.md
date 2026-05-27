# Deferred Follow-ups Registry

**Purpose:** explicit list of items intentionally NOT done inside the
A0 / A1 / A2 trust-foundation phases. Each entry records what to do
next, why it was deferred, and which phase introduced or affirmed the
deferral. New deferrals are appended at the bottom with a date.

The registry is intentionally NOT a generic backlog. Only items that
risk being forgotten because they fall between phase boundaries
appear here. Generic feature work lives in product planning.

---

## A0 — Truth-gate the integrity claim

### A0.1 — Admin operational counter for `evidence_integrity_rejected`

- **Why deferred:** the SecurityEvent + structured log + metric all
  ship in A0. A small Admin UI counter on `/admin/audit` to surface
  the last-24h count is a follow-up.
- **Where:** `apps/web/app/(app)/admin/audit/page.tsx`,
  `services/api/src/routes/admin-audit.routes.ts`.
- **Acceptance:** admin sees a tile "Integrity rejections (24h): N".

### A0.2 — Reviewer queue auto-clear on FAILED_HASH_MISMATCH

- **Why deferred:** A0 transitions the Evidence row but doesn't
  notify in-flight reviewer assignments.
- **Where:** `services/api/src/services/reviewer-ops/*`.
- **Acceptance:** when an Evidence reaches FAILED_HASH_MISMATCH, any
  ACTIVE EvidenceReviewWorkflow automatically transitions to
  `NEEDS_INFO` (or equivalent) so the reviewer's queue clears the row.

### A0.3 — Background reconciler that revalidates SIGNED rows

- **Why deferred:** A0 reuses the worker's existing report-time hash
  recompute; a periodic out-of-band recompute lives elsewhere.
- **Where:** new worker scheduler, reuse `rejectEvidenceIntegrity`
  with `source: "worker.reconciler"`.
- **Acceptance:** scheduled sweep covers a configurable percentage
  of recent SIGNED rows per day; mismatches transition cleanly.

### A0.4 — On-device capture attestation pipeline

- **Why deferred:** A0 closes the server-side trust gap; the
  pre-server trust gap (was the file altered on the device before
  upload?) requires a mobile-side attestation key.
- **Where:** `apps/mobile`, new API endpoint to accept device-signed
  capture metadata.
- **Acceptance:** the API rejects an upload whose device-signed
  metadata fails verification.

---

## A1 — Finish Phase 2.7X Stage 6 (Evidence org tenancy)

### A1.1 — Tenancy observability metrics

- **Why deferred:** A1 lands the FK + CHECK + the diagnostic script,
  but doesn't add live counters for the four anomaly classes the
  diagnostic checks for.
- **Where:** `packages/shared-runtime/src/ops/metrics.service.ts`,
  `services/api/src/services/organization/tenancy-resolver.service.ts`.
- **New counters to register:**
  - `tenancy_evidence_team_org_mismatch_total`
  - `tenancy_evidence_org_dangling_fk_total` (will be 0 once FK
    validation lands; useful for delta-detection)
  - `tenancy_resolver_disagreement_total`
  - `tenancy_resolver_team_org_missing_total`
- **Acceptance:** the worker reconciler can read these counters to
  alert on a regression in tenancy invariants without re-running the
  diagnostic script.

### A1.2 — Governance inheritance metrics

- **Why deferred:** the helper `getOrganizationIdForTeam()` lands in
  A1; Phase B0 will consume it for retention/legal-hold inheritance.
- **Where:** `services/api/src/services/governance-lifecycle/`.
- **New counters:**
  - `governance_policy_resolved_team_total`
  - `governance_policy_resolved_org_total`
  - `governance_policy_inheritance_fallback_total`
- **Acceptance:** operators can see how many policy lookups fell
  back from team-level to org-level (or had no policy at all).

### A1.3 — Legacy personal-mode evidence migration strategy

- **Why deferred:** A1 leaves `team_id IS NULL` rows owner-scoped.
  Deciding whether to migrate them under each user's personal Team
  is a separate operator decision documented in the A1 runbook §7.
- **Where:** new diagnostic, possibly a new operator-driven
  migration.
- **Acceptance:** the operator can produce a sized population
  estimate, then choose to either migrate (under a separate
  Stage 7) or leave permanently as legacy.

### A1.4 — Reports / VerificationPackages indirect tenancy

- **Why deferred:** Reports and VerificationPackages today resolve
  tenancy via Evidence → Team → Organization. No direct
  `organizationId` column. If a future feature needs an org-scoped
  query without an Evidence join, a follow-up A1-style backfill
  applies.
- **Where:** `services/api/prisma/schema.prisma` (Report,
  VerificationPackage models), and the corresponding services.
- **Acceptance:** decision recorded — keep indirect or add direct
  column with the same FK + CHECK pattern A1 used.

### A1.5 — Stage 7: `evidence.organization_id` NOT NULL

- **Why deferred:** A1 deliberately keeps the column nullable to
  preserve legacy personal-mode evidence. Stage 7 is the migration
  that tightens the column once the population is migrated (A1.3)
  or formally accepted as orphan.
- **Where:** new migration, after A1.3 lands.
- **Acceptance:** `ALTER TABLE evidence ALTER COLUMN
  organization_id SET NOT NULL`; the diagnostic confirms zero NULLs
  before the migration runs.

---

## A2 — PDF signing default-on + Report-vs-Package vocabulary

### A2.1 — Evidence detail page artifact-status polling

- **Why deferred:** A2 lands the API contract and the ArtifactPanel
  consumer. The evidence detail hero page (which has its own polling
  shape via `useArtifactStatus`) does not yet read the new
  `pdfSignature` projection.
- **Where:** `apps/web/app/(app)/evidence/[id]/page.tsx`, the
  `useArtifactStatus` consumer (if any).
- **Acceptance:** the detail hero renders the same signed /
  unsigned badge as ArtifactPanel.

### A2.2 — Reports page (`/reports`) signature columns

- **Why deferred:** A2 lands the bounded vocabulary
  (`ARTIFACT_LABELS`, `PDF_SIGNATURE_STATUSES`) and the API contract.
  Adding distinct columns for "Report PDF signature" + "Package
  manifest signature" to the ReportsIndex table is UI work
  considered out of A2's surgical scope.
- **Where:** `apps/web/components/reports-experience/ReportsIndex.tsx`.
- **Acceptance:** the table shows separate cells with the bounded
  signature status; sortable.

### A2.3 — Public verify page artifact-vs-evidence wording pass

- **Why deferred:** A2 closes the API + worker + ArtifactPanel
  surface. The public verify page already has disclaimers (Phase 1),
  but a small pass to use the canonical `ARTIFACT_LABELS` strings
  there is deferred.
- **Where:** `apps/web/app/verify/[token]/page.tsx`.
- **Acceptance:** the verify page distinguishes "Report PDF
  signature" from "Verification Package manifest signature" from
  "Evidence custody chain integrity" explicitly.

### A2.4 — Operator runbook test: `pdfsig` on a generated PDF

- **Why deferred:** worker integration test infrastructure does not
  invoke `pdfsig` today. The A2 runbook documents the verification
  steps for operators; automating it is a follow-up.
- **Where:** new worker E2E test against a real (or fixture) `.p12`.
- **Acceptance:** test boots a temporary `.p12`, generates a Report
  PDF, runs `pdfsig` (or a node-level signature verifier), asserts
  SIGNED.

### A2.5 — Certificate rotation observability

- **Why deferred:** A2 records `pdf_signer_key_id` on each Report
  row; an operator dashboard that shows the distribution of signer
  keys (so rotations are visible) is follow-up.
- **Where:** `apps/web/app/(app)/admin/page.tsx` or
  `/admin/identity`.
- **Acceptance:** admin sees "Reports signed by `operator_pkcs12_2026`
  in last 7d: N" so a rotation that didn't take effect everywhere is
  visible at a glance.

---

---

## A3 — Backend hardening (operational security + abuse resistance)

### A3.1 — Org-level abuse dashboards

- **Why deferred:** A3 emits bounded SecurityEvents +
  metric counters for every abuse path (analytics, AI chat,
  webhook, verify view). An admin UI tile that surfaces these
  per-org over time is follow-up work.
- **Where:** `apps/web/app/(app)/admin/audit/page.tsx`,
  `services/api/src/routes/admin-audit.routes.ts`.
- **New tile candidates:** webhook signature failures last 24h
  (per provider), AI chat rate-limit hits last 24h (top users),
  analytics rejection rate last 24h.
- **Acceptance:** admin can answer "are we currently under
  abuse?" without grepping logs.

### A3.2 — Verify traffic anomaly dashboards

- **Why deferred:** A3 records `public_verify_viewed_emitted_total`
  + `public_verify_viewed_debounced_total`, and the per-evidence
  `lastPublicVerifyViewAtUtc` already exists. A frontend graph of
  verify traffic per evidence over time is follow-up.
- **Where:** `apps/web/app/(app)/evidence/[id]/page.tsx`
  (existing Verification tab) or a new admin page.
- **Acceptance:** an owner / admin can see a sparkline of verify
  views per evidence without raw SQL.

### A3.3 — Webhook replay forensic tooling

- **Why deferred:** A3 bumps `webhook_replay_rejections_total` and
  emits the `webhook_signature_failure` SecurityEvent with the
  bounded reason. A dedicated forensic surface (correlation by
  IP / provider id / time window) is follow-up.
- **Where:** admin audit page, or a new
  `/admin/security/webhooks` surface.
- **Acceptance:** operator can pivot from a `replay_detected`
  SecurityEvent to its full correlation set in one click.

### A3.4 — AI moderation + escalation tooling

- **Why deferred:** A3 hardens AI chat against rate-limit abuse +
  timeout + cost-guard exhaustion. Per-user moderation (kicking a
  user out of the AI surface for a window after repeated abuse
  signals) is follow-up.
- **Where:** `services/api/src/services/ai/`.
- **Acceptance:** repeated `ai_chat_abuse_signal` events for a
  user within a window auto-suspend their AI surface for a
  bounded period with operator-visible audit.

## B0 — Workspace / Team / Organization Operating Model

### B0.1 — Frontend `ctx.workspace.*` consumer migration

- **Why deferred:** B0 ships the v3 envelope opt-in (server stamps
  `authoritySchemaVersion: 3` when the client sends the header).
  Migrating every `ctx.workspace.*` reader in `apps/web` to consume
  `ctx.activeSpace.*` / `ctx.personalSpace.*` / `ctx.organizations[]`
  is a broad sweep deferred to keep B0 surgical.
- **Where:** every page consuming `PlatformContextEnvelope` in
  `apps/web/app/(app)/**`.
- **Acceptance:** a Phase B0.x test greps for `ctx.workspace.` in
  `apps/web` and fails when matches remain.

### B0.2 — Organization UI tabs

- **Why deferred:** B0 lands the backend write surfaces
  (retention publish, billing rollup) + the read endpoints. The
  organization detail page (`/organizations/[id]`) with its 7-tab
  layout (Overview, Workspaces, Policies, Security, Billing,
  Members, Audit) is frontend work intentionally scoped out.
- **Where:** `apps/web/app/(app)/organizations/[id]/page.tsx`.
- **Acceptance:** all seven tabs render, write surfaces gated on
  org-admin role, audit feed paginated.

### B0.3 — Workspace switcher tooltip + recovery banner — CLOSED BY G0

- **Why deferred:** B0 ships the API surface; the top-bar workspace
  switcher tooltip ("What is a Workspace?" → `/about/trust`) and
  the global `PlatformContextRecoveryAction` banner rendering are
  UI work for a follow-up.
- **Where:** `apps/web/components/app-shell-v2/AppTopbarV2.tsx`,
  `apps/web/components/app-shell-v2/AppShellV2.tsx`.
- **Acceptance:** hover the switcher shows the tooltip; a degraded
  envelope renders a banner with the bounded recovery actions.

### B0.4 — Retention engine consumes the inheritance resolver — CLOSED BY G1

- **Why deferred:** B0 ships the resolver
  (`resolveTeamRetentionPolicy`) but the existing retention engine
  in `services/governance-lifecycle/retention-engine.service.ts`
  still computes deadlines per-team only. A follow-up wires the
  resolver into the engine so org-inherited deadlines apply
  automatically.
- **Where:** `services/api/src/services/governance-lifecycle/retention-engine.service.ts`.
- **Acceptance:** a workspace with no team-level policy but an
  org-inherited template gets the correct deadline on new evidence.

## C0 — Reviewer Console

### C0.1 — Inline reviewer actions on the console

- **Why deferred:** C0 ships the navigation + keyboard layer.
  Reviewer mutations (assign / escalate / decide) still happen
  via the per-workflow inspector at `/reviewer-ops/[reviewId]`.
  Adding inline letter-key actions (`a` to assign, `e` to
  escalate) directly on the row without leaving the console is a
  follow-up — it requires confirmation modals + step-up token
  prompts inside the console, which expands the scope.
- **Where:** `apps/web/components/reviewer-experience/ReviewerConsole.tsx`,
  new modal components.
- **Acceptance:** a reviewer can assign and escalate from the row
  with `a` / `e` and complete the step-up handshake inline.

### C0.2 — Saved-view CRUD inside the console

- **Why deferred:** C0 reads saved views via the aggregator. CRUD
  (create / delete / rename) exists on the per-domain endpoint
  but is not yet wired into the console's saved-views aside.
- **Where:** `apps/web/components/reviewer-experience/ReviewerConsole.tsx`
  + a small modal.
- **Acceptance:** a reviewer can create / delete saved views from
  the console without leaving the page.

### C0.3 — Console aggregator pagination

- **Why deferred:** C0 caps every section at 25 rows. For
  enterprise workspaces with hundreds of queued reviews, the
  console needs deeper drill. The existing per-domain endpoints
  already paginate; the console needs to surface "Open full
  queue" links per tab.
- **Where:** `ReviewerConsole.tsx` (UI), no backend change required.
- **Acceptance:** each tab shows a "View all" link that opens the
  legacy `/reviewer-ops/queue` (or equivalent) with the same
  filter context preserved.

### C0.4 — Reviewer presence + collision indicators

- **Why deferred:** When two reviewers are looking at the same
  workflow simultaneously, the console should warn the second
  one. The conflict-detection backend exists (Phase 25 reviewer
  command service); the UI integration is follow-up.
- **Where:** `ReviewerConsole.tsx`, new presence channel.
- **Acceptance:** a "reviewer X is also viewing this" banner
  appears within a few seconds when conflict is detected.

### C0.5 — Reviewer analytics dashboard

- **Why deferred:** C0 spec explicitly forbade BI-dashboard-style
  analytics. A separate, opt-in analytics surface
  (`/review/analytics`) for ops leads — throughput, SLA breach
  history, reviewer load over time — is recorded here as a
  future product question, NOT a C0 deliverable.
- **Where:** new page.
- **Acceptance:** ops lead can see weekly throughput per reviewer
  without leaving the platform.

### B0.5 — URL flip `/teams` → `/workspaces` (frontend) — CLOSED BY G0

- **Why deferred:** B0 ships the backend `/v1/workspaces/*` aliases
  and the sidebar "Workspaces" label. The frontend page route
  `/teams` is kept for backwards-compat. A future B0.x can introduce
  a `/workspaces` Next.js route + 301 redirect once external links
  are tracked.
- **Where:** `apps/web/app/(app)/teams/` → potentially
  `apps/web/app/(app)/workspaces/`.
- **Acceptance:** new internal links use `/workspaces`; old
  `/teams` URLs redirect cleanly.

### A3.5 — Advanced analytics aggregation

- **Why deferred:** A3 deliberately keeps analytics intake narrow.
  Aggregating the bounded events into operator-facing summaries
  (e.g. "verify views by region over time") is product work
  separate from hardening.
- **Where:** new admin route + new aggregator endpoint.
- **Acceptance:** does NOT relax the A3 allowlist; instead adds
  bounded read-only aggregations over already-collected events.

---

## C1 — Matter Workspace surfacing

### C1.1 — Interactive relationship graph visualisation

- **Why deferred:** C1's Graph tab renders the relationship-role
  counts + total relationship count from the matter envelope.
  A real interactive force-directed graph lives elsewhere
  (Investigation Graph surface).
- **Where:** `apps/web/components/cases-experience/MatterWorkspace.tsx`
  (Graph tab), new shared graph component.
- **Acceptance:** Graph tab embeds an interactive layered view
  driven by the same `sections.relationships` slice; keyboard +
  screen-reader accessible.

### C1.2 — Inline row actions on Matter Workspace tabs

- **Why deferred:** C1 deliberately routes every mutation through
  the classic `/cases/[id]/classic` scroll-spy surface so audit +
  custody + step-up enforcement stay on a single canonical surface.
  Inline tab actions (assign / escalate / place-hold) without
  leaving the tab are valuable for high-throughput reviewers.
- **Where:** `apps/web/components/cases-experience/MatterWorkspace.tsx`.
- **Acceptance:** the audited per-domain endpoints accept the same
  call shape from the Matter Workspace as from the classic view;
  step-up enforcement is preserved end-to-end.

### C1.3 — Per-tab filter + sort affordances — CLOSED BY G2 (Evidence + Timeline tabs wired; remaining tabs accept prop as continuation)

- **Why deferred:** C1 ships fixed top-25-row lists per tab. A
  configurable filter + sort surface (by status, severity, due,
  etc.) is the obvious next iteration.
- **Where:** every tab function in `MatterWorkspace.tsx`.
- **Acceptance:** each table-style tab gains column header sort +
  status-pill filter; URL state preserved on tab switch.

### C1.4 — Per-tab degraded-section retry

- **Why deferred:** C1 surfaces a `degraded` chip on the tab
  navigation but does not offer an in-tab retry. A future surface
  can issue a bounded re-fetch of just the failing section.
- **Where:** `MatterWorkspace.tsx` + matter envelope route
  (per-section re-fetch endpoint).
- **Acceptance:** clicking the chip re-runs the failing section
  without re-fetching the whole envelope.

### C1.5 — Matter Workspace keyboard shortcuts — CLOSED BY G2

- **Why deferred:** C1 ships canonical navigation but no
  keyboard-first acceleration (parity with the Reviewer Console
  from C0 would be `1`-`9` to jump tabs, `j`/`k` within a tab).
- **Where:** `MatterWorkspace.tsx` keyboard handler.
- **Acceptance:** keyboard shortcuts documented in this runbook;
  do not collide with global shortcuts.

---

## C2 — Collaboration surfacing

### C2.1 — Realtime / push delivery for mentions

- **Why deferred:** C2 ships a slow-poll topbar indicator
  (`GET /v1/me/inbox/summary` every 60s) which is sufficient to
  reduce context-switching but is not instant. A future surface
  could push mentions via WebSocket or Server-Sent Events when
  the operator has the app open.
- **Where:** new WebSocket/SSE channel + `InboxIndicator.tsx`
  fallback to push when the channel is healthy.
- **Acceptance:** mention latency drops to sub-second when the
  recipient is online; polling fallback remains for offline /
  flaky network states. Cannot increase server cost per
  connected reviewer beyond a hard ceiling.

### C2.2 — Thread subscriptions

- **Why deferred:** today a reviewer becomes a thread participant
  only by being mentioned, assigned, or by being the resolver. A
  future surface could let reviewers explicitly subscribe to a
  thread without those triggers (e.g., to follow an investigation
  they observe but are not yet a participant in).
- **Where:** new `DiscussionSubscription` model + route + UI
  affordance on the Evidence Discussion panel.
- **Acceptance:** subscription is workspace-scoped; subscribers
  receive inbox items via the same `discussion_mention` /
  `discussion_assigned` rails; no notification storm if a thread
  has many subscribers.

### C2.3 — Reviewer presence + collision indicators

- **Why deferred:** the C0 carryover already flagged this for the
  Reviewer Console. C2 extends the scope: when two reviewers
  open the same thread concurrently, surface a presence
  indicator so the second reviewer knows coordination is in
  flight.
- **Where:** new ephemeral presence service + indicator in
  `EvidenceDiscussionPanel.tsx`.
- **Acceptance:** presence is best-effort, never persisted to
  audit; reviewer identity is workspace-scoped; collisions
  trigger a passive UX hint, never block the second reviewer.

### C2.4 — Cross-workspace inbox digest preferences

- **Why deferred:** today the inbox is in-platform only. An
  optional email-digest preference (e.g., daily rollup of
  unread mentions) would help reviewers operating across
  multiple workspaces.
- **Where:** new preference column on `UserPreferences` + new
  digest worker job + new admin surface to set the cadence.
- **Acceptance:** opt-in only; respects existing email
  communication preferences; digest is workspace-grouped to
  preserve isolation in the email body.

### C2.5 — Inline thread filters + advanced search — CLOSED BY G2

- **Why deferred:** the Evidence Discussion panel today shows the
  full thread list for a single evidence (which is bounded by
  evidence count). The Matter Workspace aggregator caps at 50
  threads. A future surface could add status / severity /
  assignee / kind filters and free-text search across threads.
- **Where:** new search/filter UI in `EvidenceDiscussionPanel.tsx`
  + `MatterWorkspace.tsx` Communications tab; backend search
  endpoint with bounded query DSL.
- **Acceptance:** filters compose with workspace isolation
  (filters can never widen the workspace scope); free-text
  search never returns thread bodies from a different
  workspace.

---

## C3 — Intake polish

### C3.1 — Submission history per intake link

- **Why deferred:** the schema already tracks multiple sessions per
  link (`maxUses > 1`), but the C3 contributor surface renders only
  the current session. A future surface could show "submitted on
  …", "re-uploaded on …", "marked needs-more-info on …" as an
  operational history so the contributor sees their own trail.
- **Where:** intake page (`apps/web/app/intake/[token]/page.tsx`),
  possibly a new `GET /v1/external-intake/:token/history` projection
  that emits ONLY the contributor-safe slice.
- **Acceptance:** history surfaces session timestamps + request
  state transitions; never leaks reviewer notes or workspace
  internals.

### C3.2 — Real-time link expiry countdown

- **Why deferred:** the page today renders the expiry as a static
  date. As the link nears expiry the contributor would benefit
  from an explicit countdown so they can prioritise submission.
- **Where:** intake page header.
- **Acceptance:** countdown updates client-side without polling
  the server; degrades to the static timestamp when JS is
  disabled.

### C3.3 — Reviewer-side "Create new request" surface

- **Why deferred:** Phase 7 backend supports `POST
  /v1/evidence-requests` (create draft) and `POST .../send`. C3
  ships the inspector + Matter Workspace surfacing but not the
  composition flow. Today a reviewer must use API tooling or a
  separate admin route to create a draft.
- **Where:** new authenticated route (e.g.
  `/evidence-requests/new` or a drawer on `/cases/[id]`) that
  composes deliverables + sends the request + reveals the raw
  token exactly once.
- **Acceptance:** the composition flow is workspace-scoped,
  audit-emitting, and never re-shows a revealed token.

### C3.4 — Mobile-native intake wizard

- **Why deferred:** the C3 contributor surface is web-only. A
  Capacitor / native wrapper would let the contributor capture
  fresh evidence (camera + geo) inline without uploading
  pre-existing files — aligning with the `captureAfterRequest`
  flag.
- **Where:** `apps/mobile` + a slim shared intake state machine.
- **Acceptance:** native intake honors the same audit trail and
  workspace isolation; reuses the same consent + step state
  machine.

### C3.5 — Per-deliverable contributor messaging

- **Why deferred:** today the contributor sees a request-level
  re-request banner. A future surface could attach a specific
  reviewer note to a single deliverable (e.g. "This photo is
  blurry, please re-shoot the serial number"), shown only on
  that deliverable's card.
- **Where:** new
  `EvidenceRequestDeliverable.contributorMessage` column (or a
  related table) + projection extension + inspector surface +
  intake page rendering.
- **Acceptance:** the per-deliverable message follows the same
  workspace-internal-vs-contributor-visible discipline as the
  rest of the projection — operators choose visibility per
  message.

---

## B — IA reset

> **Closed by Phase G0** (Operational Convergence Wave 1):
> B.1 (sidebar rewrite), B.2 (breadcrumb expansion), B.3
> (terminology normalization), and B.4 (operations path
> normalization) are now closed. See
> `docs/operations/operational-convergence-runbook.md`. B.5 and
> B.6 remain as separate concerns.

### B.5 — Retire `/cases/[id]/classic` after Matter Workspace gains inline mutation

- **Why deferred:** Phase C1 deliberately preserved the classic
  scroll-spy CaseWorkspace at `/cases/[id]/classic` as the
  mutation surface until the Matter Workspace gains inline
  mutation in C1.2. Phase B does NOT retire it yet for the same
  reason. Once C1.2 lands, the classic route can be removed.
- **Where:** `app/(app)/cases/[id]/classic/page.tsx` + sidebar +
  C1.2 inline mutation work.
- **Acceptance:** the classic route is gone; every reviewer
  action is reachable from the Matter Workspace; redirect added
  for backward compat.

### B.6 — Global operational quick-jump — CLOSED BY G2

- **Why deferred:** the existing command palette (`Cmd+K`) is
  reviewer-console-scoped (Phase C0). A follow-up can extend it
  into a workspace-wide quick-jump that surfaces every Phase B
  group's destinations as fuzzy-search results.
- **Where:** new global command palette wrapper consuming
  `phaseBOperationalGroups.ts` + `ROUTE_REGISTRY`.
- **Acceptance:** Cmd+K from any page surfaces operator-relevant
  destinations grouped by Phase B group; respects workspace
  isolation + capability gating.

### B.2.x — Breadcrumb mount continuation

- **Why deferred (continuation, NOT new):** G0 expanded breadcrumb
  mounts from 2 to 6 nested surfaces. The Evidence detail page
  (2,600-line file) and the Reviewer per-workflow inspector remain
  as continuation work — mechanical, each its own PR-sized scope.
  This is the *same* B.2 deferred item, partially closed by G0.
- **Where:** `apps/web/app/(app)/evidence/[id]/page.tsx`,
  `apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx`.
- **Acceptance:** every nested operational surface anchored by a
  registered route id renders the breadcrumb.

---

## F — Governance UX

### F.1 — Per-evidence lifecycle state badge on Evidence detail — CLOSED BY G1

- **Why deferred:** Phase F surfaces the lifecycle state inside the
  destruction-impact preview, but the Evidence detail page does not
  yet render a dedicated badge + tooltip explaining each lifecycle
  state (`ACTIVE`, `UNDER_REVIEW`, `ON_HOLD`, `RETENTION_LOCKED`,
  `PENDING_DESTRUCTION`, `DESTROYED`, `ARCHIVED`). The information
  exists; the visual surface is missing.
- **Where:** `apps/web/app/(app)/evidence/[id]/page.tsx` sidebar +
  new `LifecycleStateBadge` component.
- **Acceptance:** every evidence detail page shows the current
  lifecycle state with a tooltip explaining what actions are
  blocked while in that state.

### F.2 — Governance summary panel on Matter Workspace — CLOSED BY G1 (component shipped; mount-on-pages is G1.x continuation)

- **Why deferred:** the C1 Matter Workspace surfaces hold counts in
  the Holds tab but doesn't yet emit a unified governance summary
  (inherited policy, hold sources, destruction queue presence,
  export eligibility) at the Overview tile level.
- **Where:** `apps/web/components/cases-experience/MatterWorkspace.tsx`
  Overview tab + Holds tab.
- **Acceptance:** the Matter Workspace Overview surfaces a
  governance summary that mirrors the new
  `RetentionInheritanceSummary` + hold sources for the case's
  evidence.

### F.3 — Export eligibility pre-flight UI — CLOSED BY G1 (component shipped; per-button wiring is G1.x continuation)

- **Why deferred:** the backend `checkExportEligibility` exists and
  is invoked at export time (post-hoc). A pre-flight UI surface
  that warns operators "this evidence is under destruction review
  — export blocked" BEFORE they click Generate would save round
  trips.
- **Where:** Evidence detail page + Matter Workspace Export tab.
- **Acceptance:** before any export button is clickable, the
  eligibility verdict is rendered with the bounded reason from the
  existing backend.

### F.4 — Retention policy conflict surface — CLOSED BY G1

- **Why deferred:** the backend already computes
  `countActivePolicyConflicts(teamId)` but the retention policy
  page does not surface conflicts. Phase F focused on inheritance;
  conflict resolution UX is its own deliberate phase.
- **Where:** `apps/web/app/(app)/governance/retention/page.tsx`.
- **Acceptance:** the retention page warns operators when two
  ACTIVE policies overlap on the same scope, and offers a
  deterministic de-duplication action.

### F.5 — Destruction certificate PDF export

- **Why deferred:** Phase F's certificate viewer downloads canonical
  JSON. A PDF rendering with operator-readable fields would help
  for audit-archive workflows that prefer paper-equivalent records.
- **Where:** new worker job that takes the certificate JSON +
  caveats and emits a PDF; new
  `/v1/governance/destruction-reviews/:id/certificate.pdf`
  endpoint.
- **Acceptance:** the PDF embeds the caveats verbatim, the
  certificate hash, and the lineage hash — no additional claims.

### F.6 — Destruction review deferral auto-reminder

- **Why deferred:** Phase F's preview shows the `deferredUntilUtc`
  field but no notification fires when the deferred date passes.
  Operators may forget about deferred reviews.
- **Where:** new scheduled job + `GovernanceNotification` of kind
  `REVIEW_OVERDUE` keyed on `deferredUntilUtc`.
- **Acceptance:** when a deferred review's date approaches, a
  governance notification is emitted and the workspace inbox row
  appears (via the C2 inbox aggregator).

---

## How to use this registry

When a deferred item is picked up:

1. Open a new phase brief that references the registry id (e.g.,
   "Phase F.1 picks up A1.1 tenancy observability metrics").
2. Delete the entry from this file in the same PR that lands the
   work. Do NOT mark "completed" inline — the registry stays small.
3. If a new deferral arises during a phase, add it here with the
   phase id + date.

Last updated: 2026-05-27 (Phase G3 step-up closure + presence/realtime/collision close).
