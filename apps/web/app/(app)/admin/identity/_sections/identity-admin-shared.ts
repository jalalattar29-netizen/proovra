"use client";

/**
 * PHASE 12B — shared vocabulary for the Organization identity administration
 * console (`/admin/identity` + its inspector sub-pages).
 *
 * ONE failure classifier for every section, so a DENIAL never renders as
 * "nothing here" and a raw backend string never reaches an operator:
 *
 *   denied — the API refused on authorization (capability, membership status,
 *            parent-Organization lifecycle) or concealed the target as 404.
 *            Rendered as an explicit "you cannot do this here" state.
 *   blocked — the operation is legitimate but the platform refuses it as a
 *            matter of policy (a SCIM-managed identity, the last remaining
 *            administrator, an already-terminal row).
 *   error  — anything else, always via the sanctioned `toSafeUserError`.
 *
 * No client-side permission, role-precedence or plan decision is made here or
 * in any consumer: the sections render the server projection and the server's
 * denial, nothing more.
 */

import { ApiError } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

export type SurfaceFailure = {
  kind: "denied" | "blocked" | "error";
  message: string;
};

/**
 * Bounded backend code → operator copy. Every entry corresponds to a code the
 * identity routes actually emit; unknown codes fall through to the safe path.
 */
const CODE_COPY: Record<string, string> = {
  not_found:
    "That item is not part of the workspace you are administering. It may have been removed, or it belongs to another organization.",
  permission_denied:
    "Your role in this workspace does not include this identity-administration action.",
  member_not_active:
    "Your membership in this workspace is not active, so identity administration is unavailable.",
  member_access_expired:
    "Your time-bound access to this workspace has expired. Ask an administrator to renew it.",
  organization_not_active:
    "This organization is suspended. Identity administration is unavailable until it is reactivated.",
  managed_identity_readonly:
    "This identity is provisioned by your directory (SCIM/SSO). Change it in the identity provider — a change made here would be reverted on the next sync.",
  identity_mode_unavailable:
    "The identity-ownership check could not run, so the change was refused. Retry shortly.",
  last_administrator_protected:
    "This would leave the workspace with no active administrator. Promote another member first.",
  member_owner_immutable:
    "The workspace owner cannot be suspended, revoked, or demoted here. Transfer ownership first.",
  role_transition_to_owner_forbidden:
    "Ownership is transferred through the workspace ownership flow, not through a role change.",
  self_action_forbidden: "You cannot apply this action to your own membership.",
  invalid_status_transition:
    "That transition is not allowed from the member's current state. Reload and check the current status.",
  capability_already_active:
    "That capability is already granted. Revoke it first to re-issue it.",
  capability_not_found: "That capability grant no longer exists or was already revoked.",
  capability_unknown: "That is not a recognised capability.",
  delegated_scope_already_active: "That delegated-admin scope is already granted.",
  delegated_scope_not_found:
    "That delegated-admin scope no longer exists or was already revoked.",
  mapping_already_active:
    "An active mapping already exists for this member and provider. Unlink it first.",
  mapping_not_found: "That external identity mapping no longer exists.",
  user_not_in_workspace:
    "That member is not part of the workspace you are administering.",
  credential_not_found: "That service account no longer exists in this workspace.",
  credential_already_revoked:
    "That service account is revoked. A revoked credential cannot be re-enabled or hardened.",
  session_already_revoked: "That contributor session was already revoked.",
  session_already_terminal:
    "That contributor session already finished (submitted or abandoned), so there is nothing to revoke.",
  session_not_found: "That contributor session is not part of this workspace.",
  ENTITLEMENT_REQUIRED:
    "This capability is not included in the current plan for this workspace.",
  RBAC_MEMBER_NOT_FOUND:
    "That member is not part of the workspace you are administering.",
  RBAC_ELEVATION_BLOCKED:
    "The elevation was refused: the member must be an active member of this workspace.",
  RBAC_PERMISSION_UNKNOWN: "That is not a recognised permission.",
  HIGH_RISK_ACTION_BLOCKED:
    "This action is blocked while your session is flagged high-risk. Contact another administrator.",
  RISK_EVALUATION_UNAVAILABLE:
    "The risk check could not run, so the action was refused. Retry shortly.",
};

const BLOCKED_CODES = new Set([
  "managed_identity_readonly",
  "last_administrator_protected",
  "member_owner_immutable",
  "role_transition_to_owner_forbidden",
  "self_action_forbidden",
  "invalid_status_transition",
  "capability_already_active",
  "capability_not_found",
  "delegated_scope_already_active",
  "delegated_scope_not_found",
  "mapping_already_active",
  "mapping_not_found",
  "credential_already_revoked",
  "session_already_revoked",
  "session_already_terminal",
  "RBAC_ELEVATION_BLOCKED",
  "ENTITLEMENT_REQUIRED",
]);

function readCode(err: unknown): string | null {
  if (err instanceof ApiError) return err.code ?? null;
  const e = err as { code?: unknown };
  return typeof e?.code === "string" ? e.code : null;
}

function readStatus(err: unknown): number | null {
  const e = err as { statusCode?: unknown };
  return typeof e?.statusCode === "number" ? e.statusCode : null;
}

export function classifyFailure(err: unknown, fallback: string): SurfaceFailure {
  const code = readCode(err);
  const status = readStatus(err);
  if (code && BLOCKED_CODES.has(code)) {
    return { kind: "blocked", message: CODE_COPY[code] ?? fallback };
  }
  if (code && CODE_COPY[code]) {
    return {
      kind: status === 403 || status === 404 ? "denied" : "error",
      message: CODE_COPY[code],
    };
  }
  if (status === 403 || status === 404) {
    return { kind: "denied", message: CODE_COPY.permission_denied };
  }
  if (status === 402) {
    // The plan boundary, not a fault. The API answers 402
    // ENTERPRISE_FEATURE_REQUIRED when the active workspace's plan does not
    // include this surface's feature; presented as a generic error it reads
    // as breakage, and the honest state is "this workspace's plan does not
    // include it".
    return {
      kind: "blocked",
      message:
        "This surface is part of the Enterprise plan, and the workspace you are acting in does not carry it. Switch into an Enterprise workspace to use it here.",
    };
  }
  return {
    kind: "error",
    message: toSafeUserError(err, { message: fallback }).message,
  };
}

/** A cancelled step-up is the operator's own decision, never an error. */
export function isStepUpCancel(err: unknown): boolean {
  return (err as { code?: string })?.code === "STEP_UP_CANCEL";
}

/** Per-row outcome feedback: which row succeeded or failed, and why. */
export type RowResult = {
  rowId: string;
  ok: boolean;
  message: string;
};

/** Short, non-identifying display form for an opaque id. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
