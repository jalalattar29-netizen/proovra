/**
 * RETIRED — the legacy Collaboration-Team invitation link.
 *
 * Route: `/collaboration-teams/invites/[token]/accept`
 *
 * Team remediation T-121 (ARCH-13, COR-M). Collaboration-Team invitations
 * stopped being CREATED on 2026-09-06 (the create route answers 410); people
 * now join a workspace through the workspace invitation (`/invite/<token>`)
 * and are then added to a Collaboration Team from its Members tab. A
 * Collaboration-Team invitation lived for 7 days, so every link that was ever
 * sent has expired.
 *
 * This page therefore ACCEPTS NOTHING. It sends no request, keeps no token,
 * and says what to do instead. The API accept route is left untouched for
 * any older client; it is not called from here.
 *
 * Security: the token in the path is never read, stored, logged or sent.
 * Any hand-off an older build left in this tab's sessionStorage is cleared.
 */

"use client";

import { useEffect } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { ProovraSystemState } from "../../../../../../components/feedback/ProovraSystemState";

/** The sessionStorage key older builds used to hold a token across sign-in. */
const LEGACY_HANDOFF_KEY = "proovra-collab-invite-handoff";

const RETIRED_TEAM_INVITE_TITLE = "This invitation link is no longer used";

const RETIRED_TEAM_INVITE_MESSAGE =
  "Collaboration Team invitation links have been replaced by workspace invitations. Ask the workspace owner or an admin to invite you to the workspace: you receive an email with a link to accept. Once you have joined, they can add you to the Collaboration Team.";

export default function RetiredCollaborationTeamInvitePage() {
  return (
    <PageRouteGate routeId="workspace.collaboration_team_invite_accept">
      <RetiredCollaborationTeamInvite />
    </PageRouteGate>
  );
}

function RetiredCollaborationTeamInvite() {
  useEffect(() => {
    try {
      window.sessionStorage.removeItem(LEGACY_HANDOFF_KEY);
    } catch {
      // No storage: nothing was held.
    }
  }, []);

  return (
    <div data-testid="accept-invite-page" data-status="retired">
      <ProovraSystemState
        context="authenticated"
        presentation="contained"
        kind="invitation-invalid"
        statusLabel="Collaboration Team invitation"
        title={RETIRED_TEAM_INVITE_TITLE}
        message={RETIRED_TEAM_INVITE_MESSAGE}
        testId="team-invite-retired"
        actions={[
          { label: "Go to Home", href: "/home", variant: "primary", testId: "team-invite-retired-home" },
          {
            label: "Collaboration Teams",
            href: "/collaboration-teams",
            variant: "secondary",
            testId: "team-invite-retired-teams",
          },
        ]}
      />
    </div>
  );
}
