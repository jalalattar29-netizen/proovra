/**
 * Phase 32.8 Foundation — Canonical platform-context entry point.
 *
 * Consumers MUST import from `@/lib/platform-context` only. Importing
 * deeper paths is allowed for type-only narrowing but discouraged.
 *
 * Phase 32.8 Foundation cleanup: the legacy `useActiveWorkspaceId`
 * hook has been removed from the codebase. Pages that previously
 * needed a team-scoped gate now call `useTeamWorkspaceGate()` from
 * this module, which is a non-authoritative derivation of the
 * canonical envelope (no fetches, no role derivation).
 */

export {
  PlatformContextProvider,
  usePlatformContext,
  type PlatformContextValue,
  type PlatformContextProviderProps,
} from "./PlatformContextProvider";

export * from "./types";

// PHASE 7 §10.2/§10.3 — tenant-scoped storage + in-flight guard.
export {
  tenantStorageKey,
  useTenantDraft,
  useTenantGuard,
  useWorkspaceContextSafety,
} from "./tenantStorage";
// PHASE 7 §10.5 — canonical owning-context banner.
export {
  WorkspaceContextBanner,
  useOwningContextLabel,
} from "./WorkspaceContextBanner";
// PHASE 7 §10.1 — dirty-work registry (re-export for one import site).
export {
  useDirtyWork,
  registerDirtyWork,
  getDirtyWorkLabels,
  // PHASE 10 CLOSURE FIX 3 — reactive read + subscription for the automatic
  // no-Personal heal's dirty-work guard (no parallel registry).
  useDirtyWorkLabels,
  subscribeDirtyWork,
  clearAllDirtyWork,
} from "./dirtyWorkRegistry";

export { CapabilityDegradedPanel } from "./CapabilityDegradedPanel";
export {
  useTeamWorkspaceGate,
  useTeamId,
  useWorkspaceId,
  useActiveWorkspaceId,
  useWorkspaceFragment,
  usePersonalSpaceFragment,
  type TeamWorkspaceGateState,
} from "./useTeamWorkspaceGate";
export { WorkspaceRecoveryPanel } from "./WorkspaceRecoveryPanel";
// ENTERPRISE TENANT MODEL — canonical product-model hooks.
export {
  useAccount,
  usePersonalSpace,
  useOrganizations,
  useActiveSpace,
  useActiveSpaceId,
  useCan,
  useDuplicatePersonalCandidates,
} from "./useTenantModel";
// Track 1A (surface-tier removal) — server-projection gate hooks. The
// sanctioned successors of the deleted lib/surface/* tier layer.
export {
  useEnterpriseSurfaceAccess,
  usePlanFeature,
  usePlanFeatureGate,
  // POINT 7 — the server-projected numeric limits. The client renders these;
  // it no longer derives them from a plan name.
  useWorkspaceLimits,
  type PlanFeatureBooleanKey,
  type ServerWorkspaceLimits,
} from "./useServerProjectionGates";
// Canonical terminology accessor (persona-override dimension removed
// 2026-07-20 — returns the single canonical vocabulary).
export { useTerminology, resolveTerminology } from "./useTerminology";
export type { TerminologyKey } from "./useTerminology";

// PHASE 10 CLOSURE FIX 3 (2026-07-23) — canonical no-Personal client gate.
export {
  isPersonalSpaceDisallowed,
  firstAvailableNonPersonalWorkspaceId,
  resolvePersonalSpaceGate,
  type PersonalSpaceGateEnvelopeInput,
  type PersonalSpaceGateResult,
} from "./personalSpaceGate";
export {
  usePersonalSpaceGate,
  type PersonalSpaceGateRenderState,
} from "./usePersonalSpaceGate";
export {
  PersonalSpaceUnavailablePanel,
  PERSONAL_SPACE_UNAVAILABLE_MESSAGE,
  PERSONAL_SPACE_WITHHELD_MESSAGE,
} from "./PersonalSpaceUnavailablePanel";
export {
  useHealWithheld,
  requestHealRelease,
  markHealWithheld,
  clearHealWithheld,
  getHealWithheldState,
  type HealWithheldState,
} from "./personalSpaceHealLatch";
