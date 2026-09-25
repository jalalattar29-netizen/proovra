/**
 * WORKSPACE MEMBER PICKER — the native port of the web's
 * `WorkspaceMemberSelect` (evidence/[id]/components/WorkspaceMemberSelect.tsx),
 * which three web surfaces share: assigning an evidence request's reviewer,
 * granting case access, and assigning a discussion thread.
 *
 * Reads ACTIVE members only, server-side (`status=ACTIVE`), searchable and
 * paged — the web's source, states and copy. It writes nothing: the caller
 * decides what choosing a member means.
 */
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import {
  buildWorkspaceMembersPath,
  parseWorkspaceMembers,
  roleLabel,
  type WorkspaceMember,
} from "../product/workspace-people";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraInput, ProovraListRow, ProovraSheet, ProovraText } from "./index";

/** WorkspaceMemberSelect.tsx copy, verbatim. */
export const MEMBER_PICKER_COPY = {
  loading: "Loading workspace members…",
  noTeam: "This record has no workspace, so no members can be listed.",
  failed: "Workspace members could not be loaded.",
  failedMore: "More workspace members could not be loaded.",
  emptySearch: "No active workspace member matches this search.",
  empty: "This workspace has no active members to choose from.",
  more: "Show more members",
  loadingMore: "Loading more members…",
} as const;

export function WorkspaceMemberPicker({
  visible,
  title,
  teamId,
  selectedUserId,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  teamId: string | null;
  selectedUserId?: string | null;
  onSelect: (member: WorkspaceMember) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (next: string | null) => {
      if (!teamId) return;
      if (next) setLoadingMore(true);
      else setMembers(null);
      setFailed(null);
      try {
        const page = parseWorkspaceMembers(
          await apiFetch(buildWorkspaceMembersPath(teamId, next, { status: "ACTIVE", q: applied, limit: 100 })),
        );
        // The web re-filters to ACTIVE too: the picker must never offer a
        // suspended or revoked member even if the server's filter drifts.
        const active = page.members.filter((m) => m.status.toUpperCase() === "ACTIVE" && m.userId);
        setMembers((prev) => (next && prev ? [...prev, ...active] : active));
        setCursor(page.nextCursor);
      } catch {
        setFailed(next ? MEMBER_PICKER_COPY.failedMore : MEMBER_PICKER_COPY.failed);
        if (!next) setMembers([]);
      } finally {
        setLoadingMore(false);
      }
    },
    [teamId, applied],
  );

  useEffect(() => {
    if (visible) void load(null);
  }, [visible, load]);

  return (
    <ProovraSheet visible={visible} title={title} onClose={onClose}>
      <View style={{ gap: theme.space.s2 }} testID="member-picker">
        {!teamId ? (
          <ProovraText variant="bodySm">{MEMBER_PICKER_COPY.noTeam}</ProovraText>
        ) : (
          <>
            <ProovraInput value={q} onChangeText={setQ} placeholder="Search members" accessibilityLabel="Search members" onSubmitEditing={() => setApplied(q.trim())} />
            <ProovraButton label="Search" variant="secondary" fullWidth={false} onPress={() => setApplied(q.trim())} />
            {members === null ? <ProovraText variant="bodySm">{MEMBER_PICKER_COPY.loading}</ProovraText> : null}
            {failed ? (
              <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>
                {failed}
              </ProovraText>
            ) : null}
            {members && members.length === 0 && !failed ? (
              <ProovraText variant="bodySm">{applied ? MEMBER_PICKER_COPY.emptySearch : MEMBER_PICKER_COPY.empty}</ProovraText>
            ) : null}
            {members?.map((m) => (
              <ProovraListRow
                key={m.id}
                title={m.displayName || "Workspace member"}
                subtitle={roleLabel(m.role)}
                onPress={() => onSelect(m)}
                trailing={m.userId === selectedUserId ? <ProovraBadge tone="verified" label="Selected" /> : undefined}
              />
            ))}
            {cursor ? (
              <ProovraButton
                label={loadingMore ? MEMBER_PICKER_COPY.loadingMore : MEMBER_PICKER_COPY.more}
                variant="ghost"
                disabled={loadingMore}
                onPress={() => void load(cursor)}
              />
            ) : null}
          </>
        )}
      </View>
    </ProovraSheet>
  );
}
