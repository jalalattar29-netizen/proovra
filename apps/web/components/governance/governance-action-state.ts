"use client";

/**
 * PHASE 13 — shared state machine for the governance-platform WRITE surfaces.
 *
 * Six registered governance routes were reachable only from a REST client:
 *
 *   POST /v1/governance/cross-org-review
 *   POST /v1/governance/cross-org-review/:id/accept
 *   POST /v1/governance/access-reviews/campaigns
 *   POST /v1/governance/destruction-reviews
 *   POST /v1/governance/policies
 *
 * (The sixth, `POST /v1/governance/delegated-admin`, belonged to the retired
 * delegated-admin TIER model and now answers 410; delegated administration is
 * granted per member in Security Center.)
 *
 * Every one of them is a governance capability whose console already LISTED
 * the entity and could never create one. This module is the single place the
 * create/accept surfaces get:
 *
 *   1. `useGovernanceAction` — in-flight state, stale/superseded-response
 *      protection (per-call sequence + unmount + tenant generation), and a
 *      bounded outcome. A response that lands after a newer submit, after the
 *      operator switched workspace, or after the form unmounted is DROPPED.
 *
 *   2. `classifyGovernanceFailure` — the ONLY mapping from a thrown API error
 *      to user-facing copy on these surfaces. It never renders a raw backend
 *      message: 400 → invalid, 402/403/404 → denied, 409 → conflict,
 *      everything else → `toSafeUserError`. Bounded fragments (a permission
 *      key, an entitlement key) are echoed only after matching the shared
 *      catalog / a strict pattern, so a hostile body cannot inject text into
 *      the page.
 *
 *   3. `useWorkspacePermissionAccess` — a CLIENT-SIDE MIRROR of the canonical
 *      permission engine (`authorize.ts`): role permissions + capability
 *      grants + delegated scopes. It is built ONLY from sources the console
 *      already reads — the platform-context role of the active space through
 *      the shared `roleHasPermission` matrix, and the caller's own row of
 *      `GET /v1/identity/members` (live capability grants, live delegated
 *      scopes expanded through the shared `listPermissionsForDelegatedAdminScope`).
 *      It exists so a control the caller cannot use renders DISABLED with a
 *      reason instead of failing on click. It is a hint, never an
 *      authorisation: every route re-checks the permission server-side.
 *
 *   4. `useGovernanceOrganization` — the SERVER-derived governance
 *      Organization for the active workspace, read from
 *      `GET /v1/governance/departments`, which echoes `organizationId`
 *      precisely so a console never has to ask an operator to type a tenancy
 *      UUID. Four of the six routes take an organization id in the body; this
 *      is where all four get it.
 *
 *   5. `useWorkspaceMembers` — the member roster used by the grantee /
 *      subject pickers, so a user id is never hand-typed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DELEGATED_ADMIN_SCOPE_KINDS,
  listPermissionsForDelegatedAdminScope,
  roleHasPermission,
  type DbTeamRole,
  type DelegatedAdminScopeKind,
  type DepartmentProjection,
  type Permission,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import {
  isKnownPermission,
  permissionRequiredDetail,
} from "../../lib/labels/governanceReviewLabels";
import { usePlatformContext, useTenantGuard } from "../../lib/platform-context";

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/** `POST /v1/governance/policies` — `slug` and `invitedOrgSlug` regexes. */
export const POLICY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ORG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * `<input type="datetime-local">` gives a local wall-clock string with no
 * zone. Every one of these routes declares `z.string().datetime()`, i.e. an
 * ISO-8601 instant, so the value is converted here exactly once.
 */
export function toIsoInstant(localValue: string): string | null {
  const trimmed = localValue.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type GovernanceOutcomeKind =
  | "success"
  | "invalid"
  | "denied"
  | "conflict"
  | "error";

export type GovernanceOutcome = {
  kind: GovernanceOutcomeKind;
  message: string;
};

const ENTITLEMENT_PATTERN = /^FEATURE_[A-Z0-9_]{1,60}$/;

/**
 * Bounded copy for the 409 `denial` / error codes these six routes emit. A
 * code that is not in this table falls back to a generic conflict sentence —
 * the raw code is never rendered.
 */
const CONFLICT_COPY: Readonly<Record<string, string>> = {
  POLICY_REJECTED:
    "The governance engine rejected these details. Check the values and try again.",
  EXTERNAL_GRANT_NOT_FOUND:
    "The external review grant referenced here no longer exists.",
  EXTERNAL_GRANT_REVOKED:
    "The external review grant referenced here has been revoked.",
  ACTOR_REQUIRED:
    "This action needs an identified actor. Sign in again and retry.",
  DESTRUCTION_REVIEW_ACTIVE:
    "This evidence already has an open destruction review. Close that review before opening another.",
  DESTRUCTION_REVIEW_TERMINAL:
    "The destruction review for this evidence has already reached a final state.",
  DESTRUCTION_REVIEW_BLOCKED_BY_HOLD:
    "A legal hold blocks a destruction review for this evidence. Release the hold first.",
  DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE:
    "Immutable retention blocks a destruction review for this evidence.",
  SUBJECT_NOT_IN_WORKSPACE:
    "The record chosen for review is no longer in this workspace. Choose it again.",
  SUBJECT_REQUIRED:
    "This review was created without a record to review, so it cannot be accepted. Ask the inviting organization to send a new invitation.",
  PORTAL_INVITATION_REFUSED:
    "The reviewer portal refused the invitation for this review's record. The record may have been removed; ask the inviting organization to send a new invitation.",
  DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE:
    "The lifecycle state of this evidence does not allow a destruction review right now.",
};

function readErrorFields(err: unknown): {
  status: number;
  code: string | null;
  details: Record<string, unknown>;
} {
  const e = err as {
    statusCode?: unknown;
    code?: unknown;
    details?: unknown;
  } | null;
  const status = typeof e?.statusCode === "number" ? e.statusCode : 0;
  const code = typeof e?.code === "string" ? e.code : null;
  const details =
    e?.details && typeof e.details === "object"
      ? (e.details as Record<string, unknown>)
      : {};
  return { status, code, details };
}

/**
 * Turn a thrown API error into bounded, user-safe copy.
 *
 * NOTHING from the response body reaches the DOM except the LABEL of a
 * permission key that is a member of the shared `PERMISSIONS` catalog, or an
 * entitlement key matching `FEATURE_[A-Z0-9_]+`. No message, no detail
 * object, no code.
 */
export function classifyGovernanceFailure(
  err: unknown,
  fallback: string,
): GovernanceOutcome {
  const { status, code, details } = readErrorFields(err);

  const denial =
    typeof details["denial"] === "string" ? (details["denial"] as string) : null;
  const entitlement =
    typeof details["entitlement"] === "string"
      ? (details["entitlement"] as string)
      : null;
  const permission =
    typeof details["permission"] === "string"
      ? (details["permission"] as string)
      : null;

  // 404 is folded into "denied": these routes answer an unauthorised read of
  // another tenant's row with a bounded not-found (anti-enumeration), so the
  // operator must not be told the two apart.
  if (status === 403 || status === 404) {
    if (denial === "ENTITLEMENT_REQUIRED") {
      return {
        kind: "denied",
        message:
          entitlement && ENTITLEMENT_PATTERN.test(entitlement)
            ? `This workspace's plan does not include ${entitlement}. Ask a workspace owner to upgrade, then try again.`
            : "This workspace's plan does not include this governance capability.",
      };
    }
    if (denial === "PERMISSION_REQUIRED" && isKnownPermission(permission)) {
      return {
        kind: "denied",
        message: permissionRequiredDetail(permission),
      };
    }
    return {
      kind: "denied",
      message:
        "You do not have permission to perform this governance action in the current workspace.",
    };
  }

  if (status === 402) {
    return {
      kind: "denied",
      message:
        "This governance capability is included on Enterprise plans only. Contact sales to enable it for this workspace.",
    };
  }

  if (status === 400 || status === 422) {
    return {
      kind: "invalid",
      message:
        "The server rejected these details as invalid. Review the highlighted fields and try again.",
    };
  }

  if (status === 409) {
    const key = denial ?? code ?? "";
    return {
      kind: "conflict",
      message:
        CONFLICT_COPY[key] ??
        "This action conflicts with the current state of the record. Refresh the list and try again.",
    };
  }

  return {
    kind: "error",
    message: toSafeUserError(err, { message: fallback }).message,
  };
}

// ---------------------------------------------------------------------------
// useGovernanceAction
// ---------------------------------------------------------------------------

export type GovernanceActionRunner = {
  /** True while a submit is in flight. Drives `aria-busy` + disabled. */
  busy: boolean;
  /** Latest bounded outcome, or null before the first submit. */
  outcome: GovernanceOutcome | null;
  /** Clear the outcome (used when the operator edits the form again). */
  reset: () => void;
  /**
   * Run one mutation. The result is applied ONLY if this call is still the
   * newest one, the component is still mounted, and the tenant generation has
   * not changed since the call started.
   */
  run: (
    op: () => Promise<void>,
    copy: { success: string; fallback: string },
  ) => Promise<void>;
};

export function useGovernanceAction(): GovernanceActionRunner {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<GovernanceOutcome | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  const { stamp, isStale } = useTenantGuard();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setOutcome(null);
  }, []);

  const run = useCallback<GovernanceActionRunner["run"]>(
    async (op, copy) => {
      const seq = ++seqRef.current;
      const generation = stamp();
      const current = () =>
        mountedRef.current && seq === seqRef.current && !isStale(generation);

      setBusy(true);
      setOutcome(null);
      try {
        await op();
        if (!current()) return;
        setOutcome({ kind: "success", message: copy.success });
      } catch (err) {
        if (!current()) return;
        setOutcome(classifyGovernanceFailure(err, copy.fallback));
      } finally {
        if (current()) setBusy(false);
      }
    },
    [stamp, isStale],
  );

  return useMemo(
    () => ({ busy, outcome, reset, run }),
    [busy, outcome, reset, run],
  );
}

// ---------------------------------------------------------------------------
// useGovernanceOrganization
// ---------------------------------------------------------------------------

export type GovernanceOrganizationState = {
  /** SERVER-derived governance Organization for the active workspace. */
  organizationId: string | null;
  departments: ReadonlyArray<DepartmentProjection>;
  loading: boolean;
  /** True when the read failed — the caller must not offer the write. */
  failed: boolean;
};

/**
 * `GET /v1/governance/departments` echoes `organizationId` for the resolved
 * workspace. That echo is the canonical, non-invented source of the
 * organization id the cross-org and access-review bodies
 * require. The client never asks an operator to type it.
 */
export function useGovernanceOrganization(): GovernanceOrganizationState {
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [departments, setDepartments] = useState<
    ReadonlyArray<DepartmentProjection>
  >([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const { stamp, isStale } = useTenantGuard();

  useEffect(() => {
    let cancelled = false;
    const generation = stamp();
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const res = await apiFetch("/v1/governance/departments", {
          method: "GET",
        });
        if (cancelled || isStale(generation)) return;
        setOrganizationId(
          typeof res?.organizationId === "string" ? res.organizationId : null,
        );
        setDepartments(
          (res?.departments ?? []) as ReadonlyArray<DepartmentProjection>,
        );
      } catch {
        if (cancelled || isStale(generation)) return;
        setOrganizationId(null);
        setDepartments([]);
        setFailed(true);
      } finally {
        if (!cancelled && !isStale(generation)) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stamp, isStale]);

  return useMemo(
    () => ({ organizationId, departments, loading, failed }),
    [organizationId, departments, loading, failed],
  );
}

// ---------------------------------------------------------------------------
// useWorkspacePermissionAccess — client mirror of the permission engine
// ---------------------------------------------------------------------------

/**
 * What the mirror can say about one permission:
 *
 *   granted — the role, a live capability grant or a live delegated scope
 *             grants it.
 *   missing — the mirror saw the WHOLE picture (role + the caller's own
 *             grants and scopes) and nothing grants it. The control is
 *             disabled with a reason.
 *   unknown — the role does not grant it and the caller's own grants and
 *             scopes could not be read (the roster needs
 *             `identity.member.read`, which e.g. a GOVERNANCE_ADMIN scope does
 *             not include). The control stays ENABLED and the server decides:
 *             disabling it would lock a legitimate scope holder out of a
 *             capability the server would allow.
 */
export type PermissionVerdict = "granted" | "missing" | "unknown";

export type WorkspacePermissionAccess = {
  /** False until the mirror has resolved — gate optimistic UI on this. */
  ready: boolean;
  /** ADVISORY ONLY: the route re-checks the permission on every request. */
  verdict: (permission: Permission) => PermissionVerdict;
  /** True unless the verdict is "missing". */
  allows: (permission: Permission) => boolean;
};

type OwnAccessRow = {
  userId: string;
  status: string;
  capabilityGrants?: ReadonlyArray<{
    permission: string;
    expiresAtUtc: string | null;
    revokedAtUtc: string | null;
  }>;
  delegatedAdminScopes?: ReadonlyArray<{
    scopeKind: string;
    expiresAtUtc: string | null;
    revokedAtUtc: string | null;
  }>;
};

const KNOWN_SCOPE_KINDS: ReadonlySet<string> = new Set(DELEGATED_ADMIN_SCOPE_KINDS);

/** Live = not revoked and not past its expiry, exactly as the engine reads it. */
function isLive(
  row: { expiresAtUtc: string | null; revokedAtUtc: string | null },
  now: number,
): boolean {
  if (row.revokedAtUtc) return false;
  if (row.expiresAtUtc && new Date(row.expiresAtUtc).getTime() <= now) return false;
  return true;
}

/**
 * The extra permissions the caller's own membership row carries on top of
 * the role: live capability grants plus every permission of every live
 * delegated scope (expanded through the shared scope → permission table the
 * engine itself uses).
 */
export function grantedExtraPermissions(
  row: OwnAccessRow,
  now: number = Date.now(),
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const grant of row.capabilityGrants ?? []) {
    if (isLive(grant, now)) out.add(grant.permission);
  }
  for (const scope of row.delegatedAdminScopes ?? []) {
    if (!KNOWN_SCOPE_KINDS.has(scope.scopeKind) || !isLive(scope, now)) continue;
    for (const p of listPermissionsForDelegatedAdminScope(
      scope.scopeKind as DelegatedAdminScopeKind,
    )) {
      out.add(p);
    }
  }
  return out;
}

const DB_ROLES: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);

export function useWorkspacePermissionAccess(): WorkspacePermissionAccess {
  const { envelope } = usePlatformContext();
  // `undefined` = not read yet; `null` = unreadable (the verdict degrades to
  // "unknown", never to "granted").
  const [ownRow, setOwnRow] = useState<OwnAccessRow | null | undefined>(undefined);
  const [rosterRead, setRosterRead] = useState(false);
  const { stamp, isStale } = useTenantGuard();
  const userId = envelope?.user?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    const generation = stamp();
    setOwnRow(undefined);
    setRosterRead(false);
    void (async () => {
      try {
        const res = await apiFetch("/v1/identity/members", { method: "GET" });
        if (cancelled || isStale(generation)) return;
        const rows = (res?.members ?? []) as ReadonlyArray<OwnAccessRow>;
        setOwnRow(rows.find((m) => m.userId === userId) ?? null);
        setRosterRead(true);
      } catch {
        if (cancelled || isStale(generation)) return;
        setOwnRow(null);
        setRosterRead(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stamp, isStale, userId]);

  /**
   * Read from `activeSpace.roleLabel`, never from the deprecated legacy
   * workspace field on the envelope. `roleLabel` is the raw `TeamRole` enum
   * ("OWNER") for an Organization space and the literal "Owner" on the
   * Personal branch (PHASE 13 NEW-061) — both shapes are accepted.
   */
  const roleLabel = envelope?.activeSpace?.roleLabel ?? null;
  const role: DbTeamRole | null =
    roleLabel === "Owner"
      ? "OWNER"
      : roleLabel && DB_ROLES.has(roleLabel)
        ? (roleLabel as DbTeamRole)
        : null;

  const extras = useMemo(
    () =>
      ownRow && ownRow.status === "ACTIVE" ? grantedExtraPermissions(ownRow) : null,
    [ownRow],
  );

  const verdict = useCallback<WorkspacePermissionAccess["verdict"]>(
    (permission) => {
      if (roleHasPermission(role, permission)) return "granted";
      if (extras?.has(permission)) return "granted";
      // The whole picture was seen and nothing grants it.
      if (rosterRead && ownRow !== undefined) return "missing";
      return "unknown";
    },
    [role, extras, rosterRead, ownRow],
  );

  const allows = useCallback<WorkspacePermissionAccess["allows"]>(
    (permission) => verdict(permission) !== "missing",
    [verdict],
  );

  const ready = ownRow !== undefined;

  return useMemo(() => ({ ready, verdict, allows }), [ready, verdict, allows]);
}

// ---------------------------------------------------------------------------
// useWorkspaceMembers
// ---------------------------------------------------------------------------

export type GovernanceMember = {
  teamMemberId: string;
  userId: string;
  role: string;
  status: string;
};

export type WorkspaceMembersState = {
  members: ReadonlyArray<GovernanceMember>;
  loading: boolean;
  failed: boolean;
};

/**
 * `GET /v1/identity/members` is the roster the identity console already
 * renders. It backs the grantee / review-subject pickers so a user id is
 * selected from real membership rather than pasted.
 */
export function useWorkspaceMembers(): WorkspaceMembersState {
  const [members, setMembers] = useState<ReadonlyArray<GovernanceMember>>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const { stamp, isStale } = useTenantGuard();

  useEffect(() => {
    let cancelled = false;
    const generation = stamp();
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const res = await apiFetch("/v1/identity/members", { method: "GET" });
        if (cancelled || isStale(generation)) return;
        const rows = (res?.members ?? []) as ReadonlyArray<GovernanceMember>;
        setMembers(rows.filter((m) => m.status === "ACTIVE"));
      } catch {
        if (cancelled || isStale(generation)) return;
        setMembers([]);
        setFailed(true);
      } finally {
        if (!cancelled && !isStale(generation)) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stamp, isStale]);

  return useMemo(
    () => ({ members, loading, failed }),
    [members, loading, failed],
  );
}

/** Short, non-identifying label for a member row in a picker. */
export function memberLabel(member: GovernanceMember): string {
  return `${member.userId.slice(0, 8)}… · ${member.role}`;
}
