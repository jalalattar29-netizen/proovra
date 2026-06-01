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
// PHASE 38 — persona profile hook + reorder utility (UX-only).
export {
  usePersonaProfile,
  usePrimaryPersona,
  useIsOperatorPersona,
} from "./usePersonaProfile";
export {
  reorderByPersona,
  splitByPersona,
  PERSONA_PRIORITY_PREFIXES,
} from "./personaPriorityOrder";
export {
  getPersonaSectionOrder,
  PERSONA_DASHBOARD_PRIORITY,
} from "./personaSectionOrder";
export { resolvePersonaHint } from "./personaHints";
export type { PersonaHint, PersonaHintSurface } from "./personaHints";
export {
  WORKFLOW_PROFILE_CODES,
  workflowFromPersona,
  workflowFromCode,
  listWorkflowDescriptors,
} from "./workflowProfile";
export type {
  WorkflowProfileCode,
  WorkflowProfileDescriptor,
} from "./workflowProfile";
export { suggestWorkflow } from "./workflowSuggestion";
export type {
  WorkflowUsageSignals,
  WorkflowSuggestion,
} from "./workflowSuggestion";
export { resolveWorkflowHelp } from "./workflowHelp";
export type { HelpSurface, WorkflowHelpEntry } from "./workflowHelp";
export { useTerminology, resolveTerminology } from "./useTerminology";
export type { TerminologyKey } from "./useTerminology";
export {
  resolvePersonaEmptyState,
} from "./personaEmptyStates";
export type {
  EmptyStateSurface,
  PersonaEmptyState,
} from "./personaEmptyStates";
