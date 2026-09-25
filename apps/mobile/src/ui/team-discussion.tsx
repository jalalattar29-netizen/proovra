/**
 * GROUP DISCUSSION (T-14 / sweep S21–S22) — the native port of the web
 * collaboration-team Discussion tab (DiscussionTab.tsx): the group's comments,
 * post, and edit/delete for the author or a server-authorised moderator. See
 * the defect note on buildTeamCommentsPath (src/product/collaboration.ts).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";

import { apiFetch } from "../api";
import { useAuth } from "../auth-context";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import { useToast } from "../toast-context";
import { theme } from "../theme/theme";
import {
  TEAM_COMMENT_MAX,
  TEAM_DISCUSSION_COPY as COPY,
  buildTeamCommentPath,
  buildTeamCommentsPath,
  parseTeamComments,
  type TeamComment,
} from "../product/collaboration";
import { ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraSection, ProovraText } from "./index";

export function TeamDiscussion({ teamId, canModerate, viaWorkspaceGovernance }: { teamId: string; canModerate: boolean; viaWorkspaceGovernance: boolean }) {
  const { user } = useAuth();
  const viewerId = (user as { id?: string } | null)?.id ?? null;
  const { addToast } = useToast();
  const [items, setItems] = useState<TeamComment[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const page = parseTeamComments(await apiFetch(buildTeamCommentsPath(teamId)));
      setItems(page.items);
      setNames(page.names);
      setLoadError(null);
    } catch (err) {
      setLoadError(toSafeUserError(err, { message: COPY.loadFailed }).message);
      setItems((prev) => prev ?? []);
    }
  }, [teamId]);
  useEffect(() => {
    if (!viaWorkspaceGovernance) void refresh();
  }, [refresh, viaWorkspaceGovernance]);

  if (viaWorkspaceGovernance) {
    // Stated, not surfaced as a load failure (DiscussionTab.tsx governance branch).
    return (
      <ProovraSection title={COPY.title}>
        <ProovraCard>
          <ProovraText variant="bodySm" weight="semibold">{COPY.governanceTitle}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.governanceBody}</ProovraText>
        </ProovraCard>
      </ProovraSection>
    );
  }

  const post = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await apiFetch(buildTeamCommentsPath(teamId), { method: "POST", body: JSON.stringify({ targetType: "TEAM", body }) });
      setBody("");
      await refresh();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async () => {
    if (!editing || !editing.draft.trim() || busy) return;
    setBusy(true);
    try {
      await apiFetch(buildTeamCommentPath(teamId, editing.id), { method: "PATCH", body: JSON.stringify({ body: editing.draft }) });
      addToast(COPY.updated, "success");
      setEditing(null);
      await refresh();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = (c: TeamComment) => {
    Alert.alert("Delete this comment?", "It is removed for everyone in the team.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              await apiFetch(buildTeamCommentPath(teamId, c.id), { method: "DELETE" });
              addToast(COPY.deleted, "success");
              await refresh();
            } catch (err) {
              addToast(toSafeUserError(err).message, "error");
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  };

  return (
    <ProovraSection title={COPY.title}>
      <View style={{ gap: theme.space.s3 }} testID="team-discussion">
        <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.visibility}</ProovraText>
        <ProovraCard>
          <View style={{ gap: theme.space.s2 }}>
            <ProovraFormField label="Write a comment for the team">
              <ProovraInput value={body} onChangeText={(v) => setBody(v.slice(0, TEAM_COMMENT_MAX))} placeholder={COPY.placeholder} multiline />
            </ProovraFormField>
            <ProovraButton label={busy ? COPY.posting : COPY.post} accessibilityLabel={COPY.post} fullWidth={false} disabled={!body.trim() || busy} onPress={() => void post()} />
          </View>
        </ProovraCard>

        {loadError ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{loadError}</ProovraText> : null}
        {items !== null && items.length === 0 && !loadError ? (
          <ProovraCard>
            <ProovraText variant="bodySm" weight="semibold">{COPY.empty}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.emptyBody}</ProovraText>
          </ProovraCard>
        ) : null}

        {(items ?? []).map((c) => {
          const mine = viewerId !== null && c.authorUserId === viewerId;
          const isEditing = editing?.id === c.id;
          return (
            <ProovraCard key={c.id}>
              <View style={{ gap: theme.space.s1 }}>
                <ProovraText variant="label" weight="semibold">
                  {`${names[c.authorUserId] ?? COPY.unknownAuthor} · ${c.createdAt ? formatUserDateTime(c.createdAt) : ""}${c.edited ? " · edited" : ""}`}
                </ProovraText>
                {isEditing ? (
                  <>
                    <ProovraInput value={editing.draft} onChangeText={(v) => setEditing({ id: c.id, draft: v.slice(0, TEAM_COMMENT_MAX) })} multiline accessibilityLabel="Edit comment" />
                    <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
                      <ProovraButton label="Save" fullWidth={false} disabled={busy} onPress={() => void saveEdit()} />
                      <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={busy} onPress={() => setEditing(null)} />
                    </View>
                  </>
                ) : (
                  <ProovraText variant="bodySm">{c.body}</ProovraText>
                )}
                {!isEditing && (mine || canModerate) ? (
                  <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
                    <ProovraButton label="Edit" accessibilityLabel={`Edit comment ${c.id}`} variant="ghost" fullWidth={false} onPress={() => setEditing({ id: c.id, draft: c.body })} />
                    <ProovraButton label="Delete" accessibilityLabel={`Delete comment ${c.id}`} variant="ghost" fullWidth={false} onPress={() => remove(c)} />
                  </View>
                ) : null}
              </View>
            </ProovraCard>
          );
        })}
      </View>
    </ProovraSection>
  );
}
