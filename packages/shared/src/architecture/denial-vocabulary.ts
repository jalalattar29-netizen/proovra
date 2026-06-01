/**
 * PROOVRA Phase 3 — Canonical denial vocabulary.
 *
 * Three parallel denial vocabularies exist in the codebase today:
 *
 *   1. `AccessState` — frontend route-resolver decision states
 *      (apps/web/lib/navigation/routeAccessResolver.ts:24-33).
 *      7 codes. Drives the structured PageRouteGate panel.
 *
 *   2. `AccessGateKind` — frontend reactive-error gate kinds
 *      (apps/web/components/access/AccessGate.tsx:27-34). 7 kinds.
 *      Used by `classifyAccessError` to map HTTP 402/403/409 + error
 *      codes to a panel kind.
 *
 *   3. `AuthorizationDenialCode` — backend route-level denials
 *      (services/api/src/middleware/authorize.ts:70-89). 14 codes.
 *      Emitted in JSON responses + audit events.
 *
 * Each vocabulary serves a different layer's needs (route-time
 * pre-fetch decision vs reactive error classification vs server-side
 * authorization outcome). They are NOT going to merge into a single
 * enum — each layer has legitimate semantic distinctions the others
 * don't need.
 *
 * What this module provides:
 *
 *   * A canonical `DenialReason` enum that is the UNION of the
 *     user-meaningful failure modes. This is the user-facing
 *     vocabulary — every UI denial panel resolves to one of these.
 *
 *   * Three mapping functions:
 *       - `accessStateToDenialReason(state)` — frontend route resolver
 *       - `accessGateKindToDenialReason(kind)` — frontend reactive gate
 *       - `authorizationDenialCodeToDenialReason(code)` — backend
 *
 *   * A `denialReasonHeadline` + `denialReasonGuidance` pair that any
 *     UI surface can call to render consistent copy regardless of
 *     which underlying vocabulary produced the denial.
 *
 * This module does NOT replace the three vocabularies. They remain
 * authoritative at their own layer. This module is the bridge.
 *
 * Constitutional reference:
 *   docs/architecture/architecture-invariants.md — INV-9
 *   docs/architecture/proovra-domain-model.md — denial vocabulary
 */

// =============================================================================
// Canonical user-facing denial reasons
// =============================================================================

export const DENIAL_REASONS = [
  /** The user is unauthenticated. */
  "AUTH_REQUIRED",
  /** The user is authenticated but lacks the capability for this surface. */
  "PERMISSION_REQUIRED",
  /** The route requires an Organization context. Personal users see this for org-only surfaces. */
  "ORGANIZATION_REQUIRED",
  /** Neither a personal nor an org workspace is active. Recovery/onboarding path. */
  "WORKSPACE_REQUIRED",
  /** The user's plan tier does not include this surface (PAYG-or-PRO gates). */
  "UPGRADE_REQUIRED",
  /** Only platform admins (User.platformRole='admin') may use this surface. */
  "PLATFORM_ADMIN_REQUIRED",
  /** The workspace is in a degraded/recovery state and the user must take action. */
  "RECOVERY_REQUIRED",
  /** A legal acceptance step is required before continuing. */
  "LEGAL_ACCEPTANCE_REQUIRED",
  /** The user's session/membership has been revoked or expired. */
  "SESSION_REVOKED",
  /** The feature is unavailable (deprecated / disabled / under maintenance). */
  "FEATURE_UNAVAILABLE",
  /** Service-side failure (5xx) — fail-closed deny rather than serve. */
  "OPERATIONAL_ERROR",
] as const;

export type DenialReason = (typeof DENIAL_REASONS)[number];

// =============================================================================
// Headlines + guidance copy
// =============================================================================

export type DenialCopy = {
  headline: string;
  guidance: string;
};

const DENIAL_COPY: Record<DenialReason, DenialCopy> = {
  AUTH_REQUIRED: {
    headline: "Sign in required",
    guidance: "You need to be signed in to use this surface.",
  },
  PERMISSION_REQUIRED: {
    headline: "Permission required",
    guidance:
      "Your current role does not include this capability. An admin can grant access.",
  },
  ORGANIZATION_REQUIRED: {
    headline: "Activate in an organization workspace",
    guidance:
      "This surface activates inside an organization workspace. Create or switch to an organization to continue.",
  },
  WORKSPACE_REQUIRED: {
    headline: "Workspace setup required",
    guidance: "This surface needs an active workspace. Set one up to continue.",
  },
  UPGRADE_REQUIRED: {
    headline: "Plan upgrade required",
    guidance:
      "Your current plan does not include this feature. Upgrade to continue.",
  },
  PLATFORM_ADMIN_REQUIRED: {
    headline: "Platform administrator only",
    guidance:
      "This surface is restricted to platform administrators.",
  },
  RECOVERY_REQUIRED: {
    headline: "Workspace recovery required",
    guidance:
      "Your workspace is in a degraded state. Recovery actions are available.",
  },
  LEGAL_ACCEPTANCE_REQUIRED: {
    headline: "Legal acceptance required",
    guidance:
      "Please review and accept the updated terms to continue.",
  },
  SESSION_REVOKED: {
    headline: "Session ended",
    guidance: "Your session has ended. Sign in again to continue.",
  },
  FEATURE_UNAVAILABLE: {
    headline: "Feature unavailable",
    guidance:
      "This feature is temporarily unavailable.",
  },
  OPERATIONAL_ERROR: {
    headline: "Service temporarily unavailable",
    guidance:
      "We can't make an authorization decision right now. Try again shortly.",
  },
};

export function denialReasonCopy(reason: DenialReason): DenialCopy {
  return DENIAL_COPY[reason];
}

export function denialReasonHeadline(reason: DenialReason): string {
  return DENIAL_COPY[reason].headline;
}

export function denialReasonGuidance(reason: DenialReason): string {
  return DENIAL_COPY[reason].guidance;
}

// =============================================================================
// Mapping from AccessState (frontend route resolver)
// =============================================================================

/**
 * Maps an `AccessState` from `apps/web/lib/navigation/routeAccessResolver.ts`
 * to a canonical `DenialReason`. The `AccessState` enum has 7 codes:
 * ALLOWED | DENIED_NO_CAPABILITY | NEEDS_ORGANIZATION |
 * NEEDS_PERSONAL_OR_ORG | NEEDS_UPGRADE | PLATFORM_ADMIN_ONLY |
 * RECOVERY_REQUIRED.
 *
 * Returns `null` for `ALLOWED` (no denial).
 */
export function accessStateToDenialReason(
  state: string | null | undefined,
): DenialReason | null {
  switch (state) {
    case "ALLOWED":
      return null;
    case "DENIED_NO_CAPABILITY":
      return "PERMISSION_REQUIRED";
    case "NEEDS_ORGANIZATION":
      return "ORGANIZATION_REQUIRED";
    case "NEEDS_PERSONAL_OR_ORG":
      return "WORKSPACE_REQUIRED";
    case "NEEDS_UPGRADE":
      return "UPGRADE_REQUIRED";
    case "PLATFORM_ADMIN_ONLY":
      return "PLATFORM_ADMIN_REQUIRED";
    case "RECOVERY_REQUIRED":
      return "RECOVERY_REQUIRED";
    default:
      return null;
  }
}

// =============================================================================
// Mapping from AccessGateKind (frontend reactive gate)
// =============================================================================

/**
 * Maps an `AccessGateKind` from `apps/web/components/access/AccessGate.tsx`
 * to a canonical `DenialReason`. The `AccessGateKind` enum has 7 kinds:
 * PLAN_UPGRADE | ASK_ADMIN | REQUEST_ACCESS | CONTACT_OWNER |
 * WORKSPACE_REQUIRED | FEATURE_UNAVAILABLE | PERMISSION_REQUIRED.
 */
export function accessGateKindToDenialReason(
  kind: string | null | undefined,
): DenialReason | null {
  switch (kind) {
    case "PLAN_UPGRADE":
      return "UPGRADE_REQUIRED";
    case "ASK_ADMIN":
    case "REQUEST_ACCESS":
    case "CONTACT_OWNER":
    case "PERMISSION_REQUIRED":
      return "PERMISSION_REQUIRED";
    case "WORKSPACE_REQUIRED":
      return "WORKSPACE_REQUIRED";
    case "FEATURE_UNAVAILABLE":
      return "FEATURE_UNAVAILABLE";
    default:
      return null;
  }
}

// =============================================================================
// Mapping from AuthorizationDenialCode (backend)
// =============================================================================

/**
 * Maps an `AuthorizationDenialCode` from
 * `services/api/src/middleware/authorize.ts` to a canonical
 * `DenialReason`. The backend code surfaces 14 distinct values; many
 * collapse into the same user-facing reason.
 */
export function authorizationDenialCodeToDenialReason(
  code: string | null | undefined,
): DenialReason | null {
  switch (code) {
    case "missing_actor":
    case "no_actor":
      return "AUTH_REQUIRED";
    case "missing_team_id":
      return "WORKSPACE_REQUIRED";
    case "member_not_active":
    case "member_access_expired":
      return "SESSION_REVOKED";
    case "service_account_revoked":
    case "service_account_disabled":
    case "service_account_expired":
      return "SESSION_REVOKED";
    case "service_account_scope_missing":
      return "PERMISSION_REQUIRED";
    case "contributor_session_revoked":
    case "contributor_session_expired":
      return "SESSION_REVOKED";
    case "contributor_unsupported_permission":
    case "permission_not_granted":
      return "PERMISSION_REQUIRED";
    case "authorization_unavailable":
      return "OPERATIONAL_ERROR";
    default:
      return null;
  }
}

// =============================================================================
// Unified mapper — accepts ANY of the three vocabularies
// =============================================================================

/**
 * Universal mapper — tries each of the three vocabularies in order
 * and returns the first canonical match.
 *
 * Useful for UI surfaces that receive a denial signal but don't know
 * which layer it came from (e.g. cross-cutting error toast logic).
 */
export function anyDenialToCanonical(
  value: string | null | undefined,
): DenialReason | null {
  if (!value) return null;
  return (
    accessStateToDenialReason(value) ??
    accessGateKindToDenialReason(value) ??
    authorizationDenialCodeToDenialReason(value)
  );
}
