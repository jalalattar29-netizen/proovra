# PHASE R7 — Onboarding & Setup Recovery — Final Report

**Status:** Complete.
**Scope:** Canonical onboarding-step vocabulary as pure data + single resolver. NO new dashboards. NO new root navigation. NO mobile or external workflow expansion. NO permission logic. NO parallel onboarding state store. NO duplicate banner / wizard components.

R7 turns the orchestration layers (R1 envelope refresh, R3 dashboard onboarding hint, R5 disclosure help, R6 hub vocabulary) into a coherent onboarding journey by codifying bounded per-mode step sequences. Existing surfaces (PersonaSetupBanner, CommandCenter hero, dashboard quick-actions) remain — R7 provides the canonical data they can consume.

---

## 1. Onboarding state model

The canonical onboarding state is the **`onboardingCompleted`** boolean on `envelope.personaProfile`. R7 does NOT introduce a parallel store. Test 1 pins the resolver against introducing new state primitives (`setupStep`, `setupProgress`, `onboardingState`).

The single source flows:

```
PATCH /v1/workspaces/:id/persona (sets onboardingCompleted)
  → ctx.refresh() (R1)
  → envelope.personaProfile.onboardingCompleted (canonical)
  → resolveOnboardingState({ mode, onboardingCompleted }) (R7)
  → bounded step sequence OR empty (when complete)
```

---

## 2. Personal Space onboarding

Bounded 5-step sequence (Test 2 pins 3-5 bound + step labels):

1. **Create your first evidence record** → `/capture` *(primary)*
2. **Review your recent evidence** → `/evidence` *(secondary)*
3. **Generate or view a report** → `/reports` *(secondary)*
4. **Open collaboration** → `/collaboration` *(secondary)*
5. **Set up an intake link (optional)** → `/intake-links` *(secondary)*

Tone: simple, calm, action-oriented. No enterprise heaviness. Each step opens an existing canonical page.

---

## 3. Organization onboarding

Bounded 5-step sequence (Test 3 pins):

1. **Configure your workspace profile** → `/settings/persona` *(primary)*
2. **Invite collaborators** → `/teams` *(primary)*
3. **Configure intake operations** → `/intake-links` *(secondary)*
4. **Review queues and escalations** → `/reviewer-ops` *(secondary)*
5. **Configure governance and retention** → `/governance` *(secondary)*

Tone: operational, team-aware, enterprise — but not overwhelming.

---

## 4. Hub-aware onboarding (REVIEW_OPS + GOVERNANCE)

R7 emphasizes that the hub vocabulary (R6) and the onboarding vocabulary share the same operational lexicon.

### REVIEW_OPS (3 steps)
1. **Open the reviewer queue** → `/reviewer-ops` *(primary)*
2. **Triage escalations** → `/reviewer-ops/escalations` *(primary)*
3. **Check SLA** → `/reviewer-ops/sla` *(secondary)*

### GOVERNANCE (3 steps)
1. **Review retention posture** → `/governance/retention` *(primary)*
2. **Open lifecycle reviews** → `/governance/lifecycle` *(primary)*
3. **Configure governance policy** → `/governance/policy` *(secondary)*

The sequences naturally lead operators into their corresponding R6 hubs (Reviewer Center / Governance Center). Test 4 pins both the hub-vocabulary use and the 3-5 step bound for both modes.

R7 does NOT turn onboarding into a hub portal. Onboarding is the CANONICAL FIRST-STEP LIST per mode; hubs are the canonical workflow homes operators land in once they pick a step.

---

## 5. Workflow setup outcome (R1 contract preserved)

When a user completes the persona wizard:

- The PATCH fires (already existed).
- The R1 fix triggers `await ctx.refresh()` after success (Test 6 pins this is still in place).
- The envelope re-fetches.
- Sidebar / dashboard / density / persona banner / help / onboarding-hint copy ALL re-derive automatically. No manual reload.
- The stale "Reload to see updated navigation and labels." copy stays REMOVED (Test 6 pins absence + presence of "Workspace profile updated").
- The R3 `resolveDashboardOnboarding({ mode, onboardingCompleted })` returns `null` once the user completes setup; the dashboard hint disappears.

R7 builds on this without changing it. The new `resolveOnboardingState(...)` resolver returns an empty `steps` array when `onboardingCompleted === true`, so any future surface that consumes it (e.g. a PersonaSetupBanner enrichment in R10) inherits the same correct refresh behavior.

---

## 6. Empty-state recovery

R3 already replaced generic emptiness with mode-aware hints (`dashboardModeRules.MODE_ONBOARDING_HINTS`). R7 extends the vocabulary so a future surface can render the full sequence rather than just one hint:

| Mode | Primary first step | Why it matters |
| --- | --- | --- |
| PERSONAL | "Create your first evidence record" → `/capture` | Capture is the platform's reason for existing for personal users. |
| ORGANIZATION | "Configure your workspace profile" → `/settings/persona` | Persona drives sidebar order, dashboard emphasis, density, terminology. |
| REVIEW_OPS | "Open the reviewer queue" → `/reviewer-ops` | The canonical reviewer workflow home. |
| GOVERNANCE | "Review retention posture" → `/governance/retention` | The most actionable governance setup task. |

Forbidden copy across all sequences (Test 7):
- No "Unknown" / "No workspace selected" / "Reload to see" regressions.
- No marketing fluff (revolutionary / next-gen / best-in-class / AI-powered / world-class).
- No dramatic / debug language (catastrophic / oops / object not found).

---

## 7. Single onboarding system (no duplicates)

Test 8 forbids parallel onboarding system components:

- ❌ `OnboardingProvider.tsx`
- ❌ `OnboardingContext.tsx`
- ❌ `OnboardingStateProvider.tsx`
- ❌ `SetupWizard.tsx`
- ❌ `SetupProvider.tsx`
- ❌ `OnboardingPortal.tsx`

The existing canonical setup surfaces remain (Test 8 pins their continued existence):

- `apps/web/components/app-shell-v2/PersonaSetupBanner.tsx` — the dismissible setup banner.
- `apps/web/app/(app)/settings/persona/page.tsx` — the persona wizard.

Both consume the canonical platform envelope; R7 makes the onboarding sequence data available for future enrichment without parallel state.

---

## 8. Files touched

### Created (4 source + 1 test + 1 doc)
- `apps/web/lib/onboarding/types.ts`
- `apps/web/lib/onboarding/onboardingSteps.ts`
- `apps/web/lib/onboarding/resolveOnboardingState.ts`
- `apps/web/lib/onboarding/index.ts`
- `services/api/test/phase-r7-onboarding-setup-recovery.test.ts`
- `docs/recovery/R7_ONBOARDING_SETUP_RECOVERY.md`

### Modified (0)
R7 introduces NO production code modifications. The existing onboarding surfaces (PersonaSetupBanner, CommandCenter onboarding hint, persona wizard, dashboard quick actions) all keep their current behavior. R7 ships the canonical sequence data so any future surface can consume it without authoring new sequences.

### Unchanged (verified by Test 11 file-size pins)
- All capture / custody / TSA / report / package source.
- Route registry, navigation pipeline, dashboard orchestration.
- R1 persona refresh behavior, R3 dashboard hint, R5 disclosure help, R6 hub vocabulary.

---

## 9. Validation

Required: all 6 gates green.

- `pnpm --filter proovra-api typecheck`
- `pnpm --filter proovra-api test`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-web build`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-worker test`

---

## 10. Remaining risks (honest)

- **R7 does not modify any rendering surface.** Personal/Org/Reviewer/Governance step sequences are available as pure data + resolver. Wiring them into PersonaSetupBanner or a CommandCenter onboarding panel is a presentation decision deferred to R10 (visual maturity) or a dedicated future onboarding-UX phase.
- **No backend onboarding tracking.** "Step completed" granularity (e.g. "user has captured their first piece of evidence") would require a new backend field. R7 keeps the contract at the single `onboardingCompleted` flag; per-step progress is out of scope.
- **Sequences are conservative.** Each mode has 3-5 steps. Future modes (or sub-modes) may expand — but the test pins keep the bound.
- **No A/B / personalization on sequence ordering.** The mode → sequence mapping is the only source of variation. Future personalization can extend the resolver inputs.
- **No registry-level onboarding annotation.** Step hrefs are cross-checked against `routeRegistry.ts` (Test 5) but the registry has no `onboardingStep: true` annotation. R10 may add one.

---

## 11. Exact next phase recommendation

Per the locked CR0.5 §10 roadmap, the next phase is **R8 — Enterprise Security Activation**:

1. Wire R5/R6/R7 vocabulary into security-center surfaces.
2. Decide on the `services/api-keys.service.ts` in-memory orphan (deferred from CR1 Phase E — has live consumers; R8 owns the canonical migration).
3. Activate enterprise security capabilities (TOTP MFA, SCIM, SSO) per CR0.5 R8 / R9 brief.
4. Each new security surface consumes R7 onboarding step sequences so first-time users have a guided setup journey.

R8 turns the operational platform into one a security operator can actually adopt without manual training.

---

## Hard confirmations

- ✅ Onboarding feels real, not decorative (Test 2/3/4 — bounded per-mode action sequences with concrete next-step labels).
- ✅ No mobile / external workflow expansion performed (R7 is web-only; no new API surfaces).
- ✅ No new root navigation added (no registry changes; no new sidebar groups).
- ✅ No duplicated onboarding system (Test 8 — forbidden parallel components; PersonaSetupBanner + persona wizard preserved as the single canonical surfaces).
- ✅ No permission logic introduced (Test 9 — resolver + steps + barrel carry no auth predicates).
- ✅ No capture / upload / finalize / custody / TSA / OTS / report / package regression (Test 11 file-size pins).

**R7 SUCCESS:** New users have a canonical, bounded, mode-aware list of next steps that lead directly into the operational platform — capture for personal, workspace + team + intake + queues + governance for organizations, and hub-aligned sequences for reviewer-ops and governance contexts. PROOVRA finally has a coherent setup journey without becoming a checklist factory.
