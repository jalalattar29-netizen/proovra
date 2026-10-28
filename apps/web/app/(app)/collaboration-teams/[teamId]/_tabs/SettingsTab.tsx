"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusBadge } from "../../../../../components/app-primitives/AppStatusBadge";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import type { SafeErrorFallback } from "../../../../../lib/feedback/toSafeUserError";
import {
  type CollaborationTeamDetail,
  type CollaborationTeamMember,
  archiveTeam,
  unarchiveTeam,
  updateMember,
  updateTeam,
} from "../../../../../lib/api/collaboration-teams";
import { ArchiveTeamDialog } from "../_components/ArchiveTeamDialog";
import {
  COLLABORATION_TEAM_TYPES,
  type CollaborationTeamType,
} from "@proovra/shared";

// =============================================================================
// Settings tab
//
// Sections mapped to REAL backing fields only. `updateTeam` supports exactly
// { name, description, teamType }. Therefore:
//   A. General details      — name, description, Save changes           [real]
//   B. Team configuration   — Team type (teamType)                      [real]
//   C. Leadership           — grant LEAD via updateMember               [real]
//   E. Danger zone          — Archive / Restore Collaboration Team      [real]
//
// 2026-10-28 — there is no Delete. A Collaboration Team is never
// customer-deleted: archiving preserves it and everything it did, and needs a
// recent step-up.
// Notifications and Access & permissions have no field on updateTeam and are
// intentionally omitted rather than fabricated. Notification preferences live
// on the separate collaboration/page.tsx with their own API.
// =============================================================================

/** The person, named the way every other Collaboration Team surface names them. */
function memberLabel(member: CollaborationTeamMember): string {
  return (
    member.user.displayName ||
    [member.user.firstName, member.user.lastName].filter(Boolean).join(" ") ||
    member.user.email ||
    member.userId.slice(0, 8)
  );
}

const TEAM_TYPE_OPTIONS = COLLABORATION_TEAM_TYPES.map((t) => ({
  value: t,
  label: t.charAt(0) + t.slice(1).toLowerCase(),
}));

function SettingsTab({
  team,
  onChange,
  canManage,
  canArchive,
  canTransferLead,
  onError,
}: {
  team: CollaborationTeamDetail;
  onChange: () => Promise<void>;
  /** Role AND lifecycle — the page folds `status` in, so an archived team
   *  arrives here already false and no control has to remember. */
  canManage: boolean;
  /**
   * Role only (`team.archive`): Archive on an active team AND Restore on an
   * archived one. Not folded with the lifecycle — Restore exists precisely
   * for the archived state.
   */
  canArchive: boolean;
  canTransferLead: boolean;
  onError: (err: unknown, fallback?: SafeErrorFallback) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const router = useRouter();
  const stepUp = useStepUpAction({ teamId: team.workspaceId });
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [teamType, setTeamType] = useState<CollaborationTeamType>(team.teamType);
  const [busy, setBusy] = useState(false);
  const [leadTarget, setLeadTarget] = useState("");

  /**
   * Who may be made Lead — ACTIVE members who are not already one.
   *
   * The eligibility rule is the SERVER's (`changeMemberRole` refuses a
   * non-member, and only a LEAD may grant LEAD); this narrows the list to
   * candidates that call would accept, so the control cannot offer a choice
   * that is certain to fail. A SUSPENDED or REMOVED member is not offered.
   */
  const leadCandidates = team.members.filter(
    (m) => m.status === "ACTIVE" && m.role !== "LEAD",
  );

  const onTransferLead = async () => {
    const target = leadCandidates.find((m) => m.id === leadTarget);
    if (!target) return;
    const name = memberLabel(target);
    const ok = await confirm({
      title: "Make this member a Lead?",
      description: `${name} will become a Lead of this Collaboration Team, with full team management including archiving and granting leadership. This does not change workspace ownership or billing.`,
      confirmLabel: "Make Lead",
      tone: "neutral",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await updateMember(team.id, target.id, { role: "LEAD" });
      addToast(`${name} is now a Lead of this team.`, "success");
      setLeadTarget("");
      // The viewer's OWN capabilities can change as a result, so the whole
      // detail is refetched rather than the roster patched in place.
      await onChange();
    } catch (err) {
      onError(err, { message: "Couldn't change this team's leadership." });
    } finally {
      setBusy(false);
    }
  };

  // Save-disabled-until-dirty: current field values compared to the loaded team.
  const dirty =
    name !== team.name ||
    description !== (team.description ?? "") ||
    teamType !== team.teamType;

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await updateTeam(team.id, {
        name: name !== team.name ? name : undefined,
        description:
          description !== (team.description ?? "")
            ? description || null
            : undefined,
        teamType: teamType !== team.teamType ? teamType : undefined,
      });
      addToast("Settings saved.", "success");
      await onChange();
    } catch (err) {
      notifyApiError(addToast, err, { message: "Couldn't save settings." });
    } finally {
      setBusy(false);
    }
  };

  const [archiveOpen, setArchiveOpen] = useState(false);

  /**
   * ARCHIVE — the confirmation collects the exact name and an optional reason
   * after showing the server's impact preview; the archive then runs through
   * the one step-up flow, bound to this team. Nothing is archived unless the
   * step-up succeeds; cancelling it changes nothing.
   */
  const onArchiveConfirmed = async (input: { confirmName: string; reason?: string }) => {
    setBusy(true);
    try {
      const result = await stepUp.runStepUpAction(
        async (headers) => archiveTeam(team.id, input, headers ?? undefined),
        { teamId: team.workspaceId },
      );
      setArchiveOpen(false);
      addToast(
        result.alreadyArchived
          ? "This Collaboration Team was already archived."
          : "Collaboration Team archived. Its history is preserved.",
        "success",
      );
      router.push("/collaboration-teams");
    } catch (err) {
      if ((err as { code?: string })?.code === "STEP_UP_CANCEL") {
        addToast("Not archived — confirmation cancelled.", "info");
        return;
      }
      notifyApiError(addToast, err, { message: "Couldn't archive the Collaboration Team." });
    } finally {
      setBusy(false);
    }
  };

  /**
   * RESTORE (WCR-13). The server re-checks plan entitlement, the active-Team
   * count, per-Team member capacity, and the workspace, Organization and
   * contract state at this moment — a refusal names which, and the copy says
   * so before anyone clicks.
   */
  const onUnarchive = async () => {
    const ok = await confirm({
      title: `Restore "${team.name}"?`,
      description:
        "Restoring makes this Collaboration Team active again, so it uses one of your plan's active Team slots. Your plan, the number of active Teams and the team's member capacity are checked first. Tasks cancelled and invitations revoked when it was archived stay as they are.",
      confirmLabel: "Restore Collaboration Team",
      tone: "neutral",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await unarchiveTeam(team.id);
      addToast("Collaboration Team restored.", "success");
      await onChange();
    } catch (err) {
      notifyApiError(addToast, err, { message: "Couldn't restore the Collaboration Team." });
    } finally {
      setBusy(false);
    }
  };

  const isArchived = team.status === "ARCHIVED";

  // Restore is reachable on an archived team (WCR-13): only a viewer who can
  // neither edit nor archive is refused the tab.
  if (!canManage && !canArchive) {
    return (
      <div className="app-panel" data-testid="settings-permission-denied">
        <div className="app-panel__body">
          <p style={{ margin: 0, color: "#5F6878", fontSize: 13.5 }}>
            Only LEAD and ADMIN can change team settings.
          </p>
        </div>
      </div>
    );
  }

  return (
    /*
     * A SETTINGS GRID, NOT A 620px COLUMN (§1).
     *
     * Every card here was stacked full-width inside a `maxWidth: 620` section,
     * which on a 1360px page meant a narrow ribbon of cards down the left and
     * roughly half the page permanently empty beside it. Nothing about these
     * cards needed that: two of them are a single select and a paragraph.
     *
     * `.app-grid-panels` is the canonical panel row and its `--pairs` variant
     * fixes the column count at two, because the base `auto-fit` resolves to
     * THREE at this width — right for a rail of status panels, wrong for a card
     * holding a form. Cards top-align, each pair shares a width, and no height
     * is forced: two cards with different amounts of content are allowed to
     * differ rather than being stretched to match.
     *
     * WHAT SPANS, AND WHY:
     *   row 1  General details | Team configuration   — a form and a classifier,
     *          both editing the team's own fields; genuine peers
     *   row 2  Leadership                             — full width; its body is
     *          three lines of governance copy that reads badly in a half column
     *          and would otherwise leave the right half empty
     *   row 3  Danger zone                            — full width, separated;
     *          its rows are [explanation | action] bars that need the width, and
     *          a destructive card should not share a line with a routine one
     *
     * Below 900px the grid is a single clean stack, so a portrait tablet or a
     * phone never gets two columns holding a textarea each.
     */
    <section data-testid="tab-settings-content">
      <div
        className="app-grid-panels app-grid-panels--pairs"
        data-testid="settings-grid"
      >
        {/* A–C are editing controls: shown only while the team can be edited
            (an archived team is restored first). */}
        {canManage ? (
        <>
        {/* A. General details */}
        <div className="app-panel">
          <div className="app-panel__head">
            <h3 className="app-panel__title">General details</h3>
          </div>
          <div className="app-panel__body">
            <form onSubmit={onSave}>
              <div style={{ marginBottom: 16 }}>
                <label
                  className="app-field-label"
                  htmlFor="settings-name-input"
                >
                  Team name
                </label>
                <input
                  id="settings-name-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  required
                  data-testid="settings-name"
                  className="app-form-input"
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label
                  className="app-field-label"
                  htmlFor="settings-description-input"
                >
                  Description
                </label>
                <textarea
                  id="settings-description-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={600}
                  rows={3}
                  data-testid="settings-description"
                  className="app-form-input"
                />
                <p className="app-field-help">
                  What this team is for. Visible to members.
                </p>
              </div>

              <button
                type="submit"
                disabled={!dirty || busy}
                className="app-primary-action"
                data-testid="settings-save"
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
            </form>
          </div>
        </div>

        {/* B. Team configuration */}
        <div className="app-panel">
          <div className="app-panel__head">
            <h3 className="app-panel__title">Team configuration</h3>
          </div>
          <div className="app-panel__body">
            <label
              className="app-field-label"
              htmlFor="settings-team-type-listbox"
              id="settings-team-type-label"
            >
              Team type
            </label>
            <AppListbox<CollaborationTeamType>
              id="settings-team-type-listbox"
              value={teamType}
              options={TEAM_TYPE_OPTIONS}
              ariaLabelledby="settings-team-type-label"
              disabled={busy}
              onChange={(v) => setTeamType(v)}
            />
            <p className="app-field-help">
              {/*
                TRUTHFUL COPY (§15). This said the type "shapes default workflow
                and terminology". It does not: `teamType` is validated, stored
                and echoed, and no branch anywhere in the API or the console
                reads it. It is a classification an operator sets and filters
                by, so that is what it now claims to be.
              */}
              Classifies the team&rsquo;s operational purpose. Used for
              filtering and reporting; it does not change how the team works.
              Save changes above to apply.
            </p>
            {/* Value carrier — preserves the settings-team-type test contract. */}
            <span data-testid="settings-team-type" hidden>
              {teamType}
            </span>
          </div>
        </div>

        {/*
          C. LEADERSHIP (§14).

          `team.transfer_lead` and its server rule — only a LEAD may grant LEAD
          — have existed since the permission catalog was written, and no
          control ever reached them. A Lead who wanted to hand the team over had
          no way to do it from Settings.

          THIS IS THE TEAM'S LEADERSHIP AND NOTHING ELSE. It does not touch
          workspace ownership, workspace roles, seats or billing, and the copy
          says so, because "transfer leadership" is exactly the phrase a person
          would fear meant their workspace.

          IT USES THE EXISTING WRITER. `updateMember(role: "LEAD")` is the same
          call the Members tab makes; the service records `LEAD_TRANSFERRED`
          when the target was not already a Lead. No second path, no service
          logic in the route, no new endpoint.

          AND IT IS HONEST ABOUT WHAT HAPPENS. A team may hold more than one
          Lead, so granting Lead does not demote the actor — saying "transfer"
          and then leaving two Leads would be the same false copy this pass
          removed from the type field. The second step is offered in words.
        */}
        {canTransferLead ? (
          <div
            className="app-panel app-grid-panels__full"
            data-testid="settings-leadership"
          >
            <div className="app-panel__head">
              <h3 className="app-panel__title">Leadership</h3>
            </div>
            <div className="app-panel__body">
              {leadCandidates.length === 0 ? (
                <p className="app-table__muted" style={{ margin: 0 }}>
                  There is no other active member to make a Lead. Add someone to
                  the team first, from the Members tab.
                </p>
              ) : (
                <>
                  <label
                    className="app-field-label"
                    htmlFor="settings-transfer-lead-listbox"
                    id="settings-transfer-lead-label"
                  >
                    Make another member Lead
                  </label>
                  <div style={{ maxWidth: 340 }}>
                    <AppListbox<string>
                      id="settings-transfer-lead-listbox"
                      value={leadTarget}
                      options={[
                        { value: "", label: "Choose a member…" },
                        ...leadCandidates.map((m) => ({
                          value: m.id,
                          label: memberLabel(m),
                        })),
                      ]}
                      ariaLabelledby="settings-transfer-lead-label"
                      disabled={busy}
                      onChange={(v) => setLeadTarget(v)}
                    />
                  </div>
                  <p className="app-field-help">
                    Grants Lead on <strong>this Collaboration Team</strong> —
                    full team management, including archiving and leadership.
                    This does not change workspace ownership, workspace roles or
                    billing. A team can have more than one Lead; to step down
                    afterwards, change your own role from the Members tab.
                  </p>
                  <button
                    type="button"
                    className="app-secondary-action"
                    style={{ marginTop: 10 }}
                    disabled={!leadTarget || busy}
                    onClick={() => void onTransferLead()}
                    data-testid="settings-transfer-lead"
                  >
                    {busy ? "Working…" : "Make Lead"}
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}
        </>
        ) : null}

        {/* E. Danger zone — visually separated, red-tinted panel */}
        <div
          className="app-panel app-grid-panels__full"
          data-testid="settings-danger-zone"
          style={{
            border: "1px solid rgba(201, 54, 62, 0.28)",
            background: "rgba(255, 241, 242, 0.6)",
          }}
        >
          <div
            className="app-panel__head"
            style={{ borderBottomColor: "rgba(201, 54, 62, 0.16)" }}
          >
            <h3 className="app-panel__title" style={{ color: "#A9222B" }}>
              Danger zone
            </h3>
            {isArchived ? (
              <AppStatusBadge tone="red">Archived</AppStatusBadge>
            ) : null}
          </div>
          <div className="app-panel__body">
            <div
              className="app-inner-surface"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                padding: "14px 16px",
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    fontWeight: 650,
                    color: "#172033",
                  }}
                >
                  {isArchived ? "Restore Collaboration Team" : "Archive Collaboration Team"}
                </p>
                <p
                  style={{
                    margin: "4px 0 0",
                    fontSize: 12,
                    lineHeight: 1.45,
                    color: "#5F6878",
                  }}
                >
                  {isArchived
                    ? "This Collaboration Team is archived: its members have no access through it and it takes no new work, and its membership, assignments, discussion and activity are preserved. Restoring checks your plan, your active Teams and its member capacity first."
                    : "Archiving ends access through this team and stops new work, and keeps the team and its whole history. Collaboration Teams are never deleted. You'll confirm the team's name and that it is you."}
                </p>
              </div>
              {isArchived ? (
                <button
                  type="button"
                  onClick={() => void onUnarchive()}
                  disabled={!canArchive || busy}
                  className="app-secondary-action"
                  data-testid="settings-unarchive"
                >
                  {busy ? "Restoring…" : "Restore Collaboration Team"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setArchiveOpen(true)}
                  disabled={!canArchive || busy}
                  className="app-danger-action"
                  data-testid="settings-archive"
                >
                  Archive Collaboration Team
                </button>
              )}
            </div>

          </div>
        </div>
      </div>
      {archiveOpen ? (
        <ArchiveTeamDialog
          teamId={team.id}
          teamName={team.name}
          busy={busy}
          onCancel={() => setArchiveOpen(false)}
          onConfirm={(input) => void onArchiveConfirmed(input)}
        />
      ) : null}
      <StepUpModal control={stepUp} />
    </section>
  );
}

export { SettingsTab };
