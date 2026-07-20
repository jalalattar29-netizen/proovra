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
// Canonical terminology accessor (persona-override dimension removed
// 2026-07-20 — returns the single canonical vocabulary).
export { useTerminology, resolveTerminology } from "./useTerminology";
export type { TerminologyKey } from "./useTerminology";
