"use client";

/**
 * PHASE 13 — shared state machine for the governance-platform WRITE surfaces.
 *
 * Six registered governance routes were reachable only from a REST client:
 *
 *   POST /v1/governance/cross-org-review
 *   POST /v1/governance/cross-org-review/:id/accept
 *   POST /v1/governance/access-reviews/campaigns
 *   POST /v1/governance/delegated-admin
 *   POST /v1/governance/destruction-reviews
 *   POST /v1/governance/policies
 *
 * Every one of them is a governance capability whose console already LISTED
 * the entity and could never create one. This module is the single place the
 * five new create/accept surfaces get:
 *
 *   1. `useGovernanceAction` — in-flight state, stale/superseded-response
 *      protection (per-call sequence + unmount + tenant generation), and a
 *      bounded outcome. A response that lands after a newer submit, after the
 *      operator switched workspace, or after the form unmounted is DROPPED.
 *
 *   2. `classifyGovernanceFailure` — the ONLY mapping from a thrown API error
 *      to user-facing copy on these surfaces. It never renders a raw backend
 *      message: 400 → invalid, 402/403/404 → denied, 409 → conflict,
 *      everything else → `toSafeUserError`. Bounded fragments (a delegated
 *      tier, an entitlement key) are echoed only after matching a strict
 *      pattern, so a hostile body cannot inject text into the page.
 *
 *   3. `useDelegatedTierAccess` — a CLIENT-SIDE MIRROR of the server's
 *      `hasDelegatedTier` ladder, derived from the same authority the console
 *      already reads (`GET /v1/governance/delegated-admin`) plus the
 *      workspace-owner implication the server applies. It exists so a control
 *      the caller cannot use renders DISABLED with a reason instead of
 *      failing on click. It is a hint, never an authorisation: the route
 *      re-checks every tier server-side.
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
  DELEGATED_ADMIN_TIERS,
  type DelegatedAdminGrantProjection,
  type DelegatedAdminTier,
  type DepartmentProjection,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
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

const KNOWN_TIERS: ReadonlySet<string> = new Set(DELEGATED_ADMIN_TIERS);
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
 * NOTHING from the response body reaches the DOM except a delegated tier that
 * is a member of the shared `DELEGATED_ADMIN_TIERS` enum, or an entitlement
 * key matching `FEATURE_[A-Z0-9_]+`. No message, no detail object, no code.
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
  const requiredTier =
    typeof details["requiredTier"] === "string"
      ? (details["requiredTier"] as string)
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
    if (requiredTier && KNOWN_TIERS.has(requiredTier)) {
      return {
        kind: "denied",
        message: `You need the ${requiredTier} delegated-admin tier in this workspace to do this. Ask an organization admin to grant it.`,
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
 * organization id the cross-org, delegated-admin and access-review bodies
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
// useDelegatedTierAccess — client mirror of the server ladder
// ---------------------------------------------------------------------------

const ORG_CHAIN: ReadonlyArray<DelegatedAdminTier> = [
  "GLOBAL_ADMIN",
  "ORG_ADMIN",
  "DEPARTMENT_ADMIN",
  "WORKSPACE_ADMIN",
];

/** Mirrors `expandAcceptableTiers` in the delegated-admin service. */
function acceptableTiers(
  required: DelegatedAdminTier,
): ReadonlyArray<DelegatedAdminTier> {
  const index = ORG_CHAIN.indexOf(required);
  if (index >= 0) return ORG_CHAIN.slice(0, index + 1);
  return [required];
}

export type DelegatedTierAccess = {
  /** False until the grant list has resolved — gate optimistic UI on this. */
  ready: boolean;
  /**
   * Client-side mirror of `hasDelegatedTier`. ADVISORY ONLY: the route
   * re-checks the tier server-side on every request.
   */
  hasTier: (
    tier: DelegatedAdminTier,
    scope?: { organizationId?: string | null },
  ) => boolean;
  /** True when any of the supplied tiers is held. */
  hasAnyTier: (
    tiers: ReadonlyArray<DelegatedAdminTier>,
    scope?: { organizationId?: string | null },
  ) => boolean;
};

export function useDelegatedTierAccess(): DelegatedTierAccess {
  const { envelope } = usePlatformContext();
  const [grants, setGrants] = useState<
    ReadonlyArray<DelegatedAdminGrantProjection>
  >([]);
  const [ready, setReady] = useState(false);
  const { stamp, isStale } = useTenantGuard();

  useEffect(() => {
    let cancelled = false;
    const generation = stamp();
    setReady(false);
    void (async () => {
      try {
        const res = await apiFetch("/v1/governance/delegated-admin", {
          method: "GET",
        });
        if (cancelled || isStale(generation)) return;
        setGrants(
          (res?.grants ?? []) as ReadonlyArray<DelegatedAdminGrantProjection>,
        );
      } catch {
        if (cancelled || isStale(generation)) return;
        // Fail CLOSED: no readable grants means no tier is asserted. The
        // owner implication below still applies, matching the server.
        setGrants([]);
      } finally {
        if (!cancelled && !isStale(generation)) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stamp, isStale]);

  const userId = envelope?.user?.id ?? null;
  /**
   * Read from `activeSpace.roleLabel`, never from the deprecated legacy
   * workspace field on the envelope.
   *
   * That legacy field is inside a closing deprecation window: the Phase-37.95
   * and G4.3 guards allow it only for a named set of files, and a new consumer
   * fails both. `activeSpace` is the canonical projection of the space the
   * caller is actually operating in, and the two can legitimately disagree —
   * which is the whole reason the migration exists.
   */
  /**
   * PHASE 13 (NEW-061) — BOTH SHAPES THE SERVER ACTUALLY EMITS.
   *
   * `roleLabel` is NOT a display string. `platform-context.service.ts` sets it
   * to `workspace.membership.role` — the raw `TeamRole` enum, i.e. `"OWNER"` —
   * for a TEAM-scoped active space, and to the literal `"Owner"` only on the
   * PERSONAL branch. Comparing against `"Owner"` alone therefore recognised the
   * owner of a Personal Space and NO owner of any real workspace.
   *
   * The consequence was not cosmetic: this mirror is what enables the
   * cross-org-invite and delegated-admin-grant controls, and both are gated on
   * the implicit workspace-owner ORG_ADMIN tier that the server DOES apply. So
   * the genuine owner of an Organization workspace saw both controls
   * permanently disabled, with the copy claiming they lacked a tier the server
   * would have granted them. Neither capability was reachable from any surface.
   *
   * Accepting both shapes is what the rest of the app already does — see
   * `review/workspace/page.tsx`, which tests `"OWNER"` and `"Owner"`, and
   * `integrations/page.tsx` / `search/page.tsx` / `workflows/page.tsx`, which
   * test the uppercase enum.
   */
  const roleLabel = envelope?.activeSpace?.roleLabel ?? null;
  const isOwner = roleLabel === "OWNER" || roleLabel === "Owner";

  const hasTier = useCallback<DelegatedTierAccess["hasTier"]>(
    (tier, scope) => {
      const organizationId = scope?.organizationId ?? null;
      if (userId) {
        const now = Date.now();
        const acceptable = acceptableTiers(tier);
        for (const grant of grants) {
          if (grant.granteeUserId !== userId) continue;
          if (grant.state !== "ACTIVE") continue;
          if (
            grant.expiresAtUtc &&
            new Date(grant.expiresAtUtc).getTime() < now
          ) {
            continue;
          }
          if (!acceptable.includes(grant.tier)) continue;
          if (grant.tier === "GLOBAL_ADMIN") return true;
          if (grant.tier === "ORG_ADMIN") {
            if (!organizationId || grant.organizationId === organizationId) {
              return true;
            }
            continue;
          }
          if (grant.tier === "DEPARTMENT_ADMIN" || grant.tier === "WORKSPACE_ADMIN") {
            return true;
          }
          // Cross-cutting tiers match at their own tier only.
          if (grant.tier === tier) return true;
        }
      }
      // Implicit workspace-owner grant — the server treats the owner as an
      // ORG_ADMIN of their own workspace for the org-chain tiers only.
      if (isOwner && ORG_CHAIN.slice(1).includes(tier)) return true;
      return false;
    },
    [grants, userId, isOwner],
  );

  const hasAnyTier = useCallback<DelegatedTierAccess["hasAnyTier"]>(
    (tiers, scope) => tiers.some((tier) => hasTier(tier, scope)),
    [hasTier],
  );

  return useMemo(
    () => ({ ready, hasTier, hasAnyTier }),
    [ready, hasTier, hasAnyTier],
  );
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
