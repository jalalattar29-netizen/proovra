"use client";

/**
 * WORKSPACE SETTINGS → LIFECYCLE, for one named Workspace.
 *
 * Members & Access (`/teams/[id]`) manages people; how the Workspace ends is
 * rendered here, from the server's `lifecycle` projection, for the Workspace in
 * the URL — never for whichever Workspace happens to be active. The same
 * section backs Settings → Workspace lifecycle for the active Workspace.
 */

import Link from "next/link";
import { useCallback } from "react";
import { useParams, useRouter } from "next/navigation";

import { PageShell, PageHeader } from "../../../../../components/ui/PageShell";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { useAuth } from "../../../../providers";
import { WorkspaceLifecycleSection } from "../../../settings/_sections/WorkspaceLifecycleSection";
import { ACCOUNT_CLOSURE_HREF } from "../../../../../lib/members/workspaceLifecycleDestination";

function WorkspaceLifecyclePageBody() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const workspaceId = params?.id ?? null;
  const redirectToAccountClosure = useCallback(
    () => router.replace(ACCOUNT_CLOSURE_HREF),
    [router],
  );

  return (
    <PageShell
      header={
        <PageHeader
          title="Workspace lifecycle"
          subtitle="How this workspace ends. Workspaces are never deleted, and evidence stays governed by retention and legal hold."
          secondaryActions={
            workspaceId ? (
              <Link href={`/teams/${workspaceId}`} className="app-secondary-action">
                Back to Members &amp; Access
              </Link>
            ) : null
          }
        />
      }
    >
      <WorkspaceLifecycleSection
        workspaceId={workspaceId}
        currentUserId={user?.id ?? null}
        onOpenPrivacy={() => router.push(ACCOUNT_CLOSURE_HREF)}
        // A Personal Workspace has no lifecycle of its own: an old bookmark
        // of this URL lands its owner on account closure, replacing the
        // history entry so Back does not bounce through an empty page.
        onPersonalWorkspaceOwner={redirectToAccountClosure}
      />
    </PageShell>
  );
}

export default function WorkspaceLifecyclePage() {
  return (
    <PageRouteGate routeId="admin.teams">
      <WorkspaceLifecyclePageBody />
    </PageRouteGate>
  );
}
