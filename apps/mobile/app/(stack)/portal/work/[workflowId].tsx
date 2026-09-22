/**
 * ONE REVIEW — the native port of
 * `apps/web/app/portal/[token]/work/[workflowId]`.
 *
 * Reached only from inside the portal dashboard, and carries the same
 * memory-only credential. Opening it marks the review as viewed, which is a
 * real record the workspace relies on — so it is sent once, on open, and not
 * on every re-render.
 *
 * The decision vocabulary is deliberately narrow: accept, reject, needs more
 * information. None of them is a verdict about truth, authorship or
 * admissibility, because a reviewer portal is exactly where such a claim would
 * look most authoritative and the platform does not make it.
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
  PORTAL_DECISIONS,
  buildPortalCommentsPath,
  buildPortalDecisionBody,
  buildPortalDecisionPath,
  buildPortalViewPath,
  classifyPortalDenial,
  isSendablePortalComment,
  parsePortalComments,
  portalCredential,
  portalDecisionLabel,
  portalDenialMessage,
  type PortalComment,
  type PortalDecisionValue,
} from "../../../../src/product/portal";
import {
  getPortalSessionId,
  getPortalToken,
} from "../../../../src/portal/portal-session";

export default function PortalWorkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ workflowId?: string | string[] }>();
  const workflowId = Array.isArray(params.workflowId)
    ? params.workflowId[0]
    : params.workflowId;

  const [comments, setComments] = useState<PortalComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [pending, setPending] = useState<PortalDecisionValue | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const viewed = useRef(false);

  const credential = useCallback(
    () => portalCredential(getPortalToken(), getPortalSessionId()),
    [],
  );

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
    void loadComments();
  }, [workflowId, loadComments, credential]);

  const send = useCallback(async () => {
    if (!workflowId || !isSendablePortalComment(draft)) return;
    setBusy(true);
    try {
      await publicFetch(
        buildPortalCommentsPath(workflowId),
        { method: "POST", body: JSON.stringify({ body: draft.trim() }) },
        credential(),
      );
      setDraft("");
      await loadComments();
    } catch (err) {
      setDenied(portalDenialMessage(classifyPortalDenial(err)));
    } finally {
      setBusy(false);
    }
  }, [workflowId, draft, credential, loadComments]);

  const decide = useCallback(async () => {
    if (!workflowId || !pending) return;
    const decision = pending;
    setPending(null);
    setBusy(true);
    try {
      await publicFetch(
        buildPortalDecisionPath(workflowId),
        {
          method: "POST",
          body: JSON.stringify(buildPortalDecisionBody({ decision, note })),
        },
        credential(),
      );
      setSubmitted(true);
      setNote("");
    } catch (err) {
      setDenied(portalDenialMessage(classifyPortalDenial(err)));
    } finally {
      setBusy(false);
    }
  }, [workflowId, pending, note, credential]);

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
      ) : null}

      {!denied && submitted ? (
        <ProovraCard>
          <ProovraText variant="body">Your decision has been recorded.</ProovraText>
          <ProovraButton label="Back to your reviews" onPress={() => router.back()} />
        </ProovraCard>
      ) : null}

      {!denied && !submitted ? (
        <>
          <ProovraPageSection title="Discussion">
            {comments === null ? (
              <ProovraLoadingState label="Loading discussion" />
            ) : comments.length === 0 ? (
              <ProovraEmpty presence="inline" title="No comments on this review yet." />
            ) : (
              <ProovraCard>
                <View style={{ gap: theme.space.s4 }}>
                  {comments.map((c) => (
                    <View key={c.id} style={{ gap: 2 }}>
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {[c.authorLabel, c.createdAtIso ? formatUserDateTime(c.createdAtIso) : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </ProovraText>
                      <ProovraText variant="body">{c.body}</ProovraText>
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
                onPress={() => void send()}
              />
            </ProovraCard>
          </ProovraPageSection>

          <ProovraPageSection title="Your decision">
            <ProovraCard>
              {/*
                Accept / reject / needs more information. None of these is a
                verdict about truth, authorship or admissibility — a reviewer
                portal is exactly where such a claim would look most
                authoritative, and the platform does not make it.
              */}
              <ProovraFormField label="Note (optional)">
                <ProovraInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Recorded with your decision"
                  multiline
                  autoCapitalize="sentences"
                  accessibilityLabel="Decision note"
                />
              </ProovraFormField>
              <View style={{ gap: theme.space.s2 }}>
                {PORTAL_DECISIONS.map((d) => (
                  <ProovraButton
                    key={d}
                    label={portalDecisionLabel(d)}
                    variant={d === "APPROVED" ? "primary" : "secondary"}
                    loading={busy}
                    onPress={() => setPending(d)}
                  />
                ))}
              </View>
            </ProovraCard>
          </ProovraPageSection>
        </>
      ) : null}

      <ProovraConfirmSheet
        visible={pending !== null}
        title={pending ? `Record "${portalDecisionLabel(pending)}"?` : ""}
        consequence="Your decision is recorded against this review and the workspace is notified. You cannot change it here afterwards."
        confirmLabel={pending ? portalDecisionLabel(pending) : "Confirm"}
        tone={pending === "REJECTED" ? "danger" : "warning"}
        busy={busy}
        onConfirm={() => void decide()}
        onCancel={() => setPending(null)}
      />
    </ProovraScreen>
  );
}
