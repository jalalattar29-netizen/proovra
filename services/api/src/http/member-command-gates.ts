/**
 * MEMBER COMMAND GATES — the guards every workspace-membership mutation passes,
 * whichever route it arrives on (members audit ROLE-01).
 *
 * `/v1/identity/members/*` (Security Center) and `/v1/teams/:id/members/*`
 * (Members & Access) drive the SAME engine commands. The identity routes
 * refused managed identities and demanded step-up; the teams routes did
 * neither, so an ADMIN with a stolen session could re-role or remove members,
 * and SCIM-owned identities drifted from their directory. One module now owns
 * the guards and the refusal shape, and both route families call it.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { RbacError } from "../services/identity/membership-provisioning.service.js";
import { resolveManagedIdentity } from "../services/identity/identity-mode.service.js";

/**
 * MANAGED-IDENTITY GUARD. A SCIM/SSO-owned identity's membership state is
 * owned by the directory; changing it here would be silently reverted on the
 * next sync and would break the organization's provable provisioning trail.
 * Both the resolved MANAGED and the fail-closed MANAGED_UNRESOLVED states are
 * refused with ONE bounded code (never a free-text or state-revealing body).
 * A schema-unavailable read denies too — it is never read as "STANDARD".
 *
 * Returns true when the caller must stop (the reply has been sent).
 */
export async function denyIfManagedIdentity(
  reply: FastifyReply,
  targetUserId: string,
  req?: FastifyRequest,
): Promise<boolean> {
  const requestId = req?.id;
  try {
    const identity = await resolveManagedIdentity(targetUserId);
    if (identity.state === "STANDARD") return false;
    reply.code(409).send({ error: { code: "managed_identity_readonly", requestId }, requestId });
    return true;
  } catch {
    // FAIL CLOSED: an unresolvable identity mode (schema unavailable, read
    // failure) is never read as "STANDARD" — the mutation is refused.
    reply.code(503).send({ error: { code: "identity_mode_unavailable", requestId }, requestId });
    return true;
  }
}

/** The HTTP status for each bounded engine refusal. */
export function rbacErrorStatus(code: string): number {
  switch (code) {
    case "member_not_found":
    case "capability_not_found":
    case "delegated_scope_not_found":
      return 404;
    case "self_action_forbidden":
    case "grantor_lacks_permission":
    case "rank_insufficient":
      return 403;
    case "member_owner_immutable":
    case "role_transition_to_owner_forbidden":
    case "capability_unknown":
      return 400;
    case "invalid_status_transition":
    case "last_administrator_protected":
    case "capability_already_active":
    case "delegated_scope_already_active":
    case "owner_cannot_leave":
    case "workspace_seat_limit_reached":
    case "collaboration_team_capacity_reached":
    case "workspace_seat_contention":
      return 409;
    default:
      return 400;
  }
}

/**
 * Sends the typed refusal for an engine error. Returns false (and sends
 * nothing) for anything that is not an RbacError, so the caller rethrows it.
 * The code is the engine's bounded vocabulary; customer copy for it lives in
 * the shared user-facing vocabulary, identical on web and mobile.
 */
export function sendRbacRefusal(reply: FastifyReply, err: unknown, req?: FastifyRequest): boolean {
  if (!(err instanceof RbacError)) return false;
  const requestId = req?.id;
  reply.code(rbacErrorStatus(err.code)).send({ error: { code: err.code, requestId }, requestId });
  return true;
}
