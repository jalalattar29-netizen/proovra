/**
 * SETTINGS — the group's own record, and the history of what was done to it.
 *
 * Ports `_tabs/SettingsTab.tsx` and `_tabs/ActivityTab.tsx`.
 *
 * ONLY SECTIONS WITH A REAL BACKING FIELD
 * `PATCH /v1/collaboration-teams/:teamId` supports exactly
 * { name, description, teamType }. The web tab says so in its own header and
 * renders nothing else; this does the same. A "Notifications" or "Access"
 * section with no field behind it would be a control that appears to save.
 *
 * ARCHIVE AND DELETE ARE DIFFERENT ACTIONS, AND THE DIFFERENCE MATTERS
 * Archiving keeps everything and already frees the plan slot; it can be
 * reopened. Deletion is the accidental-creation path and the server refuses it
 * for a group with any history (409 TEAM_NOT_DISPOSABLE). Because archiving
 * already frees the slot, deletion is never the route to more capacity — and
 * the surface says so rather than leaving a user to discover it by trying.
 */
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../api";
import { formatUserDateTime } from "../lib/date";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
  ProovraListRow,
  ProovraSection,
  ProovraSheet,
  ProovraConfirmSheet,
  ProovraEmpty,
} from "./index";
import {
  ARCHIVE_TEAM_CONSEQUENCE,
  COLLABORATION_TEAM_ROLES,
  COLLABORATION_TEAM_TYPES,
  DELETE_TEAM_CONSEQUENCE,
  buildCollaborationMemberPath,
  buildCollaborationTeamPath,
  buildTeamActivityPath,
  buildTeamArchivePath,
  buildTeamDisposabilityPath,
  buildTeamUnarchivePath,
  buildTeamUpdateBody,
  canAdministerTeam,
  collaborationRoleLabel,
  parseTeamActivity,
  parseTeamDisposability,
  teamActivityLabel,
  validateTeamSettings,
  type CollaborationMember,
  type CollaborationTeamDetail,
  type TeamActivityItem,
  type TeamDisposability,
} from "../product/collaboration";
import { humanizeEnum } from "../product/domain-display";

type Pending = { kind: "archive" | "unarchive" | "delete" } | null;

export function CollaborationSettingsSection({
  team,
  onChanged,
  onDeleted,
}: {
  team: CollaborationTeamDetail;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const teamId = team.id;
  const admin = canAdministerTeam(team.viewerRole);

  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [teamType, setTeamType] = useState<string>("GENERAL");
  const [typePicker, setTypePicker] = useState(false);
  const [rolePicker, setRolePicker] = useState<CollaborationMember | null>(null);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const [activity, setActivity] = useState<TeamActivityItem[] | null>(null);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [disposability, setDisposability] = useState<TeamDisposability | null>(null);

  const archived = team.status.toUpperCase() === "ARCHIVED";

  useEffect(() => {
    // Both are additive to the settings form: a refusal on either must not
    // take the editable fields with it.
    void apiFetch(buildTeamActivityPath(teamId, { limit: 25 }))
      .then((d) => {
        const page = parseTeamActivity(d);
        setActivity(page.items);
        setActivityCursor(page.nextCursor);
      })
      .catch(() => setActivity(null));

    if (admin) {
      void apiFetch(buildTeamDisposabilityPath(teamId))
        .then((d) => setDisposability(parseTeamDisposability(d)))
        .catch(() => setDisposability(null));
    }
  }, [teamId, admin]);

  const loadMoreActivity = useCallback(async () => {
    if (!activityCursor) return;
    try {
      const page = parseTeamActivity(
        await apiFetch(buildTeamActivityPath(teamId, { limit: 25, cursor: activityCursor })),
      );
      setActivity((prev) => [...(prev ?? []), ...page.items]);
      setActivityCursor(page.nextCursor);
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    }
  }, [teamId, activityCursor]);

  const save = useCallback(async () => {
    const invalid = validateTeamSettings(name);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(buildCollaborationTeamPath(teamId), {
        method: "PATCH",
        body: JSON.stringify(buildTeamUpdateBody({ name, description, teamType })),
      });
      setMessage("Saved.");
      onChanged();
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [teamId, name, description, teamType, onChanged]);

  const runPending = useCallback(async () => {
    const target = pending;
    if (!target) return;
    setPending(null);
    setBusy(true);
    setMessage(null);
    try {
      if (target.kind === "archive") {
        await apiFetch(buildTeamArchivePath(teamId), { method: "POST", body: JSON.stringify({}) });
        onChanged();
      } else if (target.kind === "unarchive") {
        // Capacity is re-checked server-side: an archived group freed a plan
        // slot, so reopening competes with creating. The refusal, if there is
        // one, is the server's to make.
        await apiFetch(buildTeamUnarchivePath(teamId), {
          method: "POST",
          body: JSON.stringify({}),
        });
        onChanged();
      } else {
        await apiFetch(buildCollaborationTeamPath(teamId), { method: "DELETE" });
        onDeleted();
      }
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [pending, teamId, onChanged, onDeleted]);

  const changeRole = useCallback(
    async (member: CollaborationMember, role: string) => {
      setRolePicker(null);
      setBusy(true);
      setMessage(null);
      try {
        await apiFetch(buildCollaborationMemberPath(teamId, member.id), {
          method: "PATCH",
          body: JSON.stringify({ role }),
        });
        onChanged();
      } catch (err) {
        setMessage(toSafeUserError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [teamId, onChanged],
  );

  return (
    <>
      {admin ? (
        <ProovraSection title="Group settings">
          <ProovraFormField label="Name">
            <ProovraInput
              value={name}
              onChangeText={setName}
              autoCapitalize="sentences"
              accessibilityLabel="Group name"
            />
          </ProovraFormField>

          <ProovraFormField label="Description">
            <ProovraInput
              value={description}
              onChangeText={setDescription}
              placeholder="What this group is for"
              autoCapitalize="sentences"
              multiline
              accessibilityLabel="Group description"
            />
          </ProovraFormField>

          <ProovraListRow
            title="Group type"
            subtitle={humanizeEnum(teamType)}
            onPress={() => setTypePicker(true)}
          />

          <ProovraButton
            label="Save changes"
            loading={busy}
            disabled={validateTeamSettings(name) !== null}
            onPress={() => void save()}
          />

          {message ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {message}
            </ProovraText>
          ) : null}
        </ProovraSection>
      ) : null}

      {admin ? (
        <ProovraSection title="Roles">
          <ProovraCard>
            {team.members.map((m) => (
              <ProovraListRow
                key={m.id}
                title={m.displayName}
                subtitle={m.email ?? undefined}
                onPress={() => setRolePicker(m)}
                trailing={
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {collaborationRoleLabel(m.role) ?? "Member"}
                  </ProovraText>
                }
              />
            ))}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      <ProovraSection title="History">
        {activity === null ? (
          <ProovraEmpty
            presence="inline"
            title="This group's history is visible to its members."
          />
        ) : activity.length === 0 ? (
          <ProovraEmpty presence="inline" title="Nothing has been recorded yet." />
        ) : (
          <>
            <ProovraCard>
              {activity.map((a) => (
                <ProovraListRow
                  key={a.id}
                  title={teamActivityLabel(a.eventType)}
                  subtitle={
                    a.occurredAtIso ? formatUserDateTime(a.occurredAtIso) : undefined
                  }
                />
              ))}
            </ProovraCard>
            {activityCursor ? (
              <ProovraButton
                label="Load older"
                variant="ghost"
                onPress={() => void loadMoreActivity()}
              />
            ) : null}
          </>
        )}
      </ProovraSection>

      {admin ? (
        <ProovraSection title="This group">
          {archived ? (
            <ProovraButton
              label="Reopen this group"
              variant="secondary"
              loading={busy}
              onPress={() => setPending({ kind: "unarchive" })}
            />
          ) : (
            <ProovraButton
              label="Archive this group"
              variant="ghost"
              loading={busy}
              onPress={() => setPending({ kind: "archive" })}
            />
          )}

          {/*
            Deletion is offered only when the SERVER says the group carries no
            operational record. Absent means not disposable: defaulting to yes
            on a permanent delete would be the client deciding a destructive
            question the server owns.
          */}
          {disposability?.disposable ? (
            <ProovraButton
              label="Delete this group"
              variant="ghost"
              loading={busy}
              onPress={() => setPending({ kind: "delete" })}
            />
          ) : disposability && disposability.blockers.length > 0 ? (
            <ProovraCard>
              <ProovraText variant="label" weight="semibold">
                This group cannot be deleted
              </ProovraText>
              {disposability.blockers.map((b) => (
                <ProovraText key={b} variant="label" color={theme.color.ink.muted}>
                  {b}
                </ProovraText>
              ))}
              <ProovraText variant="label" color={theme.color.ink.muted}>
                Archiving is the action for a group that has done work, and it already frees
                the plan slot.
              </ProovraText>
            </ProovraCard>
          ) : null}
        </ProovraSection>
      ) : null}

      <ProovraSheet
        visible={typePicker}
        title="Group type"
        onClose={() => setTypePicker(false)}
      >
        {COLLABORATION_TEAM_TYPES.map((t) => (
          <ProovraListRow
            key={t}
            title={humanizeEnum(t)}
            subtitle={t === teamType ? "Current" : undefined}
            onPress={() => {
              setTeamType(t);
              setTypePicker(false);
            }}
          />
        ))}
      </ProovraSheet>

      <ProovraSheet
        visible={rolePicker !== null}
        title={rolePicker ? `${rolePicker.displayName}'s role` : ""}
        onClose={() => setRolePicker(null)}
      >
        {COLLABORATION_TEAM_ROLES.map((r) => (
          <ProovraListRow
            key={r}
            title={collaborationRoleLabel(r) ?? r}
            subtitle={rolePicker && r === rolePicker.role ? "Current" : undefined}
            onPress={() => {
              if (rolePicker) void changeRole(rolePicker, r);
            }}
          />
        ))}
      </ProovraSheet>

      <ProovraConfirmSheet
        visible={pending !== null}
        title={
          pending?.kind === "archive"
            ? "Archive this group?"
            : pending?.kind === "unarchive"
              ? "Reopen this group?"
              : "Delete this group permanently?"
        }
        consequence={
          pending?.kind === "archive"
            ? ARCHIVE_TEAM_CONSEQUENCE
            : pending?.kind === "unarchive"
              ? "It becomes usable for new work again. This takes a plan slot, so it competes with creating a new group."
              : DELETE_TEAM_CONSEQUENCE
        }
        confirmLabel={
          pending?.kind === "archive"
            ? "Archive"
            : pending?.kind === "unarchive"
              ? "Reopen"
              : "Delete permanently"
        }
        tone={pending?.kind === "unarchive" ? "warning" : "danger"}
        busy={busy}
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
