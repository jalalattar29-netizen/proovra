/**
 * ORGANIZATION DETAIL — the native port of
 * `apps/web/app/(app)/organizations/[id]/page.tsx`.
 *
 * Governance only. `GET /v1/orgs/:id` returns governance fields and
 * deliberately omits workspace-level aggregates — no evidence counts, no case
 * counts, no reviewer queue counts — because an organization member is not
 * thereby a member of every workspace inside it. Native shows what the
 * endpoint gives and asks for nothing else.
 *
 * The audit timeline and the three lifecycle actions — leaving, ownership
 * transfer, closure — are here. They were previously absent with the note that
 * "a phone-sized version of a one-way door is not a smaller feature, it is a
 * worse one". That is a claim about the affordance, and it does not survive
 * contact with where the safety actually lives: the owner check, the typed
 * confirmation phrase, the cooling-off period, the blocker list and the
 * step-up proof are all enforced by the SERVER. The client's job is to state
 * the consequence before the action and to carry the server's own words —
 * which it does, and which it can do on a phone.
 *
 * Member and invitation management are NOT here, and that is not a gap: the
 * web moved both to the organization admin console
 * (/organizations/[id]/admin/members), which the route registry declares
 * ENTERPRISE_ONLY. This page deep-links to them exactly as the web does.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { useToast } from "../../../src/toast-context";
import { StepUpSheet, useStepUp } from "../../../src/ui/step-up-sheet";
import { OrgSettings } from "../../../src/ui/org-settings";
import { OrgWorkspaceLifecycleControls } from "../../../src/ui/org-workspace-lifecycle";
import { withStepUp } from "../../../src/product/step-up";
import {
  buildClosureBody,
  canRequestClosure,
  closureFailureNeedsReload,
  closurePhraseMatches,
  hasOpenClosure,
  parseClosureState,
  type ClosureState,
} from "../../../src/product/closure";
import { formatUserDate, formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
  ProovraInput,
  ProovraFormField,
  ProovraSheet,
  ProovraConfirmSheet,
} from "../../../src/ui";
import {
  auditEventLabel,
  buildOrgAuditPath,
  buildOrgClosureCancelPath,
  buildOrgClosurePath,
  buildOrgLeavePath,
  buildOrgMembersPath,
  buildOrgTransferPath,
  isOrgOwner,
  orgLifecycleFailureMessage,
  parseOrgAuditPage,
  transferTargets,
  type OrgAuditEvent,
  buildOrgPath,
  buildOrgWorkspacesPath,
  orgRoleLabel,
  orgStatusTone,
  parseOrgDetail,
  parseOrgMembers,
  parseOrgWorkspaces,
  type OrgDetail,
  type OrgMember,
  type OrgWorkspace,
  orgPlanLabel,
  orgWorkspaceBillingStatusLabel,
  canEditOrgSettings,
  buildOrgInvitesPath,
  orgRoleTally,
  orgBillingTileSummary,
  orgAuditCountLabel,
  orgClosureStatusLabel,
  parseOrgWorkspacesCanSeeBilling,
  parseOrgPendingInviteTotal,
  ORG_DETAIL_COPY as COPY,
} from "../../../src/product/organizations";

/** One of the web's four overview tiles (organizations/[id]/page.tsx OverviewTile). */
function OverviewTile({
  title,
  primary,
  secondary,
  footer,
}: {
  title: string;
  primary: string;
  secondary: string;
  footer?: React.ReactNode;
}) {
  return (
    <ProovraCard testID={`org-tile-${title.toLowerCase()}`} style={{ flexGrow: 1, flexBasis: 150, gap: 4 }}>
      <ProovraText variant="label" weight="bold" color={theme.color.ink.muted}>
        {title.toUpperCase()}
      </ProovraText>
      <ProovraText variant="h3" weight="semibold">{primary}</ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>{secondary}</ProovraText>
      {footer ?? null}
    </ProovraCard>
  );
}

type State =
  | { phase: "loading" }
  | { phase: "loaded"; org: OrgDetail }
  | { phase: "denied" }
  | { phase: "failed" };

export default function OrganizationDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const [state, setState] = useState<State>({ phase: "loading" });
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [workspaces, setWorkspaces] = useState<OrgWorkspace[] | null>(null);
  const [workspacesFailure, setWorkspacesFailure] = useState<string | null>(null);
  const [canSeeBilling, setCanSeeBilling] = useState(false);
  // GET /v1/orgs/:id/invites — ORG_ADMIN+; null for everyone else.
  const [pendingTotal, setPendingTotal] = useState<number | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [audit, setAudit] = useState<OrgAuditEvent[] | null>(null);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [closure, setClosure] = useState<ClosureState | null>(null);

  const { addToast } = useToast();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [transferTarget, setTransferTarget] = useState<OrgMember | null>(null);
  const [closing, setClosing] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [cancellingClosure, setCancellingClosure] = useState(false);

  // A silent re-read after a settings save: the form stays mounted with its confirmation.
  const reloadOrg = useCallback(async () => {
    if (!id) return;
    try {
      const org = parseOrgDetail(await apiFetch(buildOrgPath(id)));
      if (org) setState({ phase: "loaded", org });
    } catch {
      // The save succeeded; a failed re-read leaves the last good header in place.
    }
  }, [id]);

  // The workspace list alone, re-read in place: a suspend/resume announcement
  // lives inside the list and must survive the refresh it triggers.
  const loadWorkspaces = useCallback(async () => {
    if (!id) return;
    try {
      const data = await apiFetch(buildOrgWorkspacesPath(id));
      setWorkspaces(parseOrgWorkspaces(data));
      setCanSeeBilling(parseOrgWorkspacesCanSeeBilling(data));
      setWorkspacesFailure(null);
    } catch (err) {
      setWorkspaces(null);
      // The list is MEMBER-readable (organizations.routes.ts:588), so a
      // failure is not "visible to administrators" — that claim sent
      // members looking for a permission they already had.
      setWorkspacesFailure(
        (err as { statusCode?: number })?.statusCode === 403
          ? "You don’t have access to the workspace list."
          : toSafeUserError(err).message || "The workspace list could not be loaded.",
      );
    }
  }, [id]);

  const load = useCallback(async () => {
    if (!id) return;
    setState({ phase: "loading" });
    try {
      const org = parseOrgDetail(await apiFetch(buildOrgPath(id)));
      if (!org) {
        setState({ phase: "failed" });
        return;
      }
      setState({ phase: "loaded", org });
    } catch (err) {
      // 403 is the membership gate answering; it is not a page failure.
      const status = (err as { statusCode?: number } | undefined)?.statusCode;
      setState({ phase: status === 403 || status === 404 ? "denied" : "failed" });
      return;
    }

    // Members and workspaces load independently: either may be gated on the
    // caller's org role, and one refusal must not blank the whole page.
    await Promise.all([
      apiFetch(buildOrgMembersPath(id))
        .then((d) => setMembers(parseOrgMembers(d)))
        .catch(() => setMembers(null)),
      loadWorkspaces(),
      // ORG_AUDITOR and above. A caller below that rank gets a refusal here
      // and a null feed, which the section states as a visibility fact rather
      // than as an error the page could retry out of.
      // The web's pending-invite figure for the Governance tile (ORG_ADMIN+).
      apiFetch(buildOrgInvitesPath(id))
        .then((d) => setPendingTotal(parseOrgPendingInviteTotal(d)))
        .catch(() => setPendingTotal(null)),
      apiFetch(buildOrgAuditPath(id, { take: 50 }))
        .then((d) => {
          const page = parseOrgAuditPage(d);
          setAudit(page.events);
          setAuditCursor(page.nextCursor);
        })
        .catch(() => setAudit(null)),
      // Owner-only, and it carries the phrase, the cooling-off period and the
      // blocker list. None of those three is ever restated by the client.
      apiFetch(buildOrgClosurePath(id))
        .then((d) => setClosure(parseClosureState(d)))
        .catch(() => setClosure(null)),
    ]);
  }, [id, loadWorkspaces]);

  const loadMoreAudit = useCallback(async () => {
    if (!id || !auditCursor) return;
    try {
      const page = parseOrgAuditPage(
        await apiFetch(buildOrgAuditPath(id, { take: 50, cursor: auditCursor })),
      );
      setAudit((prev) => [...(prev ?? []), ...page.events]);
      setAuditCursor(page.nextCursor);
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    }
  }, [id, auditCursor, addToast]);

  const reloadClosure = useCallback(async () => {
    if (!id) return;
    try {
      setClosure(parseClosureState(await apiFetch(buildOrgClosurePath(id))));
    } catch {
      setClosure(null);
    }
  }, [id]);

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      // The named refusals say what actually happened. "Could not transfer
      // ownership" hides both "you are no longer the owner" and "they left".
      setNotice(orgLifecycleFailureMessage(err, toSafeUserError(err).message) ?? fallback);
      if (closureFailureNeedsReload(err)) void reloadClosure();
    },
    [reloadClosure],
  );

  const leave = useCallback(async () => {
    if (!id) return;
    setLeaving(false);
    setBusy(true);
    setLeaveError(null);
    await stepUp.start(
      async (proof) => {
        await apiFetch(buildOrgLeavePath(id), {
          method: "POST",
          body: JSON.stringify(withStepUp({}, proof)),
        });
        addToast("You have left this organization.", "success");
        // The web returns to the list (router.replace("/organizations")).
        router.replace("/organizations");
      },
      // 409 OWNERSHIP_TRANSFER_REQUIRED carries the server's own sentence.
      (err) => setLeaveError(orgLifecycleFailureMessage(err, toSafeUserError(err, { message: COPY.leaveFailed }).message)),
    );
    setBusy(false);
  }, [id, stepUp, addToast, router]);

  const transfer = useCallback(async () => {
    const target = transferTarget;
    if (!id || !target) return;
    setTransferTarget(null);
    setTransferring(false);
    setBusy(true);
    setNotice(null);
    await stepUp.start(
      async (proof) => {
        await apiFetch(buildOrgTransferPath(id), {
          method: "POST",
          body: JSON.stringify(withStepUp({ targetUserId: target.userId }, proof)),
        });
        addToast("Ownership transferred. You are now an organization admin.", "success");
        await load();
      },
      (err) => fail(err, "Could not transfer ownership."),
    );
    setBusy(false);
  }, [id, transferTarget, stepUp, addToast, load, fail]);

  const requestClosure = useCallback(async () => {
    if (!id) return;
    setBusy(true);
    setNotice(null);
    await stepUp.start(
      async (proof) => {
        await apiFetch(buildOrgClosurePath(id), {
          method: "POST",
          // The phrase is sent exactly as typed and checked SERVER-side. The
          // client compares it only to decide whether to enable the button.
          body: JSON.stringify(withStepUp(buildClosureBody(phrase), proof)),
        });
        setClosing(false);
        setPhrase("");
        await reloadClosure();
      },
      (err) => fail(err, "Could not request closure."),
    );
    setBusy(false);
  }, [id, phrase, stepUp, reloadClosure, fail]);

  const cancelClosure = useCallback(async () => {
    const requestId = closure?.requestId;
    if (!id || !requestId) return;
    setCancellingClosure(false);
    setBusy(true);
    setNotice(null);
    try {
      await apiFetch(buildOrgClosureCancelPath(id, requestId), {
        method: "POST",
        body: JSON.stringify({}),
      });
      addToast("The closure request was cancelled.", "success");
      await reloadClosure();
    } catch (err) {
      fail(err, "Could not cancel the request.");
    } finally {
      setBusy(false);
    }
  }, [id, closure, addToast, reloadClosure, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadedOrg = state.phase === "loaded" ? state.org : null;
  const pendingCount = pendingTotal ?? loadedOrg?.pendingInviteCount ?? null;
  const roleTally = members === null ? null : orgRoleTally(members);
  const lastAuditAt = audit && audit.length > 0 ? audit[0]?.occurredAtIso ?? null : null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <ProovraScreen shell testID="organization-detail">
      <ProovraPageHeader
        title={loadedOrg ? (loadedOrg.name ?? "Organization") : "Organization"}
        eyebrow={COPY.eyebrow}
        subtitle={COPY.subtitle}
        contextStrip={
          loadedOrg ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
              {loadedOrg.callerRole ? (
                <ProovraBadge label={`Your role · ${orgRoleLabel(loadedOrg.callerRole)}`} tone="governance" />
              ) : null}
              {loadedOrg.status ? (
                <ProovraBadge label={loadedOrg.status} tone={orgStatusTone(loadedOrg.status)} />
              ) : null}
              {loadedOrg.verificationState ? (
                <ProovraBadge label={loadedOrg.verificationState} tone={orgStatusTone(loadedOrg.verificationState)} />
              ) : null}
              {loadedOrg.memberCount !== null && loadedOrg.workspaceCount !== null ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {`${plural(loadedOrg.memberCount, "member")} · ${plural(loadedOrg.workspaceCount, "workspace")}`}
                </ProovraText>
              ) : null}
              {loadedOrg.legalName || loadedOrg.legalEmail ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[loadedOrg.legalName ? `Legal: ${loadedOrg.legalName}` : null, loadedOrg.legalEmail].filter(Boolean).join(" · ")}
                </ProovraText>
              ) : null}
            </View>
          ) : undefined
        }
        secondaryActions={
          <>
            <ProovraButton label={COPY.allOrgs} variant="ghost" fullWidth={false} onPress={() => router.replace("/organizations")} />
            {loadedOrg ? (
              <ProovraButton label={COPY.workspaceAdmin} variant="secondary" fullWidth={false} onPress={() => router.push("/spaces")} />
            ) : null}
            {/* Leave — hidden for the owner, who must transfer or close first
                (the server enforces the same guard regardless). */}
            {loadedOrg && !isOrgOwner(loadedOrg) ? (
              <ProovraButton label={COPY.leave} variant="ghost" fullWidth={false} loading={busy} onPress={() => setLeaving(true)} />
            ) : null}
          </>
        }
      />

      {leaveError ? (
        <ProovraCard testID="org-leave-error">
          <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{leaveError}</ProovraText>
        </ProovraCard>
      ) : null}

      {state.phase === "loading" ? <ProovraLoadingState label="Loading organization" /> : null}
      {state.phase === "failed" ? (
        <ProovraErrorState message="This organization could not be loaded." onRetry={() => void load()} />
      ) : null}
      {state.phase === "denied" ? (
        <ProovraEmpty
          presence="page"
          title="This organization is not available to you"
          purpose="You may have left it, or your membership may no longer be active."
        />
      ) : null}

      {state.phase === "loaded" ? (
        <>
          {/* The web's owner onboarding (organizations/[id]/page.tsx:636): only for an
              owner who is still the organization's only member. */}
          {isOrgOwner(state.org) && state.org.memberCount === 1 ? (
            <ProovraCard testID="org-onboarding">
              <ProovraText variant="h3" weight="semibold">You just created this organization — next steps</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                Three governance steps that turn a single-owner org into a real collaborative tenant. Each one is wired to a real audited endpoint.
              </ProovraText>
              <ProovraText variant="bodySm">
                1. Invite the first member. Open Members in the organization admin console, pick a role, and share the invite token URL. Each invitation is recorded in the audit timeline.
              </ProovraText>
              <ProovraText variant="bodySm">
                2. Set legal metadata. Fill name, legal name, and legal email in the Settings panel below so audit timeline events and exports carry your org’s identity. Each change is recorded in the audit timeline.
              </ProovraText>
              <ProovraText variant="bodySm">
                3. Bind a workspace. Workspaces are where evidence and cases live; the binding shows up in this org’s Workspaces panel below.
              </ProovraText>
              <ProovraButton label="Workspace administration" variant="secondary" fullWidth={false} onPress={() => router.push("/spaces")} />
            </ProovraCard>
          ) : null}

          {/* The web's four overview tiles (organizations/[id]/page.tsx "org-overview"). */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }} testID="org-overview">
            <OverviewTile
              title="Governance"
              primary={state.org.memberCount !== null ? plural(state.org.memberCount, "member") : "—"}
              secondary={pendingCount === null ? "Pending invites are visible to organization admins." : plural(pendingCount, "pending invite")}
              footer={
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {roleTally ?? "Role distribution is not available."}
                </ProovraText>
              }
            />
            <OverviewTile
              title="Workspaces"
              primary={state.org.workspaceCount !== null ? String(state.org.workspaceCount) : "—"}
              secondary={
                workspaces && workspaces.length > 0
                  ? workspaces.slice(0, 3).map((w) => w.name).join(", ")
                  : "No workspaces bound to this organization yet."
              }
              footer={
                <ProovraButton label="Open in Workspace administration →" variant="ghost" fullWidth={false} onPress={() => router.push("/spaces")} />
              }
            />
            <OverviewTile
              title="Billing"
              primary={canSeeBilling && workspaces && workspaces.length > 0 ? orgBillingTileSummary(workspaces) : "Workspace-scoped"}
              secondary={
                canSeeBilling
                  ? "Per-workspace plan + seat usage shown below. Org-level billing unification is on the Phase 2.7X roadmap; for now the workspace is the billing unit."
                  : "Org-level billing unification is on the Phase 2.7X roadmap. Today, plan / seats / addons are managed per workspace. Visibility requires ORG_ADMIN+ or ORG_BILLING_ADMIN."
              }
              footer={<ProovraButton label="Open billing →" variant="ghost" fullWidth={false} onPress={() => router.push("/billing")} />}
            />
            <OverviewTile
              title="Audit"
              primary={audit ? orgAuditCountLabel(audit.length, auditCursor !== null) : "Auditor-only"}
              secondary={
                lastAuditAt
                  ? `Latest ${formatUserDateTime(lastAuditAt)}`
                  : audit
                    ? "No events recorded yet."
                    : COPY.auditorOnly
              }
            />
          </View>

          {/* T-14 — identity metadata (organizations/[id]/page.tsx Settings card). */}
          <OrgSettings orgId={String(id)} org={state.org} onSaved={reloadOrg} />

          <ProovraPageSection title={COPY.membersTitle} description={COPY.membersSubtitle}>
            {state.org.memberCount !== null ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {[
                  plural(state.org.memberCount, "member"),
                  pendingCount !== null ? plural(pendingCount, "pending invite") : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </ProovraText>
            ) : null}
            {roleTally && members && members.length > 0 ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>{roleTally}</ProovraText>
            ) : null}
            {members === null ? (
              <ProovraEmpty
                presence="inline"
                title="Members are visible to organization administrators."
              />
            ) : members.length === 0 ? (
              <ProovraEmpty presence="inline" title="No members are listed." />
            ) : (
              <ProovraCard>
                {members.map((m) => (
                  <ProovraListRow
                    key={m.id}
                    title={m.displayName}
                    subtitle={m.email ?? undefined}
                    trailing={<ProovraBadge label={orgRoleLabel(m.role)} tone="neutral" />}
                  />
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>

          <ProovraPageSection
            title="Workspaces"
            description={COPY.workspacesSubtitle}
            actions={<ProovraButton label={COPY.workspaceAdmin} variant="secondary" fullWidth={false} onPress={() => router.push("/spaces")} />}
          >
            {workspaces === null ? (
              <ProovraEmpty presence="inline" title={workspacesFailure ?? "The workspace list could not be loaded."} />
            ) : workspaces.length === 0 ? (
              <ProovraEmpty
                presence="inline"
                title={COPY.workspacesEmptyTitle}
                purpose={COPY.workspacesEmptyPurpose}
                action={<ProovraButton label={COPY.openWorkspaceAdmin} variant="secondary" fullWidth={false} onPress={() => router.push("/spaces")} />}
              />
            ) : (
              <ProovraCard>
                {workspaces.map((w) => (
                  <View key={w.id} style={{ gap: 4, paddingVertical: theme.space.s2 }} testID={`org-workspace-${w.id}`}>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s1 }}>
                      <ProovraText variant="bodySm" weight="semibold">{w.name}</ProovraText>
                      {w.isPersonal ? <ProovraBadge label="personal" tone="neutral" /> : null}
                      {w.billing ? <ProovraBadge label={orgPlanLabel(w.billing.plan)} tone="governance" /> : null}
                      {w.billing ? (
                        <ProovraBadge label={orgWorkspaceBillingStatusLabel(w.billing.status)} tone={w.billing.status === "ACTIVE" ? "verified" : "pending"} />
                      ) : null}
                      {w.billing?.overSeatLimit ? <ProovraBadge label="OVER SEAT LIMIT" tone="risk" /> : null}
                    </View>
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      {[
                        w.createdAtIso ? `Created ${formatUserDate(w.createdAtIso)}` : null,
                        w.billing && w.billing.includedSeats !== null
                          ? `${w.billing.includedSeats} included seat${w.billing.includedSeats === 1 ? "" : "s"}`
                          : null,
                        w.memberCount === null ? null : `${w.memberCount} member${w.memberCount === 1 ? "" : "s"}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </ProovraText>
                    {/* Reversible org-workspace suspension (web OrgWorkspaceLifecycleControls). */}
                    <OrgWorkspaceLifecycleControls
                      orgId={String(id)}
                      workspaceId={w.id}
                      workspaceName={w.name}
                      isPersonal={w.isPersonal}
                      canManage={canEditOrgSettings(state.org)}
                      onChanged={loadWorkspaces}
                    />
                  </View>
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>

          <ProovraPageSection title="Audit timeline" description={COPY.auditSubtitle}>
            {audit === null ? (
              // Auditor and above. A caller below that rank is not seeing a
              // failure, they are seeing the limit of their role.
              <ProovraEmpty
                presence="inline"
                title="The audit timeline is visible to organization auditors and administrators."
              />
            ) : audit.length === 0 ? (
              <ProovraEmpty presence="inline" title="No events have been recorded yet." />
            ) : (
              <>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {`${orgAuditCountLabel(audit.length, auditCursor !== null)}${lastAuditAt ? ` · latest ${formatUserDateTime(lastAuditAt)}` : ""}`}
                </ProovraText>
                <ProovraCard>
                  {audit.map((e) => (
                    <View key={e.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                      <ProovraText variant="bodySm">{auditEventLabel(e.eventType)}</ProovraText>
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {[
                          // An unresolved actor is "system", not a raw uuid
                          // printed where a person name belongs.
                          e.actorLabel ?? "System",
                          e.targetType,
                          e.occurredAtIso ? formatUserDateTime(e.occurredAtIso) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </ProovraText>
                    </View>
                  ))}
                </ProovraCard>
                {auditCursor ? (
                  <ProovraButton
                    label="Load older events"
                    variant="ghost"
                    onPress={() => void loadMoreAudit()}
                  />
                ) : null}
              </>
            )}
          </ProovraPageSection>

          {/* The web's "Scope — what lives where" explainer (organizations/[id]/page.tsx:1170). */}
          <ProovraPageSection title="Scope — what lives where">
            <ProovraCard testID="org-scope">
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                The platform uses three tenancy scopes. Each one owns a specific category of operational data and a specific category of identity.
              </ProovraText>
              <ProovraText variant="bodySm" weight="semibold">Personal Space</ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Private to you. Your own evidence, drafts, and integrations. Never shared. Lives outside any organization.
              </ProovraText>
              <ProovraText variant="bodySm" weight="semibold">Organization (you are here)</ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Governance + identity tenant. Members, roles, invites, audit timeline, legal metadata. Does NOT grant workspace data access on its own.
              </ProovraText>
              <ProovraText variant="bodySm" weight="semibold">Workspace (a.k.a. Team)</ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Operational tenant. Evidence, cases, reviewer queues, retention policy, plan + seats. Each workspace is bound to exactly one organization. Workspace-level RBAC is independent of organization role.
              </ProovraText>
            </ProovraCard>
          </ProovraPageSection>

          {/* The web's danger-zone card (organizations/[id]/page.tsx "org-danger-zone"). */}
          <ProovraPageSection title={COPY.lifecycleTitle} description={COPY.lifecycleSubtitle}>
            <ProovraCard testID="org-lifecycle" style={{ gap: theme.space.s3 }}>
              {notice ? (
                <ProovraText variant="label" color={theme.color.status.risk.fg}>
                  {notice}
                </ProovraText>
              ) : null}

              {!isOrgOwner(state.org) ? (
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.ownerOnlyNote}</ProovraText>
              ) : (
                <>
                  <View style={{ gap: theme.space.s1 }}>
                    <ProovraText variant="bodySm" weight="semibold">Transfer ownership.</ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.transferLead}</ProovraText>
                    {members !== null && transferTargets(members).length === 0 ? (
                      <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.transferNoTargets}</ProovraText>
                    ) : (
                      <ProovraButton
                        label="Transfer ownership"
                        variant="secondary"
                        fullWidth={false}
                        loading={busy}
                        onPress={() => setTransferring(true)}
                      />
                    )}
                  </View>

                  <View style={{ gap: theme.space.s1 }}>
                    <ProovraText variant="bodySm" weight="semibold">Close organization.</ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.secondary}>
                      {closure?.coolingOffDays !== null && closure?.coolingOffDays !== undefined
                        ? COPY.closureLead(closure.coolingOffDays)
                        : "Archives the organization after a cancellation window. Workspace access and machine credentials are revoked; evidence is never deleted by closure — it stays governed by retention and legal-hold rules."}
                    </ProovraText>

                    {closure && hasOpenClosure(closure) ? (
                      <View style={{ gap: theme.space.s1 }} testID="org-closure-open">
                        <ProovraText variant="body" weight="semibold">
                          Closure requested
                        </ProovraText>
                        {closure.requestStatus ? (
                          <ProovraBadge label={orgClosureStatusLabel(closure.requestStatus)} tone="pending" />
                        ) : null}
                        <ProovraText variant="label" color={theme.color.ink.secondary}>
                          {closure.effectiveAtIso
                            ? `This organization is scheduled to close on ${formatUserDateTime(closure.effectiveAtIso)}. It can be cancelled until then.`
                            : "A closure request is open and can still be cancelled."}
                        </ProovraText>
                        <ProovraButton
                          label="Cancel the closure request"
                          variant="secondary"
                          fullWidth={false}
                          loading={busy}
                          onPress={() => setCancellingClosure(true)}
                        />
                      </View>
                    ) : null}

                    {closure && !hasOpenClosure(closure) && closure.blockers.length > 0 ? (
                      <View style={{ gap: 2 }}>
                        <ProovraText variant="label" weight="semibold">
                          Closure is blocked
                        </ProovraText>
                        {/*
                          The server wrote these sentences. Restating them here
                          would put the client in the business of explaining a
                          refusal it did not make.
                        */}
                        {closure.blockers.map((b) => (
                          <ProovraText key={b.code} variant="label" color={theme.color.ink.muted}>
                            {b.count !== null ? `• ${b.message} (${b.count})` : `• ${b.message}`}
                          </ProovraText>
                        ))}
                      </View>
                    ) : null}

                    {closure && canRequestClosure(closure) ? (
                      <ProovraButton
                        label="Close this organization…"
                        variant="secondary"
                        fullWidth={false}
                        loading={busy}
                        onPress={() => setClosing(true)}
                      />
                    ) : null}
                  </View>
                </>
              )}
            </ProovraCard>

            {/*
              Members and invitations live in the organization admin console,
              which the route registry declares ENTERPRISE_ONLY. The web page
              deep-links to it from here too; it is not a native gap.
            */}
            <ProovraText variant="label" color={theme.color.ink.muted}>
              Managing members, roles and pending invitations is done in the organization
              admin console.
            </ProovraText>
          </ProovraPageSection>

          {/* ---------------------------------------------------- the sheets */}

          <ProovraConfirmSheet
            visible={leaving}
            title={`Leave ${state.org.name ?? "this organization"}?`}
            consequence={COPY.leaveConsequence}
            confirmLabel={COPY.leave}
            tone="danger"
            busy={busy}
            onConfirm={() => void leave()}
            onCancel={() => setLeaving(false)}
          />

          <ProovraSheet
            visible={transferring}
            title="Transfer ownership"
            onClose={() => setTransferring(false)}
          >
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              The person you choose becomes the organization owner and you become an admin.
              Billing ownership follows the owner. This is atomic and audited.
            </ProovraText>
            {members === null || transferTargets(members).length === 0 ? (
              <ProovraEmpty
                presence="inline"
                title="There is no other active member to transfer ownership to."
              />
            ) : (
              transferTargets(members).map((m) => (
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
            title={`Transfer ownership of ${state.org.name ?? "this organization"}?`}
            consequence={`${transferTarget?.displayName ?? "The selected member"} becomes the organization owner and you become an admin. Billing ownership follows the owner. This is atomic and audited.`}
            confirmLabel="Transfer ownership"
            tone="danger"
            busy={busy}
            onConfirm={() => void transfer()}
            onCancel={() => setTransferTarget(null)}
          />

          <ProovraSheet
            visible={closing}
            title="Close this organization"
            onClose={() => setClosing(false)}
          >
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {closure?.coolingOffDays !== null && closure?.coolingOffDays !== undefined
                ? `Closure does not happen immediately: there is a ${closure.coolingOffDays}-day period in which it can be cancelled.`
                : "Closure does not happen immediately; it can be cancelled during a cooling-off period."}
            </ProovraText>

            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              {closure?.confirmationPhrase ? `Type ${closure.confirmationPhrase} to confirm.` : "Type the confirmation phrase to confirm."}
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
            {/*
              The phrase is the SERVER's. A client that believed in its own
              copy and the route rejected it would make closure impossible with
              no explanation the user could act on.
            */}
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
            <ProovraButton
              label={COPY.keep}
              variant="ghost"
              disabled={busy}
              onPress={() => {
                setClosing(false);
                setPhrase("");
              }}
            />
          </ProovraSheet>

          <ProovraConfirmSheet
            visible={cancellingClosure}
            title="Cancel the closure request?"
            consequence="The organization stays open and nothing is deleted. You can request closure again later."
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
              void stepUp.retry(proof, (err) => fail(err, "That could not be completed."))
            }
            onCancel={stepUp.dismiss}
          />
        </>
      ) : null}
    </ProovraScreen>
  );
}

