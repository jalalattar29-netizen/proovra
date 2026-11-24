/**
 * THE WORKSPACE A MUTATION ACTS IN (Team remediation T-118 / T-123, members
 * audit MEM-09 / MEM-S2, ARCH-16).
 *
 * A request can name its workspace twice: the `x-proovra-workspace-id` header
 * (the workspace on the client's screen, per tab) and a body or query id. The
 * two used to be reconciled differently per route — case create used the body
 * and otherwise silently fell back to the caller's PERSONAL space even when the
 * header named a shared one, while the context read used the per-user pointer.
 * So a headerless or stale client could write somewhere other than the
 * workspace it showed. This module is the one rule for the body-scoped create
 * routes:
 *
 *   - header and body both present and different → 409
 *     WORKSPACE_CONTEXT_MISMATCH (nothing written);
 *   - otherwise the body id, else the header id, names the workspace;
 *   - neither → `null` (the route decides: case create answers 400
 *     WORKSPACE_REQUIRED; evidence capture keeps its documented personal
 *     default, see evidence.routes.ts).
 *
 * Stage B's reviewer-ops header-vs-body guard (T-042) applies the same
 * comparison; this module owns the case / evidence / collaboration routes.
 * Nothing here authorizes: the caller hands the id to its own admission check,
 * which answers 404 to a non-member (T-123), never 403.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { readWorkspaceHeader } from "../services/access/request-workspace.js";

export const WORKSPACE_CONTEXT_MISMATCH = "WORKSPACE_CONTEXT_MISMATCH";
export const WORKSPACE_REQUIRED = "WORKSPACE_REQUIRED";
export const WORKSPACE_NOT_FOUND = "WORKSPACE_NOT_FOUND";

export type NamedMutationWorkspace =
  | { kind: "named"; teamId: string; source: "body" | "header" }
  | { kind: "unnamed" }
  | { kind: "mismatch"; headerTeamId: string; bodyTeamId: string };

/** Which workspace does this mutation name? Pure; sends nothing. */
export function namedMutationWorkspace(
  req: FastifyRequest,
  bodyTeamId: string | null | undefined,
): NamedMutationWorkspace {
  const header = readWorkspaceHeader(req);
  const body = typeof bodyTeamId === "string" && bodyTeamId.length > 0 ? bodyTeamId : null;
  if (header && body && header.toLowerCase() !== body.toLowerCase()) {
    return { kind: "mismatch", headerTeamId: header, bodyTeamId: body };
  }
  if (body) return { kind: "named", teamId: body, source: "body" };
  if (header) return { kind: "named", teamId: header, source: "header" };
  return { kind: "unnamed" };
}

export function sendWorkspaceContextMismatch(reply: FastifyReply, req: FastifyRequest): FastifyReply {
  return reply.code(409).send({
    code: WORKSPACE_CONTEXT_MISMATCH,
    message:
      "This request names a different workspace than the one it was sent from. Reload the page and try again in the workspace you mean.",
    error: { code: WORKSPACE_CONTEXT_MISMATCH, requestId: req.id ?? null },
  });
}

export function sendWorkspaceRequired(reply: FastifyReply, req: FastifyRequest): FastifyReply {
  return reply.code(400).send({
    code: WORKSPACE_REQUIRED,
    message: "Choose the workspace this belongs to, then try again.",
    error: { code: WORKSPACE_REQUIRED, requestId: req.id ?? null },
  });
}

/** A workspace the caller is not an ACTIVE member of is answered as a missing one (T-123). */
export function sendWorkspaceNotFound(reply: FastifyReply, req: FastifyRequest): FastifyReply {
  return reply.code(404).send({
    code: WORKSPACE_NOT_FOUND,
    message: "Workspace not found",
    error: { code: WORKSPACE_NOT_FOUND, requestId: req.id ?? null },
  });
}
