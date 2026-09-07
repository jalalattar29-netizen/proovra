"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusBadge } from "../../../../../components/app-primitives/AppStatusBadge";
import { ApiError } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import {
  type CollaborationTeamDetail,
  archiveTeam,
  unarchiveTeam,
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
// { name, description, teamType }; `archiveTeam` is the only destructive op
// (no delete endpoint). Therefore:
//   A. General details      — name, description, Save changes           [real]
//   B. Team configuration   — Template (teamType)                       [real]
//   E. Danger zone          — Archive team                              [real]
// Sections C (Notifications) and D (Access & permissions) have no field on
// updateTeam and are intentionally omitted rather than fabricated. Notification
// preferences live on the separate collaboration/page.tsx with their own API.
// =============================================================================

const TEAM_TYPE_OPTIONS = COLLABORATION_TEAM_TYPES.map((t) => ({
  value: t,
  label: t.charAt(0) + t.slice(1).toLowerCase(),
}));

function SettingsTab({
  team,
  onChange,
  canManage,
  canArchive,
}: {
  team: CollaborationTeamDetail;
  onChange: () => Promise<void>;
  canManage: boolean;
  canArchive: boolean;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const router = useRouter();
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [teamType, setTeamType] = useState<CollaborationTeamType>(team.teamType);
  const [busy, setBusy] = useState(false);

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
      if (err instanceof ApiError) {
        notifyApiError(addToast, err);
      } else {
        addToast("Couldn't save settings.", "error");
      }
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
      if (err instanceof ApiError) {
        notifyApiError(addToast, err);
      } else {
        addToast("Couldn't archive team.", "error");
      }
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
      if (err instanceof ApiError) {
        notifyApiError(addToast, err);
      } else {
        addToast("Couldn't reopen team.", "error");
      }
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
              Template
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
              Shapes default workflow and terminology for the team. Save changes
              above to apply.
            </p>
            {/* Value carrier — preserves the settings-team-type test contract. */}
            <span data-testid="settings-team-type" hidden>
              {teamType}
            </span>
          </div>
        </div>

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
          </div>
        </div>
      </div>
    </section>
  );
}

export { SettingsTab };
