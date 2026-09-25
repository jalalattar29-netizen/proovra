/**
 * WORKSPACE PEOPLE — the native port of `apps/web/app/(app)/teams/[id]/page.tsx`
 * ("Members & Access").
 *
 * Members, invitations and seats for the ACTIVE workspace. The web keys this
 * surface by workspace id and reaches it through a resolver at `/people`
 * because no static href can name it; native has no URL bar at all, so it
 * takes the active workspace directly from the canonical platform context and
 * this screen IS the resolver's destination.
 *
 * Section order follows the web's two columns re-flowed into one: the header
 * and its four summary figures, the roster, pending invitations, recent
 * activity and the owner-only lifecycle region (the web's MAIN column), then
 * the rail — invite, workspace overview, the Collaboration Teams signpost,
 * external collaborators and the cases in this workspace.
 *
 * Counts come from the server's `stats`, never from the length of the member
 * page — the web route's own comment records what happened when a detail read
 * tried to carry every membership.
 *
 * Linking and unlinking a case are gated DIFFERENTLY by the route — a MEMBER
 * may bring a case in and may not take one out — and the surface keeps them
 * apart rather than treating "can manage cases" as one permission.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch, apiFetchText } from "../../src/api";
import { formatUserDate, formatUserDateTime } from "../../src/lib/date";
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
  ProovraFilterSearch,
  ProovraFilterChips,
  ProovraLoadingState,
  ProovraEmpty,
  ProovraConfirmSheet,
  ProovraSheet,
  ProovraKpiGrid,
  ProovraDetailRows,
} from "../../src/ui";
import { RolePermissionsSheet } from "../../src/ui/role-permissions-sheet";
import { useAuth } from "../../src/auth-context";
import { MemberRemovalSheet } from "../../src/ui/member-removal";
import { ExternalCollaboratorsCard } from "../../src/ui/external-collaborators";
import { WorkspaceOwnershipTransferCard } from "../../src/ui/workspace-ownership-transfer";
import { WorkspaceClosureCard } from "../../src/ui/workspace-closure-card";
import {
  INVITABLE_ROLES,
  MANAGEABLE_ROLES,
  RECENT_ACTIVITY_LIMIT,
  activityTone,
  buildRenameBody,
  buildRoleChangeBody,
  buildWorkspaceActivityPath,
  buildWorkspaceCaseLinkPath,
  buildWorkspaceCaseUnlinkPath,
  buildWorkspaceCasesPath,
  buildWorkspaceMemberPath,
  canChangeRole,
  canRemoveMember,
  canLinkCase,
  canUnlinkCase,
  deleteWorkspaceFailure,
  describeActivity,
  describeRoleChange,
  invitesReadFailure,
  linkableCases,
  memberStatusLabel,
  parseWorkspaceActivity,
  parseWorkspaceCases,
  isWorkspaceOwner,
  resendErrorCopy,
  resendOutcome,
  seatsAvailable,
  validateWorkspaceName,
  type InvitesReadState,
  type WorkspaceActivity,
  type WorkspaceCase,
  buildWorkspaceInvitePath,
  buildWorkspaceInviteResendPath,
  buildWorkspaceInvitesPath,
  buildWorkspaceMembersPath,
  MEMBER_STATUS_FILTERS,
  rosterNoMatchCopy,
  type MemberStatusFilter,
  buildWorkspacePath,
  canInviteMore,
  looksLikeEmail,
  memberStatusTone,
  parseWorkspaceInvites,
  parseWorkspaceMembers,
  parseWorkspaceOverview,
  roleLabel,
  type WorkspaceInvite,
  type WorkspaceMember,
  type WorkspaceOverview,
} from "../../src/product/workspace-people";

type Phase = "loading" | "ready" | "failed";
type RosterState = "loading" | "ready" | "failed";

export default function WorkspacePeopleScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const { context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [roster, setRoster] = useState<RosterState>("loading");
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const { user: authUser } = useAuth();
  const selfId = authUser?.id ?? null;
  const [cursor, setCursor] = useState<string | null>(null);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  // T-12 — roster status filter + search, sent to the server (the web's
  // WorkspaceMembersPanel). Changing either resets the cursor.
  const [memberStatus, setMemberStatus] = useState<MemberStatusFilter>("ALL");
  const [memberQuery, setMemberQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const rosterFilter = useMemo(() => ({ status: memberStatus, q: debouncedQuery }), [memberStatus, debouncedQuery]);
  const filtered = memberStatus !== "ALL" || debouncedQuery.trim().length > 0;
  const [invitesRead, setInvitesRead] = useState<InvitesReadState>("ready");

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("MEMBER");
  const [busy, setBusy] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<WorkspaceInvite | null>(null);

  const [cases, setCases] = useState<WorkspaceCase[] | null>(null);
  const [activity, setActivity] = useState<WorkspaceActivity[] | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkable, setLinkable] = useState<WorkspaceCase[] | null>(null);
  const [unlinking, setUnlinking] = useState<WorkspaceCase | null>(null);
  const [roleFor, setRoleFor] = useState<WorkspaceMember | null>(null);
  // T-14 — member removal (web MemberRemovalDialog) and the roster total.
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null);
  const [memberTotal, setMemberTotal] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");

  // Held at PAGE level: a transfer demotes the actor and unmounts the card
  // that produced the sentence (web NEW-049).
  const [ownershipNotice, setOwnershipNotice] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const applyRoster = useCallback((d: unknown) => {
    const mp = parseWorkspaceMembers(d);
    setMembers(mp.members);
    setMemberTotal(mp.total);
    setCursor(mp.nextCursor);
    setRoster("ready");
    setRosterError(null);
    return mp;
  }, []);

  const rosterFailure = useCallback((err: unknown) => {
    const code = (err as { statusCode?: number } | null)?.statusCode;
    setRoster("failed");
    setRosterError(
      code === 403 || code === 404
        ? "You no longer have access to this workspace's members. Reload the page or switch workspace."
        : toSafeUserError(err, { message: "The member list could not be loaded." }).message,
    );
  }, []);

  const reloadInvites = useCallback(async (): Promise<WorkspaceInvite[] | null> => {
    if (!teamId) return null;
    try {
      const list = parseWorkspaceInvites(await apiFetch(buildWorkspaceInvitesPath(teamId)));
      setInvites(list);
      setInvitesRead("ready");
      return list;
    } catch (err) {
      // A 403 is a statement about this user's role, not a failure of the page.
      setInvitesRead(invitesReadFailure(err));
      return null;
    }
  }, [teamId]);

  const load = useCallback(async () => {
    if (!teamId) return;
    setPhase("loading");
    setLoadError(null);
    let ov: WorkspaceOverview;
    try {
      ov = parseWorkspaceOverview(await apiFetch(buildWorkspacePath(teamId)));
    } catch (err) {
      setLoadError(toSafeUserError(err, { message: "Failed to load workspace" }).message);
      setPhase("failed");
      return;
    }
    setOverview(ov);
    setPhase("ready");

    // Every section below is independent: a refusal of one (a role gate, a
    // failure) must not take the page — or another section — with it.
    setRoster("loading");
    await Promise.all([
      apiFetch(buildWorkspaceMembersPath(teamId, null, rosterFilter)).then(applyRoster).catch(rosterFailure),
      reloadInvites(),
      apiFetch(buildWorkspaceCasesPath(teamId))
        .then((d) => setCases(parseWorkspaceCases(d)))
        .catch(() => setCases(null)),
      apiFetch(buildWorkspaceActivityPath(teamId, 25))
        .then((d) => setActivity(parseWorkspaceActivity(d)))
        .catch(() => setActivity(null)),
    ]);
  }, [teamId, rosterFilter, applyRoster, rosterFailure, reloadInvites]);

  useEffect(() => {
    void load();
    // The roster filter re-reads only the roster (effect below), so the
    // whole-page load runs on workspace change alone.
  }, [teamId]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(memberQuery), 300);
    return () => clearTimeout(t);
  }, [memberQuery]);

  const reloadRoster = useCallback(async () => {
    if (!teamId) return null;
    try {
      return applyRoster(await apiFetch(buildWorkspaceMembersPath(teamId, null, rosterFilter)));
    } catch (err) {
      rosterFailure(err);
      return null;
    }
  }, [teamId, rosterFilter, applyRoster, rosterFailure]);

  // Re-read the ROSTER (not the whole page) when a filter changes.
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    if (!teamId) return;
    let live = true;
    apiFetch(buildWorkspaceMembersPath(teamId, null, rosterFilter))
      .then((d) => {
        if (live) applyRoster(d);
      })
      .catch((err) => addToast(toSafeUserError(err).message, "error"));
    return () => {
      live = false;
    };
  }, [teamId, rosterFilter, addToast, applyRoster]);

  const loadMore = useCallback(async () => {
    if (!teamId || !cursor) return;
    setBusy(true);
    try {
      const mp = parseWorkspaceMembers(await apiFetch(buildWorkspaceMembersPath(teamId, cursor, rosterFilter)));
      setMembers((prev) => [...prev, ...mp.members]);
      setCursor(mp.nextCursor);
    } catch (err) {
      addToast(toSafeUserError(err, { message: "More members could not be loaded. Try again." }).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, cursor, rosterFilter, addToast]);

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
      setRole("MEMBER");
      setInviteOpen(false);
      addToast("Invitation created successfully", "success");
      await reloadInvites();
    } catch (err) {
      addToast(toSafeUserError(err, { message: "Failed to invite member" }).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, email, role, addToast, reloadInvites]);

  /**
   * POST …/invites/:inviteId/resend → { invite, emailSent }. It rotates the
   * token, so the link the person already holds stops working. The list is
   * REREAD before anything is announced, and the announcement says whether the
   * email actually went.
   */
  const resend = useCallback(
    async (target: WorkspaceInvite) => {
      if (!teamId || resendingId) return;
      setResendingId(target.id);
      let emailSent = false;
      try {
        const d = (await apiFetch(buildWorkspaceInviteResendPath(teamId, target.id), { method: "POST" })) as {
          emailSent?: unknown;
        } | null;
        emailSent = d?.emailSent === true;
      } catch (err) {
        const known = resendErrorCopy(err);
        addToast(known ?? toSafeUserError(err, { message: "The invitation could not be resent." }).message, "error");
        if (known) await reloadInvites();
        setResendingId(null);
        return;
      }
      const rows = await reloadInvites();
      setResendingId(null);
      const outcome = resendOutcome(target, emailSent, rows);
      addToast(outcome.message, outcome.tone);
    },
    [teamId, resendingId, addToast, reloadInvites],
  );

  const revoke = useCallback(async () => {
    if (!teamId || !revoking) return;
    const target = revoking;
    setBusy(true);
    try {
      await apiFetch(buildWorkspaceInvitePath(teamId, target.id), { method: "DELETE" });
      setRevoking(null);
      setInvites((prev) => prev.filter((i) => i.id !== target.id));
      addToast("Invite deleted", "success");
    } catch (err) {
      addToast(toSafeUserError(err, { message: "Failed to delete invite" }).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, revoking, addToast]);

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
        addToast(toSafeUserError(err, { message: "Failed to update role" }).message, "error");
        setBusy(false);
        return;
      }

      // An accepted request is not a completed change. The roster is reread
      // and the OUTCOME is reported from the reloaded row.
      const mp = await reloadRoster();
      const reread = mp?.members.find((m) => m.id === member.id) ?? null;
      const outcome = describeRoleChange(member, nextRole, mp ? reread : null);
      addToast(outcome.message, outcome.ok ? "success" : "error");
      setBusy(false);
    },
    [teamId, addToast, reloadRoster],
  );

  const openLinkPicker = useCallback(async () => {
    if (!teamId) return;
    setLinking(true);
    setLinkable(null);
    try {
      // The cases this person can see, minus the ones linked here or to any
      // other workspace — the route refuses those.
      const all = parseWorkspaceCases(await apiFetch("/v1/cases"));
      setLinkable(linkableCases(all, cases ?? []));
    } catch (err) {
      addToast(toSafeUserError(err, { message: "Failed to load available cases" }).message, "error");
      setLinkable([]);
    }
  }, [teamId, cases, addToast]);

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
        setCases((prev) => [{ ...target, teamId }, ...(prev ?? [])]);
        addToast("Case linked successfully", "success");
      } catch (err) {
        addToast(toSafeUserError(err, { message: "Failed to link case" }).message, "error");
      } finally {
        setBusy(false);
      }
    },
    [teamId, addToast],
  );

  const unlinkCase = useCallback(async () => {
    const target = unlinking;
    if (!teamId || !target) return;
    setBusy(true);
    try {
      await apiFetch(buildWorkspaceCaseUnlinkPath(teamId, target.id), { method: "DELETE" });
      setUnlinking(null);
      setCases((prev) => (prev ?? []).filter((c) => c.id !== target.id));
      addToast("Case removed from workspace", "success");
    } catch (err) {
      addToast(toSafeUserError(err, { message: "Failed to remove case from workspace" }).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, unlinking, addToast]);

  const rename = useCallback(async () => {
    if (!teamId) return;
    const invalid = validateWorkspaceName(draftName);
    if (invalid) {
      addToast(invalid, "error");
      return;
    }
    setBusy(true);
    try {
      const updated = (await apiFetch(buildWorkspacePath(teamId), {
        method: "PATCH",
        body: JSON.stringify(buildRenameBody(draftName)),
      })) as { name?: unknown } | null;
      const name = typeof updated?.name === "string" && updated.name ? updated.name : draftName.trim();
      setOverview((prev) => (prev ? { ...prev, name } : prev));
      setRenaming(false);
      addToast("Workspace name updated", "success");
    } catch (err) {
      addToast(toSafeUserError(err, { message: "Failed to update workspace name" }).message, "error");
    } finally {
      setBusy(false);
    }
  }, [teamId, draftName, addToast]);

  const deleteWorkspace = useCallback(async () => {
    if (!teamId) return;
    setDeleting(true);
    try {
      // 204 No Content (teams.routes.ts:1362) — read as text; apiFetch would
      // fail to parse the empty body and report a deleted workspace as not deleted.
      await apiFetchText(buildWorkspacePath(teamId), { method: "DELETE" });
      setDeleteConfirm(false);
      addToast("Workspace deleted successfully", "success");
      router.replace("/spaces" as never);
    } catch (err) {
      setDeleteConfirm(false);
      addToast(deleteWorkspaceFailure(err, toSafeUserError(err, { message: "Failed to delete workspace" }).message), "error");
    } finally {
      setDeleting(false);
    }
  }, [teamId, addToast, router]);

  const seats = overview?.seats ?? null;
  const available = seats ? seatsAvailable(seats) : null;
  const roomLeft = seats ? canInviteMore(seats) : null;
  const canManage = overview?.canManageMembers === true;
  const currentRole =
    overview?.currentUserRole ?? members.find((m) => m.userId && m.userId === selfId)?.role ?? null;
  const pendingCount = invitesRead === "ready" ? invites.length : overview?.pendingInviteCount ?? 0;
  const caseCount = cases?.length ?? overview?.caseCount ?? 0;
  const activeMemberCount = overview?.seats.memberCount ?? 0;

  const header = (subtitle: string | undefined, withActions: boolean) => (
    <ProovraPageHeader
      title="Members & Access"
      eyebrow={overview?.name ?? "Workspace"}
      subtitle={subtitle}
      secondaryActions={
        <>
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
          {/* T-15 — the server's role → capability catalog (TeamPermissionMatrix). */}
          {withActions ? (
            <ProovraButton label="Role permissions" variant="secondary" fullWidth={false} onPress={() => setPermissionsOpen(true)} />
          ) : null}
        </>
      }
      primaryAction={
        withActions && canManage ? (
          <ProovraButton label="Invite person" fullWidth={false} onPress={() => setInviteOpen(true)} />
        ) : undefined
      }
    />
  );

  return (
    <ProovraScreen shell testID="workspace-people">
      {phase === "ready" && overview
        ? header(
            `Who can access ${overview.name ?? "this workspace"} — members, invitations, roles and access governance.${
              currentRole ? ` You are ${roleLabel(currentRole)}` : ""
            }${overview.effectivePlan ? ` · ${overview.effectivePlan} plan` : ""}`,
            true,
          )
        : header(teamId && phase === "loading" ? "Loading members, invitations and workspace cases…" : undefined, false)}
      <RolePermissionsSheet visible={permissionsOpen} currentRole={currentRole} onClose={() => setPermissionsOpen(false)} />

      {!teamId ? (
        <ProovraEmpty
          presence="page"
          title="No workspace is selected"
          purpose="People are managed inside a workspace. Switch to one, and this opens its members and invitations."
        />
      ) : null}

      {teamId && phase === "loading" ? <ProovraLoadingState label="Loading members" /> : null}
      {teamId && phase === "failed" ? (
        <ProovraEmpty
          presence="page"
          title="Couldn't load this workspace"
          purpose={loadError ?? "Workspace not found, or you no longer have access to it."}
          action={
            <View style={{ gap: theme.space.s2, alignItems: "center" }}>
              <ProovraButton label="Try again" fullWidth={false} onPress={() => void load()} />
              <ProovraButton label="Back to workspaces" variant="secondary" fullWidth={false} onPress={() => router.push("/spaces" as never)} />
            </View>
          }
        />
      ) : null}

      {phase === "ready" && overview ? (
        <>
          {/* SUMMARY — the four figures a person managing access needs; seats
              from the SERVER's projection, never counted from the rows. */}
          <ProovraKpiGrid
            items={[
              { key: "active", label: "Active members", value: String(activeMemberCount), caption: "With access to this workspace", tone: "verified" },
              { key: "pending", label: "Pending invitations", value: String(pendingCount), caption: "Sent, not yet accepted", tone: "pending" },
              {
                key: "seats",
                label: "Seats available",
                value: available === null ? "—" : String(available),
                caption:
                  seats?.seatLimit === null || !seats
                    ? "Capacity unavailable"
                    : `${seats.seatUsed ?? activeMemberCount} of ${seats.seatLimit} used`,
                tone: available === 0 ? "risk" : available === null ? "neutral" : "info",
              },
              {
                key: "cases",
                label: "Cases in this workspace",
                value: String(caseCount),
                caption: "Open Cases",
                tone: "governance",
                onPress: () => router.push("/cases" as never),
              },
            ]}
          />

          {/* A seat-full workspace says so once, here, rather than letting the
              operator discover it from a refusal. */}
          {available === 0 ? (
            <ProovraCard testID="people-seats-full">
              <ProovraText variant="bodySm" weight="semibold">
                Every seat is in use.
              </ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                A new person can be invited once a seat frees up, or when the plan is changed.
              </ProovraText>
              <ProovraButton label="Review plan and seats" variant="ghost" fullWidth={false} onPress={() => router.push("/billing" as never)} />
            </ProovraCard>
          ) : null}

          <ProovraPageSection title="Members">
            <ProovraFilterSearch
              value={memberQuery}
              onChange={setMemberQuery}
              placeholder={canManage ? "Search by name or email" : "Search by name"}
            />
            <ProovraFilterChips
              label="Filter members by status"
              value={memberStatus}
              onChange={(v) => setMemberStatus(v as MemberStatusFilter)}
              options={MEMBER_STATUS_FILTERS}
            />
            {roster === "loading" ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                Loading members…
              </ProovraText>
            ) : roster === "failed" ? (
              <ProovraEmpty
                presence="inline"
                title={rosterError ?? "The member list could not be loaded."}
                action={<ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={() => void reloadRoster()} />}
              />
            ) : members.length === 0 && filtered ? (
              <ProovraEmpty
                presence="inline"
                title={rosterNoMatchCopy(canManage).title}
                purpose={rosterNoMatchCopy(canManage).body}
              />
            ) : members.length === 0 ? (
              <ProovraEmpty
                presence="inline"
                title="Nobody has access to this workspace yet"
                purpose="Invite a colleague to give them access to this workspace's evidence, cases and reports."
                action={
                  canManage ? <ProovraButton label="Invite person" fullWidth={false} onPress={() => setInviteOpen(true)} /> : undefined
                }
              />
            ) : (
              <ProovraCard>
                {members.map((m) => {
                  const isSelf = !!m.userId && m.userId === selfId;
                  // Only where the server would accept the change: OWNER moves
                  // by transfer, and nobody edits their own role.
                  const editable = canChangeRole(m, canManage) && !isSelf;
                  return (
                    <ProovraListRow
                      key={m.id}
                      title={`${m.displayName}${isSelf ? " (you)" : ""}`}
                      subtitle={
                        [m.email, m.joinedAtIso ? `Joined ${formatUserDate(m.joinedAtIso)}` : null].filter(Boolean).join(" · ") ||
                        undefined
                      }
                      // Opening the role picker IS the row action; a row that
                      // cannot be managed stays inert.
                      onPress={editable ? () => setRoleFor(m) : undefined}
                      accessibilityHint={editable ? "Change this person's workspace role" : undefined}
                      trailing={
                        <View style={{ flexDirection: "row", gap: theme.space.s1, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                          <ProovraBadge label={roleLabel(m.role)} tone={m.role.toUpperCase() === "OWNER" ? "governance" : "neutral"} />
                          <ProovraBadge label={memberStatusLabel(m.status)} tone={memberStatusTone(m.status)} />
                          {canRemoveMember(m, canManage, selfId) ? (
                            <ProovraButton
                              label="Remove"
                              accessibilityLabel={`Remove ${m.displayName}`}
                              variant="ghost"
                              fullWidth={false}
                              onPress={() => setRemoving(m)}
                            />
                          ) : null}
                        </View>
                      }
                    />
                  );
                })}
              </ProovraCard>
            )}
            {roster === "ready" && members.length > 0 && memberTotal !== null ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {`Showing ${members.length} of ${memberTotal} ${filtered ? "matching " : ""}${memberTotal === 1 ? "person" : "people"}`}
              </ProovraText>
            ) : null}
            {roster === "ready" && cursor ? (
              <ProovraButton label="Load more" variant="secondary" loading={busy} onPress={() => void loadMore()} />
            ) : null}
          </ProovraPageSection>

          {/* PENDING INVITATIONS — rendered when there are any, or when the
              viewer can create one. Zero is a sentence, not a slab. */}
          {invites.length > 0 || canManage ? (
            <ProovraPageSection title="Pending invitations">
              {canManage && invitesRead !== "ready" ? (
                <ProovraEmpty
                  presence="inline"
                  title={
                    invitesRead === "refused"
                      ? "Your role cannot list this workspace's invitations."
                      : "Pending invitations could not be loaded."
                  }
                  action={<ProovraButton label="Try again" variant="secondary" fullWidth={false} onPress={() => void reloadInvites()} />}
                />
              ) : invites.length === 0 ? (
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  No invitations outstanding — everyone invited has either joined or had their invitation withdrawn. New
                  invitations are delivered by email.
                </ProovraText>
              ) : (
                <ProovraCard>
                  {invites.map((i) => (
                    <View key={i.id} style={{ gap: theme.space.s1, paddingVertical: theme.space.s2 }}>
                      <View style={{ flexDirection: "row", gap: theme.space.s2, alignItems: "center", flexWrap: "wrap" }}>
                        <ProovraText variant="body" weight="semibold">
                          {i.email}
                        </ProovraText>
                        <ProovraBadge label={roleLabel(i.role)} tone="neutral" />
                      </View>
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {[
                          i.lastResentAtIso
                            ? `Resent ${formatUserDate(i.lastResentAtIso)}`
                            : i.createdAtIso
                              ? `Sent ${formatUserDate(i.createdAtIso)}`
                              : null,
                          i.expiresAtIso ? `Expires ${formatUserDate(i.expiresAtIso)}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </ProovraText>
                      {canManage ? (
                        <View style={{ gap: theme.space.s1 }}>
                          <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
                            <ProovraButton
                              label="Resend"
                              accessibilityLabel={`Resend invitation to ${i.email}`}
                              variant="secondary"
                              fullWidth={false}
                              loading={resendingId === i.id}
                              disabled={resendingId !== null}
                              onPress={() => void resend(i)}
                            />
                            <ProovraButton
                              label="Revoke"
                              accessibilityLabel={`Revoke invitation to ${i.email}`}
                              variant="ghost"
                              fullWidth={false}
                              disabled={resendingId === i.id}
                              onPress={() => setRevoking(i)}
                            />
                          </View>
                          <ProovraText variant="label" color={theme.color.ink.muted}>
                            Resend sends a new link by email. The link sent earlier stops working.
                          </ProovraText>
                        </View>
                      ) : null}
                    </View>
                  ))}
                </ProovraCard>
              )}
            </ProovraPageSection>
          ) : null}

          {/* RECENT ACTIVITY — a marker, a sentence, a time; only when there is any. */}
          {activity && activity.length > 0 ? (
            <ProovraPageSection title="Recent activity">
              <ProovraCard>
                {activity.slice(0, RECENT_ACTIVITY_LIMIT).map((a) => (
                  <View key={a.id} style={{ flexDirection: "row", gap: theme.space.s2, paddingVertical: theme.space.s2 }}>
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        marginTop: 6,
                        backgroundColor: theme.color.status[activityTone(a.eventType)].solid,
                      }}
                    />
                    <View style={{ flex: 1, gap: 2 }}>
                      <ProovraText variant="bodySm">{describeActivity(a)}</ProovraText>
                      {a.occurredAtIso ? (
                        <ProovraText variant="label" color={theme.color.ink.muted}>
                          {formatUserDateTime(a.occurredAtIso)}
                        </ProovraText>
                      ) : null}
                    </View>
                  </View>
                ))}
              </ProovraCard>
            </ProovraPageSection>
          ) : null}

          {/* The transfer outcome lives OUTSIDE the owner gate: a transfer
              demotes the caller and the lifecycle region unmounts. */}
          {ownershipNotice ? (
            <ProovraCard testID="people-ownership-notice">
              <ProovraText variant="bodySm">{ownershipNotice}</ProovraText>
            </ProovraCard>
          ) : null}

          {isWorkspaceOwner(overview) && teamId ? (
            <ProovraPageSection title="Workspace lifecycle">
              <WorkspaceOwnershipTransferCard
                teamId={teamId}
                teamName={overview.name ?? "this workspace"}
                currentUserId={selfId}
                onTransferred={async (notice) => {
                  setOwnershipNotice(notice);
                  await load();
                }}
              />
              <WorkspaceClosureCard teamId={teamId} />
              <ProovraCard testID="people-delete-workspace">
                <ProovraText variant="h3" weight="semibold">
                  Delete this workspace
                </ProovraText>
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  Deleting removes the workspace and everybody’s access to it. Evidence retention and legal holds are
                  governed separately and are not overridden by this action.
                </ProovraText>
                <ProovraButton
                  label={deleting ? "Deleting…" : "Delete workspace"}
                  variant="ghost"
                  fullWidth={false}
                  disabled={deleting}
                  onPress={() => setDeleteConfirm(true)}
                />
              </ProovraCard>
            </ProovraPageSection>
          ) : null}

          {/* ---- THE RAIL ---- */}

          {canManage ? (
            <ProovraCard testID="people-rail-invite">
              <ProovraText variant="h3" weight="semibold">
                Invite people
              </ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Send someone an invitation to join this workspace. They are delivered by email, and the recipient joins by
                following the link in that message.
              </ProovraText>
              <ProovraButton label="Invite person" onPress={() => setInviteOpen(true)} />
            </ProovraCard>
          ) : null}

          <ProovraPageSection
            title="Workspace overview"
            actions={
              canManage ? (
                <ProovraButton
                  label="Rename"
                  accessibilityLabel="Rename workspace"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => {
                    setDraftName(overview.name ?? "");
                    setRenaming(true);
                  }}
                />
              ) : undefined
            }
          >
            <ProovraCard testID="people-workspace-overview">
              <ProovraDetailRows
                rows={[
                  { label: "Name", value: overview.name ?? "—" },
                  // The row STAYS when the plan is unknown, and says so.
                  { label: "Plan", value: overview.effectivePlan ?? "—" },
                  ...(overview.ownerLabel ? [{ label: "Owner", value: overview.ownerLabel }] : []),
                  {
                    label: "Members",
                    value:
                      seats?.seatLimit === null || !seats
                        ? `${activeMemberCount} active`
                        : `${seats.seatUsed ?? activeMemberCount} of ${seats.seatLimit} seats used`,
                  },
                ]}
              />
              {/* The web People rail's Billing entry (teams/[id]/page.tsx:1978). */}
              <ProovraButton label="Open billing" variant="secondary" fullWidth={false} onPress={() => router.push("/billing" as never)} />
              <ProovraText variant="label" color={theme.color.ink.muted}>
                Storage, subscription and payment for this workspace are managed in Billing.
              </ProovraText>
            </ProovraCard>
          </ProovraPageSection>

          {/* THE BRIDGE — a signpost to the operational groups, not documentation. */}
          <ProovraCard testID="people-collaboration-bridge">
            <ProovraText variant="h3" weight="semibold">
              Collaboration Teams
            </ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              Organise existing workspace members into operational groups for cases, evidence and work.
            </ProovraText>
            <ProovraButton label="Organise members" variant="secondary" onPress={() => router.push("/(tabs)/teams" as never)} />
          </ProovraCard>

          {/* T-14 — external collaborators and per-case revoke (web TeamAccessReviewCard). */}
          {teamId ? (
            <ProovraPageSection title="External collaborators">
              <ExternalCollaboratorsCard teamId={teamId} />
            </ProovraPageSection>
          ) : null}

          <ProovraPageSection
            title="Cases in this workspace"
            actions={
              canLinkCase(currentRole ?? "") ? (
                <ProovraButton label="Link a case" variant="secondary" fullWidth={false} loading={busy && linking} onPress={() => void openLinkPicker()} />
              ) : undefined
            }
          >
            {cases === null ? (
              <ProovraEmpty presence="inline" title="Linked cases are visible to workspace members." />
            ) : cases.length === 0 ? (
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                No cases are linked to this workspace yet.
              </ProovraText>
            ) : (
              <ProovraCard>
                {cases.map((c) => (
                  <ProovraListRow
                    key={c.id}
                    title={c.name}
                    subtitle={c.createdAtIso ? `Opened ${formatUserDate(c.createdAtIso)}` : undefined}
                    onPress={() => router.push(`/case/${c.id}` as never)}
                    trailing={
                      // Unlinking is ADMIN+, linking is MEMBER+. Two permissions.
                      canUnlinkCase(currentRole ?? "") ? (
                        <ProovraButton
                          label="Remove"
                          accessibilityLabel={`Remove ${c.name} from this workspace`}
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
          </ProovraPageSection>
        </>
      ) : null}

      {/* INVITE — the canonical workspace invitation. Email only: that is the
          only channel the invitation service delivers through. */}
      <ProovraSheet visible={inviteOpen} title="Invite a person to this workspace" onClose={() => setInviteOpen(false)}>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          They receive an email with a secure link. A pending invitation does not use a seat — the seat is claimed when they
          accept.
        </ProovraText>
        {roomLeft === false ? (
          <ProovraText variant="label" color={theme.color.status.pending.fg}>
            Every seat on this plan is in use. Free a seat or change plan to invite more people.
          </ProovraText>
        ) : null}
        <ProovraFormField label="Email address">
          <ProovraInput
            value={email}
            onChangeText={setEmail}
            placeholder="colleague@example.com"
            autoCapitalize="none"
            keyboardType="email-address"
            accessibilityLabel="Email address to invite"
          />
        </ProovraFormField>
        <ProovraFilterChips
          label="Workspace role"
          value={role}
          onChange={setRole}
          options={INVITABLE_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
        />
        <ProovraText variant="label" color={theme.color.ink.muted}>
          Access across this whole workspace. Roles inside a Collaboration Team are separate. Ownership is not granted by
          invitation — it moves by transfer.
        </ProovraText>
        <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
          <ProovraButton label="Cancel" variant="ghost" fullWidth={false} onPress={() => setInviteOpen(false)} />
          <ProovraButton
            label={busy ? "Sending…" : "Send invitation"}
            fullWidth={false}
            loading={busy}
            disabled={roomLeft === false || !email.trim()}
            onPress={() => void invite()}
          />
        </View>
      </ProovraSheet>

      {teamId ? (
        <MemberRemovalSheet
          teamId={teamId}
          member={removing}
          onClose={() => setRemoving(null)}
          onRemoved={async (gone) => {
            setRemoving(null);
            // The outcome is reported from the RE-READ roster, as the web does.
            const mp = await reloadRoster();
            if (!mp) {
              addToast("The member was removed, but the list could not be reloaded to confirm it. Reload the page.", "error");
              return;
            }
            const still = mp.members.some((x) => x.id === gone.id || (x.userId && x.userId === gone.userId));
            addToast(
              still ? "The removal was accepted, but the reloaded list still shows this person. Reload the page before trying again." : "Member removed",
              still ? "error" : "success",
            );
            if (!still) setOverview((prev) => (prev ? { ...prev, seats: { ...prev.seats, memberCount: Math.max(0, prev.seats.memberCount - 1) } } : prev));
          }}
        />
      ) : null}

      <ProovraSheet
        visible={roleFor !== null}
        title={roleFor ? `Workspace role for ${roleFor.displayName}` : ""}
        onClose={() => setRoleFor(null)}
      >
        {/* OWNER is not offered: ownership moves by transfer, not by role. */}
        {MANAGEABLE_ROLES.map((r) => (
          <ProovraListRow
            key={r}
            title={roleLabel(r)}
            subtitle={roleFor && r.toUpperCase() === roleFor.role.toUpperCase() ? "Their current role" : undefined}
            onPress={() => {
              if (roleFor) void changeRole(roleFor, r);
            }}
          />
        ))}
      </ProovraSheet>

      <ProovraSheet visible={linking} title="Link a case" onClose={() => setLinking(false)}>
        {linkable === null ? (
          <ProovraLoadingState label="Loading cases…" />
        ) : linkable.length === 0 ? (
          <ProovraEmpty presence="inline" title="No unlinked cases are available to add." />
        ) : (
          linkable.map((c) => (
            <ProovraListRow
              key={c.id}
              title={c.name}
              trailing={<ProovraButton label="Link" accessibilityLabel={`Link ${c.name}`} variant="secondary" fullWidth={false} onPress={() => void linkCase(c)} />}
            />
          ))
        )}
      </ProovraSheet>

      <ProovraSheet visible={renaming} title="Rename this workspace" onClose={() => setRenaming(false)}>
        <ProovraFormField label="Workspace name">
          <ProovraInput value={draftName} onChangeText={setDraftName} autoCapitalize="sentences" accessibilityLabel="Workspace name" />
        </ProovraFormField>
        <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
          <ProovraButton label="Cancel" variant="ghost" fullWidth={false} onPress={() => setRenaming(false)} />
          <ProovraButton
            label={busy ? "Saving…" : "Save name"}
            fullWidth={false}
            loading={busy}
            disabled={validateWorkspaceName(draftName) !== null}
            onPress={() => void rename()}
          />
        </View>
      </ProovraSheet>

      <ProovraConfirmSheet
        visible={unlinking !== null}
        title="Remove case from this workspace?"
        consequence={
          unlinking
            ? `"${unlinking.name}" will be detached from this workspace. The case itself is not deleted; its owner retains it. Existing case access grants stay on the case. To revoke individual members, manage access on the case itself.`
            : ""
        }
        confirmLabel="Remove from workspace"
        tone="danger"
        busy={busy}
        onConfirm={() => void unlinkCase()}
        onCancel={() => setUnlinking(null)}
      />

      <ProovraConfirmSheet
        visible={revoking !== null}
        title="Revoke this invitation?"
        consequence={
          revoking
            ? `${revoking.email} will no longer be able to accept the invitation link. The recipient is not notified. To invite them again, send a fresh invitation.`
            : ""
        }
        confirmLabel="Revoke invitation"
        tone="danger"
        busy={busy}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />

      <ProovraConfirmSheet
        visible={deleteConfirm}
        title="Delete this workspace?"
        consequence="Everybody loses access to this workspace. Evidence retention and legal holds are governed separately and are not overridden by deleting a workspace."
        confirmLabel="Delete workspace"
        tone="danger"
        busy={deleting}
        onConfirm={() => void deleteWorkspace()}
        onCancel={() => setDeleteConfirm(false)}
      />
    </ProovraScreen>
  );
}
