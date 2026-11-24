# Commercial authorities: which one answers which question

Team remediation stage F, T-126 (audit ARCH-14). Three commercial authorities
exist. They are not alternatives for the same question; each answers its own,
and a UI gate reads only the server's projection of the answer
(`GET /v1/platform/context` → `planFeatures`, `flags`), never a plan name.

| # | Authority | Answers | Where it is enforced | Projected as |
|---|---|---|---|---|
| 1 | **Plan catalog** `PLAN_CAPABILITIES` (`@proovra/shared` plan-catalog, via `planCapabilities`) | What a plan sells: reports, packages, cases, intake (with wallet rules), External Review, professional surfaces, collaboration teams, AI allowance | The owning routes (reports, cases, intake mint, external-review / external-portal `workspaceIncludesExternalReview`) | `reportsIncluded`, `verificationPackageIncluded`, `casesIncluded`, `intakeIncluded`, `externalReviewIncluded`, `professionalSurfacesIncluded`, `teamCollaborationIncluded`, `aiAssistanceMonthlyOperations` |
| 2 | **Review ladder narrowed by the Enterprise contract** `workspaceReviewCapabilities` → `resolveEffectiveReviewCapabilities` (`billing-enforcement.service.ts`, `billing/enterprise-contract-limits.ts`) | Which of the six review capabilities a workspace includes | Every `/v1/reviewer-ops/*` route (`requireReviewerActor`), record review routes, the reviewer workspace | `basicRecordReviewIncluded`, `reviewerOperationsIncluded`, `reviewQueuesIncluded` |
| 3 | **Packaging product-line grants** `resolveEntitlement` (`packaging/entitlement.service.ts`) | Feature flags sold as product lines (e.g. `FEATURE_REDACTION`) | The feature's own routes (`redaction.routes.ts` gate) | `redactionIncluded`, `redactionReadRetained` |

## Precedence

1. **The route that serves the feature is the authority.** A projection is
   rendering input only; it must be computed by the same function the route
   enforces with, so the UI cannot offer what the route refuses.
2. **One question, one authority.** Review capabilities come only from (2) —
   never from (1) plan names or (3) grants. Redaction comes only from (3) —
   never from the workspace being Enterprise (T-125 removed
   `workspace.review_redaction` from the web's Enterprise-only route set; its
   navigation follows `redactionIncluded`, and `/redaction` opens read-only
   on `redactionReadRetained`).
3. **An Enterprise contract only narrows (2).** It never widens a plan.
4. **Enterprise-workspace surfaces** (`flags.isEnterpriseWorkspace`, server-
   derived) are a fourth, separate input: which operator surfaces exist for
   the workspace kind. They are not a commercial feature and are not projected
   in `planFeatures`.
5. **Unknown fails closed.** A missing or non-boolean projection hides the
   surface.

## Contract (tests)

- Every plan-feature key a web gate reads — route registry
  `requiredPlanFeature` / `navPlanFeature`, surface rules `entitlementOverride`
  / `readRetainedOverride` — is projected as a boolean:
  `services/api/test/team-f-platform-context-navigation.integration.test.ts`.
- The server navigation advertises only routes that load for the context
  (FREE, PRO, TEAM, ENTERPRISE): `apps/web/__tests__/navigation-contract-resolves.test.ts`.

## Not changed here

The web still has two gate layers for a route — the route registry
(`resolveRouteAccess`) and the path surface rules (`lib/surface/tiers.ts`,
mounted by `SurfaceGate` / `EnterpriseSurfaceLayout`). The navigation contract
test checks both for every advertised item. Folding the tier table into the
registry (one gate engine) touches every Enterprise route that relies on
`entitlementOverride` and is left as a follow-up (stage F log, handoff).
