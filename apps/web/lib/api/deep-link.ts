/**
 * PHASE 11 §4 — THE ONE web consumer of the canonical deep-link authority.
 *
 * A deep link carries a resource LOCATOR (resourceType + id), never
 * authoritative tenant truth. The browser must NEVER decide which workspace a
 * resource belongs to. This helper is the single typed wrapper the web app
 * uses to ask the server authority — `POST /v1/deep-link/resolve` — to
 * authorize the actor and re-derive the workspace from the PERSISTED resource.
 *
 * Contract (see services/api phase11-tenant.routes.ts):
 *   request  : { resourceType, resourceId, declaredWorkspaceId? }
 *   200      : { ok:true, workspaceId, resourceType, resourceId }
 *   404      : anti-enumeration denial (never leaks existence / reason)
 *
 * A denial surfaces here as `null` — the client learns nothing about the
 * resource and simply falls back to a safe non-tenant destination.
 */

import {
  type InternalResourceType,
  internalResourcePath,
  parseInternalResourcePath,
} from "@proovra/shared";

import { apiFetch } from "../api";

export type ResolvedDeepLink = {
  workspaceId: string;
  resourceType: InternalResourceType;
  resourceId: string;
};

type ResolveResponse = {
  ok?: boolean;
  workspaceId?: string;
  resourceType?: InternalResourceType;
  resourceId?: string;
};

/**
 * Ask the server authority to resolve a resource deep-link into an AUTHORIZED
 * workspace. Returns the resolution on success, or `null` for any denial /
 * error (the anti-enumeration 404 is indistinguishable from a network error by
 * design — the client never decides tenant access itself).
 */
export async function resolveDeepLink(input: {
  resourceType: InternalResourceType;
  resourceId: string;
  declaredWorkspaceId?: string | null;
}): Promise<ResolvedDeepLink | null> {
  try {
    const res = (await apiFetch("/v1/deep-link/resolve", {
      method: "POST",
      body: JSON.stringify({
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        declaredWorkspaceId: input.declaredWorkspaceId ?? null,
      }),
    })) as ResolveResponse | null;

    if (
      res &&
      res.ok === true &&
      typeof res.workspaceId === "string" &&
      res.resourceType &&
      typeof res.resourceId === "string"
    ) {
      return {
        workspaceId: res.workspaceId,
        resourceType: res.resourceType,
        resourceId: res.resourceId,
      };
    }
    return null;
  } catch {
    // 404 anti-enumeration denial (or transient error) → the client decides
    // NOTHING about tenant access. Callers treat null as "no authorized
    // destination" and fall back to a safe surface.
    return null;
  }
}

/**
 * Resolve a raw internal resource PATH (e.g. a stored notification href or a
 * post-login intended destination) through the server authority and return the
 * canonical, server-authorized resource path to navigate to.
 *
 *   - Returns `null` when `rawPath` is not a resource deep-link at all — the
 *     caller keeps its own (non-tenant) navigation.
 *   - Returns `null` when the server denies — the caller falls back to a safe
 *     destination (e.g. /home), NEVER to the unresolved tenant URL.
 *
 * The optional `declaredWorkspaceId` is passed through as a mere HINT; the
 * server re-derives the authoritative workspace regardless and may reject it.
 */
export async function resolveDeepLinkPath(
  rawPath: string,
  declaredWorkspaceId?: string | null,
): Promise<string | null> {
  const ref = parseInternalResourcePath(rawPath);
  if (!ref) return null;
  const resolved = await resolveDeepLink({
    resourceType: ref.type,
    resourceId: ref.id,
    declaredWorkspaceId: declaredWorkspaceId ?? null,
  });
  if (!resolved) return null;
  return internalResourcePath({ type: resolved.resourceType, id: resolved.resourceId });
}
