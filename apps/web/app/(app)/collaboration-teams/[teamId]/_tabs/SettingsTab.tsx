"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusBadge } from "../../../../../components/app-primitives/AppStatusBadge";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import type { SafeErrorFallback } from "../../../../../lib/feedback/toSafeUserError";
import {
  type CollaborationTeamDetail,
  type CollaborationTeamMember,
  type CollaborationTeamDisposability,
  archiveTeam,
  deleteTeam,
  getTeamDisposability,
  unarchiveTeam,
  updateMember,
  updateTeam,
} from "../../../../../lib/api/collaboration-teams";
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
//   E. Danger zone          — Archive / Reopen / Delete                 [real]
//
// The old note here said "archiveTeam is the only destructive op (no delete
// endpoint)" while this tab rendered a Delete button against a live
// `DELETE /v1/collaboration-teams/:teamId`. The comment predated the endpoint
// and was never corrected.
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
  canDelete,
  canTransferLead,
  onError,
}: {
  team: CollaborationTeamDetail;
  onChange: () => Promise<void>;
  /** Role AND lifecycle — the page folds `status` in, so an archived team
   *  arrives here already false and no control has to remember. */
  canManage: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canTransferLead: boolean;
  onError: (err: unknown, fallback?: SafeErrorFallback) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const router = useRouter();
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

  /**
   * The SERVER's disposition on permanent deletion. `null` means not yet known
   * — while loading, and if the read fails. A failed read must never surface a
   * destructive control, so `null` shows neither Delete nor a claim that the
   * group is protected.
   *
   * Keyed on the group id so a different team never inherits the previous
   * one's answer.
   */
  const [disposability, setDisposability] =
    useState<CollaborationTeamDisposability | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDisposability(null);
    void getTeamDisposability(team.id)
      .then((d) => {
        if (!cancelled) setDisposability(d);
      })
      .catch(() => {
        if (!cancelled) setDisposability(null);
      });
    return () => {
      cancelled = true;
    };
  }, [team.id]);

  /**
   * Delete is reached only when the projection says the group is disposable,
   * so the confirmation describes what it actually does rather than warning
   * about consequences that cannot occur here. No typed-name confirmation:
   * that ceremony belongs to destroying work, and this group has none — asking
   * for it would be the bureaucracy §15.26 rules out.
   */
  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete "${team.name}" permanently?`,
      description:
        "This team has no operational records. Deleting permanently removes the team itself. " +
        "Workspace members keep their access, and cases and evidence are not affected.",
      confirmLabel: "Delete team",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteTeam(team.id);
      addToast("Team deleted.", "success");
      router.push("/collaboration-teams");
    } catch (err) {
      notifyApiError(addToast, err, { message: "Couldn't delete team." });
    } finally {
      setBusy(false);
    }
  };

  const onArchive = async () => {
    const ok = await confirm({
      title: `Archive "${team.name}"?`,
      description:
        "The team is hidden from the overview and drops out of active work routing. Assignments, discussion and activity history are preserved, and the team can be reopened from this page — reopening re-checks your plan's Team allowance, because an archived team does not occupy one.",
      confirmLabel: "Archive team",
      tone: "danger",
      requireConfirmText: team.name,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await archiveTeam(team.id);
      addToast("Team archived.", "success");
      router.push("/collaboration-teams");
    } catch (err) {
      notifyApiError(addToast, err, { message: "Couldn't archive team." });
    } finally {
      setBusy(false);
    }
  };

  /**
   * WCR-13 (2026-09-07) — the operation the dialog above always promised.
   *
   * Archiving was one-way: no service function, no route, no client call, and
   * every mutation route refusing an archived group. The confirmation said
   * members would lose access *"until the team is unarchived"*, which was not
   * true of anything the product could do.
   *
   * Reopening RE-CHECKS CAPACITY server-side, and the copy says so, because an
   * archived group does not occupy a plan slot: a workspace can archive one,
   * create another, and then find the first cannot come back. That refusal is
   * a real 409 with the plan and the ceiling in it, not a surprise.
   */
  const onUnarchive = async () => {
    setBusy(true);
    try {
      await unarchiveTeam(team.id);
      addToast("Team reopened.", "success");
      await onChange();
    } catch (err) {
      notifyApiError(addToast, err, { message: "Couldn't reopen team." });
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
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

  const isArchived = team.status === "ARCHIVED";

  return (
    <section data-testid="tab-settings-content" style={{ maxWidth: 620 }}>
      <div className="app-section-stack">
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
          <div className="app-panel" data-testid="settings-leadership">
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

        {/* E. Danger zone — visually separated, red-tinted panel */}
        <div
          className="app-panel"
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
                  Archive team
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
                    ? "This team is archived: it is hidden from the overview and out of active work routing, and its assignments, discussion and activity are preserved. Reopening re-checks your plan's Team allowance, because an archived team does not occupy one."
                    : "Hides the team from the overview and removes it from active work routing. Assignments, discussion and activity history are preserved, and you can reopen it from here."}
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
                  {busy ? "Reopening…" : "Reopen team"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void onArchive()}
                  disabled={!canArchive || busy}
                  className="app-danger-action"
                  data-testid="settings-archive"
                >
                  Archive team
                </button>
              )}
            </div>

            {/*
              DELETE — the accidental-creation case, and ONLY that.

              The control is offered only when the SERVER says the group carries
              no operational record. §15.28 is explicit that a failed request
              must not be how an operator learns deletion is unsafe, so a
              history-bearing group gets an explanation and Archive instead of a
              destructive button that answers 409.

              This is never a route to capacity: an ARCHIVED group already
              consumes no active slot, so nobody needs to erase history to make
              room. Archive retires work; Delete removes a group that never did
              any.

              `null` means the disposition has not arrived — no Delete control
              and no claim either way, which is the honest state while loading
              and the safe one if the read fails.
            */}
            {disposability === null ? null : disposability.disposable ? (
              <div
                className="app-inner-surface"
                data-testid="settings-delete-available"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  padding: "14px 16px",
                  flexWrap: "wrap",
                  marginTop: 12,
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
                    Delete team
                  </p>
                  <p
                    style={{
                      margin: "4px 0 0",
                      fontSize: 12,
                      lineHeight: 1.45,
                      color: "#5F6878",
                    }}
                  >
                    This team has no assignments, discussion or activity history.
                    Deleting permanently removes the team itself. Workspace
                    members, cases and evidence are not affected.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={!canDelete || busy}
                  className="app-danger-action"
                  data-testid="settings-delete"
                >
                  Delete team
                </button>
              </div>
            ) : (
              <p
                className="app-alert"
                data-testid="settings-delete-blocked"
                style={{ marginTop: 12 }}
              >
                <strong>This team has operational history.</strong> It is linked
                to work that the workspace keeps a record of, so it cannot be
                permanently deleted. Archive it instead — the history stays
                available and the team stops using one of your active team
                slots.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export { SettingsTab };
