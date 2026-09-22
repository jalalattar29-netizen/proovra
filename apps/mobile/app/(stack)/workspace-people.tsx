/**
 * WORKSPACE PEOPLE — the native port of `apps/web/app/(app)/teams/[id]/page.tsx`.
 *
 * Members, invitations and seats for the ACTIVE workspace. The web keys this
 * surface by workspace id and reaches it through a resolver at `/people`
 * because no static href can name it; native has no URL bar at all, so it
 * takes the active workspace directly from the canonical platform context and
 * this screen IS the resolver's destination.
 *
 * Until this existed a PRO or TEAM customer on a phone had no way to fill the
 * seats they had paid for.
 *
 * Counts come from the server's `stats`, never from the length of the member
 * page — the web route's own comment records what happened when a detail read
 * tried to carry every membership.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../src/api";
import { formatUserDateTime } from "../../src/lib/date";
import { toSafeUserError } from "../../src/errors/safe-error";
import { usePlatformContext } from "../../src/product/platform-context";
import { useToast } from "../../src/toast-context";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraListRow,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraFilterChips,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
  ProovraConfirmSheet,
} from "../../src/ui";
import {
  INVITABLE_ROLES,
  buildWorkspaceInvitePath,
  buildWorkspaceInviteResendPath,
  buildWorkspaceInvitesPath,
  buildWorkspaceMembersPath,
  buildWorkspacePath,
  canInviteMore,
  looksLikeEmail,
  memberStatusTone,
  parseWorkspaceInvites,
  parseWorkspaceMembers,
  parseWorkspaceOverview,
  roleLabel,
  seatsSummary,
  type WorkspaceInvite,
  type WorkspaceMember,
  type WorkspaceOverview,
} from "../../src/product/workspace-people";

type Phase = "loading" | "ready" | "failed";

export default function WorkspacePeopleScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const { context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;

  const [phase, setPhase] = useState<Phase>("loading");
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [invitesReadable, setInvitesReadable] = useState(true);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("MEMBER");
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<WorkspaceInvite | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setPhase("loading");
    try {
      const [detail, page] = await Promise.all([
        apiFetch(buildWorkspacePath(teamId)),
        apiFetch(buildWorkspaceMembersPath(teamId)),
      ]);
      const ov = parseWorkspaceOverview(detail);
      const mp = parseWorkspaceMembers(page);
      setOverview(ov);
      setMembers(mp.members);
      setCursor(mp.nextCursor);
      setPhase("ready");

      // Invitations are admin-gated; a 403 is an answer about this user's
      // role, not a failure of the page, so the roster still renders.
      try {
        setInvites(parseWorkspaceInvites(await apiFetch(buildWorkspaceInvitesPath(teamId))));
        setInvitesReadable(true);
      } catch {
        setInvites([]);
        setInvitesReadable(false);
      }
    } catch {
      setPhase("failed");
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!teamId || !cursor) return;
    setBusy(true);
    try {
      const mp = parseWorkspaceMembers(await apiFetch(buildWorkspaceMembersPath(teamId, cursor)));
      setMembers((prev) => [...prev, ...mp.members]);
      setCursor(mp.nextCursor);
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, cursor, addToast]);

  const invite = useCallback(async () => {
    if (!teamId) return;
    const value = email.trim();
    if (!looksLikeEmail(value)) {
      addToast("Enter an email address to invite.", "error");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(buildWorkspaceInvitesPath(teamId), {
        method: "POST",
        body: JSON.stringify({ email: value, role }),
      });
      setEmail("");
      addToast("Invitation sent.", "success");
      await load();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, email, role, addToast, load]);

  const resend = useCallback(
    async (inviteId: string) => {
      if (!teamId) return;
      setBusy(true);
      try {
        await apiFetch(buildWorkspaceInviteResendPath(teamId, inviteId), { method: "POST" });
        addToast("Invitation resent.", "success");
        await load();
      } catch (err) {
        addToast(toSafeUserError(err).message, "error");
      } finally {
        setBusy(false);
      }
    },
    [teamId, addToast, load],
  );

  const revoke = useCallback(async () => {
    if (!teamId || !revoking) return;
    const target = revoking;
    setRevoking(null);
    setBusy(true);
    try {
      await apiFetch(buildWorkspaceInvitePath(teamId, target.id), { method: "DELETE" });
      addToast("Invitation revoked.", "success");
      await load();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, revoking, addToast, load]);

  const seats = overview?.seats ?? null;
  const summary = seats ? seatsSummary(seats) : null;
  const roomLeft = seats ? canInviteMore(seats) : null;

  return (
    <ProovraScreen testID="workspace-people">
      <ProovraPageHeader
        title="People"
        eyebrow={overview?.name ?? "Workspace"}
        subtitle="Who is in this workspace, and who has been invited."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {!teamId ? (
        <ProovraEmpty
          presence="page"
          title="No workspace is selected"
          purpose="People are managed inside a workspace. Switch to one, and this opens its members and invitations."
        />
      ) : null}

      {teamId && phase === "loading" ? <ProovraLoadingState label="Loading people" /> : null}
      {teamId && phase === "failed" ? (
        <ProovraErrorState message="This workspace could not be loaded." onRetry={() => void load()} />
      ) : null}

      {phase === "ready" && overview ? (
        <>
          <ProovraCard>
            <ProovraText variant="body" weight="semibold">
              {`${overview.seats.memberCount} member${overview.seats.memberCount === 1 ? "" : "s"}`}
            </ProovraText>
            {/*
              Stated only when the server gave enough to state it. A plan that
              publishes no seat limit has an UNKNOWN allowance, and printing
              "0 available" would tell an owner they cannot invite anyone when
              nobody has said so.
            */}
            {summary ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {summary}
              </ProovraText>
            ) : null}
            {overview.effectivePlan ? (
              <ProovraBadge label={overview.effectivePlan} tone="neutral" />
            ) : null}
          </ProovraCard>

          <ProovraPageSection title="Members">
            {members.length === 0 ? (
              <ProovraEmpty presence="inline" title="No members are listed." />
            ) : (
              <ProovraCard>
                {members.map((m) => (
                  <ProovraListRow
                    key={m.id}
                    title={m.displayName}
                    subtitle={
                      [m.email, m.joinedAtIso ? `joined ${formatUserDateTime(m.joinedAtIso)}` : null]
                        .filter(Boolean)
                        .join(" · ") || undefined
                    }
                    trailing={
                      <View style={{ flexDirection: "row", gap: theme.space.s1, alignItems: "center" }}>
                        <ProovraText variant="label" color={theme.color.ink.muted}>
                          {roleLabel(m.role)}
                        </ProovraText>
                        {m.status.toUpperCase() !== "ACTIVE" ? (
                          <ProovraBadge label={m.status} tone={memberStatusTone(m.status)} />
                        ) : null}
                      </View>
                    }
                  />
                ))}
              </ProovraCard>
            )}
            {cursor ? (
              <ProovraButton
                label="Load more"
                variant="secondary"
                loading={busy}
                onPress={() => void loadMore()}
              />
            ) : null}
          </ProovraPageSection>

          {overview.canManageMembers ? (
            <ProovraPageSection title="Invite someone">
              <ProovraCard>
                {roomLeft === false ? (
                  <ProovraText variant="label" color={theme.color.status.pending.fg}>
                    Every seat on this plan is in use. Free a seat or change plan to invite more
                    people.
                  </ProovraText>
                ) : null}
                <ProovraFormField label="Email address">
                  <ProovraInput
                    value={email}
                    onChangeText={setEmail}
                    placeholder="name@example.com"
                    autoCapitalize="none"
                    keyboardType="email-address"
                    accessibilityLabel="Email address to invite"
                  />
                </ProovraFormField>
                <ProovraFilterChips
                  label="Role"
                  value={role}
                  onChange={setRole}
                  options={INVITABLE_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
                />
                <ProovraButton
                  label="Send invitation"
                  loading={busy}
                  disabled={roomLeft === false}
                  onPress={() => void invite()}
                />
              </ProovraCard>
            </ProovraPageSection>
          ) : null}

          <ProovraPageSection title="Pending invitations">
            {!invitesReadable ? (
              // A 403 here is a statement about this user's role, not a
              // failure of the page — and not "there are none".
              <ProovraEmpty
                presence="inline"
                title="Invitations are managed by workspace admins."
              />
            ) : invites.length === 0 ? (
              <ProovraEmpty presence="inline" title="No invitations are outstanding." />
            ) : (
              <ProovraCard>
                {invites.map((i) => (
                  <View key={i.id} style={{ gap: theme.space.s1, paddingVertical: theme.space.s2 }}>
                    <ProovraText variant="body">{i.email}</ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      {[
                        roleLabel(i.role),
                        i.expiresAtIso ? `expires ${formatUserDateTime(i.expiresAtIso)}` : null,
                        i.lastResentAtIso
                          ? `resent ${formatUserDateTime(i.lastResentAtIso)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </ProovraText>
                    {overview.canManageMembers ? (
                      <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
                        <ProovraButton
                          label="Resend"
                          variant="secondary"
                          fullWidth={false}
                          disabled={busy}
                          onPress={() => void resend(i.id)}
                        />
                        <ProovraButton
                          label="Revoke"
                          variant="ghost"
                          fullWidth={false}
                          disabled={busy}
                          onPress={() => setRevoking(i)}
                        />
                      </View>
                    ) : null}
                  </View>
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>
        </>
      ) : null}

      <ProovraConfirmSheet
        visible={revoking !== null}
        title="Revoke this invitation?"
        // The confirm button restates the specific action: several rows on this
        // screen can open a sheet, and "Confirm" alone does not say which.
        consequence={
          revoking
            ? `${revoking.email} will no longer be able to join with this invitation. You can invite them again later.`
            : ""
        }
        confirmLabel={revoking ? `Revoke ${revoking.email}` : "Revoke"}
        tone="danger"
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
    </ProovraScreen>
  );
}
