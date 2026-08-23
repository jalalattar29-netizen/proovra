/**
 * MAY THE SHELL READ OPERATIONAL RUNTIME FOR THIS CONTEXT?
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS REPLACES
 * ---------------------------------------------------------------------------
 * `useGlobalRuntimeState` polled three endpoints — runtime readiness, open
 * operational incidents, open reviewer escalations — for any context that
 * resolved a `teamId`. The only thing standing between a caller and those
 * reads was how the sidebar computed that id:
 *
 *     const teamId =
 *       envelope?.workspace?.status === "active" &&
 *       envelope.workspace.scope === "TEAM"
 *         ? envelope.workspace.id
 *         : null;
 *
 * That is a gate on the workspace's SHAPE, not on the caller's AUTHORITY. It
 * happened to silence a Personal Free space (scope PERSONAL), which is why the
 * defect read as fixed, and it let every refused ORGANIZATION context through:
 * a platform administrator with no membership, a member below the operational
 * role floor, a workspace whose package grants no Operations surface. Each of
 * them polled `/v1/ops/incidents` every 45 seconds and drove a severity pill
 * for a surface they cannot open.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * The one predicate the shell asks before reading. It is PURE — no fetch, no
 * hook, no clock — so it can be tested exhaustively without a browser, and it
 * is per-SOURCE because the three endpoints answer to three different
 * authorities. Gating them together would either over-read (escalations in a
 * personal space that has none) or under-read (no incident count for a
 * workspace that plainly has one).
 *
 * It creates no second Operations authority. It decides only whether to ASK;
 * what the answer means still belongs to the canonical incident projection,
 * and the server remains authoritative on every one of these routes.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT READ
 * ---------------------------------------------------------------------------
 * No plan name. No workspace label. No email. No `isPlatformAdmin` shortcut —
 * platform-admin status is not tenant authority, and a staff account without a
 * membership must be refused exactly like anyone else without one.
 */

import type { CapabilityKey, PlatformContextEnvelope } from "./types";

/** Which of the shell's three runtime sources this context may read. */
export type RuntimeReadAccess = {
  /** `GET /admin/runtime/readiness` */
  readiness: boolean;
  /** `GET /v1/ops/incidents` */
  incidents: boolean;
  /** `GET /v1/reviewer-ops/escalations` */
  escalations: boolean;
  /**
   * Why everything is refused, when everything is refused. Null when at least
   * one source is readable. Present so a diagnostic can say which boundary
   * stopped a read rather than leaving it looking like a silent failure.
   */
  refusedReason:
    | null
    | "no_envelope"
    | "no_workspace"
    | "workspace_not_resolved"
    | "context_mismatch"
    | "account_not_active"
    | "no_operational_capability";
};

const REFUSE = (
  refusedReason: NonNullable<RuntimeReadAccess["refusedReason"]>,
): RuntimeReadAccess => ({
  readiness: false,
  incidents: false,
  escalations: false,
  refusedReason,
});

export type RuntimeReadAccessInput = {
  /** The resolved envelope, or null while authority is still unknown. */
  envelope: PlatformContextEnvelope | null | undefined;
  /** The workspace the caller intends to read. */
  teamId: string | null | undefined;
};

export function resolveRuntimeReadAccess(
  input: RuntimeReadAccessInput,
): RuntimeReadAccess {
  const { envelope, teamId } = input;

  // ---- 1. Authority must exist before anything is read ---------------------
  //
  // No envelope is not "probably fine". It is an unknown context, and an
  // unknown context fails CLOSED — including on the first render before the
  // envelope resolves, which is when an ungated poller does its damage.
  if (!envelope) return REFUSE("no_envelope");

  if (!teamId) return REFUSE("no_workspace");

  // ---- 2. The workspace must have resolved ---------------------------------
  if (envelope.workspace?.status !== "active") {
    return REFUSE("workspace_not_resolved");
  }

  // ---- 3. The envelope must DESCRIBE the workspace being read --------------
  //
  // The capability map is a statement about ONE workspace. Reading workspace B
  // while holding an envelope for workspace A means the capabilities consulted
  // below do not describe the thing being read — so the answer would be
  // authorised by the wrong evidence.
  //
  // This is also what stops a stale id surviving a workspace switch: the moment
  // the envelope moves on, the previous id no longer matches and its in-flight
  // reads are not merely discarded but never re-issued.
  // The envelope must also agree with ITSELF.
  //
  // It carries the active workspace id in three places — the canonical
  // `contextOptions.activeContext`, the `activeSpace`, and the legacy
  // `workspace` block — and different consumers read different ones: the
  // application shell derives its id from the legacy block, the Operations
  // route from `useActiveWorkspaceId`. When those disagree, one of them is
  // reading a workspace the capability map does not describe, and NEITHER can
  // tell which. An envelope that contradicts itself is not evidence.
  const declaredIds = [
    envelope.contextOptions?.activeContext?.workspaceId ?? null,
    envelope.activeSpace?.id ?? null,
    envelope.workspace?.id ?? null,
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  if (new Set(declaredIds).size > 1) return REFUSE("context_mismatch");

  // …and it must describe the workspace actually being read.
  const activeId = declaredIds[0] ?? null;
  if (activeId && activeId !== teamId) return REFUSE("context_mismatch");

  // ---- 4. Account lifecycle ------------------------------------------------
  //
  // A suspended or pending account may hold a capability map from before the
  // change. Operational chrome for an account that cannot act is a badge
  // nobody can do anything about.
  const accountStatus = envelope.account?.accountStatus ?? null;
  if (accountStatus !== null && accountStatus !== "active") {
    return REFUSE("account_not_active");
  }

  // ---- 5. Per-source capability -------------------------------------------
  const can = (key: CapabilityKey): boolean =>
    envelope.capabilities?.[key] === true;

  // The canonical tenant operational key. It is granted when the workspace can
  // actually PRODUCE operational conditions, or when more than one operator
  // shares it — never from a plan name.
  const operational = can("OPERATIONS_VIEW");

  // Readiness rides the operational surface. There is no tenant capability
  // meaning "may read runtime readiness" — the route is member-gated on
  // `audit.read` — and the only reason the shell reads it is to colour the
  // operational severity pill. A context with no operational surface has
  // nothing for that pill to point at.
  const readiness = operational;

  // Escalations are a REVIEW-domain authority with its own key, granted only
  // to team-shaped workspaces. A personal space has no reviewer escalations,
  // and asking for them would be a request whose answer is always empty.
  const escalations = can("ESCALATIONS_VIEW");

  if (!operational && !escalations) {
    return REFUSE("no_operational_capability");
  }

  return {
    readiness,
    incidents: operational,
    escalations,
    refusedReason: null,
  };
}

/** True when no source may be read at all — the shell polls nothing. */
export function readsNothing(access: RuntimeReadAccess): boolean {
  return !access.readiness && !access.incidents && !access.escalations;
}
