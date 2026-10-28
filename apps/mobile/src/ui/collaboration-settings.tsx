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
 * ARCHIVE COLLABORATION TEAM — NEVER DELETE (2026-10-28)
 * A Collaboration Team is never customer-deleted. Archiving keeps the team and
 * its whole history, ends access through it and frees one active slot; it is
 * confirmed with the server's impact preview and the team's exact name, then
 * a recent step-up. Restore re-checks the plan and capacity server-side.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

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
  ARCHIVE_TEAM_ACTION,
  ARCHIVE_TEAM_CONSEQUENCE,
  COLLABORATION_TEAM_ROLES,
  COLLABORATION_TEAM_TYPES,
  RESTORE_TEAM_ACTION,
  RESTORE_TEAM_CONSEQUENCE,
  archiveConfirmationMatches,
  buildCollaborationMemberPath,
  buildCollaborationTeamPath,
  buildTeamActivityPath,
  buildTeamArchiveBody,
  buildTeamArchiveImpactPath,
  buildTeamArchivePath,
  buildTeamUnarchivePath,
  buildTeamUpdateBody,
  canAdministerTeam,
  collaborationRoleLabel,
  describeArchiveImpact,
  parseTeamActivity,
  parseTeamArchiveImpact,
  teamActivityLabel,
  validateTeamSettings,
  type CollaborationMember,
  type CollaborationTeamDetail,
  type TeamActivityItem,
  type TeamArchiveImpact,
} from "../product/collaboration";
import { humanizeEnum } from "../product/domain-display";
import { STEP_UP_CANCEL } from "../product/challenge-step-up";
import { ChallengeStepUpSheet, useChallengeStepUp } from "./challenge-step-up";

type Pending = { kind: "unarchive" } | null;

export function CollaborationSettingsSection({
  team,
  onChanged,
  onArchived,
}: {
  team: CollaborationTeamDetail;
  onChanged: () => void;
  onArchived: () => void;
}) {
  const teamId = team.id;
  const admin = canAdministerTeam(team.viewerRole);
  // Archiving withdraws every member's reach through the group: a recent
  // step-up, bound to this group and its workspace, through the one flow.
  const stepUp = useChallengeStepUp(team.workspaceId);

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
  // The archive sheet: the server's impact preview, the typed exact name and
  // an optional reason. `impact` null while loading; `impactFailed` offers no
  // destructive control.
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [impact, setImpact] = useState<TeamArchiveImpact | null>(null);
  const [impactFailed, setImpactFailed] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [reason, setReason] = useState("");

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
  }, [teamId]);

  const openArchive = useCallback(() => {
    setArchiveOpen(true);
    setImpact(null);
    setImpactFailed(false);
    setTypedName("");
    setReason("");
    void apiFetch(buildTeamArchiveImpactPath(teamId))
      .then((d) => {
        const parsed = parseTeamArchiveImpact(d);
        if (parsed) setImpact(parsed);
        else setImpactFailed(true);
      })
      .catch(() => setImpactFailed(true));
  }, [teamId]);

  const archive = useCallback(async () => {
    if (!impact || !archiveConfirmationMatches(typedName, team.name)) return;
    setBusy(true);
    setMessage(null);
    try {
      await stepUp.run((headers) =>
        apiFetch(buildTeamArchivePath(teamId), {
          method: "POST",
          body: JSON.stringify(buildTeamArchiveBody({ confirmName: typedName, reason })),
          ...(headers ? { headers } : {}),
        }),
      );
      setArchiveOpen(false);
      onArchived();
    } catch (err) {
      if ((err as { code?: string })?.code === STEP_UP_CANCEL) {
        setMessage("Not archived — confirmation cancelled.");
        return;
      }
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [impact, typedName, reason, team.name, teamId, stepUp, onArchived]);

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
      if (target.kind === "unarchive") {
        // Plan, active-Team count, member capacity and the workspace,
        // Organization and contract state are re-checked server-side; the
        // refusal, if there is one, is the server's to make.
        await apiFetch(buildTeamUnarchivePath(teamId), {
          method: "POST",
          body: JSON.stringify({}),
        });
        onChanged();
      }
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [pending, teamId, onChanged]);

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
        <ProovraSection title="This Collaboration Team">
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {archived ? RESTORE_TEAM_CONSEQUENCE : ARCHIVE_TEAM_CONSEQUENCE}
          </ProovraText>
          {archived ? (
            <ProovraButton
              label={RESTORE_TEAM_ACTION}
              variant="secondary"
              loading={busy}
              onPress={() => setPending({ kind: "unarchive" })}
            />
          ) : (
            <ProovraButton
              label={ARCHIVE_TEAM_ACTION}
              variant="ghost"
              loading={busy}
              onPress={openArchive}
            />
          )}
        </ProovraSection>
      ) : null}

      <ProovraSheet
        visible={archiveOpen}
        title={ARCHIVE_TEAM_ACTION}
        onClose={() => {
          if (!busy) setArchiveOpen(false);
        }}
      >
        <View style={{ gap: theme.space.s3 }} testID="archive-team-sheet">
          <ProovraText variant="bodySm" weight="semibold">
            {team.name}
          </ProovraText>
          {impactFailed ? (
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg} testID="archive-impact-failed">
              We couldn't load what archiving would affect, so the team can't be archived right now.
            </ProovraText>
          ) : impact === null ? (
            <ProovraText variant="bodySm">Checking what archiving would affect…</ProovraText>
          ) : (
            <>
              {(() => {
                const copy = describeArchiveImpact(impact);
                return (
                  <>
                    <ProovraText variant="label" weight="semibold">Affected</ProovraText>
                    {copy.affected.map((line) => (
                      <ProovraText key={line} variant="bodySm">• {line}</ProovraText>
                    ))}
                    <ProovraText variant="label" weight="semibold">Unavailable while archived</ProovraText>
                    {copy.unavailable.map((line) => (
                      <ProovraText key={line} variant="bodySm">• {line}</ProovraText>
                    ))}
                    <ProovraText variant="label" weight="semibold">Preserved</ProovraText>
                    {copy.preserved.map((line) => (
                      <ProovraText key={line} variant="bodySm">• {line}</ProovraText>
                    ))}
                    <ProovraText variant="bodySm">{copy.restore}</ProovraText>
                  </>
                );
              })()}
              <ProovraFormField label={`Type ${team.name} to confirm`}>
                <ProovraInput
                  value={typedName}
                  onChangeText={setTypedName}
                  autoCapitalize="none"
                  accessibilityLabel="Collaboration Team name confirmation"
                />
              </ProovraFormField>
              <ProovraFormField label="Reason (optional, recorded in the audit trail)">
                <ProovraInput
                  value={reason}
                  onChangeText={setReason}
                  multiline
                  accessibilityLabel="Archive reason"
                />
              </ProovraFormField>
              <ProovraButton
                label={ARCHIVE_TEAM_ACTION}
                loading={busy}
                disabled={!archiveConfirmationMatches(typedName, team.name)}
                onPress={() => void archive()}
              />
            </>
          )}
          <ProovraButton label="Cancel" variant="ghost" disabled={busy} onPress={() => setArchiveOpen(false)} />
        </View>
      </ProovraSheet>

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
        title={`Restore "${team.name}"?`}
        consequence={RESTORE_TEAM_CONSEQUENCE}
        confirmLabel={RESTORE_TEAM_ACTION}
        tone="warning"
        busy={busy}
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />
      {/* The verification sheet `stepUp.run` waits on; without it a challenged
          archive would wait on a prompt nobody can see. */}
      <ChallengeStepUpSheet stepUp={stepUp} />
    </>
  );
}
