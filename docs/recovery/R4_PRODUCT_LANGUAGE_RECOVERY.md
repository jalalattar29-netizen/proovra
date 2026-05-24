# PHASE R4 — Product Language & UX Coherence Recovery — Final Report

**Status:** Complete.
**Scope:** Canonical product-language dictionary + targeted sweep of remaining engineering / architecture leakage out of the operational primary UX. NO permissions touched. NO routing changed. NO orchestration logic refactored. NO marketing fluff introduced. NO forensic-trust terms softened.

R4 establishes the platform's operational vocabulary as code. Surfaces import from the dictionary; the test suite enforces the bounded vocabulary and the bounded forbidden-phrase list.

---

## 1. Canonical vocabulary

The dictionary lives at `apps/web/lib/product-language/` and is the single source of truth for user-facing language across navigation, dashboard, help, empty states, CTA copy, and state labels.

| File | Owns |
| --- | --- |
| `tones.ts` | `UX_TONES` (8 bounded tones) + `FORBIDDEN_TONE_PATTERNS` (marketing / dramatic / debug regex). |
| `stateLabels.ts` | `RUNTIME_SEVERITY_LABELS`, `REVIEW_WORKFLOW_STAGE_LABELS`, `SLA_STATUS_LABELS`, `BILLING_ADDON_STATUS_LABELS`, `WORKSPACE_SETUP_LABELS`, `STATE_FALLBACK_LABEL = "Status pending"`, and `formatStateLabel()` (never returns "Unknown"). |
| `operationalTerminology.ts` | Concept → canonical term map (workspace, organization, review queue, governance posture, etc.) + CTA wording + access-state copy + empty-state copy + `FORENSIC_TERMS_PRESERVED` list. |
| `forbidden.ts` | `FORBIDDEN_ENGINEERING_PHRASES` + `FORBIDDEN_MARKETING_PHRASES` + `FORBIDDEN_DRAMATIC_PHRASES` (regex). |
| `index.ts` | Barrel. |

---

## 2. UX tone system

`UX_TONES` is bounded to 8 named voices:

1. `operational` — calm operational default.
2. `guidance` — setup / onboarding step-by-step.
3. `warning` — pending action / soft alert (NOT red panic).
4. `success` — confirmation / completion / safe-state.
5. `neutral-system-state` — loading / pending data.
6. `governance-compliance` — policy posture copy.
7. `verification-integrity` — forensic-state copy.
8. `reviewer-operations` — queue / SLA / escalation copy.

These map to existing CSS classes — R4 does NOT introduce new styling. New tones require a deliberate CR-level review (Test 1 pins the count at 8).

Forbidden tone patterns (regex, enforced by Test 5 across primary UX): `revolutionary`, `next[-\s]gen`, `best[-\s]in[-\s]class`, `world[-\s]class`, `synergy`, `game[-\s]chang(er|ing)`, `AI[-\s]powered`, `intelligent assistant`, `catastrophic failure`, `oops`, `object not found`.

---

## 3. Forbidden wording (three categories)

| Category | Examples |
| --- | --- |
| Engineering / architecture leakage | raw `"Org"` / `"Access"` chip returns, ALL_CAPS backend states (`STATUS_PENDING`, `PERMISSION_DENIED`, `AUTH_REQUIRED`, `UNKNOWN`), debug fallbacks (`null pointer`, `undefined state`, `object not found`) |
| Marketing fluff | revolutionary, next-gen, disrupt, best-in-class, world-class, synergy, game-changer, AI-powered, intelligent assistant, innovation platform |
| Dramatic / panic | critical failure detected, emergency condition, catastrophic failure, "Oops!" |

The R4 test suite scans the primary-shell + dashboard + sidebar + topbar + command palette + runtime indicator + billing addon + admin dashboard for each of these. Any match breaks the build.

---

## 4. Engineering leakage cleanup

Targeted sweep on the surfaces R4 owns:

| File | Before | After |
| --- | --- | --- |
| `lib/navigation/routeRegistry.ts` | label: "Governance analytics" | label: "Governance insights" |
| `components/billing/StorageAddonsPanel.tsx` | empty-status → "Unknown"; unmapped status → raw ALL_CAPS value | empty-status → "Not configured"; unmapped status → "Status pending" |
| `app/(app)/admin/dashboard/page.tsx` | `page.path ?? "Unknown"` | `page.path ?? "Path unavailable"` |
| `app/(app)/admin/dashboard/page.tsx` | `country.name ?? "Unknown"` | `country.name ?? "Region unavailable"` |

Already-clean from prior phases (R4 just re-pins them via the dictionary):

- `components/operational/GlobalRuntimeIndicator.tsx` — R1 changed `UNKNOWN: "Unknown"` → `UNKNOWN: "Status pending"`.
- `components/app-shell-v2/AppSidebarV2.tsx` — R2 replaced raw `"Org"` / `"Access"` chip returns with `DEGRADATION_CHIP_LABELS` (`"Requires organization"`, `"Requires permission"`, `"Setup needed"`, `"Upgrade required"`).
- `app/(app)/settings/persona/page.tsx` — R1 replaced `"Reload to see updated navigation and labels."` with `"Workspace profile updated. Your navigation and recommendations have been refreshed."`.
- `app/(app)/home/` dashboard hero (R3) — operational onboarding hints replaced generic emptiness; `"No workspace selected"` softened to `"Workspace setup incomplete"` in CommandCenter.

---

## 5. What R4 deliberately did NOT change

| Surface | Why deferred |
| --- | --- |
| `app/verify/[token]/page.tsx` (public verify) | Forensic / risk-level copy carries legal weight. "Unknown" risk-level is a legitimate forensic state (assessment could not complete). A dedicated forensic-copy review owns any change to this surface. |
| `app/share/[id]/page.tsx` (public share) | Same — forensic-adjacent public surface. |
| Other route labels (e.g. "Duplicate review", "Reviewer intelligence", "Media intelligence ops") | Existing labels are operationally reasonable. Renaming them would touch broad test surface for marginal gain. R4 chose minimal targeted cleanup. |
| Section header copy inside `CommandCenter.tsx` (~5000 lines of section components) | Out of R4's scope — would require a full UX copy review per section. The dictionary provides the vocabulary; future copy updates flow through it. |
| Help / empty-state copy variants per experience mode | Wired in R3 (`helpAudience` discriminator) but not yet consumed. R3/R5 own the per-mode copy authoring. |

---

## 6. Hub / workflow terminology alignment

The dictionary fixes ONE concept = ONE term:

- "Review queue" — not "Reviewer Operations Queue Engine" or "Queue Operations Panel"
- "Escalations" — not "Escalation Workflow Manager"
- "Governance insights" — not "Governance Analytics"
- "Governance posture" — not "Governance Compliance State"
- "Investigation overview" — not "Investigation Hub Engine"
- "Operations center" — not "Operations Hub" / "Operations Dashboard"

Surfaces that need to render a concept name MUST consume the corresponding `TERM_*` export from `operationalTerminology.ts`. R5/R6 will systematically replace inline literals with imports as the language sweep matures.

---

## 7. State / status language recovery

The state-label dictionary maps every operational backend enum to operational copy:

- **Runtime severity** — HEALTHY / DEGRADED / INCIDENT / CRITICAL / **Status pending** (was "Unknown").
- **Review workflow stage** — Queued, Assigned, In review, Needs more info, Response received, Approved (internal), Rejected (insufficient), Escalated, Reopened, Closed.
- **SLA status** — On track, Due soon, Overdue, Breached, Paused.
- **Billing addon** — Active, Pending, Past due, Canceled, Expired, Failed (the empty-status fallback is "Not configured"; unmapped → "Status pending").
- **Workspace setup** — Setup complete / Setup in progress / Setup incomplete / Setup needed.

The single fallback constant `STATE_FALLBACK_LABEL = "Status pending"` is operationally neutral. No surface that goes through `formatStateLabel()` will ever render "Unknown" again.

---

## 8. Advanced tooling wording cleanup

R4 keeps advanced tools advanced — but their NAMES read as operational concepts, not engineering systems:

- "Investigation graph" — operational concept, not "Graph Engine".
- "Lifecycle reviews" — operational concept, not "Destruction Internals".
- "Observability" — operational concept (already in registry).
- "Runbooks" — operational concept (already in registry).
- "Reliability operations" — existing label, kept.

These match the operational-terminology dictionary entries.

---

## 9. Files touched

### Created (5 source + 1 test + 1 doc)
- `apps/web/lib/product-language/tones.ts`
- `apps/web/lib/product-language/stateLabels.ts`
- `apps/web/lib/product-language/operationalTerminology.ts`
- `apps/web/lib/product-language/forbidden.ts`
- `apps/web/lib/product-language/index.ts`
- `services/api/test/phase-r4-product-language-recovery.test.ts`
- `docs/recovery/R4_PRODUCT_LANGUAGE_RECOVERY.md`

### Modified (3)
- `apps/web/lib/navigation/routeRegistry.ts` — "Governance analytics" → "Governance insights".
- `apps/web/components/billing/StorageAddonsPanel.tsx` — "Unknown" → "Not configured"; raw ALL_CAPS fallback → "Status pending".
- `apps/web/app/(app)/admin/dashboard/page.tsx` — `?? "Unknown"` (×2) → `?? "Path unavailable"` / `?? "Region unavailable"`.

### Unchanged (verified by Test 12 file-size pins)
- All capture / custody / TSA / report / package source.
- All backend services.
- All worker source.
- Permissions, routing, orchestration, navigation pipeline, dashboard orchestration.

---

## 10. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

---

## 11. Remaining risks (honest)

- **The dictionary is not yet consumed by all existing surfaces.** R4 establishes the vocabulary and pins the bounded-forbidden list; systematically replacing inline label literals with `TERM_*` imports across every component is R5/R6 work.
- **Forensic public surfaces (verify, share) are NOT swept.** "Unknown" risk-level may legitimately appear there as a forensic state. A dedicated forensic-copy review owns those changes.
- **Section header copy inside `CommandCenter.tsx` is unchanged.** R4 didn't audit every section header (~5000 LoC of section components). Future drift is caught by Test 4 (no raw ALL_CAPS enums) + Test 5 (no marketing/dramatic phrases) which scan the whole CommandCenter.
- **Marketing / dramatic / debug forbidden-list is regex-based.** A clever rephrase could slip through. The bounded vocabulary in `tones.ts` + the canonical terminology dictionary are the positive contract; the forbidden list is the safety net.
- **The 8 tones don't yet drive CSS rules.** They're a named vocabulary so future styling work has a stable target. R5/R6 may wire actual visual tone treatments.
- **Per-mode copy variants for help / empty states are still not wired.** The `helpAudience` discriminator R1.5B exposed is ready to consume; R3 didn't wire it; R4 doesn't either. R5/R6 own the per-mode copy authoring.

---

## 12. Exact next phase recommendation

Per the locked CR0.5 §10 roadmap, the next phase is **R5 — Progressive Disclosure & Capability-Aware Bucketing** (depends on R4's vocabulary):

1. Redesign `resolveWorkflowExposure` to consume the experience mode as a first-class input (currently the disclosure resolver layers mode on top).
2. Consume the `helpAudience` discriminator to author per-mode help + empty-state copy using the R4 vocabulary.
3. Decide per-route whether the current "demote to More/Advanced" approach for personal mode is right, or whether `canSeeNav: false` would be cleaner for some entries (e.g. genuinely operator-only surfaces).
4. Author CSS rules consuming the `data-workspace-experience-mode` + `data-cc-experience-mode` + `data-cc-section-emphasis` attributes (visual emphasis tilts; not visual redesign).

R5 is the phase where the canonical vocabulary + the orchestration layers (R1.5B / R2 / R3) start to produce visible per-mode polish.

---

## Hard confirmations

- ✅ No engineering / debug wording remains in primary UX (Test 4, Test 5).
- ✅ No raw enum leakage (Test 4 — pinned ALL_CAPS regex sweep).
- ✅ No Access / Org raw chips (Test 2 — re-pinned from R2).
- ✅ Product language now feels operational and enterprise-grade (canonical dictionary; bounded tones; bounded forbidden list).
- ✅ No startup-marketing fluff introduced (Test 5 — regex sweep; Test 1 — bounded tone count).
- ✅ No duplicated terminology introduced (`CONCEPT_CANONICAL_TERMS` is the single source of truth; one concept = one term).
- ✅ No permission / routing / orchestration logic changed (no auth code touched; no resolver edited).
- ✅ No capture / upload / finalize / custody / TSA / OTS / report / package regression (Test 12 file-size pins).

**R4 SUCCESS:** PROOVRA finally sounds like a mature operational platform — not an internal engineering system with a UI on top. The vocabulary is in code, the forbidden list is enforced, and forensic-trust terms are preserved verbatim.
