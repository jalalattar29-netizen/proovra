/**
 * Phase 28-G — Operational component barrel.
 *
 * Drop-in enterprise UI primitives that consume the runtime
 * surfaces shipped in Phase 28-D / 28-F:
 *
 *   - GovernanceSnapshotPanel  → /v1/evidence/:id/governance-snapshot
 *   - OperationalTimelinePanel → /v1/evidence/:id/operational-timeline
 *   - RuntimeStatusBanner      → contextual service notice beside an action
 *                                (capability-scoped, /v1/runtime/status)
 *   - ServiceStatusIndicator   → the header's global service status
 *   - ExportPackageEligibilityBadge → fail-closed snapshot-driven badge
 *   - OperationalEmptyState    + bounded presets + a fail-closed variant
 *
 * All components are fail-closed: when the underlying endpoint fails
 * they render an UNKNOWN / DEGRADED state, never an implicit success.
 */

export {
  GovernanceSnapshotPanel,
  type GovernanceSnapshotPanelProps,
} from "./GovernanceSnapshotPanel";
export {
  OperationalTimelinePanel,
  type OperationalTimelinePanelProps,
} from "./OperationalTimelinePanel";
export {
  RuntimeStatusBanner,
  type RuntimeStatusBannerProps,
} from "./RuntimeStatusBanner";
export {
  ExportPackageEligibilityBadge,
  type ExportPackageEligibilityBadgeProps,
} from "./ExportPackageEligibilityBadge";
export {
  GlobalRuntimeIndicator,
  type GlobalRuntimeIndicatorProps,
} from "./GlobalRuntimeIndicator";
export { ServiceStatusIndicator } from "./ServiceStatusIndicator";
export {
  Sparkline,
  type SparklineProps,
  type SparklineSeverity,
} from "./Sparkline";
// Phase 25.6 — Reviewer Ops UI maturity primitives (consume the shared
// reviewer-priority + reviewer-assignment + stuck-workflow engines).
export { PriorityChip, type PriorityChipProps } from "./PriorityChip";
export { StuckBadge, type StuckBadgeProps } from "./StuckBadge";
export {
  AssignmentSuggestionRow,
  type AssignmentSuggestionRowProps,
} from "./AssignmentSuggestionRow";
export {
  WorkloadHeatTile,
  type WorkloadHeatTileProps,
  type ReviewerWorkloadSnapshot,
} from "./WorkloadHeatTile";
export {
  OperationalEmptyState,
  NoEscalationsEmptyState,
  NoWorkloadSnapshotsEmptyState,
  NoGovernanceIncidentsEmptyState,
  NoSlaBreachesEmptyState,
  NoOperationalTimelineEmptyState,
  GovernanceSnapshotUnavailableNotice,
  type OperationalEmptyStateProps,
  type OperationalEmptyStateAction,
  type OperationalEmptyStateVariant,
} from "./OperationalEmptyState";
export {
  OPS_INK,
  OPS_SURFACE,
  OPS_LINK,
  OPS_TONES,
  OPS_SEVERITY_DOT,
  OPS_PILL,
  type OpsSeverity,
  type OpsToneToken,
} from "./tokens";
