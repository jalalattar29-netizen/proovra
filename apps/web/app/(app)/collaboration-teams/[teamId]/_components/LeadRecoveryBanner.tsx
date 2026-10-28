"use client";

/**
 * LEAD RECOVERY (members ledger X5, 2026-10-28).
 *
 * A group whose every lead left the workspace cannot be archived, renamed or
 * given a new lead by anyone inside it. The workspace owner — the authority
 * the server names for leads — can appoint one: a current member, or
 * themself. Everyone else is told who can fix it. The server decides; this
 * only offers the action to the person who reaches the group as a workspace
 * administrator.
 */

import { useState } from "react";

import { useToast } from "../../../../../components/ui";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import {
  type CollaborationTeamDetail,
  recoverTeamLead,
} from "../../../../../lib/api/collaboration-teams";

export function LeadRecoveryBanner({
  team,
  viewerUserId,
  onDone,
}: {
  team: CollaborationTeamDetail & { viaWorkspaceGovernance?: boolean };
  viewerUserId: string;
  onDone: () => void | Promise<void>;
}) {
  const { addToast } = useToast();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const candidates = team.members
    .filter((m) => m.status === "ACTIVE")
    .map((m) => ({
      value: m.userId,
      label: m.user.displayName || [m.user.firstName, m.user.lastName].filter(Boolean).join(" ") || m.user.email || "Member",
    }));
  const options = [
    ...(viewerUserId ? [{ value: viewerUserId, label: "Me" }] : []),
    ...candidates.filter((c) => c.value !== viewerUserId),
  ];

  const appoint = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await recoverTeamLead(team.id, target);
      addToast("Lead appointed.", "success");
      await onDone();
    } catch (err) {
      notifyApiError(addToast, err, { message: "Couldn't appoint a lead." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-alert" role="status" data-testid="team-lead-recovery" style={{ marginBottom: 12 }}>
      <strong>This Collaboration Team has no lead.</strong>{" "}
      {team.viaWorkspaceGovernance ? (
        <>
          As the workspace owner you can appoint one: a current member, or yourself.
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
            <span id="lead-recovery-label" className="app-field-label" style={{ margin: 0 }}>
              New lead
            </span>
            <AppListbox
              value={target}
              options={[{ value: "", label: "Choose a person" }, ...options]}
              onChange={(v) => setTarget(v)}
              ariaLabelledby="lead-recovery-label"
              id="lead-recovery-target"
            />
            <button
              type="button"
              className="app-primary-action"
              disabled={!target || busy}
              onClick={() => void appoint()}
              data-testid="team-lead-recovery-submit"
            >
              {busy ? "Appointing…" : "Appoint lead"}
            </button>
          </div>
        </>
      ) : (
        "Ask the workspace owner to appoint one."
      )}
    </div>
  );
}
