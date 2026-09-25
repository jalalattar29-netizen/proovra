/**
 * ONE REVIEW — the native port of
 * `apps/web/app/portal/[token]/work/[workflowId]`.
 *
 * Reached only from inside the portal dashboard, and carries the same
 * memory-only credential. Opening it marks the review as viewed, which is a
 * real record the workspace relies on — so it is sent once, on open, and not
 * on every re-render.
 *
 * The verdict vocabulary is the server's (EXTERNAL_DECISION_VERDICTS). None of
 * them is a verdict about truth, authorship or admissibility, because a
 * reviewer portal is exactly where such a claim would look most authoritative
 * and the platform does not make it. The reviewer's RECORDED decision is read
 * back (GET …/decisions); a submission is announced only once that re-read
 * shows it, and submitting again replaces it — as on the web.
 *
 * The web's evidence preview is not ported: it iframes the internal,
 * app-authenticated evidence page, which a portal reviewer has no session
 * for, and no portal-scoped content endpoint exists (recorded in the ledger).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { publicFetch } from "../../../../src/api";
import { formatUserDateTime } from "../../../../src/lib/date";
import { theme } from "../../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraLoadingState,
  ProovraEmpty,
  ProovraConfirmSheet,
} from "../../../../src/ui";
import {
  PORTAL_DASHBOARD_PATH,
  PORTAL_DECISIONS,
  PORTAL_RATIONALE_MAX,
  buildPortalCommentsPath,
  buildPortalDecisionBody,
  buildPortalDecisionPath,
  buildPortalDecisionsPath,
  buildPortalViewPath,
  classifyPortalDenial,
  hasPortalCapability,
  isSendablePortalComment,
  parsePortalComments,
  parsePortalDashboard,
  parsePortalRecordedDecision,
  portalCredential,
  portalDecisionLabel,
  portalDecisionRationaleProblem,
  portalDecisionRecordedNotice,
  portalDenialMessage,
  threadPortalComments,
  type PortalComment,
  type PortalDashboard,
  type PortalDecisionValue,
  type PortalRecordedDecision,
} from "../../../../src/product/portal";
import {
  getPortalSessionId,
  getPortalToken,
} from "../../../../src/portal/portal-session";

type DecisionState =
  | { kind: "loading" }
  | { kind: "ready"; decision: PortalRecordedDecision | null }
  | { kind: "denied" }
  | { kind: "failed"; message: string };

export default function PortalWorkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ workflowId?: string | string[] }>();
  const workflowId = Array.isArray(params.workflowId)
    ? params.workflowId[0]
    : params.workflowId;

  const [dashboard, setDashboard] = useState<PortalDashboard | null>(null);
  const [comments, setComments] = useState<PortalComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [pending, setPending] = useState<PortalDecisionValue | null>(null);
  const [decision, setDecision] = useState<DecisionState>({ kind: "loading" });
  const [status, setStatus] = useState<string | null>(null);
  const viewed = useRef(false);

  const credential = useCallback(
    () => portalCredential(getPortalToken(), getPortalSessionId()),
    [],
  );

  const canDecide = hasPortalCapability(dashboard, "portal.decide");
  const canReadHistory = canDecide || hasPortalCapability(dashboard, "portal.history.read");

  const loadComments = useCallback(async () => {
    if (!workflowId) return;
    try {
      setComments(
        parsePortalComments(
          await publicFetch(buildPortalCommentsPath(workflowId), { method: "GET" }, credential()),
        ),
      );
    } catch (err) {
      setDenied(portalDenialMessage(classifyPortalDenial(err)));
      setComments([]);
    }
  }, [workflowId, credential]);

  const loadDecision = useCallback(async (): Promise<PortalRecordedDecision | null | undefined> => {
    if (!workflowId) return undefined;
    setDecision({ kind: "loading" });
    try {
      const d = parsePortalRecordedDecision(
        await publicFetch(buildPortalDecisionsPath(workflowId), { method: "GET" }, credential()),
      );
      setDecision({ kind: "ready", decision: d });
      return d;
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      setDecision(
        statusCode === 403 || statusCode === 404
          ? { kind: "denied" }
          : { kind: "failed", message: "Your recorded decision could not be loaded." },
      );
      return undefined;
    }
  }, [workflowId, credential]);

  useEffect(() => {
    if (!workflowId) return;
    // Marking a review viewed is a real record. Sent once, on open — not on
    // every render, and not on a list that merely scrolled past it.
    if (!viewed.current) {
      viewed.current = true;
      void publicFetch(
        buildPortalViewPath(workflowId),
        { method: "POST", body: JSON.stringify({}) },
        credential(),
      ).catch(() => undefined);
    }
    // The projection carries the reviewer's capabilities, as on the web page.
    void publicFetch(PORTAL_DASHBOARD_PATH, { method: "GET" }, credential())
      .then((d) => setDashboard(parsePortalDashboard(d)))
      .catch(() => setDashboard(null));
    void loadComments();
  }, [workflowId, loadComments, credential]);

  useEffect(() => {
    if (canReadHistory) void loadDecision();
  }, [canReadHistory, loadDecision]);

  const post = useCallback(
    async (body: string, parentCommentId?: string) => {
      if (!workflowId || !isSendablePortalComment(body)) return;
      setBusy(true);
      try {
        await publicFetch(
          buildPortalCommentsPath(workflowId),
          { method: "POST", body: JSON.stringify(parentCommentId ? { body: body.trim(), parentCommentId } : { body: body.trim() }) },
          credential(),
        );
        if (parentCommentId) setReplyDraft((prev) => ({ ...prev, [parentCommentId]: "" }));
        else setDraft("");
        await loadComments();
      } catch (err) {
        setDenied(portalDenialMessage(classifyPortalDenial(err)));
      } finally {
        setBusy(false);
      }
    },
    [workflowId, credential, loadComments],
  );

  const decide = useCallback(async () => {
    if (!workflowId || !pending) return;
    const verdict = pending;
    setPending(null);
    setBusy(true);
    setStatus(null);
    try {
      const res = (await publicFetch(
        buildPortalDecisionPath(workflowId),
        { method: "POST", body: JSON.stringify(buildPortalDecisionBody({ verdict, rationale })) },
        credential(),
      )) as { replaced?: boolean } | null;
      // Announced only once the re-read shows it.
      const reread = await loadDecision();
      if (reread && reread.verdict === verdict) {
        setStatus(portalDecisionRecordedNotice(verdict, res?.replaced === true));
        setRationale("");
      } else {
        setStatus("Your decision was sent, but it could not be confirmed yet. Reload to check.");
      }
    } catch (err) {
      setDenied(portalDenialMessage(classifyPortalDenial(err)));
    } finally {
      setBusy(false);
    }
  }, [workflowId, pending, rationale, credential, loadDecision]);

  const recorded = decision.kind === "ready" ? decision.decision : null;

  return (
    <ProovraScreen testID="portal-work">
      <ProovraPageHeader
        title="Review"
        eyebrow="External review"
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {denied ? (
        <ProovraEmpty presence="page" title="This review is not open" purpose={denied} />
      ) : (
        <>
          <ProovraPageSection title="Discussion">
            {comments === null ? (
              <ProovraLoadingState label="Loading discussion" />
            ) : comments.length === 0 ? (
              <ProovraEmpty presence="inline" title="No comments on this review yet." />
            ) : (
              <ProovraCard>
                <View style={{ gap: theme.space.s4 }}>
                  {threadPortalComments(comments).map(({ root, replies }) => (
                    <View key={root.id} style={{ gap: 4 }} testID={`portal-comment-${root.id}`}>
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {[root.authorLabel, root.createdAtIso ? formatUserDateTime(root.createdAtIso) : null].filter(Boolean).join(" · ")}
                      </ProovraText>
                      <ProovraText variant="body">{root.body}</ProovraText>
                      {replies.map((rep) => (
                        <View key={rep.id} style={{ marginStart: theme.space.s4, gap: 2 }}>
                          <ProovraText variant="label" color={theme.color.ink.muted}>
                            {[rep.authorLabel, rep.createdAtIso ? formatUserDateTime(rep.createdAtIso) : null].filter(Boolean).join(" · ")}
                          </ProovraText>
                          <ProovraText variant="bodySm">{rep.body}</ProovraText>
                        </View>
                      ))}
                      <View style={{ flexDirection: "row", gap: theme.space.s2, alignItems: "center" }}>
                        <View style={{ flex: 1 }}>
                          <ProovraInput
                            value={replyDraft[root.id] ?? ""}
                            onChangeText={(v) => setReplyDraft((prev) => ({ ...prev, [root.id]: v }))}
                            placeholder="Reply…"
                            accessibilityLabel="Reply to this comment"
                          />
                        </View>
                        <ProovraButton
                          label="Reply"
                          variant="secondary"
                          fullWidth={false}
                          disabled={busy || !isSendablePortalComment(replyDraft[root.id] ?? "")}
                          onPress={() => void post(replyDraft[root.id] ?? "", root.id)}
                        />
                      </View>
                    </View>
                  ))}
                </View>
              </ProovraCard>
            )}

            <ProovraCard>
              <ProovraFormField label="Add a comment">
                <ProovraInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="What should the workspace know?"
                  multiline
                  autoCapitalize="sentences"
                  accessibilityLabel="Add a comment"
                />
              </ProovraFormField>
              <ProovraButton
                label="Post comment"
                loading={busy}
                disabled={!isSendablePortalComment(draft)}
                onPress={() => void post(draft)}
              />
            </ProovraCard>
          </ProovraPageSection>

          <ProovraPageSection title="Decision">
            <ProovraCard testID="portal-recorded-decision">
              {!canReadHistory ? (
                <ProovraText variant="bodySm">Your role cannot view recorded decisions for this review.</ProovraText>
              ) : decision.kind === "loading" ? (
                <ProovraText variant="bodySm">Loading your recorded decision…</ProovraText>
              ) : decision.kind === "denied" ? (
                <ProovraText variant="bodySm">Your recorded decision is not available for this review.</ProovraText>
              ) : decision.kind === "failed" ? (
                <View style={{ gap: theme.space.s2 }}>
                  <ProovraText variant="bodySm">{decision.message}</ProovraText>
                  <ProovraButton label="Retry" variant="secondary" fullWidth={false} onPress={() => void loadDecision()} />
                </View>
              ) : recorded ? (
                <View style={{ gap: 2 }}>
                  <ProovraText variant="label" weight="semibold">Your recorded decision</ProovraText>
                  <ProovraText variant="bodySm">{portalDecisionLabel(recorded.verdict)}</ProovraText>
                  <ProovraText variant="label" weight="semibold">Recorded</ProovraText>
                  <ProovraText variant="bodySm">{recorded.submittedAtIso ? formatUserDateTime(recorded.submittedAtIso) : "—"}</ProovraText>
                  <ProovraText variant="label" weight="semibold">Rationale</ProovraText>
                  <ProovraText variant="bodySm">{recorded.rationale ?? "No rationale recorded."}</ProovraText>
                </View>
              ) : (
                <ProovraText variant="bodySm">You have not recorded a decision for this review yet.</ProovraText>
              )}
              {canDecide && recorded ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>Submitting again replaces this decision.</ProovraText>
              ) : null}
              {status ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{status}</ProovraText> : null}
            </ProovraCard>

            {!canDecide ? (
              dashboard ? (
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  Your role is read-only for decisions. You may still annotate and comment when permitted.
                </ProovraText>
              ) : null
            ) : (
              <ProovraCard>
                <ProovraFormField label="Rationale" error={rationale.trim().length > PORTAL_RATIONALE_MAX ? `Keep the rationale to ${PORTAL_RATIONALE_MAX} characters.` : null}>
                  <ProovraInput
                    value={rationale}
                    onChangeText={setRationale}
                    placeholder="Bounded rationale (≤ 600 chars). Required for non-APPROVE verdicts."
                    multiline
                    autoCapitalize="sentences"
                    accessibilityLabel="Decision rationale"
                  />
                </ProovraFormField>
                <View style={{ gap: theme.space.s2 }}>
                  {PORTAL_DECISIONS.map((v) => (
                    <ProovraButton
                      key={v}
                      label={portalDecisionLabel(v)}
                      variant={v === "APPROVE" ? "primary" : "secondary"}
                      loading={busy}
                      disabled={portalDecisionRationaleProblem(v, rationale) !== null}
                      onPress={() => setPending(v)}
                    />
                  ))}
                </View>
              </ProovraCard>
            )}
          </ProovraPageSection>
        </>
      )}

      <ProovraConfirmSheet
        visible={pending !== null}
        title={pending ? `Record "${portalDecisionLabel(pending)}"?` : ""}
        consequence="Your decision is recorded against this review and the workspace is notified. Submitting again replaces it."
        confirmLabel={pending ? portalDecisionLabel(pending) : "Confirm"}
        tone={pending === "REJECT" ? "danger" : "warning"}
        busy={busy}
        onConfirm={() => void decide()}
        onCancel={() => setPending(null)}
      />
    </ProovraScreen>
  );
}
