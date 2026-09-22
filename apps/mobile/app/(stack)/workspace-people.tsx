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
 *
 * The workspace name, role changes, linked cases and the activity feed are all
 * here. Linking and unlinking a case are gated DIFFERENTLY by the route — a
 * MEMBER may bring a case in and may not take one out — and the surface keeps
 * them apart rather than treating "can manage cases" as one permission.
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
  ProovraSheet,
} from "../../src/ui";
import { StepUpSheet, useStepUp } from "../../src/ui/step-up-sheet";
import { withStepUp } from "../../src/product/step-up";
import {
  buildClosureBody,
  canRequestClosure,
  closureFailureNeedsReload,
  closurePhraseMatches,
  hasOpenClosure,
  parseClosureState,
  type ClosureState,
} from "../../src/product/closure";
import {
  INVITABLE_ROLES,
  MANAGEABLE_ROLES,
  activityLabel,
  buildRenameBody,
  buildRoleChangeBody,
  buildWorkspaceActivityPath,
  buildWorkspaceCaseLinkPath,
  buildWorkspaceCaseUnlinkPath,
  buildWorkspaceCasesPath,
  buildWorkspaceMemberPath,
  canChangeRole,
  canLinkCase,
  canUnlinkCase,
  describeRoleChange,
  linkableCases,
  parseWorkspaceActivity,
  parseWorkspaceCases,
  buildWorkspaceClosureCancelPath,
  buildWorkspaceClosurePath,
  buildWorkspaceTransferBody,
  buildWorkspaceTransferPath,
  isWorkspaceOwner,
  validateWorkspaceName,
  workspaceLifecycleFailureMessage,
  workspaceTransferTargets,
  type WorkspaceActivity,
  type WorkspaceCase,
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

  const [cases, setCases] = useState<WorkspaceCase[] | null>(null);
  const [activity, setActivity] = useState<WorkspaceActivity[] | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkable, setLinkable] = useState<WorkspaceCase[] | null>(null);
  const [unlinking, setUnlinking] = useState<WorkspaceCase | null>(null);
  const [roleFor, setRoleFor] = useState<WorkspaceMember | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");

  const stepUp = useStepUp();
  const [closure, setClosure] = useState<ClosureState | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [transferTarget, setTransferTarget] = useState<WorkspaceMember | null>(null);
  const [closing, setClosing] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [cancellingClosure, setCancellingClosure] = useState(false);

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

      // Cases and activity are independent of each other and of the roster:
      // either may be refused for this caller, and one refusal must not take
      // the page with it.
      await Promise.all([
        apiFetch(buildWorkspaceCasesPath(teamId))
          .then((d) => setCases(parseWorkspaceCases(d)))
          .catch(() => setCases(null)),
        apiFetch(buildWorkspaceActivityPath(teamId, 25))
          .then((d) => setActivity(parseWorkspaceActivity(d)))
          .catch(() => setActivity(null)),
        // Owner-only. It carries the phrase, the cooling-off period and the
        // blockers; none of the three is ever restated by the client.
        apiFetch(buildWorkspaceClosurePath(teamId))
          .then((d) => setClosure(parseClosureState(d)))
          .catch(() => setClosure(null)),
      ]);
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

  const changeRole = useCallback(
    async (member: WorkspaceMember, nextRole: string) => {
      if (!teamId || nextRole.toUpperCase() === member.role.toUpperCase()) {
        setRoleFor(null);
        return;
      }
      setRoleFor(null);
      setBusy(true);
      try {
        await apiFetch(buildWorkspaceMemberPath(teamId, member.id), {
          method: "PATCH",
          body: JSON.stringify(buildRoleChangeBody(nextRole)),
        });
      } catch (err) {
        addToast(toSafeUserError(err).message, "error");
        setBusy(false);
        return;
      }

      // An accepted request is not a completed change. The roster is reread
      // and the OUTCOME is reported from the reloaded row — announcing the
      // change from the request would be the client asserting something the
      // server has not confirmed.
      let reread: WorkspaceMember | null = null;
      try {
        const mp = parseWorkspaceMembers(await apiFetch(buildWorkspaceMembersPath(teamId)));
        setMembers(mp.members);
        setCursor(mp.nextCursor);
        reread = mp.members.find((m) => m.id === member.id) ?? null;
      } catch {
        reread = null;
      }
      const outcome = describeRoleChange(member, nextRole, reread);
      addToast(outcome.message, outcome.ok ? "success" : "error");
      setBusy(false);
    },
    [teamId, addToast],
  );

  const openLinkPicker = useCallback(async () => {
    if (!teamId) return;
    setLinking(true);
    setLinkable(null);
    try {
      // The cases this person can see, minus the ones already linked, so the
      // picker cannot offer a link that already exists.
      const all = parseWorkspaceCases(await apiFetch("/v1/cases"));
      setLinkable(linkableCases(all, cases ?? []));
    } catch {
      setLinkable([]);
    }
  }, [teamId, cases]);

  const linkCase = useCallback(
    async (target: WorkspaceCase) => {
      if (!teamId) return;
      setLinking(false);
      setBusy(true);
      try {
        await apiFetch(buildWorkspaceCaseLinkPath(teamId), {
          method: "POST",
          body: JSON.stringify({ caseId: target.id }),
        });
        addToast(`${target.name} is now linked to this workspace.`, "success");
        await load();
      } catch (err) {
        addToast(toSafeUserError(err).message, "error");
      } finally {
        setBusy(false);
      }
    },
    [teamId, addToast, load],
  );

  const unlinkCase = useCallback(async () => {
    const target = unlinking;
    if (!teamId || !target) return;
    setUnlinking(null);
    setBusy(true);
    try {
      await apiFetch(buildWorkspaceCaseUnlinkPath(teamId, target.id), { method: "DELETE" });
      addToast(`${target.name} is no longer linked to this workspace.`, "success");
      await load();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, unlinking, addToast, load]);

  const rename = useCallback(async () => {
    if (!teamId) return;
    const invalid = validateWorkspaceName(draftName);
    if (invalid) {
      addToast(invalid, "error");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(buildWorkspacePath(teamId), {
        method: "PATCH",
        body: JSON.stringify(buildRenameBody(draftName)),
      });
      setRenaming(false);
      addToast("Workspace renamed.", "success");
      await load();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, draftName, addToast, load]);

  const reloadClosure = useCallback(async () => {
    if (!teamId) return;
    try {
      setClosure(parseClosureState(await apiFetch(buildWorkspaceClosurePath(teamId))));
    } catch {
      setClosure(null);
    }
  }, [teamId]);

  const failLifecycle = useCallback(
    (err: unknown, fallback: string) => {
      addToast(
        workspaceLifecycleFailureMessage(err, toSafeUserError(err).message || fallback),
        "error",
      );
      if (closureFailureNeedsReload(err)) void reloadClosure();
    },
    [addToast, reloadClosure],
  );

  const transferOwnership = useCallback(async () => {
    const target = transferTarget;
    if (!teamId || !target?.userId) return;
    setTransferTarget(null);
    setBusy(true);
    await stepUp.start(
      async (proof) => {
        await apiFetch(buildWorkspaceTransferPath(teamId), {
          method: "POST",
          // `newOwnerUserId` here; the organization route spells the same
          // thing `targetUserId`. Each surface names its own.
          body: JSON.stringify(withStepUp(buildWorkspaceTransferBody(target.userId!), proof)),
        });
        addToast("Ownership transferred. You are now a workspace admin.", "success");
        await load();
      },
      (err) => failLifecycle(err, "Could not transfer ownership."),
    );
    setBusy(false);
  }, [teamId, transferTarget, stepUp, addToast, load, failLifecycle]);

  const requestClosure = useCallback(async () => {
    if (!teamId) return;
    setBusy(true);
    await stepUp.start(
      async (proof) => {
        await apiFetch(buildWorkspaceClosurePath(teamId), {
          method: "POST",
          body: JSON.stringify(withStepUp(buildClosureBody(phrase), proof)),
        });
        setClosing(false);
        setPhrase("");
        await reloadClosure();
      },
      (err) => failLifecycle(err, "Could not request closure."),
    );
    setBusy(false);
  }, [teamId, phrase, stepUp, reloadClosure, failLifecycle]);

  const cancelClosure = useCallback(async () => {
    const requestId = closure?.requestId;
    if (!teamId || !requestId) return;
    setCancellingClosure(false);
    setBusy(true);
    try {
      await apiFetch(buildWorkspaceClosureCancelPath(teamId, requestId), {
        method: "POST",
        body: JSON.stringify({}),
      });
      addToast("The closure request was cancelled.", "success");
      await reloadClosure();
    } catch (err) {
      failLifecycle(err, "Could not cancel the request.");
    } finally {
      setBusy(false);
    }
  }, [teamId, closure, addToast, reloadClosure, failLifecycle]);

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
            {overview.canManageWorkspace ? (
              <ProovraButton
                label="Rename workspace"
                variant="ghost"
                fullWidth={false}
                onPress={() => {
                  setDraftName(overview.name ?? "");
                  setRenaming(true);
                }}
              />
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
                    // Opening the role picker IS the row action; a row that
                    // cannot be managed stays inert rather than opening a
                    // sheet that offers nothing.
                    onPress={
                      canChangeRole(m, overview.canManageMembers)
                        ? () => setRoleFor(m)
                        : undefined
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
          <ProovraPageSection title="Linked cases">
            {cases === null ? (
              <ProovraEmpty
                presence="inline"
                title="Linked cases are visible to workspace members."
              />
            ) : cases.length === 0 ? (
              <ProovraEmpty
                presence="inline"
                title="No cases are linked to this workspace yet."
              />
            ) : (
              <ProovraCard>
                {cases.map((c) => (
                  <ProovraListRow
                    key={c.id}
                    title={c.name}
                    subtitle={
                      c.createdAtIso ? `opened ${formatUserDateTime(c.createdAtIso)}` : undefined
                    }
                    trailing={
                      // Unlinking is ADMIN+, linking is MEMBER+. They are two
                      // permissions and the row does not merge them.
                      canUnlinkCase(overview.currentUserRole ?? "") ? (
                        <ProovraButton
                          label="Unlink"
                          variant="ghost"
                          fullWidth={false}
                          onPress={() => setUnlinking(c)}
                        />
                      ) : undefined
                    }
                  />
                ))}
              </ProovraCard>
            )}
            {canLinkCase(overview.currentUserRole ?? "") ? (
              <ProovraButton
                label="Link a case"
                variant="secondary"
                loading={busy}
                onPress={() => void openLinkPicker()}
              />
            ) : null}
          </ProovraPageSection>

          <ProovraPageSection title="Activity">
            {activity === null ? (
              <ProovraEmpty
                presence="inline"
                title="Workspace activity is visible to workspace members."
              />
            ) : activity.length === 0 ? (
              <ProovraEmpty presence="inline" title="Nothing has happened here yet." />
            ) : (
              <ProovraCard>
                {activity.map((a) => (
                  <View key={a.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                    <ProovraText variant="bodySm">{activityLabel(a.eventType)}</ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      {[
                        // An unresolved actor reads as System, not as a raw id
                        // printed where a person's name belongs.
                        a.actorLabel ?? "System",
                        a.targetType,
                        a.occurredAtIso ? formatUserDateTime(a.occurredAtIso) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </ProovraText>
                  </View>
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>
          {isWorkspaceOwner(overview) ? (
            <ProovraPageSection title="This workspace">
              <ProovraButton
                label="Transfer ownership"
                variant="ghost"
                loading={busy}
                onPress={() => setTransferring(true)}
              />

              {closure && hasOpenClosure(closure) ? (
                <ProovraCard>
                  <ProovraText variant="body" weight="semibold">
                    Closure requested
                  </ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {closure.effectiveAtIso
                      ? `This workspace is scheduled to close on ${formatUserDateTime(closure.effectiveAtIso)}. It can be cancelled until then.`
                      : "A closure request is open and can still be cancelled."}
                  </ProovraText>
                  <ProovraButton
                    label="Cancel the closure request"
                    loading={busy}
                    onPress={() => setCancellingClosure(true)}
                  />
                </ProovraCard>
              ) : null}

              {closure && !hasOpenClosure(closure) && closure.blockers.length > 0 ? (
                <ProovraCard>
                  <ProovraText variant="label" weight="semibold">
                    Closure is blocked
                  </ProovraText>
                  {closure.blockers.map((b) => (
                    <ProovraText key={b.code} variant="label" color={theme.color.ink.muted}>
                      {b.count !== null ? `${b.message} (${b.count})` : b.message}
                    </ProovraText>
                  ))}
                </ProovraCard>
              ) : null}

              {closure && canRequestClosure(closure) ? (
                <ProovraButton
                  label="Close this workspace"
                  variant="ghost"
                  loading={busy}
                  onPress={() => setClosing(true)}
                />
              ) : null}
            </ProovraPageSection>
          ) : null}
        </>
      ) : null}

      <ProovraSheet
        visible={transferring}
        title="Transfer ownership"
        onClose={() => setTransferring(false)}
      >
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          The person you choose becomes the workspace owner and you become an admin.
          Evidence, cases and reviewer queues are unaffected.
        </ProovraText>
        {workspaceTransferTargets(members).length === 0 ? (
          <ProovraEmpty
            presence="inline"
            title="There is no other active member to transfer ownership to."
          />
        ) : (
          workspaceTransferTargets(members).map((m) => (
            <ProovraListRow
              key={m.id}
              title={m.displayName}
              subtitle={m.email ?? undefined}
              onPress={() => {
                setTransferring(false);
                setTransferTarget(m);
              }}
            />
          ))
        )}
      </ProovraSheet>

      <ProovraConfirmSheet
        visible={transferTarget !== null}
        title={transferTarget ? `Make ${transferTarget.displayName} the owner?` : ""}
        consequence="They become the workspace owner and you become an admin. Evidence, cases and reviewer queues are unaffected."
        confirmLabel="Transfer ownership"
        tone="danger"
        busy={busy}
        onConfirm={() => void transferOwnership()}
        onCancel={() => setTransferTarget(null)}
      />

      <ProovraSheet
        visible={closing}
        title="Close this workspace"
        onClose={() => setClosing(false)}
      >
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {closure?.coolingOffDays !== null && closure?.coolingOffDays !== undefined
            ? `Closure does not happen immediately: there is a ${closure.coolingOffDays}-day period in which it can be cancelled.`
            : "Closure does not happen immediately; it can be cancelled during a cooling-off period."}
        </ProovraText>

        <ProovraFormField label="Type the confirmation phrase">
          <ProovraInput
            value={phrase}
            onChangeText={setPhrase}
            placeholder={closure?.confirmationPhrase ?? ""}
            autoCapitalize="none"
            accessibilityLabel="Closure confirmation phrase"
          />
        </ProovraFormField>
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {closure?.confirmationPhrase
            ? `Type exactly: ${closure.confirmationPhrase}`
            : "The confirmation phrase could not be read. Try again in a moment."}
        </ProovraText>

        <ProovraButton
          label="Request closure"
          loading={busy}
          disabled={closure === null || !closurePhraseMatches(closure, phrase)}
          onPress={() => void requestClosure()}
        />
      </ProovraSheet>

      <ProovraConfirmSheet
        visible={cancellingClosure}
        title="Cancel the closure request?"
        consequence="The workspace stays open and nothing is deleted. You can request closure again later."
        confirmLabel="Cancel the request"
        tone="warning"
        busy={busy}
        onConfirm={() => void cancelClosure()}
        onCancel={() => setCancellingClosure(false)}
      />

      <StepUpSheet
        challenge={stepUp.challenge}
        title="Confirm it is you"
        busy={busy}
        onSubmit={(proof) =>
          void stepUp.retry(proof, (err) => failLifecycle(err, "That could not be completed."))
        }
        onCancel={stepUp.dismiss}
      />

      <ProovraSheet
        visible={roleFor !== null}
        title={roleFor ? `Change ${roleFor.displayName}'s role` : ""}
        onClose={() => setRoleFor(null)}
      >
        {/*
          OWNER is not offered. Ownership is not a role you assign, it is
          transferred, and offering it here would be a different action under
          the wrong name.
        */}
        {MANAGEABLE_ROLES.map((r) => (
          <ProovraListRow
            key={r}
            title={roleLabel(r)}
            subtitle={
              roleFor && r.toUpperCase() === roleFor.role.toUpperCase()
                ? "Their current role"
                : undefined
            }
            onPress={() => {
              if (roleFor) void changeRole(roleFor, r);
            }}
          />
        ))}
      </ProovraSheet>

      <ProovraSheet visible={linking} title="Link a case" onClose={() => setLinking(false)}>
        {linkable === null ? (
          <ProovraLoadingState label="Loading your cases" />
        ) : linkable.length === 0 ? (
          <ProovraEmpty
            presence="inline"
            title="There is no case to link."
            purpose="Every case you can see is already linked to this workspace."
          />
        ) : (
          linkable.map((c) => (
            <ProovraListRow key={c.id} title={c.name} onPress={() => void linkCase(c)} />
          ))
        )}
      </ProovraSheet>

      <ProovraSheet
        visible={renaming}
        title="Rename this workspace"
        onClose={() => setRenaming(false)}
      >
        <ProovraFormField label="Workspace name">
          <ProovraInput
            value={draftName}
            onChangeText={setDraftName}
            autoCapitalize="sentences"
            accessibilityLabel="Workspace name"
          />
        </ProovraFormField>
        <ProovraButton
          label="Save"
          loading={busy}
          disabled={validateWorkspaceName(draftName) !== null}
          onPress={() => void rename()}
        />
      </ProovraSheet>

      <ProovraConfirmSheet
        visible={unlinking !== null}
        title={unlinking ? `Unlink ${unlinking.name}?` : ""}
        consequence="The case stays exactly as it is. It is no longer reachable through this workspace, and it can be linked again later."
        confirmLabel="Unlink"
        tone="warning"
        busy={busy}
        onConfirm={() => void unlinkCase()}
        onCancel={() => setUnlinking(null)}
      />

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
