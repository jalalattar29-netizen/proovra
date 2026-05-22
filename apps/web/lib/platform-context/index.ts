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
  type TeamWorkspaceGateState,
} from "./useTeamWorkspaceGate";
