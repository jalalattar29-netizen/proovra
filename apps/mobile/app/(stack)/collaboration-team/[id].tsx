/**
 * COLLABORATION TEAM DETAIL (Native Convergence §7/D). Members, roles and pending
 * invites of one collaboration group, from GET /v1/collaboration-teams/:id (the
 * server binds it to the active workspace). Read surface — governance/admin stays
 * on web. A 403 means no collaboration capability → honest unavailable state.
 */
import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiFetch } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import {
  parseCollaborationTeamDetail,
  collaborationRoleLabel,
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
import { DiscussionSection } from "../../../src/ui/discussion-section";

type Phase = "loading" | "ready" | "error" | "notfound" | "unavailable";

export default function CollaborationTeamDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? "";
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [team, setTeam] = useState<CollaborationTeamDetail | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setPhase("loading");
    setError(null);
    try {
      const data = await apiFetch(`/v1/collaboration-teams/${id}`);
      const detail = parseCollaborationTeamDetail(data);
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

  if (phase === "loading") return <ProovraScreen scroll={false}><ProovraLoadingState label="Loading group" /></ProovraScreen>;
  if (phase === "unavailable") return <ProovraScreen scroll={false}><ProovraEmptyState title="Not available" message="Collaboration groups are part of Team plans." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} /></ProovraScreen>;
  if (phase === "notfound") return <ProovraScreen scroll={false}><ProovraEmptyState title="Group not found" message="This collaboration group is no longer available." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} /></ProovraScreen>;
  if (phase === "error" && error) return <ProovraScreen scroll={false}><ProovraErrorState message={error.message} onRetry={load} /></ProovraScreen>;

  const t = team!;
  return (
    <ProovraScreen>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>

      <ProovraCard style={styles.hero}>
        <ProovraText variant="h1" weight="bold">{t.name}</ProovraText>
        {t.description ? <ProovraText variant="bodySm" color={theme.color.ink.secondary} style={styles.gap}>{t.description}</ProovraText> : null}
        <View style={styles.metaRow}>
          {t.viewerRole ? <ProovraBadge tone="governance" label={collaborationRoleLabel(t.viewerRole) ?? "Member"} /> : null}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {t.activeMemberCount} member{t.activeMemberCount === 1 ? "" : "s"}
            {t.pendingInviteCount > 0 ? ` · ${t.pendingInviteCount} pending` : ""}
          </ProovraText>
        </View>
      </ProovraCard>

      <ProovraSection title="Members">
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
      <DiscussionSection teamId={String(id)} />

      {/*
        This said "Manage members, roles and invitations in the PROOVRA web
        app" — a web handoff in copy on a manifest-required surface. Workspace
        membership IS native now, so it points there instead of off the device.
        Collaboration-group roles remain a web surface; that is stated, not
        implied by an absence.
      */}
      <ProovraButton
        label="People in this workspace"
        variant="secondary"
        onPress={() => router.push("/(stack)/workspace-people")}
      />
      <ProovraText variant="label" color={theme.color.ink.muted} style={styles.note}>
        Roles inside this collaboration group are managed in the PROOVRA web app.
      </ProovraText>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4 },
  gap: { marginTop: theme.space.s2 },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s3 },
  note: { marginTop: theme.space.s2 },
});
