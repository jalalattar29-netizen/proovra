/**
 * DISCUSSION — the conversation inside a collaboration group.
 *
 * The destination of the retired `/collaboration-teams/:teamId/collaboration`
 * route: that page's other four panels either did nothing or duplicated
 * surfaces that already existed, and what survived is the conversation, which
 * belongs beside the group's members rather than behind a second link.
 *
 * A 404 here is an AUTHORIZATION answer, not an empty list. Every
 * collaboration route answers 404 to a non-member or a member without the
 * reviewer permission, deliberately, so that a 403 never confirms a group
 * exists. Rendering that as "no discussions yet" would tell a reader there is
 * nothing to see when in fact they cannot see it.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { formatUserDateTime } from "../lib/date";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraSection,
  ProovraInput,
  ProovraFormField,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "./index";
import {
  buildThreadMessagesPath,
  buildThreadReopenPath,
  buildThreadResolvePath,
  buildThreadsPath,
  isCollaborationDenial,
  isSendableMessage,
  nextTransition,
  parseDiscussionMessages,
  parseDiscussionThreads,
  sortThreads,
  threadStatusLabel,
  threadStatusTone,
  type DiscussionMessage,
  type DiscussionThread,
} from "../product/discussion";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; threads: DiscussionThread[] }
  | { phase: "denied" }
  | { phase: "failed" };

export function DiscussionSection({ teamId }: { teamId: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [open, setOpen] = useState<DiscussionThread | null>(null);
  const [messages, setMessages] = useState<DiscussionMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const data = await apiFetch(buildThreadsPath(teamId));
      setState({ phase: "loaded", threads: sortThreads(parseDiscussionThreads(data)) });
    } catch (err) {
      setState(isCollaborationDenial(err) ? { phase: "denied" } : { phase: "failed" });
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openThread = useCallback(async (thread: DiscussionThread) => {
    setOpen(thread);
    setMessages(null);
    setError(null);
    try {
      setMessages(parseDiscussionMessages(await apiFetch(buildThreadMessagesPath(thread.id))));
    } catch (err) {
      setError(toSafeUserError(err).message);
      setMessages([]);
    }
  }, []);

  const send = useCallback(async () => {
    if (!open || !isSendableMessage(draft)) return;
    setBusy(true);
    try {
      await apiFetch(buildThreadMessagesPath(open.id), {
        method: "POST",
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft("");
      setMessages(parseDiscussionMessages(await apiFetch(buildThreadMessagesPath(open.id))));
    } catch (err) {
      setError(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [open, draft]);

  const transition = useCallback(async () => {
    if (!open) return;
    const move = nextTransition(open);
    setBusy(true);
    try {
      await apiFetch(
        move === "resolve" ? buildThreadResolvePath(open.id) : buildThreadReopenPath(open.id),
        { method: "POST", body: JSON.stringify({}) },
      );
      setOpen(null);
      await load();
    } catch (err) {
      setError(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [open, load]);

  if (open) {
    return (
      <ProovraSection title={open.title}>
        <View style={{ flexDirection: "row", gap: theme.space.s2, alignItems: "center" }}>
          <ProovraButton
            label="Back to discussions"
            variant="ghost"
            fullWidth={false}
            onPress={() => setOpen(null)}
          />
          <ProovraBadge label={threadStatusLabel(open.status)} tone={threadStatusTone(open.status)} />
        </View>

        {messages === null ? <ProovraLoadingState label="Loading messages" /> : null}

        {messages !== null && messages.length === 0 ? (
          <ProovraEmpty presence="inline" title="No messages in this thread yet." />
        ) : null}

        {messages !== null && messages.length > 0 ? (
          <ProovraCard>
            <View style={{ gap: theme.space.s4 }}>
              {messages.map((m) => (
                <View key={m.id} style={{ gap: 2 }}>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {[m.authorName ?? "Someone", m.createdAtIso ? formatUserDateTime(m.createdAtIso) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </ProovraText>
                  <ProovraText variant="body">{m.body}</ProovraText>
                </View>
              ))}
            </View>
          </ProovraCard>
        ) : null}

        {error ? (
          <ProovraText variant="label" color={theme.color.status.risk.fg}>
            {error}
          </ProovraText>
        ) : null}

        <ProovraCard>
          <ProovraFormField label="Reply">
            <ProovraInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Write a message"
              multiline
              accessibilityLabel="Write a message"
            />
          </ProovraFormField>
          <ProovraButton
            label="Send"
            loading={busy}
            disabled={!isSendableMessage(draft)}
            onPress={() => void send()}
          />
          <ProovraButton
            label={nextTransition(open) === "resolve" ? "Resolve thread" : "Reopen thread"}
            variant="secondary"
            loading={busy}
            onPress={() => void transition()}
          />
        </ProovraCard>
      </ProovraSection>
    );
  }

  return (
    <ProovraSection title="Discussion">
      {state.phase === "loading" ? <ProovraLoadingState label="Loading discussions" /> : null}

      {state.phase === "denied" ? (
        // NOT "there is nothing here". The routes answer 404 to a member
        // without the reviewer permission on purpose.
        <ProovraEmpty
          presence="inline"
          title="Discussions are open to reviewers in this group."
          purpose="Ask an admin for reviewer access if you need to take part."
        />
      ) : null}

      {state.phase === "failed" ? (
        <ProovraErrorState message="Discussions could not be loaded." onRetry={() => void load()} />
      ) : null}

      {state.phase === "loaded" && state.threads.length === 0 ? (
        <ProovraEmpty presence="inline" title="No discussions in this group yet." />
      ) : null}

      {state.phase === "loaded" && state.threads.length > 0 ? (
        <ProovraCard>
          <View style={{ gap: theme.space.s3 }}>
            {state.threads.map((t) => (
              <View key={t.id} style={{ gap: theme.space.s1 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: theme.space.s2,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <ProovraText
                      variant="body"
                      weight="semibold"
                      accessibilityLabel={`${t.title}, ${threadStatusLabel(t.status)}`}
                      onPress={() => void openThread(t)}
                    >
                      {t.title}
                    </ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      {[
                        t.updatedAtIso ? formatUserDateTime(t.updatedAtIso) : null,
                        t.reopenCount > 0 ? `reopened ${t.reopenCount}×` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </ProovraText>
                  </View>
                  <ProovraBadge label={threadStatusLabel(t.status)} tone={threadStatusTone(t.status)} />
                </View>
              </View>
            ))}
          </View>
        </ProovraCard>
      ) : null}
    </ProovraSection>
  );
}
