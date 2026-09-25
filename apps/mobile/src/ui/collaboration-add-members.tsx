/**
 * ADD WORKSPACE MEMBERS TO A GROUP (T-12 / RC-13) — the native port of the
 * web's `AddMemberPanel` (collaboration-teams/[teamId]/_tabs/MembersTab.tsx).
 *
 * The group is built from people who ALREADY hold workspace access: the
 * server's `eligible-members` directory (searchable, active members not yet
 * in the group). Multi-select, keyed by user id so a search does not drop a
 * selection. One person uses the single-member writer; several use the bulk
 * route, which loops the same writer per person on the server. Partial
 * success is reported, not rounded, and the failures stay selected.
 *
 * This panel is not an invitation writer. Someone not yet in the workspace is
 * handed to Workspace People — a link, as on the web.
 */
import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { useToast } from "../toast-context";
import { theme } from "../theme/theme";
import {
  COLLABORATION_TEAM_ROLES,
  addSubmitLabel,
  buildEligibleMembersPath,
  buildTeamMembersAddPath,
  buildTeamMembersBulkPath,
  bulkAddOutcome,
  collaborationRoleLabel,
  parseBulkAddResult,
  parseEligibleMembers,
  type EligibleMember,
} from "../product/collaboration";
import { ProovraButton, ProovraCard, ProovraInput, ProovraText } from "./index";
import { ProovraFilterChips } from "./patterns";

type Role = (typeof COLLABORATION_TEAM_ROLES)[number];

export function CollaborationAddMembers({
  teamId,
  onAdded,
  onClose,
}: {
  teamId: string;
  onAdded: () => Promise<void> | void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [eligible, setEligible] = useState<EligibleMember[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [role, setRole] = useState<Role>("MEMBER" as Role);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      apiFetch(buildEligibleMembersPath(teamId, search))
        .then((page) => {
          if (!cancelled) setEligible(parseEligibleMembers(page));
        })
        .catch((err) => {
          if (cancelled) return;
          setEligible([]);
          addToast(toSafeUserError(err, { message: "Could not load workspace members." }).message, "error");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [teamId, search, addToast]);

  const toggle = (userId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  const submit = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      if (ids.length === 1) {
        await apiFetch(buildTeamMembersAddPath(teamId), { method: "POST", body: JSON.stringify({ userId: ids[0], role }) });
        await onAdded();
        addToast("Added to this team.", "success");
        onClose();
        return;
      }
      const result = parseBulkAddResult(
        await apiFetch(buildTeamMembersBulkPath(teamId), { method: "POST", body: JSON.stringify({ userIds: ids, role }) }),
      );
      await onAdded();
      const outcome = bulkAddOutcome(result);
      addToast(outcome.message, outcome.tone);
      if (outcome.close) onClose();
      else setSelected(new Set(result.failed.map((f) => f.userId)));
    } catch (err) {
      // The server is the authority on capacity and on who may be added.
      addToast(toSafeUserError(err, { message: "Could not add these people to the team." }).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProovraCard>
      <View style={{ gap: theme.space.s3 }} testID="add-member-panel">
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          People who already have access to this workspace. To bring someone new into the workspace, invite them in workspace people first.
        </ProovraText>
        <ProovraButton label="Workspace people" variant="ghost" fullWidth={false} onPress={() => router.push("/(stack)/workspace-people")} />
        <ProovraInput value={search} onChangeText={setSearch} placeholder="Search this workspace" accessibilityLabel="Search workspace members" />

        {loading ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Loading…</ProovraText>
        ) : eligible.length === 0 ? (
          <View style={{ gap: theme.space.s2 }} testID="add-member-empty">
            <ProovraText variant="bodySm" color={theme.color.ink.muted}>
              {search.trim() ? "Nobody in this workspace matches that." : "Everyone in this workspace is already in this team."}
            </ProovraText>
            {search.trim() ? null : (
              <ProovraButton
                label="Invite someone to the workspace"
                variant="secondary"
                fullWidth={false}
                onPress={() => router.push("/(stack)/workspace-people")}
              />
            )}
          </View>
        ) : (
          <View>
            {eligible.map((c) => {
              const checked = selected.has(c.userId);
              return (
                <Pressable
                  key={c.userId}
                  onPress={() => toggle(c.userId)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={`${c.displayName}${c.email ? `, ${c.email}` : ""}`}
                  style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s3, paddingVertical: theme.space.s2 }}
                >
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 4,
                      borderWidth: 2,
                      borderColor: checked ? theme.color.accent.a500 : theme.color.border.strong,
                      backgroundColor: checked ? theme.color.accent.a500 : "transparent",
                    }}
                  />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <ProovraText variant="bodySm">{c.displayName}</ProovraText>
                    {c.email ? <ProovraText variant="label" color={theme.color.ink.muted}>{c.email}</ProovraText> : null}
                  </View>
                  {c.workspaceRole ? (
                    <ProovraText variant="label" color={theme.color.ink.secondary}>{c.workspaceRole}</ProovraText>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        )}

        <ProovraFilterChips<Role>
          label="Role in this team"
          options={COLLABORATION_TEAM_ROLES.map((r) => ({ value: r as Role, label: collaborationRoleLabel(r) ?? r }))}
          value={role}
          onChange={setRole}
          disabled={busy}
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
          <ProovraButton
            label={addSubmitLabel(selected.size)}
            fullWidth={false}
            loading={busy}
            disabled={selected.size === 0}
            onPress={() => void submit()}
          />
          <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={busy} onPress={onClose} />
        </View>
      </View>
    </ProovraCard>
  );
}
