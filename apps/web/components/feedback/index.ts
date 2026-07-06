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
export { ProovraEmptyState, type ProovraEmptyAction } from "./ProovraEmptyState";
export { ProovraErrorState, type ProovraErrorAction } from "./ProovraErrorState";
export { ProovraLoadingState } from "./ProovraLoadingState";
export { ProovraProgressState } from "./ProovraProgressState";
export { ProovraModalFeedback, type ProovraModalAction } from "./ProovraModalFeedback";
