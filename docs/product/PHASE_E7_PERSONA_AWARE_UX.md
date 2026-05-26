# PHASE E7 — Persona-Aware UX

**Status:** CLOSED
**Closure date:** 2026-05-26
**Test suite:** `services/api/test/phase-e7-persona-aware-ux.test.ts`
**Canonical persona content:** `packages/shared-evidence-presentation/src/persona-content.ts`
**Frontend bridge:** `apps/web/lib/platform-context/personaRecommendedActions.ts`
**Onboarding extension:** `apps/web/lib/onboarding/resolveOnboardingState.ts` (persona is now optional + additive)

---

## 1. Intent

Phase E7 makes PROOVRA's product surface adapt to the active workspace persona without forking into separate apps, weakening permissions, or duplicating pages. The platform's truth, custody, integrity, and authorization models are unchanged. Persona only influences:

- ordering (dashboard band priority, capture template recommendation)
- labels (cases → matters / claims / investigations, evidence → material, report → verification brief, etc.)
- summaries (persona-specific dashboard intro, onboarding next-step hints)
- recommended workflows + empty-state copy
- default templates

Persona MUST NOT influence:

- permissions or authorization (capability registry has zero persona dependency)
- capture / upload / finalize / custody / signing / timestamping
- report / package generation
- the truth of any verification claim
- the legal posture documented by the Trust Center

---

## 2. Entry-gate report

Before any code change, three parallel audit agents inventoried the backend persona model, the existing frontend persona consumers, and the highest-leverage injection points. The audit found that the persona infrastructure is **already substantial**:

| Surface | Pre-E7 state |
|---|---|
| `WorkspacePersonaProfile` model | Already shipped (Phase 38). 7 persona codes; `primaryProfile` + `secondaryUseCases[]` + `operationalDensityPreference` + `featurePriorityOverrides[]` + `onboardingState`. |
| `persona-profile.service.ts` | Read + default only. Documented hard contract: **NEVER grants capabilities, NEVER fails envelope, tenant-scoped, bounded.** |
| `workspace-persona.routes.ts` | GET + PATCH. PATCH requires `identity.org_policy.manage` (TEAM_MANAGE). Audit-emitting. |
| `PlatformContextEnvelope.personaProfile` | Optional field carrying full persona shape + `source: "default" \| "stored"`. |
| `capability-registry.ts` | Takes `(scope, role, plan, isPlatformAdmin)`. **No persona parameter.** Verified by source-grep and signature test. |
| `usePersonaProfile()` | Hook exists at `apps/web/lib/platform-context/usePersonaProfile.ts`. |
| `useTerminology()` | Exists; cases page already renders persona-aware "Matters" / "Claims" / "Investigations" via this. |
| `getPersonaSectionOrder()` | Exists at `apps/web/lib/platform-context/personaSectionOrder.ts`; dashboard already consumes it. |
| `orderTemplatesByWorkflow()` | Exists at `apps/web/app/(app)/capture/_lib/workflowTemplateOrder.ts`; capture page already reorders templates by persona-workflow mapping. |
| `personaEmptyStates.ts` | Per-persona OVERRIDES for 8 surfaces (evidence / cases / reports / ...). |
| Onboarding resolver | Did NOT consume persona (mode + onboardingCompleted only). **Gap closed in E7.** |

**No deferred items** target E7. Phase E7 is purely additive consolidation: it canonicalizes the persona contract into one shared module, adds bridging helpers, makes onboarding persona-aware as an optional extension, and writes the contract tests that pin the invariants.

---

## 3. Bounded persona contract

The single source of truth lives at `packages/shared-evidence-presentation/src/persona-content.ts`. It exports:

- `PERSONA_CODES` — the seven canonical enum codes (matches backend `WORKSPACE_PERSONA_PROFILES`):
  `INDIVIDUAL | LAWYER | INSURANCE | INVESTIGATOR | JOURNALIST | ENTERPRISE_COMPLIANCE | ADMIN_OPERATOR`
- `PERSONA_DISPLAY_LABEL` — user-facing label per code.
- `PERSONA_DOMAIN_GROUP` — coarse grouping (`individual | operator | admin`) for navigation disclosure.
- `PERSONA_CASE_TERM` — Case / Matter / Claim / Investigation label per code.
- `PERSONA_CONTENT` — full content record per code:
  - `summary` (1 sentence)
  - `primaryJobs` (3–6 jobs-to-be-done bullets)
  - `recommendedTemplates` (priority-ordered capture-template slugs)
  - `dashboardPriority` (priority-ordered dashboard section ids)
  - `recommendedNextStep` (single "do this first" line)
  - `emptyStateHints` (per-surface keys → string)
- `PERSONA_CONTENT_FORBIDDEN_PATTERNS` — 18 regex patterns blocking marketing-claim shapes ("legally admissible", "claim proven", "AI confirmed", "compliance certified", "forensically certified", etc.).

### Persona ↔ display vocabulary

| Code | Display | Case term | Domain group |
|---|---|---|---|
| INDIVIDUAL | General / individual | Case | individual |
| LAWYER | Legal practitioner | Matter | operator |
| INSURANCE | Insurance team | Claim | operator |
| INVESTIGATOR | Investigations team | Investigation | operator |
| JOURNALIST | Newsroom / field reporting | Case | individual |
| ENTERPRISE_COMPLIANCE | Compliance / governance | Case | operator |
| ADMIN_OPERATOR | Enterprise administrator | Case | admin |

### Persona contract — the hard rules

Persona MAY affect:

| Aspect | Mechanism |
|---|---|
| Dashboard band order | `PERSONA_CONTENT[code].dashboardPriority` + the existing `getPersonaSectionOrder()` resolver |
| Capture template priority | `PERSONA_CONTENT[code].recommendedTemplates` + the existing `orderTemplatesByWorkflow()` resolver |
| Page titles (Cases ↔ Matters / Claims / Investigations) | `useTerminology()` already in place |
| Empty-state copy | `getPersonaEmptyStateHint(code, surface)` + the existing `personaEmptyStates.ts` overrides |
| Onboarding next-step hint | Phase E7 addition — optional `personaCode` on `OnboardingResolverInput` |

Persona MUST NOT affect:

| Aspect | Why |
|---|---|
| Permissions / authorization | Capability registry has zero persona dependency. Verified by source-grep + signature test. |
| Capture / upload / finalize / custody / signing / timestamping | Frozen since CR0. Trust Center pins. |
| Report / package generation | Frozen since CR0. |
| Authentication / MFA / SAML / SCIM | Out of scope. |
| Routing (which routes exist) | `routeRegistry.ts` is the authoritative source. Persona never re-grants visibility. |
| Trust claims | E5 boundary applies to ALL surfaces including persona copy. |

---

## 4. Dashboard persona emphasis (already shipped, now codified)

The dashboard CommandCenter consumes `getPersonaSectionOrder()` (Phase 38) which prioritises sections per persona. The web-side `PERSONA_DASHBOARD_PRIORITY` map and the shared `PERSONA_CONTENT[*].dashboardPriority` list are kept in sync; the E7 test asserts the shared module has a non-empty priority list per persona.

| Persona | Priority bands (first 3) |
|---|---|
| INDIVIDUAL | summary · projectionSummary · recentEvidence |
| LAWYER | caseOperations · summary · pipelineDetail |
| INSURANCE | reviewerOrchestration · operationalPressure · caseOperations |
| INVESTIGATOR | investigationIntelligence · timeline · caseOperations |
| JOURNALIST | summary · pipelineDetail · recentEvidence |
| ENTERPRISE_COMPLIANCE | governancePosture · auditReadiness · operationalPressure |
| ADMIN_OPERATOR | operationalPressure · incidents · reviewerOrchestration |

Bands the viewer cannot see (because they lack capability) are absent from the envelope — persona never brings them back. The reorder is presentation only.

---

## 5. Navigation ordering / disclosure

Phase E7 does **NOT** modify the route registry, the navigation disclosure resolver, or the canonical 6 primaries. The audit confirmed:

- `routeRegistry.ts` remains the authoritative source for route existence + required capabilities.
- 32.8 canonical primaries remain exactly six (home / capture / evidence / cases / reports / search). The E7 contract test asserts this.
- Hub-tier routes (governance / reviewer-ops / ops / security-center / about/trust / ops/analytics) remain bounded.
- `PERSONA_DOMAIN_GROUP` is exposed for future surfaces that want a coarse grouping signal (operator vs admin vs individual). It is NOT consumed by the disclosure resolver in E7 — it is available for a future bounded phase if needed.

---

## 6. Capture template defaults

The capture page already reorders templates via `orderTemplatesByWorkflow()` keyed on the workflow profile (which derives from persona). Phase E7 contributes `PERSONA_CONTENT[*].recommendedTemplates` as the canonical SUGGESTED priority list so future surfaces (e.g. an onboarding "first capture" prompt) can pull from the same source of truth.

Crucial constraint: recommendations are SUGGESTIONS only. The workflow-template registry remains authoritative for what is selectable; the user can always pick a different template.

| Persona | Recommended templates (priority) |
|---|---|
| INDIVIDUAL | general-evidence-record · single-file-capture |
| LAWYER | legal-matter-evidence · general-evidence-record |
| INSURANCE | insurance-claim-intake · general-evidence-record |
| INVESTIGATOR | incident-investigation · general-evidence-record |
| JOURNALIST | field-capture · general-evidence-record |
| ENTERPRISE_COMPLIANCE | compliance-audit-record · general-evidence-record |
| ADMIN_OPERATOR | general-evidence-record |

Unknown slugs are silently skipped by the workflow-template-order resolver.

---

## 7. Onboarding guidance

Phase E7 adds an OPTIONAL `personaCode` field to `OnboardingResolverInput` and an OPTIONAL `personaRecommendedNextStep` field to `OnboardingResolverResult`. Existing callers that omit `personaCode` get the same shape they did before — the change is fully backward-compatible.

When a persona code is supplied:

- The canonical mode-driven step sequence (R7 contract) is unchanged.
- The resolver additionally returns the persona-specific "do this first" line from `PERSONA_CONTENT[code].recommendedNextStep`.
- Surfaces can render the persona line alongside the canonical step (e.g. as a "For your persona, we suggest:" hint).

| Persona | Onboarding next-step copy |
|---|---|
| INDIVIDUAL | Capture your first evidence record from the Capture surface. |
| LAWYER | Create a matter to organize evidence, reviewer notes, and reports for one case. |
| INSURANCE | Invite claims reviewers before sharing intake links with claimants. |
| INVESTIGATOR | Open an investigation to link related evidence and build the timeline. |
| JOURNALIST | Capture a field evidence record from the Capture surface — the verification package follows automatically. |
| ENTERPRISE_COMPLIANCE | Configure your retention policy before opening compliance evidence intake. |
| ADMIN_OPERATOR | Review the Security Center and Operations Center to set up users, SSO, and operational health checks. |

---

## 8. Empty states

Per-surface, per-persona hints are exposed via `getPersonaEmptyStateHint(code, surface)`. The existing `personaEmptyStates.ts` web-side helper continues to operate; the shared module's hints serve as the canonical baseline that other surfaces (e.g. a future mobile client) can consume.

| Persona × surface | Hint |
|---|---|
| LAWYER × cases | "Create a matter to organize evidence, reviewer notes, and generated reports." |
| INSURANCE × evidence | "Start a claim intake or share an intake link to receive evidence." |
| INVESTIGATOR × cases | "Open an investigation to link evidence, manage reviewer tasks, and assemble the timeline." |
| ENTERPRISE_COMPLIANCE × evidence | "Configure retention policy first so newly captured evidence inherits the workspace's lifecycle rules." |

(Full matrix in `persona-content.ts`.)

---

## 9. Hub landing emphasis

The Reviewer Operations / Governance / Operations Center hubs are NOT modified by E7. They remain `PageRouteGate`-wrapped and capability-gated. A future bounded phase (E8) could pull from `PERSONA_DOMAIN_GROUP` to surface a persona-relevant quick-action ordering on `HubQuickActionsBar`, but doing so in E7 would expand scope beyond the canonicalization mission.

---

## 10. Analytics persona context

The Phase E4 `/ops/analytics` surface remains the authoritative analytics page. Persona is NOT used to filter analytics, hide degraded sources, or rebrand any metric. The page continues to render real counts from real source tables with explicit degraded-state badges. A persona-aware section ordering on the analytics page is OUT OF SCOPE for E7 — it would duplicate the dashboard band order pattern without operator value.

---

## 11. Product language alignment

The persona content module declares `PERSONA_CONTENT_FORBIDDEN_PATTERNS` — 18 regexes blocking marketing-claim shapes. The contract test:

1. Runs every pattern against the `primaryJobs`, `recommendedNextStep`, `summary`, and `emptyStateHints` of every persona.
2. Runs the same patterns against the persona-content.ts file body (excluding the declaration block itself).

Forbidden phrasing: `legally admissible`, `admissible in court`, `claim proven`, `authenticity guaranteed`, `journalistically verified`, `compliance certified`, `AI-confirmed`, `AI-verified`, `forensically certified`, `forensic authority/grade`, `court-ready`, `court-certified`, `tamper-proof`, `100% secure`, `guarantees authenticity/admissibility/truth`, `SOC 2 compliant/certified`, `HIPAA compliant/certified`, `GDPR compliant/certified`.

This list is intentionally narrower than the Trust Center's full block-list — those patterns naturally appear in negation contexts on disclaimer surfaces. The persona module never disclaims; it only describes. So the narrower list is the right gate here.

---

## 12. Architecture invariants preserved

- 32.8 IA: root nav still exactly the 6 canonical primaries (asserted by Test 7).
- No new client-state / queue / pubsub library (asserted by Test 9).
- No new Prisma migration in E7 (no schema change).
- No mutation of capture / custody / finalize / signing / timestamp / report / package — file-size pins on the five protected core files remain green (asserted by Test 8).
- No mutation of auth / MFA / SAML / SCIM.
- No new capability key.
- No new root navigation item.
- `capability-registry.ts` continues to have zero persona dependency — verified by source-grep AND functional test (asserted by Test 3).

---

## 13. Test inventory

`services/api/test/phase-e7-persona-aware-ux.test.ts` covers 10 test groups:

1. Persona content shape + completeness (parametrised across 7 personas).
2. Forbidden trust-language wording absent everywhere (parametrised).
3. Capability registry has zero persona dependency (source-grep + functional).
4. Frontend persona consumers honour the presentation-only rule (4 consumers).
5. Onboarding resolver: persona is optional + additive (3 cases).
6. Helper-function behaviour (5 cases).
7. 32.8 IA preserved (1 case).
8. Protected core files unchanged (5 cases).
9. No new state library introduced (1 case).
10. Documentation + registry updated (2 cases).

Total: **~80 cases**, all passing.

---

## 14. CR1.7 closure summary

- **Entry-gate checklist:** completed in writing before any code edit.
- **Files added:**
  - `packages/shared-evidence-presentation/src/persona-content.ts` (canonical persona content + helpers + forbidden-list).
  - `apps/web/lib/platform-context/personaRecommendedActions.ts` (presentation-layer bridge to React hooks).
  - `services/api/test/phase-e7-persona-aware-ux.test.ts`.
  - `docs/product/PHASE_E7_PERSONA_AWARE_UX.md` (this file).
- **Files modified:**
  - `packages/shared-evidence-presentation/src/index.ts` — barrel re-export.
  - `apps/web/lib/onboarding/types.ts` — added optional `personaCode` input field + optional `personaRecommendedNextStep` result field.
  - `apps/web/lib/onboarding/resolveOnboardingState.ts` — populates the new optional field when `personaCode` is supplied.
  - `docs/recovery/MASTER_PHASE_REGISTRY.md` — Phase E7 row added.
- **No new DEFs opened.** Phase E7 is self-contained canonicalization.
- **No DEFs resolved** (none targeted E7).
- **No migration drift allow-list update required** — Phase E7 does not ship a Prisma migration.

---

## 15. Remaining risks

- The persona content module is the canonical truth. Future hands who add a persona-driven surface MUST consume from this module rather than re-declaring per-persona literals in the page. The contract test pins this for the shipped consumers; new surfaces need to opt into the same source by convention.
- A future "operator vs individual vs admin" navigation disclosure pass (using `PERSONA_DOMAIN_GROUP`) is plausible but explicitly OUT OF SCOPE for E7 to keep this phase bounded.

---

## 16. Out of scope (deliberate)

- No new persona codes. Adding one would require a schema migration + backend coordination.
- No persona-driven permission re-grant. The capability registry hard rule stands.
- No persona-driven analytics filtering or "executive view" mode.
- No persona-fork of the dashboard, capture, or any page.
- No persona settings wizard redesign (the existing `settings/persona/page.tsx` works correctly).

---

## 17. Next safe phase

Phase E8 (if planned) should focus on a bounded next-step, not on expanding the persona surface. Candidates:

- **Customer-facing audit log viewer** — capability-gated view of `SecurityEvent` for workspace owners. Also natural place to close DEF-024 (SecurityEvent retention policy).
- **Live IdP pilot rehearsal** — would resolve DEF-002.
- **In-band signing-key rotation** — would resolve DEF-027.
- **Graceful shutdown drain for webhook runtime** — would resolve DEF-026 and tighten DEF-025.
- **Hub quick-action persona ordering** — small Phase using `PERSONA_DOMAIN_GROUP` to reorder hub quick actions; only if operational data shows this is needed.

The persona content module stays as a stable v1 — its value is in being calm, complete, and authoritative, not in constant churn.
