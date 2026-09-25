/**
 * CREATE ASSIGNMENT (T-14) — the touch port of the web CreateAssignmentModal:
 * delegate a case, evidence item or evidence review from THIS workspace to a
 * teammate or to the team. The target comes from the server's assignable
 * list (never a pasted id); listboxes become chips; the due date uses the same
 * local "YYYY-MM-DD HH:MM" entry as team responsibility.
 */
import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  ASSIGNEE_TEAM_LEVEL_LABEL,
  ASSIGNMENT_PRIORITY_OPTIONS,
  ASSIGNMENT_TARGET_OPTIONS,
  buildAssignableTargetsPath,
  buildCreateAssignmentBody,
  buildCreateAssignmentPath,
  parseAssignableTargets,
  type AssignableTarget,
  type AssignmentPriority,
  type AssignmentTargetType,
  type CollaborationMember,
} from "../product/collaboration";
import { parseLocalDueInput } from "../product/team-responsibility";
import { ProovraButton, ProovraFormField, ProovraInput, ProovraText } from "./index";
import { ProovraFilterChips, ProovraSheet } from "./patterns";

export function CreateAssignmentSheet({
  teamId,
  members,
  visible,
  onClose,
  onCreated,
}: {
  teamId: string;
  members: CollaborationMember[];
  visible: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [targetType, setTargetType] = useState<AssignmentTargetType>("CASE");
  const [search, setSearch] = useState("");
  const [targets, setTargets] = useState<AssignableTarget[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [target, setTarget] = useState<AssignableTarget | null>(null);
  const [assignee, setAssignee] = useState<string>("");
  const [priority, setPriority] = useState<AssignmentPriority>("NORMAL");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Changing the kind clears the chosen record and the search, as on the web.
  useEffect(() => {
    setTarget(null);
    setSearch("");
  }, [targetType]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoadingTargets(true);
    const handle = setTimeout(
      () => {
        apiFetch(buildAssignableTargetsPath(teamId, targetType, search))
          .then((d) => {
            if (!cancelled) setTargets(parseAssignableTargets(d));
          })
          .catch(() => {
            if (!cancelled) setTargets([]);
          })
          .finally(() => {
            if (!cancelled) setLoadingTargets(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [teamId, targetType, search, visible]);

  const kind = ASSIGNMENT_TARGET_OPTIONS.find((o) => o.value === targetType)?.label ?? "Record";
  const dueIso = parseLocalDueInput(due);
  const dueInvalid = dueIso === undefined;

  const submit = async () => {
    if (!target || busy || dueInvalid) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(buildCreateAssignmentPath(teamId), {
        method: "POST",
        body: JSON.stringify(buildCreateAssignmentBody({ targetType, targetId: target.id, assigneeUserId: assignee || null, priority, dueAtUtc: dueIso ?? null, note })),
      });
      setTarget(null);
      setNote("");
      setDue("");
      await onCreated();
      onClose();
    } catch (err) {
      setError(toSafeUserError(err, { message: "Couldn't create assignment." }).message);
    } finally {
      setBusy(false);
    }
  };

  const assigneeOptions = [
    { value: "", label: ASSIGNEE_TEAM_LEVEL_LABEL },
    ...members.filter((m) => m.status === "ACTIVE" && m.userId).map((m) => ({ value: m.userId as string, label: m.displayName })),
  ];

  return (
    <ProovraSheet visible={visible} title="Create assignment" onClose={onClose}>
      <View style={{ gap: theme.space.s3 }} testID="create-assignment">
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          Delegate a case, evidence item, or evidence review to a teammate or to the team.
        </ProovraText>
        <ProovraFilterChips<AssignmentTargetType> label="Target type" options={ASSIGNMENT_TARGET_OPTIONS} value={targetType} onChange={setTargetType} />

        <ProovraFormField label={kind}>
          <ProovraInput value={search} onChangeText={setSearch} placeholder={`Search ${kind.toLowerCase()}s in this workspace`} accessibilityLabel={`Search ${kind.toLowerCase()}s`} autoCapitalize="none" />
        </ProovraFormField>
        {target ? (
          <ProovraText variant="bodySm" weight="semibold">{`Selected: ${target.label}`}</ProovraText>
        ) : loadingTargets ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Searching…</ProovraText>
        ) : targets.length === 0 ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{`No ${kind.toLowerCase()}s in this workspace match that.`}</ProovraText>
        ) : (
          <View style={{ gap: 2 }}>
            {targets.slice(0, 20).map((x) => (
              <Pressable key={x.id} onPress={() => setTarget(x)} accessibilityRole="button" accessibilityLabel={`Choose ${x.label}`} style={{ paddingVertical: theme.space.s1 }}>
                <ProovraText variant="bodySm">{x.label}</ProovraText>
                {x.sublabel ? <ProovraText variant="label" color={theme.color.ink.muted}>{x.sublabel}</ProovraText> : null}
              </Pressable>
            ))}
          </View>
        )}

        <ProovraFilterChips<string> label="Assignee" options={assigneeOptions} value={assignee} onChange={setAssignee} />
        <ProovraFilterChips<AssignmentPriority> label="Priority" options={ASSIGNMENT_PRIORITY_OPTIONS} value={priority} onChange={setPriority} />
        <ProovraFormField label="Due date (optional)" error={dueInvalid ? "Use YYYY-MM-DD HH:MM, in your local time." : null}>
          <ProovraInput value={due} onChangeText={setDue} placeholder="YYYY-MM-DD HH:MM" autoCapitalize="none" />
        </ProovraFormField>
        <ProovraFormField label="Description (optional)">
          <ProovraInput value={note} onChangeText={(v) => setNote(v.slice(0, 2000))} placeholder="Add context so the assignee knows what's expected." multiline />
        </ProovraFormField>

        {error ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{error}</ProovraText> : null}
        <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
          <ProovraButton label={busy ? "Creating…" : "Create assignment"} accessibilityLabel="Create assignment" fullWidth={false} disabled={!target || busy || dueInvalid} onPress={() => void submit()} />
          <ProovraButton label="Cancel" variant="ghost" fullWidth={false} onPress={onClose} />
        </View>
      </View>
    </ProovraSheet>
  );
}
