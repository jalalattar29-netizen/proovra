/**
 * THE ONE WORKSPACE OF A REQUEST (AUTHZ-006).
 *
 * The pointer is shared by every tab and device, so it cannot say which
 * workspace a request means. The header can: a client names the workspace on its
 * screen, and that name decides. A workspace the caller cannot enter is refused
 * by the canonical chain, never swapped for one they can, and a value that
 * cannot be a workspace id names nothing and is refused the same way.
 *
 * The pointer answers only for a client that names nothing, and it is read once.
 * A guard and the handler behind it both ask here, so they cannot see two
 * different workspaces however the pointer moves between them.
 *
 * A leaf module, so the authorizer, the route resolvers and the collaboration
 * binding read one definition without importing each other. Nothing here
 * authorizes anything: every caller hands the candidate to the canonical chain.
 */
import type { FastifyRequest } from "fastify";

import { getAuthUserId } from "../../auth.js";
import { prisma } from "../../db.js";

export const WORKSPACE_HEADER = "x-proovra-workspace-id";
/** Older clients and integrations. Same meaning, same treatment. */
export const LEGACY_WORKSPACE_HEADER = "x-team-id";

function headerValue(req: FastifyRequest, name: string): string | null {
  const raw = req.headers?.[name];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].length > 0) {
    return raw[0];
  }
  return null;
}

export function readWorkspaceHeader(req: FastifyRequest): string | null {
  return headerValue(req, WORKSPACE_HEADER) ?? headerValue(req, LEGACY_WORKSPACE_HEADER);
}

const WORKSPACE_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestWorkspaceCandidates = new WeakMap<object, Promise<string | null>>();

async function readRequestWorkspaceCandidate(req: FastifyRequest): Promise<string | null> {
  const named = readWorkspaceHeader(req);
  if (named) return WORKSPACE_ID_SHAPE.test(named) ? named : null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: getAuthUserId(req) },
      select: { currentWorkspaceId: true },
    });
    return user?.currentWorkspaceId ?? null;
  } catch {
    return null;
  }
}

/** The candidate for this request, stable for its whole life. */
export function requestWorkspaceCandidate(req: FastifyRequest): Promise<string | null> {
  const known = requestWorkspaceCandidates.get(req);
  if (known) return known;
  const pending = readRequestWorkspaceCandidate(req);
  requestWorkspaceCandidates.set(req, pending);
  return pending;
}

export type ProvenRequestWorkspace = { teamId: string; userId: string };

const provenRequestWorkspaces = new WeakMap<object, ProvenRequestWorkspace>();

export function rememberProvenRequestWorkspace(
  req: FastifyRequest,
  proven: ProvenRequestWorkspace,
): void {
  provenRequestWorkspaces.set(req, proven);
}

/**
 * The workspace the canonical chain already proved for this request, if a guard
 * got there first. A handler behind a guard acts here and asks nothing again.
 */
export function provenRequestWorkspace(req: FastifyRequest): ProvenRequestWorkspace | null {
  return provenRequestWorkspaces.get(req) ?? null;
}
