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

import { useEffect, useState } from "react";

import { useToast } from "../../../../../components/ui";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import {
  type CollaborationTeamDetail,
  listTeamMembers,
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

  // Every ACTIVE member, paged from the server — the detail payload's member
  // list is a 25-row preview, so a larger group's members would be missing.
  const [candidates, setCandidates] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    if (!team.viaWorkspaceGovernance) return;
    let cancelled = false;
    void (async () => {
      const rows: Array<{ value: string; label: string }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const res = await listTeamMembers(team.id, { status: "ACTIVE", limit: 100, cursor });
        for (const m of res.members) rows.push({ value: m.userId, label: m.displayName || "Member" });
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      if (!cancelled) setCandidates(rows);
    })().catch(() => {
      if (!cancelled) setCandidates([]);
    });
    return () => {
      cancelled = true;
    };
  }, [team.id, team.viaWorkspaceGovernance]);
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
