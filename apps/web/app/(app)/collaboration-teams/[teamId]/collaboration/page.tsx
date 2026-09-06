"use client";

/**
 * RETIRED DESTINATION — redirects into the team it belonged to.
 *
 * `/collaboration-teams/:teamId/collaboration` was a second page for one group,
 * holding five panels. Three of them did nothing at all: guests wrote a row and
 * sent no invitation and granted no access, access review recorded decisions
 * and enforced none of them, and the "Daily" digest had no consumer anywhere in
 * the worker. The other two duplicated surfaces that already exist — the
 * notification list showed rows the global inbox already reads, and per-team
 * notification preferences were a third preference store with no stated
 * precedence against workspace and organization policy.
 *
 * What was left is a conversation among the people in a group, and that belongs
 * beside the group's members and its work, not behind a second link. It is the
 * Discussion tab now.
 *
 * The route survives as a REDIRECT rather than a 404 because these links are in
 * people's history, in bookmarks and in messages they sent each other. It
 * preserves the team id and lands on the tab that carries what they came for.
 * When no link to it remains, the registry entry and this file go together.
 */

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function RetiredCollaborationHubPage() {
  const params = useParams<{ teamId: string }>();
  const router = useRouter();
  const teamId = params?.teamId ?? "";

  useEffect(() => {
    if (!teamId) return;
    router.replace(`/collaboration-teams/${teamId}?tab=discussion`);
  }, [router, teamId]);

  return (
    <main className="cc-page" data-testid="collaboration-hub-retired">
      <p className="app-empty__body">Opening the team discussion…</p>
    </main>
  );
}
