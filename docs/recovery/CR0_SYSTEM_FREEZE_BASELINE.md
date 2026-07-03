# CR0 — System Freeze & Safety Baseline

**Status:** ACTIVE — this baseline is in force until CR1 closes out the legacy purge.
**Owner:** Recovery roadmap (CR0–CR8 + R1–R11).
**Generated:** Phase CR0 (after Phase 39 platform audit).

This document records the canonical recovery baseline for PROOVRA. It exists
because the product shell became incoherent during rapid backend expansion,
and future recovery phases need an unambiguous reference for what is canonical,
what is legacy, what is safe to refactor, and what must not be touched without
deliberate work.

CR0 does NOT fix the product. It establishes the conditions under which the
later phases can fix it safely.

The companion guardrail tests live at:
`services/api/test/phase-cr0-system-freeze-baseline.test.ts`

---

## 1. Current state — one-paragraph summary

PROOVRA's **forensic substrate is genuinely production-grade**: the custody
chain is hash-chained and lock-serialized; the evidence finalization pipeline
is correct end-to-end (streaming SHA-256, Ed25519 sign, TSA stamp, atomic
finalize guard, custody events, downstream report enqueue); the verification
package is a real signed bundle with an offline verifier. The **enterprise
identity stack is sophisticated where implemented** (RBAC, step-up, hash-chained
admin audit, session inventory, trusted devices, adaptive auth) but
**incomplete on protocols** (SAML schema-only, SCIM PATCH non-compliant, MFA
SMS-only). The **frontend has shipped less than half of what the backend
exposes** — the external-review console is entirely UI-orphaned (935 LoC of
backend), the SMS-send button on intake links is not wired, the SSO login
button doesn't exist, ~70% of `ops.routes.ts` and ~85% of governance routes
have no UI consumer. The **worker has scaffolding masquerading as capability**
— 8 of 16 declared queues have no real producer, the DLQ pattern is theater,
all schedulers are `setInterval` in a single worker process. The **product
shell** has accumulated noise across 13 Phase 38 iterations: 47 of 72 app
pages are PageRouteGate-wrapped; the rest are mostly admin / redirect / legacy.
**Phase 38 architectural foundations are correct and consistently honored**.
The recovery work ahead is consolidation + UI parity + protocol completion,
NOT new architecture.

---

## 2. Canonical systems (safe to build on)

These systems are the canonical implementations. Other code should consume
THESE, not their legacy siblings.

| System | Canonical source | Consumers | Risk |
|---|---|---|---|
| Route registry | `apps/web/lib/navigation/routeRegistry.ts` | Sidebar, command palette, All Tools, PageRouteGate | LOW |
| Access resolver | `apps/web/lib/navigation/routeAccessResolver.ts` | PageRouteGate, sidebar, command palette | LOW |
| Workflow exposure resolver | `apps/web/lib/navigation/workflowExposureResolver.ts` | Sidebar group buckets | LOW |
| Page gate | `apps/web/components/navigation/PageRouteGate.tsx` | 47 app pages | LOW |
| All Tools surface | `apps/web/app/(app)/tools/page.tsx` | Operator discoverability | LOW |
| Command palette | `apps/web/components/navigation/CommandPalette.tsx` | Cmd+K global | LOW |
| Active workspace resolver | `apps/web/lib/platform-context/useTenantModel.ts` (`useActiveSpaceId`) | All migrated pages | LOW |
| Persona/workflow profile | `apps/web/lib/platform-context/workflowProfile.ts` + `usePersonaProfile.ts` | Sidebar, dashboard, capture, ContextualHelp | LOW |
| Capability registry | `apps/web/lib/platform-context/types.ts` (`CapabilityMap`); `useCan` | Page rendering | LOW |
| Workflow safety notice | `apps/web/components/navigation/WorkflowSafetyNotice.tsx` | Command palette, persona wizard, All Tools, capture | LOW |
| Contextual help | `apps/web/components/contextual-help/ContextualHelp.tsx` + `lib/platform-context/workflowHelp.ts` | 9 surfaces (capture/evidence/cases/reports/governance/reviewer-ops/ops/teams/search) | LOW |
| App shell + sidebar | `apps/web/components/app-shell-v2/AppShellV2.tsx`, `AppSidebarV2.tsx` | Every authenticated page | LOW |
| Dashboard / CommandCenter | `apps/web/components/command-center/CommandCenter.tsx` | `/home` | MEDIUM (5000 LoC; still on `useTeamWorkspaceGate`) |
| Capture flow (web) | `apps/web/app/(app)/capture/page.tsx` (1429 LoC) + `_lib/` | `/capture` | HIGH — see §5 |
| Evidence finalization | `services/api/src/services/evidence-complete.service.ts` (1251 LoC) | `POST /v1/evidence/:id/complete` | HIGH — DO NOT REFACTOR |
| Custody chain | `services/api/src/services/custody-events.service.ts` (api side) + `services/worker/src/custody-events.ts` (worker side, duplicate) | 128 call sites | HIGH — duplicate logic |
| Reports v2 | `services/worker/src/report-v2/` + `pdf/signPdf.ts` | `report` queue processor | MEDIUM |
| Verification package | `services/worker/src/verification-package.ts` (3240 LoC, single file) | report processor | MEDIUM — see §5 |
| Public verify | `apps/web/app/verify/[token]/page.tsx` (7404 LoC, single file) | unauthenticated | MEDIUM — see §5 |
| Governance lifecycle | `services/api/src/services/governance-lifecycle/` (lifecycle-orchestrator, destruction-review, retention-engine) | Governance UI + worker | LOW |
| Reviewer ops engine | `services/api/src/services/reviewer-ops/` (reviewer-operations-engine, escalation-engine, sla-policy, workload) | `/reviewer-ops` | LOW |
| Workflow intake links | `services/api/src/routes/workflow-intake-links.routes.ts` + service + token service | `/intake-links` operator + `/intake/[token]` public | LOW (backend) / HIGH-GAP (frontend) |
| External review grants | `services/api/src/routes/external-review.routes.ts` + service | ZERO UI consumers | LOW (backend) / ENTIRELY ORPHANED (frontend) |
| Notifications | `services/api/src/services/notifications/` (Resend-only) + retry sweeper | `notifications/page.tsx` | LOW |
| Integrations: API keys | `services/api/src/services/integrations/api-keys.service.ts` (DB-backed) | `/integrations` | LOW (orphan sibling exists — see §3) |
| Integrations: Webhooks | `services/api/src/services/integrations/webhooks.service.ts` + `webhook-dispatcher.ts` | `/integrations` | LOW (orphan sibling exists — see §3) |
| Audit log | `services/api/src/services/platform-audit-log.service.ts` (`AdminAuditLog`, hash-chained) | `admin/audit` | LOW (legacy tombstone exists — see §3) |
| Worker queues | `services/worker/src/queue.ts` + 15 worker registrations in `index.ts` | API + scheduled | MEDIUM (DLQ + per-queue isolation gaps) |
| Runtime readiness | `services/api/src/services/runtime-readiness/` | Not consumed by UI | LOW (backend) / ORPHAN (frontend) |
| Workflow profile codes | `WorkflowProfileCode` enum + `WORKFLOW_PROFILE_CODES` + `DESCRIPTORS` | UI-only mapping over internal `WorkspacePersonaProfile` enum | LOW |

---

## 3. Legacy / duplicate systems (CR1 purge targets)

These are the duplicate or dead systems that CR1 must purge. CR0 does NOT
delete them — it only adds guardrails preventing further drift.

### 3a. Service-level orphans (still loaded in `server.ts` — silent fallback risk)

| Legacy file | Status | Canonical replacement | Removal plan |
|---|---|---|---|
| `services/api/src/services/api-keys.service.ts` | In-memory `Map`-backed orphan; plain SHA-256 hash; hardcoded rate limits | `services/api/src/services/integrations/api-keys.service.ts` (DB-backed, HMAC, scopes, usage log) | CR1: confirm no imports remain; delete file. |
| `services/api/src/services/webhook.service.ts` | In-memory orphan with its own `Map`s and event enum | `services/api/src/services/integrations/webhooks.service.ts` + `webhook-dispatcher.ts` | CR1: same. |
| `services/api/src/services/audit.service.ts` | In-memory `Map`-backed audit; superseded but file ships ~360 LoC of dead code | `services/api/src/services/platform-audit-log.service.ts` (`AdminAuditLog`, hash-chained, verifiable) | CR1: confirm no imports; delete. |
| `services/api/src/routes/audit.routes.ts` | No-op shim per audit | `services/api/src/routes/admin-audit.routes.ts` | CR1: delete after confirming no frontend hits `/v1/audit/*`. |

### 3b. Route-level orphans (registered at `server.ts`)

| Route file | Registered at | Status | Removal plan |
|---|---|---|---|
| `webhook.routes.ts` (per-org webhooks, 7 endpoints, 657 LoC) | `server.ts:511` | Fully redundant with `integrations.routes.ts` which the UI actually uses | CR1: delete file + import. UI consumes the integrations path. |
| `ops-seed.routes.ts` (`/v1/ops/seed/reviewer-ops`) | `server.ts:469` | Seed routes shipping in production with NO env guard | CR1: wrap in `if (env.NODE_ENV !== "production")` OR delete entirely. |
| `security.routes.ts` (`/v1/security/*`) | (registered) | Orphan — `security-center/page.tsx` calls `/v1/identity-security/*` instead | CR1: confirm zero consumers, delete. |
| `runtime-readiness.routes.ts` (4 GETs) | (registered) | No frontend consumer matched | CR1: either expose to ops UI or delete. |

### 3c. Page-level legacy redirects (CR1 review for removal)

| Page | Purpose | Removal plan |
|---|---|---|
| `apps/web/app/(app)/dashboard/page.tsx` | Redirect `/dashboard` → `/home` (Phase 32.8B) | CR1: confirm no external bookmarks; consider removing in CR1 or moving to `next.config.js` redirects. |
| `apps/web/app/(app)/archive/page.tsx` | Redirect `/archive` → `/evidence?filter=archived` | Same. |
| `apps/web/app/(app)/deleted/page.tsx` | Redirect | Same. |
| `apps/web/app/(app)/locked/page.tsx` | Redirect | Same. |
| `apps/web/app/(app)/operations/page.tsx` | Redirect `/operations` → `/ops` | Same. |
| `apps/web/app/(app)/review/page.tsx` | Redirect `/review` → `/reviewer-ops` | Same. |
| `apps/web/app/(app)/reviewer-ops/policy/page.tsx` | Redirect to governance/policy | Same. |
| `apps/web/app/(app)/security/page.tsx` | Redirect → `/security-center` | Same. |
| `apps/web/app/(app)/share/[id]/page.tsx` | Explicit deprecation stub ("Share Link Page Not Active") | CR1: delete or rewire to real share flow (R7). |
| `apps/web/app/(app)/identity/page.tsx` | Phase 17 legacy identity console (workspace-scoped) | CR1: fold into `/admin/identity` OR gate as `<PageRouteGate routeId="...">`. |
| `apps/web/app/(app)/review/operations/page.tsx` | Phase 13 legacy review-ops queue | CR1: fold into `/reviewer-ops` OR gate. |

### 3d. Schema-level dual state systems (do NOT remove — track for consistency)

These dual systems exist by design but require coordination. CR0 flags them
for awareness; they should NOT be merged without a dedicated migration phase.

- **Evidence state**: `EvidenceStatus` (intake pipeline) + `EvidenceLifecycleState` (governance). Orchestrator carries consistency burden.
- **Retention**: `Team.retentionPolicy` (legacy 3-value enum, effectively dead) + `EvidenceRetentionPolicy` (Phase 27 versioned).
- **Session ledger**: `AuthenticatedSession` (denormalized mirror) + `RevokedSession` (deny-list).
- **Audit logs**: `AdminAuditLog` (active, hash-chained) + `audit.service.ts` tombstone (CR1 delete).
- **Custody events**: API `custody-events.service.ts` + worker `custody-events.ts` — **same logic, written twice**. CR1 must extract to shared package.

### 3e. Schema enum values likely unused (CR1 cleanup candidates)

Documented by the Phase 39 schema audit. CR1 should grep each before removal.

- `NotificationChannel.PUSH` (no push provider)
- `RetentionPolicy.YEAR_1`, `RetentionPolicy.YEAR_5` (legacy enum, vestigial)
- `EvidenceLifecycleState.UNDER_REVIEW` (orchestrator transitions appear unused)
- `WorkflowIntakeSessionStatus.ABANDONED` (no sweep job writes it)
- `CustodyEventType.UPLOAD_STARTED` (schema-noted "kept for backward compat")
- `EvidenceRequestType.REPLACEMENT_FILE`, `EvidenceRequestType.WITNESS_STATEMENT` (no targeted consumers)
- `EvidenceRequestRecipientMode.PSEUDONYMOUS_SOURCE` (not differentiated from `ANONYMOUS_SOURCE`)
- `RetentionPolicySource.EVIDENCE_OVERRIDE`, `RetentionPolicySource.CASE_OVERRIDE` (only `WORKSPACE_DEFAULT` / `WORKFLOW_TEMPLATE` set by code)
- `WorkspaceCategory.JOURNALISM | RESEARCH | FIELD_OPERATIONS` (inert labels; not mapped in capture-intake templates)

---

## 4. Orphan / underused backend capabilities (CR2 parity targets)

This is the input to CR2 (Frontend/Backend Parity Recovery). CR0 does NOT
implement parity. Each row records what's there + the priority for CR2.

| Capability | Backend? | Frontend? | Workflow E2E? | Risk | Priority for CR2 |
|---|---|---|---|---|---|
| Workflow intake links — CREATE | ✓ | ✓ (`/intake-links`) | ✓ | LOW | DONE |
| Workflow intake links — **SMS/WhatsApp send** | ✓ (`/send`) | ✗ ZERO calls | ✗ — operator hand-copies URL | **HIGH** — blocks entire insurance/legal external flow | **CRITICAL** |
| Workflow intake links — email send | ✗ (only SMS/WhatsApp) | ✗ | ✗ | HIGH | HIGH |
| Workflow intake links — per-link access log | partial (custody only) | ✗ no UI | partial | MEDIUM | MEDIUM |
| Workflow intake links — IP allowlist enforcement | column exists, not enforced | n/a | n/a | MEDIUM | MEDIUM |
| External review grants — issue/list/revoke | ✓ (935 LoC) | ✗ ZERO UI | ✗ | **CRITICAL** marquee enterprise gap | **CRITICAL** |
| External review grants — reviewer access SPA | ✓ (`POST /access/:token`) | ✗ no `/external-review/access/[token]` route | ✗ | **CRITICAL** | **CRITICAL** |
| Reviewer auto-assignment | ✗ engine "no auto-assignment"; workload only "suggests" | n/a | ✗ | **CRITICAL** competitor table stakes | **CRITICAL** |
| Reviewer SLA — business hours / holiday calendars | ✗ wall-clock only | n/a | ✗ false positives on weekends | HIGH | HIGH |
| Workflow instances — map-evidence/waive | ✓ | partial (generic POST) | partial | MEDIUM | MEDIUM |
| Evidence requests | ✓ | only inline panel | partial — no inbox view | MEDIUM | MEDIUM |
| Notifications — SMS via Twilio (intake link send) | ✓ | ✗ no operator surface | ✗ | HIGH | HIGH (covered by intake-link send) |
| Notifications — push channel | enum exists, no provider | n/a | n/a | LOW | LOW (defer) |
| Notifications — email custom domain DKIM/SPF | ✗ Resend defaults only | n/a | n/a | MEDIUM | MEDIUM |
| Governance — legal hold enforcement | ✓ | ✓ | ✓ — destruction reviews respect holds | LOW | DONE |
| Governance — 4-eyes hold release | ✗ single approver + boolean ack | partial | partial | MEDIUM | MEDIUM |
| Governance — destruction certificate signing | hash only, not signed | partial display | partial | HIGH | HIGH |
| Governance — SOC2 evidence pack one-button export | ✗ | ✗ | ✗ — pieces exist (chain verify, lifecycle ledger, destruction certs), nothing assembles them | HIGH | HIGH |
| Retention — automatic execution | ✓ reaper running | ✓ partial UI | ✓ | LOW | LOW |
| Webhooks — delivery log viewer | ✓ `GET /:id/deliveries` | ✗ no UI | partial | MEDIUM | MEDIUM |
| Webhooks — event catalog | 11 events shipped (missing review decisions, custody/anchor, member/role, billing, SCIM) | n/a | partial | HIGH | HIGH |
| Webhooks — SCIM provisioning events | ✗ | n/a | n/a | MEDIUM | MEDIUM |
| API keys — usage log viewer | ✓ `ApiCredentialUsageLog` | ✗ no UI | partial | MEDIUM | MEDIUM |
| API keys — per-credential rate limit ENFORCEMENT | only logged | n/a | partial | HIGH | HIGH |
| API keys — hardening fields (expiry, IP allowlist, rotation_required, environment) | ✓ backend | ✗ UI omits | partial | MEDIUM | MEDIUM |
| SCIM — Users LIST/GET/POST/DELETE | ✓ | n/a (server-to-IdP) | ✓ | LOW | DONE |
| SCIM — PATCH compliance (only `replace active` works; others 501) | ✗ | n/a | ✗ Okta cert will fail | **CRITICAL** | **CRITICAL** |
| SCIM — discovery (`/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes`) | ✗ | n/a | ✗ Azure/Okta wizards fail | **CRITICAL** | **CRITICAL** |
| SCIM — sync health UI | ✓ tokens manageable | ✗ no sync confirmation | partial | MEDIUM | MEDIUM |
| SSO — OIDC | ✓ | partial (no login button) | partial | HIGH | HIGH |
| SSO — SAML 2.0 | ✗ schema-only (`samlMetadataJson` stored, never parsed) | n/a | ✗ Azure AD federations need SAML | **CRITICAL** | **CRITICAL** |
| SSO — login button on `/login` initiator | n/a | ✗ NO `/v1/auth/sso/*` callsite | ✗ entire enterprise SSO unreachable | **CRITICAL** | **CRITICAL** |
| SSO — group→role mapping via OIDC claims | ✗ SCIM-only | n/a | ✗ | HIGH | HIGH |
| MFA — Twilio SMS OTP | ✓ | ✓ | ✓ | n/a | DONE |
| MFA — TOTP (authenticator app) | ✗ | n/a | ✗ blocks SOC2-strict | **CRITICAL** | **CRITICAL** |
| MFA — WebAuthn / passkey / FIDO2 | ✗ | n/a | ✗ blocks FedRAMP/CJIS | **CRITICAL** | **CRITICAL** |
| MFA — recovery codes | ✗ | ✗ | ✗ | HIGH | HIGH |
| Session — admin revoke (single + all-for-user) | ✓ | partial (admin only) | ✓ | LOW | DONE |
| Session — end-user self-service ("my sessions") | ✓ backend | ✗ no UI | ✗ | MEDIUM | MEDIUM |
| Audit log — hash-chained `AdminAuditLog` | ✓ | partial (admin only) | partial | LOW | DONE |
| Audit log — per-tenant chain verify | ✗ chain is global | ✗ | ✗ workspace admins cannot verify | HIGH | HIGH |
| Audit log — periodic chain verification background job | ✗ on-demand only | n/a | ✗ | HIGH | HIGH |
| Audit log — SIEM forwarder (HEC/Kinesis/syslog) | ✗ zero hits | n/a | ✗ F500 IT requirement | **CRITICAL** | **CRITICAL** |
| Audit log — per-workspace export | ✓ CSV (admin) | partial | partial | MEDIUM | MEDIUM |
| Runtime readiness | ✓ backend (`runtime-readiness.routes.ts`) | ✗ ORPHAN | ✗ | LOW | LOW (CR1 decide: expose or delete) |
| Ops — workflows / bulk-actions / causality / DLQ-replay / mitigation | ✓ (~70% of `ops.routes.ts`) | ✗ ~30% UI coverage | ✗ | HIGH | HIGH (CR2 + CR3) |
| DLQ pattern | ✗ scaffolding only (`*-dlq` queues empty; "real DLQ" = `getFailed()`) | n/a | ✗ illusion of resilience | HIGH | HIGH (CR3) |
| Verification packages — generation | ✓ | ✓ (gated by export-governance) | ✓ | MEDIUM | DONE (CR4 decomposition pending) |
| Verification packages — offline verifier | ✓ `verify-package.mjs` + public key + canonical manifest | ✓ in zip | ✓ | LOW | DONE |
| Report artifacts — per-workspace templates | ✗ one fixed v2 template | n/a | ✗ | MEDIUM | MEDIUM |
| Public verify | ✓ | ✓ but 7404-LoC monolith without progressive disclosure | partial | MEDIUM | MEDIUM (CR4) |
| Public verify — glance-verdict for non-technical | ✗ | ✗ | ✗ | HIGH | HIGH |
| Public verify — QR on `verify.html` | ✗ (QR is in PDF only) | partial | partial | LOW | LOW |
| Mobile capture — multipart + background uploads | ✗ single-PUT only | partial (Expo MVP) | ✗ OOMs on 4K video | **CRITICAL** | **CRITICAL** (R7) |
| Mobile — workflow intake link redemption | ✗ no `/intake/[token]` mobile route | ✗ | ✗ | **CRITICAL** | **CRITICAL** (R7) |
| Mobile — SSO/SAML/MDM | ✗ | ✗ | ✗ enterprise procurement blocker | **CRITICAL** | **CRITICAL** (R7) |
| Mobile — biometric reauth | ✗ (despite `expo-secure-store` installed) | ✗ | ✗ | HIGH | HIGH (R7) |
| Mobile — audio capture | ✗ (web has it) | ✗ | partial | MEDIUM | MEDIUM (R7) |
| Mobile — workflow templates / checklist | ✗ | ✗ | ✗ | MEDIUM | MEDIUM (R7) |

---

## 5. Dangerous flows (do NOT refactor blindly)

These flows have correctness invariants that are easy to break and hard to
re-verify without a browser / real upload. Each row records the safe handling
strategy.

| Flow | Source | Risk | Safe strategy |
|---|---|---|---|
| Capture page UI restructure | `apps/web/app/(app)/capture/page.tsx` (1429 LoC) | File refs / blob URLs / camera state / session draft persistence will silently break with the wrong structural change. Browser verification not available in source-only sessions. | CR5: extract child components ONE AT A TIME with browser-verified parity. Do NOT batch-restructure. |
| Upload + finalization | `services/api/src/services/evidence-complete.service.ts` (1251 LoC) | One Prisma transaction with advisory lock, streaming SHA-256, Ed25519 sign, TSA stamp, atomic finalize guard, custody events, downstream enqueue. Reordering breaks integrity. | DO NOT REFACTOR. Treat as appliance. |
| Camera / audio / video capture | `apps/web/app/(app)/capture/page.tsx` + `_hooks/useCaptureCamera.ts` + `useCaptureAudioRecorder.ts` + `useResumableUploads.ts` | Device APIs (getUserMedia, MediaRecorder) are fragile. JS MD5 fallback on mobile OOMs at 4K. | R7 mobile rebuild: add streaming hash + multipart + background uploads. Do NOT touch the camera state machine without browser verification. |
| Custody events | `services/api/src/services/custody-events.service.ts` + `services/worker/src/custody-events.ts` (duplicate logic) | Append-only; advisory lock + monotonic sequence + hash chain. **Two implementations.** | CR1: extract to `@proovra/shared/custody` package; both API and worker import from one source. |
| TSA / OTS timestamping | `services/api/src/services/timestamp.service.ts` (shells out `openssl ts` + `curl`) + `services/worker/src/ots.service.ts` (shells out `ots`) | TSA call is **synchronous inside the finalize transaction**, 20s timeout, failure silently absorbed. OTS shipped-but-off (`ANCHOR_MODE=ready` default). | CR3 reliability: async-out + retry + backfill + 2nd TSA provider. ON-by-default for OTS. |
| Report generation | `services/worker/src/report-v2/build-report-pdf.ts` (orchestrator over 13 section modules) | PDF signing gated by `PDF_SIGNING_ENABLED`; verification-package built synchronously inside report processor (saturation risk on 2-slot concurrency). | CR3: extract verification-package to its own queue. CR4: decompose `verification-package.ts` (3240 LoC) into per-section modules. |
| Verification package generation | `services/worker/src/verification-package.ts` (3240 LoC) | Real signed bundle; Ed25519 manifest signature; offline verifier embedded. Decomposing carries regression risk. | CR4: extract per-section with byte-for-byte parity tests against a snapshot bundle. |
| Public verify page | `apps/web/app/verify/[token]/page.tsx` (7404 LoC, single client file) | Live signature re-verification, mismatch explanations, tamper signaling. Renders deep technical fields. | CR4: extract presenter components; add progressive disclosure layer (R5). |
| Workspace setup / onboarding | `apps/web/app/(app)/settings/persona/page.tsx` + `lib/platform-context/PlatformContextProvider.tsx` | Personal Space bootstrap + active-space resolution + persona profile write. Personal/Org tri-tier model. | R1: any change to onboarding must preserve `is_personal` flag + active-space contract. |
| Persona / workflow persistence | `services/api/src/services/workspace-persona.service.ts` + `routes/workspace-persona.routes.ts` | Stored per active workspace; drives UI ordering, NOT capabilities. | R1: any change must keep workflow profile UX-only — never grant or deny access. |
| Dashboard active workspace resolution | `apps/web/components/command-center/CommandCenter.tsx` (still uses `useTeamWorkspaceGate`) | Section rendering reads `workspace.scope`/`role`/`memberCount` for personal-vs-team branching. 5000 LoC component. | R3: migrate to `useActiveSpace` + per-branch verified. |
| Sidebar / navigation generation | `apps/web/components/app-shell-v2/AppSidebarV2.tsx` | Phase 38.9-canonicalized to `ROUTE_REGISTRY` + resolvers. Good. | LOW risk. Adding routes to registry is the safe path; do NOT add a parallel nav source. |
| Tenant access checks | `services/api/src/services/access/`, `requireEvidenceAccess`, `requireCaseAccess`, etc. | Anti-enumeration via 404 vs 403; per-resource ACL enforcement. | DO NOT touch without dedicated tenant-isolation review. |
| Billing / plan gates | `services/api/src/services/billing-enforcement.service.ts` | Hard checks on evidence creation, report generation, package generation, storage growth. Returns 402/409. **Seat enforcement appears soft.** | R8 enterprise: harden seat enforcement on invite path. |

---

## 6. Product coherence baseline (R1–R6 input)

These are the user-facing coherence problems CR0 documents without fixing.

**Root navigation overload**
- Sidebar now has Primary Workflows + Workspace + Operations + Governance & Compliance + More/Advanced + All Tools. 6 root groups. Personal-space users see Operations + Governance even when most items inside are org-only. R2 will collapse.

**Internal labels exposed to users**
- `data-cc-role={role}` rendered as visible chip in CommandCenter hero (`Role · OWNER`). Internal capability-keyspace term.
- `roleLabel: "Owner"` and `roleLabel: WorkspaceRole` surface to users on multiple panels.
- Persona profile chip displays raw enum: `Persona · INDIVIDUAL` (CommandCenter hero, around line 181). Should display the workflow descriptor label.
- "Personal workspace" vs "Team workspace" appears as `data-reviewer-scope` chip in console headers — internal architecture leaking to operators.
- Dashboard band group keys (`"case-ops"`, `"deep-watch"`, etc.) emitted as `data-section-band` attribute — internal but invisible to users.

**"Unknown" fallback usage**
- Dashboard renders `role || "Unknown"` (defensive). R4 should standardize to a documented empty-state label or display nothing.
- `relTime()` and other helpers fall back to `"Unknown"` in many places. R4 sweep.

**Raw "Org" / "Access" wording**
- Sidebar uses "Workspace" / "Operations" — clean. No raw "Org" group label found at root.
- Several sub-page badges use "Access" terminology (e.g., access-reviews page heading). Acceptable in admin context.

**Personal user sees enterprise clutter**
- Reviewer Ops, Governance, External Review (when wired), Reports → all render in nav for personal users with capability-denied panels. R1.5B should segment personal vs org experiences.

**Advanced tools exposed too early**
- All Tools surface exposes every capability-visible registry entry. Personal users see ~40 entries including `governance.policy`, `review.escalations`, etc. R5 progressive disclosure should hide advanced unless onboarding completed.

**Dashboard state incoherence**
- CommandCenter still on `useTeamWorkspaceGate` (last enterprise component on legacy hook).
- Section render uses `getPersonaSectionOrder` client-side, but priority strip + IntersectionObserver scrollspy share the same order. Coherent within the dashboard, incoherent with the rest of the app (persona changes do not propagate to other surfaces visually).

**Onboarding disconnected from product state**
- `/settings/persona` wizard writes `WorkspacePersonaProfile`; UI immediately picks up changes via context refresh. But there's NO post-wizard onboarding flow (e.g., "great, here's your first capture") — wizard dumps user back where they came from. R1 should add a continuation.

**Workflow setup not affecting product experience deeply enough**
- Workflow profile reorders sidebar + dashboard + capture templates + provides ContextualHelp text. Does NOT change dashboard section layout meaningfully beyond strip ordering (sections still render the same set; only order changes). R3 dashboard orchestration should add per-workflow section relevance scoring.

**Backend terminology in pages**
- "Operational Pressure" / "Custody Integrity Watch" / "Queue Congestion" — these are operator-tongue terms that read as backend internals to a new user. R4 product language cleanup should reframe.
- "Reviewer Ops" / "Ops Center" — abbreviations that read as internal labels.
- "WorkflowIntakeLink" appears in copy on some operator surfaces. Should always be "intake link" to users.

---

## 7. Guardrails added (CR0 source-contract tests)

File: `services/api/test/phase-cr0-system-freeze-baseline.test.ts`

| Guardrail | What it blocks |
|---|---|
| Page-gate coverage | New `app/(app)/**/page.tsx` files without `<PageRouteGate>` and without a documented exemption with reason + revisitPhase. |
| Exemption hygiene | Exemption list entries with empty reason or empty revisitPhase. |
| Sidebar root-group vocabulary bounded | New `title:` literals outside `{Primary workflows, Workspace, Operations, Governance & Compliance, All Tools, More / Advanced}`. |
| No raw "Org" / "Access" primary labels | New `title: "Org…"` or `title: "Access…"` in `AppSidebarV2.tsx`. |
| No new user-facing "Unknown" in primary shell | New `"Unknown"` literal in primary shell files without an inline `// CR0-allowed: <reason>` comment. |
| Server.ts mount inventory frozen | New `devSeedRoutes` / `fixtureRoutes` / `debugSeedRoutes` / `testOnlyRoutes` registrations in `server.ts`. (`opsSeedRoutes` + `webhookRoutes` are pinned as acknowledged CR1 debt.) |
| CR0 baseline document existence | This document must exist + be non-trivial. |
| Phase 38 architectural locks reaffirmed | `ROUTE_REGISTRY` + `resolveRouteAccess` + `resolveWorkflowExposure` consumed by sidebar; `PageRouteGate` consumes `resolveRouteAccess`; `WORKFLOW_SAFETY_STATEMENT` retains canonical text. |

These guardrails are intentionally conservative. They block drift INTO chaos
without blocking legitimate recovery work in CR1–CR8 / R1–R11.

---

## 8. What is frozen (do not change in CR0)

- **No new features.** No new dashboards, panels, AI surfaces, governance modules, workflow systems, navigation items.
- **No new root sidebar groups.** Adding one requires CR6 (Product Orchestration Layer).
- **No new backend routes.** Diagnostic endpoints permitted only with clear justification + env-guard.
- **No new workflow / persona access gates.** Workflow is UX-only forever.
- **No risky refactors:** capture, evidence finalization, custody, TSA/OTS, report generation, verification package, public verify, tenant isolation, billing enforcement — all FROZEN.
- **No deletion of working business functionality.** Legacy systems documented in §3 are flagged for CR1 purge; CR0 does not delete them.
- **No fake legal / forensic claims.** Positive-overclaim lock holds (`legally admissible`, `tamper-proof`, `court-ready`, `proves the truth`, `authenticity guaranteed`).
- **No reintroduction of `useTeamWorkspaceGate`** outside the existing allow-list (4 consumers as of CR0: declaration + 2 re-exports + `CommandCenter.tsx` + `ops/page.tsx`).

---

## 9. What must not be changed before later phases

This section documents the phase-ownership of each known risk so that future
contributors do not accidentally collapse them.

| Subject | Owning phase | Rationale |
|---|---|---|
| Delete legacy orphan services (`api-keys.service.ts`, `webhook.service.ts`, `audit.service.ts`, `webhook.routes.ts`) | **CR1** | Live grep needed before delete; CR0 only flags. |
| Delete legacy page redirects (`dashboard/page.tsx`, `archive/page.tsx`, etc.) | **CR1** | External bookmark check needed first. |
| Wrap admin/* pages or gate via `platform.admin` routeId | **CR1** | Decision: gate or document permanent exemption. |
| Remove `ops-seed.routes.ts` from production registration | **CR1** | Env-guard or delete. |
| Extract custody hash logic to shared package | **CR1.5** (observability prerequisite) | Drift risk between API + worker copies. |
| Schema enum cleanup (PUSH, YEAR_1/5, UNDER_REVIEW, ABANDONED, …) | **CR1** | Verify zero consumers via codebase scan; migration to drop. |
| Migrate CommandCenter off `useTeamWorkspaceGate` | **R1 / R3** | 5000 LoC, deep `workspace.scope` branching, needs careful per-section verification. |
| Capture page restructure (move controls inline near items) | **CR5** | Browser verification needed; HIGH risk to camera/upload. |
| Capture page extract child components | **CR5** | One at a time; parity tests. |
| Verification package decomposition (3240 LoC → modules) | **CR4** | Byte-for-byte parity test against snapshot bundle. |
| Verify page decomposition (7404 LoC → presenters) | **CR4** | Same approach. |
| Progressive disclosure on verify page (glance-verdict) | **R5** | Reviewer UX work; coordinate with CR4 decomposition. |
| Wire SMS-send button on intake links | **CR2** | Backend ready; 1-day frontend wire-up. |
| External-review console + reviewer SPA | **CR2** | 935 LoC of orphaned backend. |
| SSO login button on `/login` | **CR2** | Backend SSO works; frontend has no entry point. |
| TOTP / WebAuthn / passkey MFA | **R8** | Enterprise identity hardening. |
| Full SAML 2.0 implementation | **R8** | Schema-only today. |
| SCIM PATCH compliance + discovery endpoints | **R8** | Okta cert depends on this. |
| SIEM audit forwarding | **R8** | F500 IT requirement. |
| Per-tenant audit chain verify endpoint | **R8** | Workspace admin self-service. |
| Reviewer auto-assignment | **R9** | Enterprise operations activation. |
| SLA business-hours / holiday calendars | **R9** | Same. |
| TSA failure retry + async + backfill | **CR3** | Reliability hardening. |
| OTS Bitcoin anchor ON by default | **CR3** | Same. |
| Real DLQ pattern with replay UI | **CR3** | Same. |
| Mobile multipart + background uploads + streaming hash | **R7** | Mobile + external workflow hardening. |
| Mobile workflow-intake-link redemption | **R7** | Same. |
| Mobile SSO/SAML/MDM | **R7** | Same. |
| Notification template branding + custom-domain DKIM | **R8** | Enterprise identity & security. |
| Bulk-export API + OpenAPI spec + SDK + Postman | **R9** | Enterprise operations activation. |
| Slack / ServiceNow / Salesforce / Jira / Zapier connectors | **R9** | Same. |
| BYOK / customer-managed encryption / data residency | **R9** | Same. |
| Design-system consolidation | **R9.5 / R10** | After functional gaps closed. |
| Browser-verified responsive + a11y | **R11** | Browser tooling required. |

---

## 10. Recovery roadmap — ordered next phases

The ordering below is deliberate. Each later phase depends on the safety
established by earlier ones.

| # | Phase | Purpose | Depends on |
|---|---|---|---|
| 1 | **CR0** *(this phase)* | System freeze + safety baseline | — |
| 2 | **CR1** Legacy & Duplicate System Purge | Delete orphans flagged in §3 (services, routes, redirects); extract custody hash to shared; gate admin/*; enum cleanup | CR0 |
| 3 | **CR1.5** State & Orchestration Observability | Add per-phase health probes, per-tenant queue + worker telemetry export, custody-chain periodic verifier | CR1 |
| 4 | **R1** Product State Recovery | Onboarding continuation, persona-write feedback loop, post-wizard flow | CR1 |
| 5 | **R1.5B** Workspace Experience Segmentation | Personal vs org segmentation; advanced surfaces hidden for personal users until promoted | R1 |
| 6 | **R4** Product Language Cleanup | Eliminate user-facing "Unknown", "Persona · INDIVIDUAL", "Role · OWNER", backend-tongue labels | R1, R1.5B |
| 7 | **CR6** Product Orchestration Layer | Single orchestrator that consumes registry + workflow + state to drive sidebar/dashboard/capture coherently; supersedes ad-hoc per-component wiring | R1.5B, R4 |
| 8 | **R2** Navigation Collapse | Reduce 6 sidebar groups to 4; relocate advanced under disclosure | CR6 |
| 9 | **R5** Progressive Disclosure | All Tools, capture panels, verify page — show advanced on intent only | R2, R4 |
| 10 | **R6** Operational Hubs | Consolidate ops + governance + reviewer-ops into hub patterns with unified info architecture | R2, R5 |
| 11 | **R3** Dashboard Orchestration | CommandCenter migration off `useTeamWorkspaceGate`; per-workflow section relevance scoring; section layout reorder reflects workflow priority | R6 |
| 12 | **CR2** Frontend/Backend Parity | Wire SMS-send button, external-review console, SSO login button, webhook delivery log viewer, API-key usage log, SCIM sync health, evidence-requests inbox | CR0 §4 inventory |
| 13 | **CR5** Capture Safety Extraction | Extract CaptureSessionPanel children one at a time with parity tests; reduce panel stack to ≤2 default | R5 |
| 14 | **CR3** Reliability Hardening | Async TSA + retry + backfill; OTS ON by default; real DLQ + replay UI; per-queue process isolation; BullMQ repeatable schedulers | CR1.5 |
| 15 | **CR4** Verify Decomposition | Split `verification-package.ts` (3240 LoC) + `verify/[token]/page.tsx` (7404 LoC) into module trees with snapshot parity tests | CR3 |
| 16 | **R7** Mobile & External Workflow Hardening | Mobile multipart + background uploads + streaming hash; mobile intake-link redemption; mobile SSO/SAML/MDM | CR2 |
| 17 | **R8** Enterprise Identity & Security | TOTP + WebAuthn + passkey MFA; full SAML 2.0; SCIM PATCH compliance + discovery; SIEM forwarder; per-tenant audit chain verify; recovery codes | CR2 |
| 18 | **R9** Enterprise Operations Activation | Reviewer auto-assignment; SLA business hours; 4-eyes hold release; signed destruction certificate; custodian hold-notification workflow; SOC2 evidence pack; OpenAPI + SDK + Postman; per-credential rate limit enforcement; bulk-export API | R7, R8 |
| 19 | **R9.5** Design Primitive Consolidation | Extract design tokens, component library; unify badges/toolbars/headers/spacing across surfaces | R9 |
| 20 | **R10** Design System & Visual Maturity | Apply design system across surfaces; remove visual fragmentation | R9.5 |
| 21 | **R11** Browser QA & Accessibility | Real browser/device verification; aXe / screen-reader walkthroughs; manual QA checklist execution | R10 |
| 22 | **CR8** Pilot & Operator Readiness | Pilot onboarding kit, operator runbooks, SOC2 evidence pack assembly, customer rollout docs | R11 |

---

## 11. Honest residual risks (post-CR0)

1. **CR0 only documents — does not fix.** All capability gaps from Phase 39 remain. The platform is no more enterprise-ready after CR0 than before. The benefit is that subsequent fixes can be safer.

2. **The exemption list will drift unless reviewed each phase.** As CR1 removes legacy pages, those entries must move out of the exemption list. As new pages land, they must be added to the test-pinned `DOCUMENTED_EXEMPTIONS` array (or wrapped). Reviewer discipline required.

3. **CR0 guardrails are source-contract tests, not runtime gates.** A determined contributor can bypass them by adding to the exemption list without justification. The tests check that the exemption list HAS a reason + revisitPhase; they do not check that the reason is good. Code review carries that load.

4. **The "no production seed routes" check pins the current acknowledged debt** (`opsSeedRoutes`, `webhookRoutes`) so future seed-route additions stand out. The acknowledged debt itself is CR1's removal target.

5. **The sidebar root-group vocabulary lock is a leaf-level check.** It catches new `title:` literals in the sidebar source. It does NOT prevent someone from rendering a parallel navigation panel elsewhere (e.g., in CommandCenter). CR6 (Product Orchestration Layer) addresses that root cause.

6. **The "Unknown" check is scoped to 5 primary-shell files.** It does NOT scan every file. Wider sweeps belong to R4.

7. **No browser verification exists.** All visual coherence work depends on R11 actually being executed with browser tooling. Until then, claims about UX are necessarily limited to source-contract evidence.

---

## Confirmation checklist (CR0)

- [x] No new features added.
- [x] No new root navigation added.
- [x] No new workflows added.
- [x] No new governance systems added.
- [x] No new AI surfaces added.
- [x] No risky capture refactor performed.
- [x] No custody/report/package/TSA/OTS regression introduced.
- [x] Recovery baseline document exists at `docs/recovery/CR0_SYSTEM_FREEZE_BASELINE.md`.
- [x] Source-contract guardrails added at `services/api/test/phase-cr0-system-freeze-baseline.test.ts`.
- [x] Next phases ordered + documented in §10.

End of CR0 baseline.
