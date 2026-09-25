/**
 * COLLABORATION TEAM DETAIL — the whole group surface.
 *
 * Overview, members, pending invitations, Discussion, WORK and SETTINGS, from
 * GET /v1/collaboration-teams/:id (the server binds it to the active
 * workspace). A 403 means no collaboration capability, which is an honest
 * unavailable state rather than a failure.
 *
 * Work and Settings used to be absent, and the screen said "Roles inside this
 * collaboration group are managed in the PROOVRA web app" — a web handoff in
 * copy on a manifest-required surface. Both are here now, each gated the way
 * the routes gate them.
 *
 * A 404 from any collaboration route is an AUTHORIZATION answer: the routes
 * answer 404 rather than 403 so a denial never confirms a group exists.
 */
import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiFetch } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import {
  parseCollaborationTeamDetail,
  parseTeamDiscussionAccess,
  collaborationRoleLabel,
  parseTeamMemberLimit,
  teamAtCapacity,
  COLLABORATION_ENTITLEMENT_PATH,
  type CollaborationTeamDetail,
} from "../../../src/product/collaboration";
import { humanizeEnum } from "../../../src/product/domain-display";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../../src/ui";
import { TeamDiscussion } from "../../../src/ui/team-discussion";
import { CreateAssignmentSheet } from "../../../src/ui/create-assignment";
import { collaborationTeamRoleHasPermission } from "@proovra/shared";
import { CollaborationWorkSection } from "../../../src/ui/collaboration-work";
import { CollaborationSettingsSection } from "../../../src/ui/collaboration-settings";
import { canAddTeamMembers } from "../../../src/product/collaboration-permissions";
import { CollaborationAddMembers } from "../../../src/ui/collaboration-add-members";

type Phase = "loading" | "ready" | "error" | "notfound" | "unavailable";

export default function CollaborationTeamDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? "";
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [team, setTeam] = useState<CollaborationTeamDetail | null>(null);
  // T-12 — the per-group member ceiling, from the entitlement projection. An
  // unknown limit (read failed) never blocks: the server re-checks capacity.
  const [memberLimit, setMemberLimit] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  // The server's comment-moderation authority + whether the viewer is here by workspace governance only.
  const [discussionAccess, setDiscussionAccess] = useState({ canModerate: false, viaWorkspaceGovernance: false });
  const [assigning, setAssigning] = useState(false);
  const [workRevision, setWorkRevision] = useState(0);

  // `silent` refreshes in place: flipping to the loading phase unmounts the
  // add-members panel and would discard the failed selection it keeps open.
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!id) return;
    if (!opts?.silent) setPhase("loading");
    setError(null);
    try {
      const data = await apiFetch(`/v1/collaboration-teams/${id}`);
      const detail = parseCollaborationTeamDetail(data);
      setDiscussionAccess(parseTeamDiscussionAccess(data));
      if (!detail) {
        setPhase("notfound");
        return;
      }
      setTeam(detail);
      setPhase("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "forbidden") setPhase("unavailable");
      else if (safe.kind === "notFound") setPhase("notfound");
      else {
        setError(safe);
        setPhase("error");
      }
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    apiFetch(COLLABORATION_ENTITLEMENT_PATH)
      .then((e) => {
        if (!cancelled) setMemberLimit(parseTeamMemberLimit(e));
      })
      .catch(() => {
        /* additive — capacity is re-checked by the server on every add */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "loading") return <ProovraScreen shell scroll={false}><ProovraLoadingState label="Loading group" /></ProovraScreen>;
  if (phase === "unavailable") return <ProovraScreen shell scroll={false}><ProovraEmptyState title="Not available" message="Collaboration groups are part of Team plans." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} /></ProovraScreen>;
  if (phase === "notfound") return <ProovraScreen shell scroll={false}><ProovraEmptyState title="Group not found" message="This collaboration group is no longer available." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} /></ProovraScreen>;
  if (phase === "error" && error) return <ProovraScreen shell scroll={false}><ProovraErrorState message={error.message} requestId={error.requestId ?? null} onRetry={() => void load()} /></ProovraScreen>;

  const t = team!;
  const canAdd = canAddTeamMembers(t);
  const atCapacity = teamAtCapacity(t.activeMemberCount, memberLimit);
  return (
    <ProovraScreen shell>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>

      <ProovraCard style={styles.hero}>
        <ProovraText variant="h1" weight="bold">{t.name}</ProovraText>
        {t.description ? <ProovraText variant="bodySm" color={theme.color.ink.secondary} style={styles.gap}>{t.description}</ProovraText> : null}
        <View style={styles.metaRow}>
          {/* Every member is told, not only the admin who can reopen it (web page.tsx:637). */}
          {t.status === "ARCHIVED" ? <ProovraBadge tone="neutral" label="Archived" /> : null}
          {t.viewerRole ? <ProovraBadge tone="governance" label={collaborationRoleLabel(t.viewerRole) ?? "Member"} /> : null}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {t.activeMemberCount} member{t.activeMemberCount === 1 ? "" : "s"}
            {t.pendingInviteCount > 0 ? ` · ${t.pendingInviteCount} pending` : ""}
          </ProovraText>
        </View>
      </ProovraCard>

      <ProovraSection title="Members">
        {canAdd ? (
          <View style={styles.addRow}>
            <ProovraButton
              label="Add workspace members"
              fullWidth={false}
              disabled={atCapacity}
              accessibilityLabel={atCapacity ? "Add workspace members, team is at capacity" : "Add workspace members"}
              onPress={() => setAdding((open) => !open)}
            />
          </View>
        ) : null}
        {atCapacity ? (
          <ProovraCard style={styles.addRow}>
            <ProovraText variant="bodySm" color={theme.color.status.pending.fg}>
              Team is at capacity for your plan. Upgrade to add more.
            </ProovraText>
            <ProovraButton label="Upgrade" variant="secondary" fullWidth={false} onPress={() => router.push("/(stack)/billing")} />
          </ProovraCard>
        ) : null}
        {adding && canAdd && !atCapacity ? (
          <View style={styles.addRow}>
            <CollaborationAddMembers teamId={String(id)} onAdded={() => load({ silent: true })} onClose={() => setAdding(false)} />
          </View>
        ) : null}
        {t.members.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>No members to show.</ProovraText>
        ) : (
          <ProovraCard>
            {t.members.map((m) => (
              <ProovraListRow
                key={m.id}
                title={m.displayName}
                subtitle={m.email ?? undefined}
                trailing={<ProovraBadge tone="neutral" label={collaborationRoleLabel(m.role) ?? "Member"} />}
              />
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      {t.invites.length > 0 ? (
        <ProovraSection title="Pending invitations">
          <ProovraCard>
            {t.invites.map((inv) => (
              <ProovraListRow
                key={inv.id}
                title={inv.email}
                subtitle={collaborationRoleLabel(inv.role) ?? undefined}
                trailing={<ProovraBadge tone="pending" label={inv.status ? humanizeEnum(inv.status) : "Pending"} />}
              />
            ))}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      {/*
        The conversation, beside the group's members. This is where the retired
        /collaboration-teams/:teamId/collaboration route now lands.
      */}
      {/* The group's conversation is its COMMENTS (web DiscussionTab), not the evidence thread system. */}
      <TeamDiscussion teamId={String(id)} canModerate={discussionAccess.canModerate} viaWorkspaceGovernance={discussionAccess.viaWorkspaceGovernance} />

      {/* The group's operational assignments — every filter server-side. */}
      {/* Create assignment: the web's canAssign — a live group and the team.assignment.create permission. */}
      {t.status !== "ARCHIVED" && collaborationTeamRoleHasPermission(t.viewerRole as never, "team.assignment.create") ? (
        <ProovraButton label="Create assignment" variant="secondary" fullWidth={false} onPress={() => setAssigning(true)} />
      ) : null}
      <CreateAssignmentSheet
        teamId={String(id)}
        members={t.members}
        visible={assigning}
        onClose={() => setAssigning(false)}
        onCreated={() => setWorkRevision((n) => n + 1)}
      />
      <CollaborationWorkSection teamId={String(id)} members={t.members} reloadToken={workRevision} />

      {/*
        Settings, roles and the administrative history. Group roles were
        previously described as "managed in the PROOVRA web app"; they are
        managed here, gated on LEAD exactly as the web tab gates them.
      */}
      <CollaborationSettingsSection
        team={t}
        onChanged={() => void load()}
        onDeleted={() => router.back()}
      />

      <ProovraButton
        label="People in this workspace"
        variant="secondary"
        onPress={() => router.push("/(stack)/workspace-people")}
      />
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4 },
  gap: { marginTop: theme.space.s2 },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s3 },
  note: { marginTop: theme.space.s2 },
  addRow: { marginBottom: theme.space.s3 },
});
