"use client";

/**
 * Workspace People — the canonical STATIC entry point.
 *
 * =============================================================================
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * =============================================================================
 * This is a RESOLVER, not a surface. It renders no roster, reads no
 * membership, issues no invitation, and holds no copy of anything the
 * Workspace People surface owns. Its whole job is to answer one question the
 * navigation layer cannot answer on its own — *which* workspace's people? —
 * and then get out of the way.
 *
 * The Workspace People surface is `/teams/[id]`
 * (`app/(app)/teams/[id]/page.tsx`): workspace members, workspace invitations,
 * seats, roles, ownership transfer, closure. It is keyed by the WORKSPACE id,
 * so no static href can name it. Its index (`/teams`) was deleted in Phase 2B
 * and 308s to `/collaboration-teams`, which left the surface reachable only by
 * typing a URL — a PRO or TEAM workspace sells 5 and 10 seats respectively and
 * had no in-product path to fill seats 2..n.
 *
 * A resolver is the smallest thing that closes that: the navigation registry,
 * the command palette and any component without a workspace in scope name
 * `/people`, and the operator lands on their own workspace's canonical
 * surface. One module produces the href
 * (`lib/navigation/workspacePeopleLocator.ts`); this page consumes it.
 *
 * =============================================================================
 * IT GRANTS NOTHING
 * =============================================================================
 * `replace()` is a navigation, not an authorization. The destination is gated
 * by `PageRouteGate routeId="admin.teams"` (capability `TEAM_VIEW`), by the
 * `/teams` surface-tier rule, and server-side by persisted workspace
 * membership on every `/v1/teams/:id/*` call. Landing here proves nothing and
 * unlocks nothing; a caller with no workspace simply sees the honest state
 * below rather than a redirect into a 404.
 *
 * `replace` rather than `push` on purpose: the resolver must not sit in the
 * back stack, or "back" from Workspace People bounces through it and forward
 * again.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ProovraSystemState } from "../../../components/feedback/ProovraSystemState";
import { usePlatformContext } from "../../../lib/platform-context";
import { buildWorkspacePeopleHref } from "../../../lib/navigation/workspacePeopleLocator";

export default function WorkspacePeopleResolverPage() {
  return (
    <PageRouteGate routeId="workspace.people">
      <WorkspacePeopleResolver />
    </PageRouteGate>
  );
}

function WorkspacePeopleResolver() {
  const router = useRouter();
  const { activeWorkspaceId, state } = usePlatformContext();

  useEffect(() => {
    if (!activeWorkspaceId) return;
    router.replace(buildWorkspacePeopleHref(activeWorkspaceId));
  }, [activeWorkspaceId, router]);

  /**
   * FAIL OPEN INTO A HONEST STATE, NEVER INTO A GUESS.
   *
   * While the envelope is in flight there is no workspace to name, and
   * substituting one would send the operator into another tenant's URL. The
   * loading state is rendered until the server answers; only a READY envelope
   * with no workspace is treated as "you have none", because that is the only
   * moment the absence is a fact rather than a race.
   */
  if (activeWorkspaceId) {
    return (
      <ProovraSystemState
        kind="unavailable"
        context="authenticated"
        statusLabel="Workspace people"
        title="Opening workspace people…"
        message="Taking you to the people in your current workspace."
        testId="workspace-people-resolving"
      />
    );
  }

  if (state.name !== "READY") {
    return (
      <ProovraSystemState
        kind="unavailable"
        context="authenticated"
        statusLabel="Workspace people"
        title="Loading your workspace…"
        message="Reading the workspace you are currently working in."
        testId="workspace-people-loading"
      />
    );
  }

  return (
    <ProovraSystemState
      kind="workspace-unavailable"
      context="authenticated"
      title="No workspace is selected"
      message="Workspace people are managed inside a workspace. Switch to one from the account menu, and this page will open its members and invitations."
      testId="workspace-people-no-workspace"
    />
  );
}
