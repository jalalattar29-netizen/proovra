/**
 * TEAM RESPONSIBILITY PANEL (T-12 / RC-13) — the native port of
 * `TeamResponsibilityPanel.tsx`, on the case and on the evidence Review tab.
 *
 * Read (which groups coordinate this record), assign from the record, edit
 * (assignee / priority / due / note) and remove — every write through the
 * group's own assignment writers. A failed read is said quietly and never
 * breaks the record it sits on; a failed team list means no assign control.
 *
 * Touch adaptations: the web modal becomes a bottom sheet; listboxes become
 * chips; the `datetime-local` input becomes a validated "YYYY-MM-DD HH:MM"
 * field (no date-picker module in this build).
 */
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDate } from "../lib/date";
import { useToast } from "../toast-context";
import { theme } from "../theme/theme";
import {
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  buildAssignmentPath,
  buildAssignmentsPath,
  buildCollaborationTeamsPath,
  parseCollaborationTeams,
  type CollaborationTeamRow,
} from "../product/collaboration";
import { assignableTeams } from "../product/collaboration-permissions";
import {
  ASSIGNEE_TEAM_LEVEL_SHORT,
  RESPONSIBILITY_COPY,
  RESPONSIBILITY_REMOVE_BODY,
  buildResponsibilityCreateBody,
  buildResponsibilityMembersPath,
  buildResponsibilityUpdateBody,
  buildTeamResponsibilityPath,
  formatLocalDueInput,
  parseLocalDueInput,
  parseResponsibilityMembers,
  parseTeamResponsibility,
  responsibilityPriorityLabel,
  responsibilityPriorityTone,
  responsibilityStatusLabel,
  type ResponsibilityMemberOption,
  type ResponsibilityTarget,
  type TeamResponsibilityRow,
} from "../product/team-responsibility";
import { ASSIGNEE_TEAM_LEVEL_LABEL } from "./collaboration-work";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraSection, ProovraText } from "./index";
import { ProovraConfirmSheet, ProovraFilterChips, ProovraSheet } from "./patterns";

type Dialog =
  | { kind: "assign" }
  | { kind: "edit"; row: TeamResponsibilityRow };

export function TeamResponsibilityPanel({ targetType, targetId }: { targetType: ResponsibilityTarget; targetId: string }) {
  const router = useRouter();
  const { addToast } = useToast();
  const [rows, setRows] = useState<TeamResponsibilityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignable, setAssignable] = useState<CollaborationTeamRow[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [removing, setRemoving] = useState<TeamResponsibilityRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(parseTeamResponsibility(await apiFetch(buildTeamResponsibilityPath(targetType, targetId))));
      setError(null);
    } catch (err) {
      // A coordination panel must never break the record it sits on.
      setError(toSafeUserError(err, { message: RESPONSIBILITY_COPY.loadFailed }).message);
      setRows([]);
    }
  }, [targetType, targetId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    apiFetch(buildCollaborationTeamsPath({ limit: 100 }))
      .then((page) => {
        if (!cancelled) setAssignable(assignableTeams(parseCollaborationTeams(page)));
      })
      // A missing list means no assign control, never a broken record page.
      .catch(() => {
        if (!cancelled) setAssignable([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async () => {
    const row = removing;
    if (!row) return;
    setBusy(true);
    try {
      await apiFetch(buildAssignmentPath(row.teamId, row.id), { method: "PATCH", body: JSON.stringify(RESPONSIBILITY_REMOVE_BODY) });
      addToast("Removed from that team.", "success");
      setRemoving(null);
      await load();
    } catch (err) {
      addToast(toSafeUserError(err, { message: RESPONSIBILITY_COPY.removeFailed }).message, "error");
    } finally {
      setBusy(false);
    }
  };

  // Nothing loaded yet — render nothing rather than a flash of an empty panel.
  if (rows === null) return null;

  return (
    <ProovraSection title={RESPONSIBILITY_COPY.title}>
      <ProovraCard>
        <View style={{ gap: theme.space.s3 }} testID="team-responsibility-panel">
          {assignable.length > 0 ? (
            <ProovraButton label="Assign to a team" variant="secondary" fullWidth={false} onPress={() => setDialog({ kind: "assign" })} />
          ) : null}
          {error ? (
            <ProovraText variant="bodySm" color={theme.color.ink.muted}>{error}</ProovraText>
          ) : rows.length === 0 ? (
            <ProovraText variant="bodySm" color={theme.color.ink.muted}>{RESPONSIBILITY_COPY.empty}</ProovraText>
          ) : (
            rows.map((r) => {
              const manageable = assignable.some((t) => t.id === r.teamId);
              return (
                <View key={r.id} style={{ gap: theme.space.s1 }} testID={`team-responsibility-${r.id}`}>
                  <ProovraButton
                    label={r.teamName}
                    variant="ghost"
                    fullWidth={false}
                    accessibilityLabel={`Open ${r.teamName}`}
                    onPress={() => router.push(`/(stack)/collaboration-team/${encodeURIComponent(r.teamId)}`)}
                  />
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
                    <ProovraBadge tone={responsibilityPriorityTone(r.priority)} label={responsibilityPriorityLabel(r.priority)} />
                    <ProovraText variant="label" color={theme.color.ink.secondary}>{responsibilityStatusLabel(r.status)}</ProovraText>
                    {r.dueAtUtc ? (
                      <ProovraText variant="label" color={r.overdue ? theme.color.status.risk.fg : theme.color.ink.muted}>
                        {`${r.overdue ? "Overdue — due " : "Due "}${formatUserDate(r.dueAtUtc)}`}
                      </ProovraText>
                    ) : null}
                    {r.assigneeUserId ? null : (
                      <ProovraText variant="label" color={theme.color.ink.muted}>{ASSIGNEE_TEAM_LEVEL_SHORT}</ProovraText>
                    )}
                  </View>
                  {manageable ? (
                    <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
                      <ProovraButton
                        label="Edit"
                        variant="ghost"
                        fullWidth={false}
                        accessibilityLabel={`Edit ${r.teamName}'s responsibility`}
                        onPress={() => setDialog({ kind: "edit", row: r })}
                      />
                      <ProovraButton
                        label="Remove from team"
                        variant="danger"
                        fullWidth={false}
                        accessibilityLabel={`Remove ${r.teamName} from this record`}
                        onPress={() => setRemoving(r)}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
          <ProovraText variant="label" color={theme.color.ink.muted}>{RESPONSIBILITY_COPY.footnote}</ProovraText>
        </View>
      </ProovraCard>

      {dialog ? (
        <ResponsibilitySheet
          title={dialog.kind === "assign" ? RESPONSIBILITY_COPY.assignTitle : `Edit ${dialog.row.teamName}'s responsibility`}
          description={dialog.kind === "assign" ? RESPONSIBILITY_COPY.assignDescription : RESPONSIBILITY_COPY.editDescription}
          // The team is fixed when editing: moving work between groups is a
          // remove plus an assign, so the activity shows both halves.
          teams={dialog.kind === "assign" ? assignable : assignable.filter((t) => t.id === dialog.row.teamId)}
          initial={
            dialog.kind === "edit"
              ? {
                  teamId: dialog.row.teamId,
                  assigneeUserId: dialog.row.assigneeUserId ?? "",
                  priority: dialog.row.priority,
                  due: formatLocalDueInput(dialog.row.dueAtUtc),
                  note: dialog.row.note ?? "",
                }
              : undefined
          }
          onClose={() => setDialog(null)}
          onSubmit={async (teamId, values) => {
            if (dialog.kind === "assign") {
              await apiFetch(buildAssignmentsPath(teamId), {
                method: "POST",
                body: JSON.stringify(buildResponsibilityCreateBody(targetType, targetId, values)),
              });
              addToast("Assigned to the team.", "success");
            } else {
              await apiFetch(buildAssignmentPath(dialog.row.teamId, dialog.row.id), {
                method: "PATCH",
                body: JSON.stringify(buildResponsibilityUpdateBody(values)),
              });
              addToast("Responsibility updated.", "success");
            }
            setDialog(null);
            await load();
          }}
        />
      ) : null}

      <ProovraConfirmSheet
        visible={!!removing}
        title={removing ? `Remove ${removing.teamName} from this record?` : ""}
        consequence={RESPONSIBILITY_COPY.removeConsequence}
        confirmLabel="Remove from team"
        tone="danger"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove()}
      />
    </ProovraSection>
  );
}

function priorityOptionLabel(p: string): string {
  return p === "NORMAL" ? "Normal" : `${p.charAt(0)}${p.slice(1).toLowerCase()}`;
}

/** ONE sheet for both record-side writes, as on the web. */
function ResponsibilitySheet({
  title,
  description,
  teams,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  teams: CollaborationTeamRow[];
  initial?: { teamId: string; assigneeUserId: string; priority: string; due: string; note: string };
  onClose: () => void;
  onSubmit: (
    teamId: string,
    values: { assigneeUserId: string; priority: string; dueAtUtc: string | null; note: string },
  ) => Promise<void>;
}) {
  const { addToast } = useToast();
  const [teamId, setTeamId] = useState(initial?.teamId ?? teams[0]?.id ?? "");
  const [assigneeUserId, setAssigneeUserId] = useState(initial?.assigneeUserId ?? "");
  const [priority, setPriority] = useState(initial?.priority ?? "NORMAL");
  const [due, setDue] = useState(initial?.due ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [members, setMembers] = useState<ResponsibilityMemberOption[]>([]);
  const [busy, setBusy] = useState(false);

  // The chosen team's OWN active members — the only people who may hold its work.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(buildResponsibilityMembersPath(teamId))
      .then((page) => {
        if (!cancelled) setMembers(parseResponsibilityMembers(page));
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const dueAtUtc = parseLocalDueInput(due);
  const dueError = dueAtUtc === undefined ? "Enter the date and time as YYYY-MM-DD HH:MM." : null;

  const submit = async () => {
    if (!teamId || busy || dueAtUtc === undefined) return;
    setBusy(true);
    try {
      await onSubmit(teamId, { assigneeUserId, priority, dueAtUtc, note });
    } catch (err) {
      // The server is the authority on who may assign; its refusal is shown as given.
      addToast(toSafeUserError(err, { message: RESPONSIBILITY_COPY.saveFailed }).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProovraSheet visible title={title} onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID="responsibility-sheet">
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{description}</ProovraText>
        {teams.length > 1 ? (
          <ProovraFilterChips<string>
            label="Team"
            options={teams.map((t) => ({ value: t.id, label: t.name }))}
            value={teamId}
            onChange={(v) => {
              setTeamId(v);
              // The assignee belongs to the previous team's roster.
              setAssigneeUserId("");
            }}
          />
        ) : null}
        <ProovraFilterChips<string>
          label="Assignee"
          options={[{ value: "", label: ASSIGNEE_TEAM_LEVEL_LABEL }, ...members.map((m) => ({ value: m.userId, label: m.label }))]}
          value={assigneeUserId}
          onChange={setAssigneeUserId}
        />
        <ProovraText variant="label" color={theme.color.ink.muted}>{RESPONSIBILITY_COPY.teamLevelHelp}</ProovraText>
        <ProovraFilterChips<string>
          label="Priority"
          options={COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.map((p) => ({ value: p, label: priorityOptionLabel(p) }))}
          value={priority}
          onChange={setPriority}
        />
        <ProovraFormField label="Due" error={dueError}>
          <ProovraInput value={due} onChangeText={setDue} placeholder="YYYY-MM-DD HH:MM" accessibilityLabel="Due" />
        </ProovraFormField>
        <ProovraFormField label="Note">
          <ProovraInput value={note} onChangeText={(v) => setNote(v.slice(0, 600))} multiline autoCapitalize="sentences" />
        </ProovraFormField>
        <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
          <ProovraButton label="Cancel" variant="ghost" fullWidth={false} onPress={onClose} />
          <ProovraButton
            label={busy ? "Saving…" : "Save"}
            accessibilityLabel="Save responsibility"
            fullWidth={false}
            disabled={busy || !teamId || !!dueError}
            onPress={() => void submit()}
          />
        </View>
      </View>
    </ProovraSheet>
  );
}
