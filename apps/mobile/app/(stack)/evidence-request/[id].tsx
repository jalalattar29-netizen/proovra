/**
 * EVIDENCE REQUEST — INSPECTOR (web `evidence-requests/[id]/page.tsx`).
 *
 * GET /v1/evidence-requests/:id (member-enforced). The web inspector's
 * layers, in its order: eyebrow + title + status chips, instructions, the
 * assigned reviewer (EvidenceRequestAssignment), "Request more information",
 * Completion, Deliverables (with waive), Responses received (Accept /
 * Request more / Reject), the delivery status, the activity timeline, and
 * "← Back to matter". Every mutation is one of the audited Phase-7 routes and
 * the request is re-read after it.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiFetch } from "../../../src/api";
import { useAuth } from "../../../src/auth-context";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import {
  availableRequestTransitions,
  availableResponseDecisions,
  buildResponseReviewBody,
  buildResponseReviewPath,
  buildRequestDeliveriesPath,
  buildRequestEventsPath,
  buildRequestTransitionPath,
  buildTransitionBody,
  buildRequestAssignPath,
  buildRequestAssignBody,
  buildRequestMoreBody,
  buildRequestMorePath,
  buildWaiveDeliverablePath,
  deliverableStatusDisplay,
  deliverableWaivable,
  parseRequestMoreResult,
  parseSendResult,
  requestAssignErrorCopy,
  requestCompletion,
  requestEyebrow,
  responseAwaitsDecision,
  sendBlockedForAssignee,
  transitionRequiresNote,
  validateWaiveReason,
  REQUEST_ASSIGN_COPY,
  REQUEST_DETAIL_COPY,
  deliveryTone,
  deliveryAttemptLine,
  buildRequestDeliveryRetryPath,
  parseEvidenceRequestDetail,
  parseRequestDeliveries,
  parseRequestEvents,
  requestStatusDisplay,
  requestTransitionConsequence,
  requestTransitionIsDestructive,
  requestTransitionLabel,
  responseContributorLabel,
  responseDecisionConsequence,
  responseDecisionIsDestructive,
  responseDecisionLabel,
  responseStatusDisplay,
  deliverableProgressLine,
  validateResponseReviewerNote,
  type EvidenceRequestDetail,
  type EvidenceRequestResponse,
  type ResponseReviewDecision,
  type RequestDelivery,
  type RequestEvent,
  type RequestTransition,
} from "../../../src/product/evidence-requests";
import { humanizeEnum } from "../../../src/product/domain-display";
import { buildWorkspaceMembersPath, parseWorkspaceMembers } from "../../../src/product/workspace-people";
import { intakeUrlFor, webOrigin } from "../../../src/product/intake-create";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmpty,
  ProovraSheet,
  ProovraInput,
  ProovraFormField,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
  ProovraConfirmSheet,
} from "../../../src/ui";
import { CopyButton } from "../../../src/ui/copy-button";
import { WorkspaceMemberPicker } from "../../../src/ui/workspace-member-picker";

type Phase = "loading" | "ready" | "error" | "notfound" | "unavailable";

/** A one-shot link the server returned — shown once, copyable (page.tsx:740-804). */
type Reveal = { title: string; message: string; url: string };

export default function EvidenceRequestDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? "";
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [request, setRequest] = useState<EvidenceRequestDetail | null>(null);
  const [deliveries, setDeliveries] = useState<RequestDelivery[] | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const viewerUserId = ((useAuth().user as { id?: string } | null)?.id) ?? null;
  /** userId → display name, from the workspace roster (web memberLabel). */
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const memberName = useCallback((userId: string) => memberNames[userId] ?? null, [memberNames]);
  // The web's contextual retry (ContextualDeliveryStatus): same authorisation as the request.
  const retryDelivery = async (deliveryId: string) => {
    if (!id || retryingId) return;
    setRetryingId(deliveryId);
    try {
      await apiFetch(buildRequestDeliveryRetryPath(String(id), deliveryId), { method: "POST" });
      setDeliveries(parseRequestDeliveries(await apiFetch(buildRequestDeliveriesPath(String(id)))));
    } catch {
      Alert.alert("Retry failed", "The delivery could not be retried right now.");
    } finally {
      setRetryingId(null);
    }
  };
  const [events, setEvents] = useState<RequestEvent[] | null>(null);
  const [pending, setPending] = useState<RequestTransition | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  /** The submission being judged, and the decision chosen for it. */
  const [reviewing, setReviewing] = useState<EvidenceRequestResponse | null>(null);
  const [decision, setDecision] = useState<ResponseReviewDecision | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  /** A rejection waits on the web's "Notify the contributor?" question. */
  const [askNotify, setAskNotify] = useState(false);
  // T-12 — the assigned reviewer (EvidenceRequestAssignment.tsx).
  const [pickingReviewer, setPickingReviewer] = useState(false);
  const [choice, setChoice] = useState<{ userId: string; label: string } | null>(null);
  const [removingReviewer, setRemovingReviewer] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [assignMessage, setAssignMessage] = useState<string | null>(null);
  // "Request more information" (page.tsx:428-468).
  const [rerequestNote, setRerequestNote] = useState("");
  const [rerequestBusy, setRerequestBusy] = useState(false);
  // Waive a deliverable (page.tsx:180-208).
  const [waiving, setWaiving] = useState<{ id: string; title: string } | null>(null);
  const [waiveReason, setWaiveReason] = useState("");
  // Request more evidence on one response (page.tsx:268-321).
  const [requestingMore, setRequestingMore] = useState<EvidenceRequestResponse | null>(null);
  const [requestMoreNote, setRequestMoreNote] = useState("");
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setPhase("loading");
    setError(null);
    try {
      const data = await apiFetch(`/v1/evidence-requests/${id}`);
      const detail = parseEvidenceRequestDetail(data);
      if (!detail) {
        setPhase("notfound");
        return;
      }
      setRequest(detail);
      setPhase("ready");

      // Deliveries and history load independently: either may be gated on the
      // reader's role, and one refusal must not blank the request itself.
      void apiFetch(buildRequestDeliveriesPath(String(id)))
        .then((d) => setDeliveries(parseRequestDeliveries(d)))
        .catch(() => setDeliveries([]));
      void apiFetch(buildRequestEventsPath(String(id)))
        .then((d) => setEvents(parseRequestEvents(d)))
        .catch(() => setEvents([]));
      // The roster names the assigned reviewer and any member who submitted
      // (the web's useWorkspaceMembers + memberLabel). A refusal leaves the
      // honest "A workspace member".
      if (detail.teamId) {
        void apiFetch(buildWorkspaceMembersPath(detail.teamId, null, { status: "ACTIVE", limit: 100 }))
          .then((p) => {
            const names: Record<string, string> = {};
            for (const m of parseWorkspaceMembers(p).members) if (m.userId) names[m.userId] = m.displayName;
            setMemberNames(names);
          })
          .catch(() => undefined);
      }
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "notFound") setPhase("notfound");
      else if (safe.kind === "forbidden") setPhase("unavailable");
      else {
        setError(safe);
        setPhase("error");
      }
    }
  }, [id]);

  /** Re-read the request without blanking the screen (write-then-reread). */
  const reread = useCallback(async (): Promise<EvidenceRequestDetail | null> => {
    const fresh = parseEvidenceRequestDetail(await apiFetch(`/v1/evidence-requests/${id}`));
    if (fresh) setRequest(fresh);
    return fresh;
  }, [id]);

  /**
   * Assign (or clear) the reviewer, then RE-READ the request and report the
   * outcome from the saved row — the web's write-then-reread rule, so the
   * screen never announces a change the server has not confirmed.
   */
  const assignReviewer = useCallback(
    async (userId: string | null, label: string | null) => {
      if (!id) return;
      setBusy(true);
      setAssignMessage(null);
      try {
        await apiFetch(buildRequestAssignPath(String(id)), {
          method: "POST",
          body: JSON.stringify(buildRequestAssignBody(userId)),
        });
        const fresh = await reread();
        if (fresh && fresh.assignedReviewerUserId === userId) {
          if (userId && label) setMemberNames((prev) => ({ ...prev, [userId]: label }));
          setAssignMessage(userId ? REQUEST_ASSIGN_COPY.assigned(label ?? REQUEST_ASSIGN_COPY.someMember) : REQUEST_ASSIGN_COPY.unassignedDone);
        } else {
          setAssignMessage("The change was sent, but the reloaded request does not show it. Refresh before trying again.");
        }
        setChoice(null);
      } catch (err) {
        const code = (err as { code?: string })?.code ?? null;
        setAssignMessage(requestAssignErrorCopy(code));
      } finally {
        setBusy(false);
      }
    },
    [id, reread],
  );

  /** EvidenceRequestAssignment.send — POST /:id/send {} then re-read. */
  const sendToReviewer = useCallback(async () => {
    if (!id) return;
    setBusy(true);
    setAssignMessage(null);
    try {
      await apiFetch(buildRequestTransitionPath(String(id), "send"), { method: "POST", body: JSON.stringify({}) });
      const fresh = await reread();
      setAssignMessage(
        fresh && fresh.status !== "DRAFT"
          ? REQUEST_DETAIL_COPY.sentToReviewer
          : "The request was accepted, but the reloaded request does not show the change. Reload before trying again.",
      );
    } catch (err) {
      const code = (err as { code?: string })?.code ?? null;
      setAssignMessage(code ? requestAssignErrorCopy(code) : toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [id, reread]);

  const runTransition = useCallback(async () => {
    if (!id || !pending) return;
    const transition = pending;
    setBusy(true);
    try {
      const result = await apiFetch(buildRequestTransitionPath(String(id), transition), {
        method: "POST",
        body: JSON.stringify(buildTransitionBody(note)),
      });
      setPending(null);
      setNote("");
      // An external request's link comes back exactly once (routes.ts:409-416).
      if (transition === "send") {
        const sent = parseSendResult(result);
        if (sent.intakeUrl) {
          setReveal({ title: REQUEST_DETAIL_COPY.sentTitle, message: sent.warning ?? REQUEST_DETAIL_COPY.followUpManual, url: sent.intakeUrl });
        }
      }
      await load();
    } catch (err) {
      Alert.alert("Could not complete that", toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [id, pending, note, load]);

  /** page.tsx:156 — POST /:id/needs-more-info { reviewerNote } (the note is REQUIRED server-side). */
  const markNeedsMoreInfo = useCallback(async () => {
    if (!id || !rerequestNote.trim()) return;
    setRerequestBusy(true);
    try {
      await apiFetch(buildRequestTransitionPath(String(id), "needs-more-info"), {
        method: "POST",
        body: JSON.stringify(buildTransitionBody(rerequestNote)),
      });
      setRerequestNote("");
      await load();
    } catch (err) {
      Alert.alert("Could not mark request as needing more info.", toSafeUserError(err).message);
    } finally {
      setRerequestBusy(false);
    }
  }, [id, rerequestNote, load]);

  /** page.tsx:180 — POST /:id/deliverables/:did/waive { reason }. */
  const waiveDeliverable = useCallback(async () => {
    if (!id || !waiving) return;
    const invalid = validateWaiveReason(waiveReason);
    if (invalid) {
      Alert.alert("Reason needed", invalid);
      return;
    }
    setBusy(true);
    try {
      await apiFetch(buildWaiveDeliverablePath(String(id), waiving.id), {
        method: "POST",
        body: JSON.stringify({ reason: waiveReason.trim() }),
      });
      setWaiving(null);
      setWaiveReason("");
      await load();
    } catch (err) {
      Alert.alert("Could not waive deliverable.", toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [id, waiving, waiveReason, load]);

  /**
   * THE REVIEWER'S DECISION ON ONE SUBMISSION.
   *
   * Separate from the request transitions above, because judging what was
   * sent in and moving the thread are different acts: a request can hold one
   * accepted submission and one rejected as insufficient at the same time.
   */
  const submitReview = useCallback(
    async (target: EvidenceRequestResponse, chosen: ResponseReviewDecision, noteText: string, notifyContributor?: boolean) => {
      if (!id) return;
      const invalid = validateResponseReviewerNote(noteText);
      if (invalid) {
        Alert.alert("Note too long", invalid);
        return;
      }
      setBusy(true);
      try {
        await apiFetch(buildResponseReviewPath(String(id), target.id), {
          method: "POST",
          body: JSON.stringify(buildResponseReviewBody({ status: chosen, reviewerNote: noteText, notifyContributor })),
        });
        setReviewing(null);
        setDecision(null);
        setReviewNote("");
        await load();
      } catch (err) {
        Alert.alert("Could not record that decision", toSafeUserError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [id, load],
  );

  const reviewResponse = useCallback(() => {
    if (!reviewing || !decision) return;
    // page.tsx:222 — a rejection asks whether to tell the contributor.
    if (decision === "REJECTED") {
      setAskNotify(true);
      return;
    }
    void submitReview(reviewing, decision, reviewNote);
  }, [reviewing, decision, reviewNote, submitReview]);

  /** page.tsx:268 — a fresh intake link in the same thread; shown once. */
  const requestMore = useCallback(
    async (notifyContributor: boolean) => {
      if (!id || !requestingMore) return;
      setBusy(true);
      try {
        const res = parseRequestMoreResult(
          await apiFetch(buildRequestMorePath(String(id), requestingMore.id), {
            method: "POST",
            body: JSON.stringify(buildRequestMoreBody({ reviewerNote: requestMoreNote, notifyContributor })),
          }),
        );
        setRequestingMore(null);
        setRequestMoreNote("");
        if (res) {
          const origin = webOrigin();
          setReveal({
            title: REQUEST_DETAIL_COPY.followUpTitle,
            message: res.sentViaMessage ? REQUEST_DETAIL_COPY.followUpSent : REQUEST_DETAIL_COPY.followUpManual,
            url: origin ? intakeUrlFor(origin, res.rawToken) : `/intake/${encodeURIComponent(res.rawToken)}`,
          });
        }
        await load();
      } catch (err) {
        Alert.alert("Could not create follow-up link.", toSafeUserError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [id, requestingMore, requestMoreNote, load],
  );

  useEffect(() => { void load(); }, [load]);

  const goToMatter = (caseId: string) => router.push(`/case/${caseId}` as never);

  if (phase === "loading") return <ProovraScreen shell scroll={false}><ProovraLoadingState label={REQUEST_DETAIL_COPY.loading} /></ProovraScreen>;
  if (phase !== "ready" || !request) {
    // page.tsx:330 — "Evidence request unavailable", the reason, and the way back.
    const message =
      phase === "notfound"
        ? "This evidence request is no longer available or has expired."
        : phase === "unavailable"
          ? "You don’t have access to this request."
          : null;
    const back = (
      <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap", justifyContent: "center" }}>
        {request?.caseId ? (
          <ProovraButton label={REQUEST_DETAIL_COPY.returnToMatter} variant="secondary" fullWidth={false} onPress={() => goToMatter(request.caseId!)} />
        ) : null}
        <ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />
      </View>
    );
    if (phase === "error" && error) {
      return (
        <ProovraScreen shell scroll={false}>
          <ProovraText variant="h3" weight="semibold" center>{REQUEST_DETAIL_COPY.unavailable}</ProovraText>
          <ProovraErrorState message={error.message} onRetry={load} />
          {back}
        </ProovraScreen>
      );
    }
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraEmptyState title={REQUEST_DETAIL_COPY.unavailable} message={message ?? "Not found."} action={back} />
      </ProovraScreen>
    );
  }

  const r = request;
  const status = requestStatusDisplay(r.status);
  const openForFulfilment = !["FULFILLED", "CLOSED", "CANCELLED"].includes(r.status);
  const completion = requestCompletion(r.deliverables);
  const terminal = ["CLOSED", "CANCELLED"].includes((r.status ?? "").toUpperCase());
  const internal = r.recipientMode === "INTERNAL_USER";
  const transitions = availableRequestTransitions(r.status ?? "");
  const canAskForMore = transitions.includes("needs-more-info");
  // "needs-more-info" has its own section (page.tsx:428); an internal
  // request is sent from the assignment block (EvidenceRequestAssignment:259).
  const actionTransitions = transitions.filter((t) => t !== "needs-more-info" && !(t === "send" && internal));
  const assigneeName = r.assignedReviewerUserId ? memberName(r.assignedReviewerUserId) ?? REQUEST_ASSIGN_COPY.someMember : null;

  return (
    <ProovraScreen shell>
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
      </View>

      <ProovraCard style={styles.hero}>
        <ProovraText variant="label" color={theme.color.ink.muted}>{requestEyebrow(r.requestType)}</ProovraText>
        <ProovraText variant="h1" weight="bold">{r.title}</ProovraText>
        {/* page.tsx:389-412 — status, priority, due, readiness. */}
        <View style={styles.chips} testID="request-chips">
          <ProovraBadge tone={status.tone} label={`Status: ${status.label}`} />
          {r.priority ? <ProovraBadge tone="info" label={`Priority: ${humanizeEnum(r.priority)}`} /> : null}
          {r.dueAtUtc ? <ProovraBadge tone="pending" label={`Due ${formatUserDateTime(r.dueAtUtc)}`} /> : null}
          <ProovraBadge
            tone={completion.reviewReady ? "verified" : "pending"}
            label={completion.reviewReady ? REQUEST_DETAIL_COPY.reviewReady : REQUEST_DETAIL_COPY.requiredRemaining}
          />
          {r.status === "NEEDS_MORE_INFO" ? <ProovraBadge tone="risk" label={REQUEST_DETAIL_COPY.needsMoreInfo} /> : null}
        </View>
        {r.recipientLabel ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{r.recipientLabel}</ProovraText>
        ) : null}
      </ProovraCard>

      {r.instructions ? (
        <ProovraSection title="Instructions">
          <ProovraCard><ProovraText variant="bodySm">{r.instructions}</ProovraText></ProovraCard>
        </ProovraSection>
      ) : null}

      <ProovraSection title={REQUEST_ASSIGN_COPY.section}>
        <ProovraCard style={styles.stack}>
          <ProovraText variant="bodySm" testID="request-reviewer">
            {assigneeName ?? REQUEST_ASSIGN_COPY.unassigned}
          </ProovraText>
          {internal ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {REQUEST_ASSIGN_COPY.internalNote}
            </ProovraText>
          ) : null}
          {terminal ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {REQUEST_ASSIGN_COPY.terminal}
            </ProovraText>
          ) : (
            <View style={styles.row}>
              <ProovraButton
                label={r.assignedReviewerUserId ? REQUEST_ASSIGN_COPY.change : REQUEST_ASSIGN_COPY.assign}
                variant="secondary"
                fullWidth={false}
                disabled={busy}
                onPress={() => { setAssignMessage(null); setPickingReviewer(true); }}
              />
              {r.assignedReviewerUserId ? (
                <ProovraButton label={REQUEST_ASSIGN_COPY.remove} variant="ghost" fullWidth={false} disabled={busy} onPress={() => setRemovingReviewer(true)} />
              ) : null}
              {internal && r.status === "DRAFT" ? (
                <ProovraButton
                  label={REQUEST_DETAIL_COPY.sendToReviewer}
                  fullWidth={false}
                  disabled={busy || sendBlockedForAssignee(r)}
                  onPress={() => setConfirmSend(true)}
                />
              ) : null}
            </View>
          )}
          {!terminal && internal && r.status === "DRAFT" && sendBlockedForAssignee(r) ? (
            <ProovraText variant="label" color={theme.color.status.pending.fg}>
              {REQUEST_ASSIGN_COPY.sendBlocked}
            </ProovraText>
          ) : null}
          {/* The staged choice, saved deliberately (EvidenceRequestAssignment:279-310). */}
          {choice && !terminal ? (
            <View style={styles.stack}>
              <ProovraText variant="bodySm">{`Reviewer: ${choice.label}`}</ProovraText>
              <View style={styles.row}>
                <ProovraButton
                  label={REQUEST_DETAIL_COPY.saveReviewer}
                  fullWidth={false}
                  loading={busy}
                  onPress={() => void assignReviewer(choice.userId, choice.label)}
                />
                <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={busy} onPress={() => setChoice(null)} />
              </View>
            </View>
          ) : null}
          {assignMessage ? <ProovraText variant="bodySm">{assignMessage}</ProovraText> : null}
        </ProovraCard>
      </ProovraSection>

      {canAskForMore ? (
        <ProovraSection title={REQUEST_DETAIL_COPY.rerequestTitle}>
          <ProovraCard style={styles.stack} testID="request-rerequest">
            <ProovraText variant="label" color={theme.color.ink.secondary}>{REQUEST_DETAIL_COPY.rerequestBody}</ProovraText>
            <ProovraInput
              value={rerequestNote}
              onChangeText={setRerequestNote}
              placeholder={REQUEST_DETAIL_COPY.rerequestPlaceholder}
              accessibilityLabel={REQUEST_DETAIL_COPY.rerequestPlaceholder}
              multiline
              autoCapitalize="sentences"
            />
            <ProovraButton
              label={rerequestBusy ? REQUEST_DETAIL_COPY.recording : REQUEST_DETAIL_COPY.rerequestAction}
              accessibilityLabel={REQUEST_DETAIL_COPY.rerequestAction}
              fullWidth={false}
              disabled={rerequestBusy || busy || rerequestNote.trim().length === 0}
              onPress={() => void markNeedsMoreInfo()}
            />
          </ProovraCard>
        </ProovraSection>
      ) : null}

      {/* page.tsx:471-524 — Completion. */}
      <ProovraCard style={styles.stack} testID="request-completion">
        <View style={styles.spread}>
          <ProovraText variant="bodySm" weight="semibold">{REQUEST_DETAIL_COPY.completion}</ProovraText>
          <ProovraText variant="bodySm">{`${completion.completionPercent}%`}</ProovraText>
        </View>
        <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View
            testID="request-completion-bar"
            style={[
              styles.fill,
              {
                width: `${completion.completionPercent}%`,
                backgroundColor: completion.reviewReady ? theme.color.status.verified.solid : theme.color.accent.a500,
              },
            ]}
          />
        </View>
        <View style={styles.row}>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`Required: ${completion.requiredFulfilled} / ${completion.requiredTotal}`}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`Optional: ${completion.optionalFulfilled} / ${completion.optionalTotal}`}
          </ProovraText>
        </View>
      </ProovraCard>

      <ProovraSection title={REQUEST_DETAIL_COPY.deliverables}>
        {r.deliverables.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{REQUEST_DETAIL_COPY.noDeliverables}</ProovraText>
        ) : (
          <View style={styles.stack}>
            {r.deliverables.map((d) => {
              const ds = deliverableStatusDisplay(d.status);
              return (
                <ProovraCard key={d.id} style={styles.stack} testID={`deliverable-${d.id}`}>
                  <ProovraText variant="bodySm" weight="semibold">{d.title}</ProovraText>
                  <View style={styles.chips}>
                    <ProovraBadge tone={d.required ? "risk" : "neutral"} label={d.required ? "Required" : "Optional"} />
                    <ProovraBadge tone={ds.tone} label={ds.label} />
                  </View>
                  {d.description ? <ProovraText variant="bodySm">{d.description}</ProovraText> : null}
                  <ProovraText variant="label" color={theme.color.ink.secondary}>{deliverableProgressLine(d)}</ProovraText>
                  {deliverableWaivable(d.status, r.status) ? (
                    <ProovraButton
                      label={REQUEST_DETAIL_COPY.waive}
                      accessibilityLabel={`Waive ${d.title}`}
                      variant="secondary"
                      fullWidth={false}
                      disabled={busy}
                      onPress={() => { setWaiveReason(""); setWaiving({ id: d.id, title: d.title }); }}
                    />
                  ) : null}
                </ProovraCard>
              );
            })}
          </View>
        )}
      </ProovraSection>

      {/*
        WHAT WAS ACTUALLY SENT IN, and the reviewer's answer to each piece of
        it (page.tsx:611-711).
      */}
      <ProovraSection title={REQUEST_DETAIL_COPY.responses}>
        {r.responses.length === 0 ? (
          <ProovraEmpty presence="inline" title={REQUEST_DETAIL_COPY.noResponses} />
        ) : (
          <ProovraCard>
            {r.responses.map((resp) => {
              const rs = responseStatusDisplay(resp.status);
              const who = responseContributorLabel(resp, memberName);
              return (
                <View key={resp.id} style={styles.response}>
                  <ProovraListRow
                    title={who}
                    subtitle={resp.submittedAtUtc ? formatUserDateTime(resp.submittedAtUtc) : undefined}
                    trailing={<ProovraBadge tone={rs.tone} label={rs.label} />}
                    onPress={() => {
                      setReviewing(resp);
                      setDecision(null);
                      setReviewNote("");
                    }}
                    accessibilityHint="Opens the reviewer decision for this submission."
                  />
                  {/* The submitted record itself (web page.tsx:658). */}
                  {resp.responseEvidenceId ? (
                    <ProovraButton
                      label="Open evidence"
                      variant="ghost"
                      fullWidth={false}
                      onPress={() => router.push(`/evidence/${resp.responseEvidenceId}` as never)}
                    />
                  ) : null}
                  {resp.reviewerNote ? (
                    <ProovraText variant="label" color={theme.color.ink.muted} style={styles.note}>
                      {`Reviewer note: ${resp.reviewerNote}`}
                    </ProovraText>
                  ) : null}
                  {responseAwaitsDecision(resp.status) ? (
                    <View style={styles.row} testID={`response-actions-${resp.id}`}>
                      <ProovraButton
                        label="Accept"
                        accessibilityLabel={`Accept submission from ${who}`}
                        fullWidth={false}
                        disabled={busy}
                        onPress={() => void submitReview(resp, "ACCEPTED", "")}
                      />
                      <ProovraButton
                        label="Request more"
                        accessibilityLabel={`Request more from ${who}`}
                        variant="secondary"
                        fullWidth={false}
                        disabled={busy}
                        onPress={() => { setRequestMoreNote(""); setRequestingMore(resp); }}
                      />
                      <ProovraButton
                        label="Reject"
                        accessibilityLabel={`Reject submission from ${who}`}
                        variant="secondary"
                        fullWidth={false}
                        disabled={busy}
                        onPress={() => {
                          setReviewing(resp);
                          setDecision("REJECTED");
                          setReviewNote("");
                        }}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ProovraCard>
        )}
      </ProovraSection>

      {openForFulfilment ? (
        <ProovraButton label="Capture evidence to fulfil" variant="secondary" onPress={() => router.push("/capture")} />
      ) : null}

      {/*
        The transitions this request's CURRENT status permits. The state
        machine is the server's and every route re-checks; what this prevents
        is offering "Send" on a request cancelled last week.
      */}
      {actionTransitions.length > 0 ? (
        <ProovraSection title="Actions">
          <ProovraCard>
            {actionTransitions.map((t) => (
              <ProovraButton
                key={t}
                label={requestTransitionLabel(t)}
                variant={requestTransitionIsDestructive(t) ? "ghost" : "secondary"}
                loading={busy}
                onPress={() => setPending(t)}
              />
            ))}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      <WorkspaceMemberPicker
        visible={pickingReviewer}
        title="Reviewer"
        teamId={r.teamId ?? null}
        selectedUserId={choice?.userId ?? r.assignedReviewerUserId ?? null}
        onClose={() => setPickingReviewer(false)}
        onSelect={(m) => {
          setPickingReviewer(false);
          if (!m.userId) return;
          if (m.userId === r.assignedReviewerUserId) {
            setChoice(null);
            setAssignMessage(REQUEST_ASSIGN_COPY.alreadyAssigned);
            return;
          }
          setChoice({ userId: m.userId, label: m.displayName });
        }}
      />
      <ProovraConfirmSheet
        visible={removingReviewer}
        title={REQUEST_ASSIGN_COPY.removeTitle}
        consequence={internal ? REQUEST_ASSIGN_COPY.removeInternal : REQUEST_ASSIGN_COPY.removeExternal}
        confirmLabel={REQUEST_ASSIGN_COPY.remove}
        tone="warning"
        busy={busy}
        onConfirm={() => {
          setRemovingReviewer(false);
          void assignReviewer(null, null);
        }}
        onCancel={() => setRemovingReviewer(false)}
      />
      <ProovraConfirmSheet
        visible={confirmSend}
        title={REQUEST_DETAIL_COPY.sendToReviewerTitle}
        consequence={REQUEST_DETAIL_COPY.sendToReviewerBody(assigneeName ?? "The assigned reviewer")}
        confirmLabel={REQUEST_DETAIL_COPY.sendToReviewerConfirm}
        busy={busy}
        onConfirm={() => {
          setConfirmSend(false);
          void sendToReviewer();
        }}
        onCancel={() => setConfirmSend(false)}
      />

      <ProovraSection title="Deliveries">
        {deliveries === null ? (
          <ProovraLoadingState label="Loading deliveries" />
        ) : deliveries.length === 0 ? (
          <ProovraEmpty presence="inline" title="This request has not been sent yet." />
        ) : (
          <ProovraCard>
            {deliveries.map((d) => (
              <View key={d.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.space.s2 }}>
                  <ProovraText variant="bodySm">{deliveryAttemptLine(d, formatUserDateTime)}</ProovraText>
                  <ProovraBadge label={d.statusLabel} tone={deliveryTone(d.status)} />
                </View>
                {/* A failure that says nothing is worse than one that names itself. */}
                {d.errorCode ? (
                  <ProovraText variant="label" color={theme.color.status.risk.fg}>
                    {`(${d.errorCode})`}
                  </ProovraText>
                ) : null}
                {d.retryable ? (
                  <ProovraButton
                    label={retryingId === d.id ? "Retrying…" : "Retry"}
                    accessibilityLabel={`Retry ${d.eventLabel}`}
                    variant="ghost"
                    fullWidth={false}
                    disabled={retryingId !== null}
                    onPress={() => void retryDelivery(d.id)}
                  />
                ) : null}
              </View>
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      <ProovraSection title="Activity timeline">
        {events === null ? (
          <ProovraLoadingState label="Loading activity" />
        ) : events.length === 0 ? (
          <ProovraEmpty presence="inline" title="No events recorded for this request." />
        ) : (
          <ProovraCard>
            {events.map((e) => (
              <View key={e.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                <ProovraText variant="bodySm">{humanizeEnum(e.type)}</ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[
                    e.actorLabel ??
                      (e.actorUserId && e.actorUserId === viewerUserId ? "You" : e.actorUserId ? memberName(e.actorUserId) : null),
                    e.occurredAtIso ? formatUserDateTime(e.occurredAtIso) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </ProovraText>
                {e.note ? (
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {e.note}
                  </ProovraText>
                ) : null}
              </View>
            ))}
          </ProovraCard>
        )}
      </ProovraSection>

      {/* page.tsx:721-738 */}
      {r.caseId ? (
        <ProovraButton label={REQUEST_DETAIL_COPY.backToMatter} variant="ghost" fullWidth={false} onPress={() => goToMatter(r.caseId!)} />
      ) : null}

      <ProovraSheet
        visible={pending !== null}
        title={pending ? requestTransitionLabel(pending) : ""}
        onClose={() => { setPending(null); setNote(""); }}
      >
        {/*
          Cancel and close both END a request and neither can be undone, so the
          difference is stated rather than left to be inferred.
        */}
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {pending ? requestTransitionConsequence(pending) : ""}
        </ProovraText>
        <ProovraFormField label={pending && transitionRequiresNote(pending) ? "Note (required)" : "Note (optional)"}>
          <ProovraInput
            value={note}
            onChangeText={setNote}
            placeholder="Recorded on the request"
            multiline
            autoCapitalize="sentences"
            accessibilityLabel="Note"
          />
        </ProovraFormField>
        <ProovraButton
          label={pending ? requestTransitionLabel(pending) : "Confirm"}
          variant={pending && requestTransitionIsDestructive(pending) ? "danger" : "primary"}
          loading={busy}
          disabled={!!pending && transitionRequiresNote(pending) && note.trim().length === 0}
          onPress={() => void runTransition()}
        />
      </ProovraSheet>

      <ProovraSheet
        visible={reviewing !== null && !askNotify}
        title={reviewing ? responseContributorLabel(reviewing, memberName) : "Submission"}
        onClose={() => { setReviewing(null); setDecision(null); setReviewNote(""); }}
      >
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          {reviewing
            ? `Submitted ${reviewing.submittedAtUtc ? formatUserDateTime(reviewing.submittedAtUtc) : "at an unrecorded time"} · ${responseStatusDisplay(reviewing.status).label}`
            : ""}
        </ProovraText>
        {reviewing?.reviewerNote ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {reviewing.reviewerNote}
          </ProovraText>
        ) : null}

        {/* The decision, then what it does, then the note it is recorded with. */}
        {reviewing
          ? availableResponseDecisions(reviewing.status).map((d) => (
              <ProovraButton
                key={d}
                label={responseDecisionLabel(d)}
                variant={
                  decision === d
                    ? responseDecisionIsDestructive(d)
                      ? "danger"
                      : "primary"
                    : "secondary"
                }
                onPress={() => setDecision(d)}
              />
            ))
          : null}

        {decision ? (
          <>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              {responseDecisionConsequence(decision)}
            </ProovraText>
            <ProovraFormField label="Reviewer note (optional)">
              <ProovraInput
                value={reviewNote}
                onChangeText={setReviewNote}
                placeholder="Reviewer note (internal — visible only to workspace members)"
                multiline
                autoCapitalize="sentences"
                accessibilityLabel="Reviewer note"
              />
            </ProovraFormField>
            <ProovraButton
              label={responseDecisionLabel(decision)}
              variant={responseDecisionIsDestructive(decision) ? "danger" : "primary"}
              loading={busy}
              onPress={() => reviewResponse()}
            />
          </>
        ) : null}
      </ProovraSheet>

      {/* page.tsx:222-233 — a rejection asks whether the contributor is told. */}
      <ProovraConfirmSheet
        visible={askNotify}
        title={REQUEST_DETAIL_COPY.rejectNotifyTitle}
        consequence={REQUEST_DETAIL_COPY.rejectNotifyBody}
        confirmLabel={REQUEST_DETAIL_COPY.rejectNotifyYes}
        cancelLabel={REQUEST_DETAIL_COPY.rejectNotifyNo}
        tone="danger"
        busy={busy}
        onConfirm={() => {
          setAskNotify(false);
          if (reviewing && decision) void submitReview(reviewing, decision, reviewNote, true);
        }}
        onCancel={() => {
          setAskNotify(false);
          if (reviewing && decision) void submitReview(reviewing, decision, reviewNote, false);
        }}
      />

      <ProovraSheet
        visible={waiving !== null}
        title={waiving ? `Waive “${waiving.title}”` : "Waive"}
        onClose={() => { setWaiving(null); setWaiveReason(""); }}
      >
        <ProovraFormField label={REQUEST_DETAIL_COPY.waivePrompt}>
          <ProovraInput
            value={waiveReason}
            onChangeText={setWaiveReason}
            placeholder="Reason"
            multiline
            autoCapitalize="sentences"
            accessibilityLabel="Waiver reason"
          />
        </ProovraFormField>
        <ProovraButton
          label={busy ? "Waiving…" : REQUEST_DETAIL_COPY.waive}
          accessibilityLabel="Confirm waiver"
          loading={busy}
          disabled={waiveReason.trim().length === 0}
          onPress={() => void waiveDeliverable()}
        />
      </ProovraSheet>

      <ProovraSheet
        visible={requestingMore !== null}
        title={REQUEST_DETAIL_COPY.requestMoreNotifyTitle}
        onClose={() => { setRequestingMore(null); setRequestMoreNote(""); }}
      >
        <ProovraFormField label={REQUEST_DETAIL_COPY.requestMorePrompt}>
          <ProovraInput
            value={requestMoreNote}
            onChangeText={setRequestMoreNote}
            placeholder="Internal note"
            multiline
            autoCapitalize="sentences"
            accessibilityLabel="Request more note"
          />
        </ProovraFormField>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{REQUEST_DETAIL_COPY.requestMoreNotifyBody}</ProovraText>
        <ProovraButton label={REQUEST_DETAIL_COPY.requestMoreNotifyYes} loading={busy} onPress={() => void requestMore(true)} />
        <ProovraButton label={REQUEST_DETAIL_COPY.requestMoreNotifyNo} variant="secondary" disabled={busy} onPress={() => void requestMore(false)} />
      </ProovraSheet>

      <ProovraSheet visible={reveal !== null} title={reveal?.title ?? ""} onClose={() => setReveal(null)}>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{reveal?.message ?? ""}</ProovraText>
        <ProovraText variant="label" mono selectable testID="request-reveal-url">{reveal?.url ?? ""}</ProovraText>
        <View style={styles.row}>
          {reveal ? <CopyButton value={reveal.url} label="Copy link" variant="secondary" /> : null}
          <ProovraButton label="Close" variant="ghost" fullWidth={false} onPress={() => setReveal(null)} />
        </View>
      </ProovraSheet>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, alignItems: "center" },
  stack: { gap: theme.space.s2 },
  spread: { flexDirection: "row", justifyContent: "space-between" },
  track: { height: 8, borderRadius: theme.radius.pill, backgroundColor: theme.color.surface.muted, overflow: "hidden" },
  fill: { height: "100%" },
  response: { gap: theme.space.s1, paddingBottom: theme.space.s2 },
  note: { borderLeftWidth: 2, borderLeftColor: theme.color.border.default, paddingLeft: theme.space.s2 },
});
