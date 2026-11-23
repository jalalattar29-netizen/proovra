"use client";

/**
 * TEAM-SPEC §3 — WHERE A REVIEW LINK MAY GO, FOR THIS ACTOR, IN THIS WORKSPACE.
 *
 * The review pages linked to each other with plain `<a>` tags: console chips to
 * the Reviewer Workspace and the Enterprise policy page, "Open QC samples" to
 * QC, the escalations empty state to `/reviewer-ops` and `/reviewer-ops/policy`.
 * Each link was right for somebody and a dead end (404, an upgrade panel, an
 * organization gate) for somebody else, because none of them asked the gate
 * the destination applies.
 *
 * This is the `healthDestination.ts` pattern generalised: ONE resolver over the
 * same two gates the destination runs (`resolveRouteAccess` for the registry
 * route, `canAccessSurface` for its path's surface tier). It answers:
 *
 *   { kind: "link" }   — the destination opens for this actor right now;
 *   { kind: "switch" } — it would open, but only in another workspace the
 *                        actor belongs to (the active space is the sole
 *                        blocker). The UI offers that switch and NEVER
 *                        upgrade copy, because paying would not fix it;
 *   null               — render nothing. A control that refuses on click is
 *                        worse than no control.
 *
 * The answer is a navigation decision, not an authorization: every request
 * behind the destination is still authorized by the API.
 */

import { useCallback } from "react";

import {
  usePersonalSpaceFragment,
  usePlatformContext,
  useWorkspaceFragment,
} from "../../lib/platform-context";
import type { PlatformContextEnvelope } from "../../lib/platform-context/types";
import { canAccessSurface, type SurfaceUserContext } from "../../lib/surface/access";
import { surfaceUserContextFromEnvelope } from "../../lib/surface/useSurfaceUserContext";
import { getRouteDefinition } from "../../lib/navigation/routeRegistry";
import {
  resolveRouteAccess,
  type RouteAccessResult,
} from "../../lib/navigation/routeAccessResolver";
import { routeAccessInputFromEnvelope } from "../../lib/navigation/useRouteDestination";

export type ReviewDestination =
  | { kind: "link"; routeId: string; href: string; label: string }
  | {
      kind: "switch";
      routeId: string;
      /** Workspace to switch into before opening `href`. */
      workspaceId: string;
      workspaceName: string;
      href: string;
      label: string;
    }
  | null;

export type ReviewDestinationOptions = {
  /** Link text; defaults to the registry label. */
  label?: string;
  /**
   * Destination href including query (e.g. `/review/queues?queue=ESCALATED`).
   * Must share the registry route's path; defaults to the registry href.
   */
  href?: string;
};

type ContextOptions = PlatformContextEnvelope["contextOptions"] | null | undefined;

/** First organization workspace (other than the active one) the actor holds a role in. */
function firstOrganizationWorkspace(
  contextOptions: ContextOptions,
  activeWorkspaceId: string | null,
): { workspaceId: string; name: string } | null {
  for (const org of contextOptions?.organizations ?? []) {
    for (const ws of org.workspaces ?? []) {
      if (!ws?.workspaceId || ws.workspaceId === activeWorkspaceId) continue;
      if (ws.lifecycleStatus !== "active") continue;
      return {
        workspaceId: ws.workspaceId,
        name: ws.workspaceName ?? org.organizationName ?? "your organization",
      };
    }
  }
  return null;
}

/**
 * Pure resolver. Exported for tests and for callers that already hold the
 * access decision.
 */
export function resolveReviewDestination(input: {
  routeId: string;
  access: RouteAccessResult | null;
  /** The surface-tier decision for the destination path. */
  surfaceAllows: boolean;
  contextOptions: ContextOptions;
  activeWorkspaceId: string | null;
  options?: ReviewDestinationOptions;
}): ReviewDestination {
  const route = getRouteDefinition(input.routeId);
  if (!route || !input.access) return null;
  const href = input.options?.href ?? route.href;
  const label = input.options?.label ?? route.label;
  if (input.access.canLoad && input.access.accessState === "ALLOWED" && input.surfaceAllows) {
    return { kind: "link", routeId: route.id, href, label };
  }
  // The ONLY blocker is the kind of the active space: offer the switch into a
  // workspace the actor already belongs to. Plan, capability and enterprise
  // refusals never become a switch (we cannot know the other workspace's plan
  // or the actor's role there would differ), and never become upgrade copy.
  if (input.access.accessState === "NEEDS_ORGANIZATION") {
    const target = firstOrganizationWorkspace(input.contextOptions, input.activeWorkspaceId);
    if (!target) return null;
    return {
      kind: "switch",
      routeId: route.id,
      workspaceId: target.workspaceId,
      workspaceName: target.name,
      href,
      label: `Switch to ${target.name} to open ${label}`,
    };
  }
  return null;
}

/** Build the resolver inputs from an envelope (no hooks — usable in tests). */
export function reviewDestinationFromEnvelope(
  routeId: string,
  envelope: PlatformContextEnvelope | null | undefined,
  fragments: {
    workspace: { id: string | null; status: string | null } | null;
    personalSpace: { id: string | null; status: string | null } | null;
  },
  options?: ReviewDestinationOptions,
  surface?: SurfaceUserContext,
): ReviewDestination {
  const route = getRouteDefinition(routeId);
  if (!route || !envelope) return null;
  const access = resolveRouteAccess(
    routeAccessInputFromEnvelope(route, envelope, fragments.workspace, fragments.personalSpace),
  );
  const surfaceCtx = surface ?? surfaceUserContextFromEnvelope(envelope);
  const path = (options?.href ?? route.href).split("?")[0] ?? route.href;
  return resolveReviewDestination({
    routeId,
    access,
    surfaceAllows: canAccessSurface(surfaceCtx, path),
    contextOptions: envelope.contextOptions,
    activeWorkspaceId:
      envelope.activeSpace?.id ?? envelope.contextOptions?.activeContext?.workspaceId ?? null,
    options,
  });
}

/**
 * The hook every review surface calls. Returns a resolver function so one
 * component can ask about several destinations without a hook per link.
 * Fails closed (null) while the context is loading.
 */
export function useReviewDestinationResolver(): (
  routeId: string,
  options?: ReviewDestinationOptions,
) => ReviewDestination {
  const { envelope } = usePlatformContext();
  const workspace = useWorkspaceFragment();
  const personalSpace = usePersonalSpaceFragment();
  return useCallback(
    (routeId: string, options?: ReviewDestinationOptions) =>
      reviewDestinationFromEnvelope(routeId, envelope, { workspace, personalSpace }, options),
    [envelope, workspace, personalSpace],
  );
}

/** Single-destination convenience hook. */
export function useReviewDestination(
  routeId: string,
  options?: ReviewDestinationOptions,
): ReviewDestination {
  return useReviewDestinationResolver()(routeId, options);
}
