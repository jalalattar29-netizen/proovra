/**
 * PROOVRA Feedback System — shared primitives barrel.
 * See README.md for the notification hierarchy + copy guidelines.
 */

export * from "./severity";
export { ProovraToast, type ProovraToastData } from "./ProovraToast";
export { ProovraSupportReference } from "./ProovraSupportReference";
export { ProovraAlert, type ProovraAlertAction } from "./ProovraAlert";
export { ProovraBanner } from "./ProovraBanner";
export { ProovraInlineError } from "./ProovraInlineError";
// (2026-07-21) ProovraEmptyState (0 consumers) removed. Generic empty
// states use components/ui/EmptyState; dense/operational lists use
// components/operational/OperationalEmptyState.
// Canonical full-surface system-state system (2026-07-21). This replaces
// the old centered-card error state; all boundaries + gates render here.
export {
  ProovraSystemState,
  SYSTEM_STATE_PRESETS,
  type ProovraSystemStateProps,
  type SystemStateKind,
  type SystemStateContext,
  type SystemStatePresentation,
  type SystemStateAction,
} from "./ProovraSystemState";
export { ProovraDenialState, type ProovraDenialStateProps } from "./ProovraDenialState";
export { SystemStateSymbol } from "./SystemStateSymbol";
export { ProovraLoadingState } from "./ProovraLoadingState";
export { ProovraProgressState } from "./ProovraProgressState";
export { ProovraModalFeedback, type ProovraModalAction } from "./ProovraModalFeedback";
