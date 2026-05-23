# Persona-aware UX — internal product model notes

PROOVRA supports persona-aware product experiences as a **UX-layer concern only**.
This document is the canonical reference for what persona does, what it does
not do, and how to extend it safely.

## TL;DR

| Concept | Source of truth |
|---------|-----------------|
| What features a user can use | **Capability registry** (server) |
| What workspace they're in | **`activeSpace`** + tenant model |
| What labels / ordering / defaults they see | **`personaProfile`** (this doc) |

Persona NEVER grants permissions. The capability registry is the sole
authority. If persona contradicts a capability, the capability wins.

## The seven personas

| Persona | When to pick |
|---------|--------------|
| `INDIVIDUAL` | Solo professional, default for new workspaces |
| `LAWYER` | Legal teams; matters, custody timelines, legal holds |
| `INSURANCE` | Claims operations; queues, SLA, assignments |
| `INVESTIGATOR` | Investigations; relationships, timelines, cross-case intelligence |
| `JOURNALIST` | Media verification; publication readiness, source protection guidance |
| `ENTERPRISE_COMPLIANCE` | Audit, retention, legal holds, policy workflows |
| `ADMIN_OPERATOR` | Platform operators; ops center, incidents, queue health |

Vocabulary is **closed**. Adding an eighth persona requires:

1. Add the code to `WORKSPACE_PERSONA_PROFILES` in
   [services/api/src/services/platform-context/types.ts](../services/api/src/services/platform-context/types.ts).
2. Mirror in [apps/web/lib/platform-context/types.ts](../apps/web/lib/platform-context/types.ts).
3. Add a priority list in
   [apps/web/lib/platform-context/personaPriorityOrder.ts](../apps/web/lib/platform-context/personaPriorityOrder.ts).
4. Add (optional) terminology overrides in
   [apps/web/lib/platform-context/useTerminology.ts](../apps/web/lib/platform-context/useTerminology.ts).
5. Add (optional) empty-state overrides in
   [apps/web/lib/platform-context/personaEmptyStates.ts](../apps/web/lib/platform-context/personaEmptyStates.ts).
6. Update the wizard label maps in
   [apps/web/app/(app)/settings/persona/page.tsx](../apps/web/app/(app)/settings/persona/page.tsx).
7. Update tests in
   [services/api/test/phase-38-persona-foundation.test.ts](../services/api/test/phase-38-persona-foundation.test.ts).

All seven steps stay within the UX layer. No backend permission change is
required.

## What persona CAN change

| Surface | Mechanism |
|---------|-----------|
| Sidebar item ordering | `reorderByPersona()` permutes the existing items |
| Topbar persona chip | Read `envelope.personaProfile.primaryProfile` |
| Dashboard section order | Future: Command Center reads `primaryProfile` |
| Empty-state copy | `resolvePersonaEmptyState({ persona, surface })` |
| Label terminology | `useTerminology()` / `resolveTerminology(persona)` |
| Capture template defaults | Future: capture surface reads `primaryProfile` |
| Operational density | `personaProfile.operationalDensityPreference` |

## What persona CANNOT change

- Whether a route returns 200 vs 403/404. That's role + capability.
- Whether a button is rendered if the capability says no. (Capability
  wins; persona ordering is a permutation of capability-allowed items.)
- Which audit / custody / report / package / TSA / OTS pipeline runs.
- Tenant isolation. `activeSpace` decides scope.
- Billing / seats. The plan comes from `Entitlement` (account) or
  `Team.billingPlan` (org), never from persona.

## Setting the persona

Two paths:

1. **Onboarding wizard.** `/settings/persona` runs a 4-step wizard:
   - Confirm workspace context (Personal Space vs Organization).
   - Choose primary persona.
   - Pick optional goals + secondary use-cases.
   - Set operational density preference.

2. **Direct API.** Use the canonical mutation route:
   ```
   PATCH /v1/workspaces/:teamId/persona
   Content-Type: application/json
   Authorization: Bearer <token>

   {
     "primaryProfile": "LAWYER",
     "secondaryUseCases": ["INVESTIGATOR"],
     "operationalDensityPreference": "compact",
     "onboardingCompleted": true
   }
   ```

The route requires `identity.org_policy.manage` (organization workspaces)
or the actor being the owner of their personal space.

## Reading the persona

Frontend:

```tsx
import {
  usePersonaProfile,
  usePrimaryPersona,
  useIsOperatorPersona,
  useTerminology,
  resolvePersonaEmptyState,
} from "@/lib/platform-context";

function MyComponent() {
  const profile = usePersonaProfile();              // full profile
  const persona = usePrimaryPersona();              // just the code
  const isOperator = useIsOperatorPersona();        // boolean
  const t = useTerminology();                       // label map

  // For empty states:
  const emptyState = resolvePersonaEmptyState({
    persona,
    surface: "cases",
  });

  return <h1>{t.casePlural}</h1>;  // "Cases" or "Matters" or "Claims"
}
```

Backend:

```ts
import { readWorkspacePersonaProfile } from "../services/platform-context/persona-profile.service.js";

const profile = await readWorkspacePersonaProfile({
  teamId,
  resolvedRolePersona: "INDIVIDUAL",
});
```

## Testing checklist for any persona-aware change

When you add a persona-aware feature:

- ✓ Capability is still the gate. The feature is reachable only if
  `ctx.can(CAPABILITY)` says yes — regardless of persona.
- ✓ The feature does NOT disappear from the UI based on persona alone.
  Personas reorder; they do not hide.
- ✓ The corresponding test in
  [services/api/test/phase-38-persona-foundation.test.ts](../services/api/test/phase-38-persona-foundation.test.ts)
  passes. Add a new persona-coverage test if the surface is new.
- ✓ The backend audit log captures persona mutations as
  `workspace.persona.updated` (already wired in the mutation route).
- ✓ No new Prisma migrations are required for label / ordering / copy
  changes.

## Data model

One row per workspace in `workspace_persona_profiles`:

| Column | Default | Bounded vocabulary |
|--------|---------|-------------------|
| `team_id` | (PK, FK → teams) | UUID |
| `primary_profile` | `INDIVIDUAL` | 7 personas |
| `secondary_use_cases` | `[]` | JSON array of personas, max 4 |
| `onboarding_completed` | `false` | boolean |
| `preferred_dashboard_layout` | `null` | string ≤ 64 chars |
| `operational_density_preference` | `comfortable` | `compact` / `comfortable` / `spacious` |
| `feature_priority_overrides` | `[]` | JSON array of strings, max 24 |
| `onboarding_state` | `{}` | bounded JSON |
| `created_at` / `updated_at` | now() | timestamptz |

Resolver behaviour: missing row → canonical default with `source: "default"`.
Degraded read → same default with `source: "default"`. Never throws.

## Audit + observability

Every persona mutation writes a `workspace.persona.updated` row to
`PlatformAuditLog` with bounded `metadata` (before/after summary, no
secrets). Failed mutations are not retried by the route; the operator
re-attempts.
