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
import { formatUserDateTime } from "../../../src/lib/date";
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
  ProovraDetailRows,
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
} from "../../../src/product/organizations";

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
      apiFetch(buildOrgWorkspacesPath(id))
        .then((d) => setWorkspaces(parseOrgWorkspaces(d)))
        .catch(() => setWorkspaces(null)),
      // ORG_AUDITOR and above. A caller below that rank gets a refusal here
      // and a null feed, which the section states as a visibility fact rather
      // than as an error the page could retry out of.
      apiFetch(buildOrgAuditPath(id, { take: 25 }))
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
  }, [id]);

  const loadMoreAudit = useCallback(async () => {
    if (!id || !auditCursor) return;
    try {
      const page = parseOrgAuditPage(
        await apiFetch(buildOrgAuditPath(id, { take: 25, cursor: auditCursor })),
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
    setNotice(null);
    await stepUp.start(
      async (proof) => {
        await apiFetch(buildOrgLeavePath(id), {
          method: "POST",
          body: JSON.stringify(withStepUp({}, proof)),
        });
        addToast("You have left this organization.", "success");
        router.back();
      },
      (err) => fail(err, "Could not leave this organization."),
    );
    setBusy(false);
  }, [id, stepUp, addToast, router, fail]);

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

  return (
    <ProovraScreen testID="organization-detail">
      <ProovraPageHeader
        title={state.phase === "loaded" ? (state.org.name ?? "Organization") : "Organization"}
        eyebrow="Governance"
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

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
          <ProovraCard>
            <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
              {state.org.status ? (
                <ProovraBadge label={state.org.status} tone={orgStatusTone(state.org.status)} />
              ) : null}
              {state.org.verificationState ? (
                <ProovraBadge
                  label={state.org.verificationState}
                  tone={orgStatusTone(state.org.verificationState)}
                />
              ) : null}
            </View>
            <ProovraDetailRows
              rows={[
                { label: "Legal name", value: state.org.legalName ?? "—" },
                { label: "Legal contact", value: state.org.legalEmail ?? "—" },
                { label: "Timezone", value: state.org.timezone ?? "—" },
                {
                  label: "Created",
                  value: state.org.createdAtIso ? formatUserDateTime(state.org.createdAtIso) : "—",
                },
                {
                  label: "Verified",
                  value: state.org.verifiedAtIso
                    ? formatUserDateTime(state.org.verifiedAtIso)
                    : "Not verified",
                },
              ]}
            />
          </ProovraCard>

          <ProovraPageSection title="Members">
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
                    trailing={
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {orgRoleLabel(m.role)}
                      </ProovraText>
                    }
                  />
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>

          <ProovraPageSection title="Workspaces">
            {workspaces === null ? (
              <ProovraEmpty
                presence="inline"
                title="Workspaces are visible to organization administrators."
              />
            ) : workspaces.length === 0 ? (
              <ProovraEmpty presence="inline" title="This organization has no workspaces." />
            ) : (
              <ProovraCard>
                {workspaces.map((w) => (
                  <ProovraListRow
                    key={w.id}
                    title={w.name}
                    subtitle={
                      w.memberCount === null
                        ? undefined
                        : `${w.memberCount} member${w.memberCount === 1 ? "" : "s"}`
                    }
                  />
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>

          <ProovraPageSection title="Audit timeline">
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

          <ProovraPageSection title="This organization and you">
            {notice ? (
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {notice}
              </ProovraText>
            ) : null}

            {/*
              Leaving is offered to anyone who is NOT the owner — an owner must
              transfer first, and the server says so in its own words if they
              try. Nothing here decides that on the server's behalf.
            */}
            {!isOrgOwner(state.org) ? (
              <ProovraButton
                label="Leave this organization"
                variant="ghost"
                loading={busy}
                onPress={() => setLeaving(true)}
              />
            ) : null}

            {isOrgOwner(state.org) ? (
              <>
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
                        ? `This organization is scheduled to close on ${formatUserDateTime(closure.effectiveAtIso)}. It can be cancelled until then.`
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
                    {/*
                      The server wrote these sentences. Restating them here
                      would put the client in the business of explaining a
                      refusal it did not make.
                    */}
                    {closure.blockers.map((b) => (
                      <ProovraText key={b.code} variant="label" color={theme.color.ink.muted}>
                        {b.count !== null ? `${b.message} (${b.count})` : b.message}
                      </ProovraText>
                    ))}
                  </ProovraCard>
                ) : null}

                {closure && canRequestClosure(closure) ? (
                  <ProovraButton
                    label="Close this organization"
                    variant="ghost"
                    loading={busy}
                    onPress={() => setClosing(true)}
                  />
                ) : null}
              </>
            ) : null}

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
            title="Leave this organization?"
            consequence="You lose organization-level access immediately. Workspace access is separate and is not changed by this."
            confirmLabel="Leave"
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
            title={transferTarget ? `Make ${transferTarget.displayName} the owner?` : ""}
            consequence="They become the organization owner and you become an admin. Billing ownership follows the owner. This is atomic and audited."
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
