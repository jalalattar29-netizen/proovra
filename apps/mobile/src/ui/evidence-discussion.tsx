/**
 * EVIDENCE DISCUSSION THREADS (T-12 / RC-13) — see
 * src/product/evidence-discussion.ts for the contract.
 *
 * Touch adaptations: the list and the selected thread stack vertically
 * instead of sitting side by side; the thread filter presets are chips; the
 * assignee `<select>` is the shared WorkspaceMemberPicker sheet; confirmations
 * are ProovraConfirmSheet with the web's copy. Presence indicators are not
 * ported (the web's realtime channel has no native client).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import { threadStatusLabel, threadStatusTone } from "../product/discussion";
import {
  COLLABORATION_CATALOGS_PATH,
  parseCatalogThreadKinds,
  threadKindLabel,
  EVIDENCE_DISCUSSION_COPY as COPY,
  MESSAGE_MAX,
  REASON_MAX,
  RESOLUTION_NOTE_MAX,
  THREAD_ACTION_LABEL,
  THREAD_FILTER_OPTIONS,
  buildEvidenceThreadMessagesPath,
  buildEvidenceThreadsPath,
  buildThreadActionPath,
  buildThreadDetailPath,
  buildThreadMentionsReadPath,
  canPostMessage,
  filterEvidenceThreads,
  isStaleThreadError,
  messageAuthorLabel,
  offeredThreadActions,
  parseEvidenceThreadMessages,
  parseEvidenceThreads,
  parseThreadDetail,
  threadActionBlocked,
  threadActionBody,
  threadActionConfirm,
  threadActionConfirmed,
  threadActionSuccess,
  type EvidenceThread,
  type EvidenceThreadMessage,
  type ThreadAction,
  type ThreadDetail,
  type ThreadFilterPreset,
} from "../product/evidence-discussion";
import { buildWorkspaceMembersPath, parseWorkspaceMembers, type WorkspaceMember } from "../product/workspace-people";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraListRow, ProovraSection, ProovraText } from "./index";
import { ProovraConfirmSheet, ProovraFilterChips } from "./patterns";
import { WorkspaceMemberPicker } from "./workspace-member-picker";
import { PresenceIndicator } from "./presence-indicator";

export function EvidenceDiscussion({
  evidenceId,
  teamId,
  readOnly,
}: {
  evidenceId: string;
  teamId: string | null;
  readOnly: boolean;
}) {
  const [threads, setThreads] = useState<EvidenceThread[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<ThreadFilterPreset>("all");
  const [filterText, setFilterText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Server-projected thread-kind vocabulary, read once per mount.
  const [catalogKinds, setCatalogKinds] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    apiFetch(COLLABORATION_CATALOGS_PATH)
      .then((d) => {
        if (alive) setCatalogKinds(parseCatalogThreadKinds(d));
      })
      .catch(() => {
        // Presentation metadata — the curated labels still render.
      });
    return () => {
      alive = false;
    };
  }, []);

  const loadThreads = useCallback(async () => {
    if (!teamId) return;
    try {
      setThreads(parseEvidenceThreads(await apiFetch(buildEvidenceThreadsPath(teamId, evidenceId))));
      setError(null);
    } catch (err) {
      setError(toSafeUserError(err, { message: "Could not load discussion threads." }).message);
      // A failed read is not an empty workspace: the list stays unknown.
      setThreads(null);
    }
  }, [teamId, evidenceId]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  const intro = (
    <>
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.intro}</ProovraText>
      <ProovraCard>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Boundary</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.boundary}</ProovraText>
      </ProovraCard>
    </>
  );

  if (!teamId) {
    return (
      <ProovraSection title={COPY.title}>
        <View style={{ gap: theme.space.s3 }} testID="evidence-discussion">
          {intro}
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.noWorkspace}</ProovraText>
        </View>
      </ProovraSection>
    );
  }

  const visible = filterEvidenceThreads(threads ?? [], preset, filterText);
  const selected = (threads ?? []).find((t) => t.id === selectedId) ?? null;

  return (
    <ProovraSection title={COPY.title}>
      <View style={{ gap: theme.space.s3 }} testID="evidence-discussion">
        {intro}
        {/* "Also here" on the open thread, else the record (EvidenceDiscussionPanel.tsx:446). */}
        <PresenceIndicator teamId={teamId} resourceKind="discussion_thread" resourceId={selectedId ?? evidenceId} />
        {readOnly ? (
          <ProovraCard>
            <ProovraText variant="bodySm" weight="semibold">{COPY.readOnlyTitle}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.readOnlyBody}</ProovraText>
          </ProovraCard>
        ) : null}
        {error ? (
          <ProovraCard>
            <ProovraText variant="bodySm" weight="semibold" color={theme.color.status.risk.fg}>{COPY.loadFailedTitle}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{error}</ProovraText>
          </ProovraCard>
        ) : null}

        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Threads</ProovraText>
        <ProovraInput value={filterText} onChangeText={setFilterText} placeholder="Filter threads by title…" accessibilityLabel="Filter threads by title" />
        <ProovraFilterChips<ThreadFilterPreset> label="Thread filter" options={THREAD_FILTER_OPTIONS} value={preset} onChange={setPreset} />

        {threads === undefined ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Loading threads…</ProovraText>
        ) : visible.length > 0 ? (
          <ProovraCard>
            {visible.map((t) => (
              <ProovraListRow
                key={t.id}
                title={t.title}
                subtitle={[t.kind ? threadKindLabel(t.kind, catalogKinds) : null, t.escalatedAtUtc ? "Escalated" : null].filter(Boolean).join(" · ") || undefined}
                trailing={<ProovraBadge tone={threadStatusTone(t.status)} label={threadStatusLabel(t.status)} />}
                onPress={() => setSelectedId(t.id)}
              />
            ))}
          </ProovraCard>
        ) : threads === null ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.threadsFailed}</ProovraText>
        ) : threads.length > 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.noMatch}</ProovraText>
        ) : (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.empty}</ProovraText>
        )}

        {selected ? (
          <SelectedThread key={selected.id} thread={selected} catalogKinds={catalogKinds} teamId={teamId} readOnly={readOnly} onChanged={() => void loadThreads()} />
        ) : null}
      </View>
    </ProovraSection>
  );
}

function SelectedThread({
  thread,
  catalogKinds,
  teamId,
  readOnly,
  onChanged,
}: {
  thread: EvidenceThread;
  catalogKinds: ReadonlyArray<string>;
  teamId: string;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<EvidenceThreadMessage[] | null>(null);
  const [messagesFailed, setMessagesFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  // Names for message authors and the assignee line, from the workspace roster (the web's
  // useWorkspaceMembers + memberLabel). An id the roster does not name is
  // shown as "A workspace member", never as a guessed name.
  const [roster, setRoster] = useState<Record<string, string>>({});
  useEffect(() => {
    let current = true;
    apiFetch(buildWorkspaceMembersPath(teamId, null, { status: "ACTIVE", limit: 100 }))
      .then((page) => {
        if (!current) return;
        const map: Record<string, string> = {};
        for (const m of parseWorkspaceMembers(page).members) if (m.userId) map[m.userId] = m.displayName;
        setRoster(map);
      })
      .catch(() => {
        /* names are presentation; the assignment itself is unaffected */
      });
    return () => {
      current = false;
    };
  }, [teamId]);

  const loadMessages = useCallback(async () => {
    setMessagesFailed(false);
    try {
      setMessages(parseEvidenceThreadMessages(await apiFetch(buildEvidenceThreadMessagesPath(thread.id, teamId))));
    } catch {
      setMessages([]);
      setMessagesFailed(true);
    }
    // Best-effort: clear the caller's unread mentions in this thread.
    try {
      await apiFetch(buildThreadMentionsReadPath(thread.id, teamId), { method: "POST" });
    } catch {
      /* intentional best-effort — the next inbox refresh surfaces them again */
    }
  }, [thread.id, teamId]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  const post = async () => {
    if (posting || !canPostMessage(draft)) return;
    setPosting(true);
    setPostError(null);
    try {
      await apiFetch(buildEvidenceThreadMessagesPath(thread.id, teamId), {
        method: "POST",
        body: JSON.stringify({ teamId, body: draft.trim() }),
      });
      setDraft("");
      await loadMessages();
    } catch (err) {
      setPostError(toSafeUserError(err, { message: COPY.postFailed }).message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <ProovraCard>
      <View style={{ gap: theme.space.s3 }} testID="evidence-discussion-thread">
        <ProovraText variant="h3" weight="semibold">{thread.title}</ProovraText>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, alignItems: "center" }}>
          {thread.kind ? <ProovraText variant="label" color={theme.color.ink.secondary}>{threadKindLabel(thread.kind, catalogKinds)}</ProovraText> : null}
          <ProovraBadge tone={threadStatusTone(thread.status)} label={threadStatusLabel(thread.status)} />
          {thread.escalatedAtUtc ? <ProovraBadge tone="risk" label="Escalated" /> : null}
          {thread.updatedAt ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>{`Updated ${formatUserDateTime(thread.updatedAt)}`}</ProovraText>
          ) : null}
        </View>

        <ThreadLifecycle threadId={thread.id} teamId={teamId} readOnly={readOnly} roster={roster} onChanged={onChanged} />

        {messages === null ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Loading messages…</ProovraText>
        ) : messagesFailed ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.messagesFailed}</ProovraText>
        ) : messages.length === 0 ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.noMessages}</ProovraText>
        ) : (
          messages.map((m) => (
            <View key={m.id} style={{ gap: 2 }}>
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {[
                  messageAuthorLabel(m, roster),
                  m.authorKind !== "USER" ? (m.authorKind === "SYSTEM" ? "System" : "Contributor") : null,
                  m.createdAt ? formatUserDateTime(m.createdAt) : null,
                  m.editedAtUtc ? `Edited ${formatUserDateTime(m.editedAtUtc)}` : null,
                ]
                  .filter((x, i, a) => x && a.indexOf(x) === i)
                  .join(" · ")}
              </ProovraText>
              {/* Rendered as text — a message cannot inject markup. */}
              <ProovraText variant="bodySm" selectable>{m.body}</ProovraText>
            </View>
          ))
        )}

        {readOnly ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.readOnlyComposer}</ProovraText>
        ) : thread.status === "RESOLVED" || thread.status === "CLOSED" ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {thread.status === "RESOLVED" ? COPY.resolvedComposer : COPY.closedComposer}
          </ProovraText>
        ) : (
          <>
            <ProovraFormField label="Post a message">
              <ProovraInput
                value={draft}
                onChangeText={(v) => setDraft(v.slice(0, MESSAGE_MAX))}
                placeholder={COPY.composerPlaceholder}
                multiline
                autoCapitalize="sentences"
              />
            </ProovraFormField>
            <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.composerNote}</ProovraText>
            {postError ? <ProovraText variant="label" color={theme.color.status.risk.fg}>{postError}</ProovraText> : null}
            <ProovraButton
              label={posting ? "Posting…" : "Post message"}
              accessibilityLabel="Post message"
              fullWidth={false}
              disabled={posting || !canPostMessage(draft)}
              onPress={() => void post()}
            />
          </>
        )}
      </View>
    </ProovraCard>
  );
}

function ThreadLifecycle({
  threadId,
  teamId,
  readOnly,
  roster,
  onChanged,
}: {
  threadId: string;
  teamId: string;
  readOnly: boolean;
  roster: Readonly<Record<string, string>>;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<{ phase: "loading" } | { phase: "ready"; value: ThreadDetail } | { phase: "failed"; message: string }>({
    phase: "loading",
  });
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState<ThreadAction | null>(null);
  const [text, setText] = useState("");
  const [assignee, setAssignee] = useState<WorkspaceMember | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);


  const detailPath = buildThreadDetailPath(threadId, teamId);
  useEffect(() => {
    let current = true;
    setDetail({ phase: "loading" });
    apiFetch(detailPath)
      .then((v) => {
        if (!current) return;
        const d = parseThreadDetail(v);
        setDetail(d ? { phase: "ready", value: d } : { phase: "failed", message: COPY.detailFailed });
        setUnconfirmed(false);
      })
      .catch((err) => {
        if (current) setDetail({ phase: "failed", message: isStaleThreadError(err) ? COPY.stale : toSafeUserError(err, { message: COPY.detailFailed }).message });
      });
    return () => {
      current = false;
    };
  }, [detailPath, revision]);

  const value = detail.phase === "ready" ? detail.value : null;
  const locked = unconfirmed
    ? "Refresh the thread to confirm the last change before making another."
    : detail.phase !== "ready"
      ? "The thread details must load before its state can change."
      : null;
  const blocked = open ? threadActionBlocked(open, text, assignee?.userId ?? null, value) : null;
  const offered = offeredThreadActions(value, readOnly);

  const openForm = (a: ThreadAction) => {
    setOpen((cur) => (cur === a ? null : a));
    setText("");
    setAssignee(null);
    setNotice("");
    setMutationError("");
  };

  const run = async () => {
    const action = open;
    if (!action || busy || blocked || locked) return;
    setBusy(true);
    setNotice("");
    setMutationError("");
    let written = false;
    try {
      await apiFetch(buildThreadActionPath(threadId, action), {
        method: "POST",
        body: JSON.stringify(threadActionBody(action, teamId, text, assignee?.userId ?? null)),
      });
      written = true;
      const reread = parseThreadDetail(await apiFetch(detailPath));
      if (!alive.current) return;
      if (reread) setDetail({ phase: "ready", value: reread });
      if (reread && threadActionConfirmed(action, reread, assignee?.userId ?? null)) {
        setNotice(threadActionSuccess(action, assignee?.displayName ?? null));
      } else {
        setMutationError(COPY.notConfirmed);
      }
      setOpen(null);
      setText("");
      setAssignee(null);
      onChanged();
    } catch (err) {
      if (!alive.current) return;
      if (written) {
        setUnconfirmed(true);
        setOpen(null);
        setMutationError(COPY.rereadFailed);
        onChanged();
      } else {
        setMutationError(isStaleThreadError(err) ? COPY.stale : toSafeUserError(err, { message: COPY.updateFailed }).message);
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        setConfirming(false);
      }
    }
  };

  const submit = () => {
    if (!open || busy || blocked || locked) return;
    if (threadActionConfirm(open)) setConfirming(true);
    else void run();
  };

  const confirmCopy = open ? threadActionConfirm(open) : null;
  const maxLen = open === "resolve" ? RESOLUTION_NOTE_MAX : REASON_MAX;

  return (
    <View style={{ gap: theme.space.s2 }} testID="thread-lifecycle">
      {detail.phase === "loading" ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>Loading thread details…</ProovraText>
      ) : detail.phase === "failed" ? (
        <ProovraText variant="label" color={theme.color.status.risk.fg}>{detail.message}</ProovraText>
      ) : (
        <View style={{ gap: 2 }}>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {`Assigned to: ${detail.value.assignedToUserId ? (roster[detail.value.assignedToUserId] ?? "A workspace member") : "Unassigned"}`}
          </ProovraText>
          {detail.value.resolutionNote ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>{`Resolution note (internal): ${detail.value.resolutionNote}`}</ProovraText>
          ) : null}
          {detail.value.escalatedAtUtc ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {`Escalation reason (internal): ${detail.value.escalationReason ?? "No reason was recorded."}`}
            </ProovraText>
          ) : null}
          {detail.value.reopenCount > 0 ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>{`Times reopened: ${detail.value.reopenCount}`}</ProovraText>
          ) : null}
        </View>
      )}

      {!readOnly ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
          {offered.map((a) => (
            <ProovraButton
              key={a}
              label={THREAD_ACTION_LABEL[a]}
              variant={a === "escalate" ? "danger" : "secondary"}
              fullWidth={false}
              disabled={!!locked || busy}
              onPress={() => openForm(a)}
            />
          ))}
          <ProovraButton
            label="Refresh thread"
            variant="ghost"
            fullWidth={false}
            disabled={detail.phase === "loading"}
            onPress={() => {
              setNotice("");
              setMutationError("");
              setRevision((v) => v + 1);
            }}
          />
        </View>
      ) : null}

      {open ? (
        <View style={{ gap: theme.space.s2 }} testID={`thread-form-${open}`}>
          {open === "assign" ? (
            <>
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Assign to</ProovraText>
              <ProovraButton
                label={assignee ? assignee.displayName : "Choose a workspace member"}
                variant="secondary"
                fullWidth={false}
                accessibilityLabel="Assign to"
                onPress={() => setPicking(true)}
              />
              <WorkspaceMemberPicker
                visible={picking}
                title="Assign thread"
                teamId={teamId}
                selectedUserId={assignee?.userId ?? null}
                onSelect={(m) => {
                  setAssignee(m);
                  setPicking(false);
                }}
                onClose={() => setPicking(false)}
              />
            </>
          ) : (
            <ProovraFormField label={open === "resolve" ? "Resolution note (optional, internal)" : "Reason (internal)"}>
              <ProovraInput value={text} onChangeText={(v) => setText(v.slice(0, maxLen))} multiline autoCapitalize="sentences" />
            </ProovraFormField>
          )}
          {blocked ? <ProovraText variant="label" color={theme.color.ink.muted}>{blocked}</ProovraText> : null}
          <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
            <ProovraButton
              label={busy ? "Saving…" : THREAD_ACTION_LABEL[open]}
              accessibilityLabel={`Submit: ${THREAD_ACTION_LABEL[open]}`}
              fullWidth={false}
              disabled={!!blocked || !!locked || busy}
              onPress={submit}
            />
            <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={busy} onPress={() => setOpen(null)} />
          </View>
        </View>
      ) : null}

      {notice ? <ProovraText variant="label" color={theme.color.status.verified.fg}>{notice}</ProovraText> : null}
      {mutationError ? <ProovraText variant="label" color={theme.color.status.risk.fg}>{mutationError}</ProovraText> : null}

      <ProovraConfirmSheet
        visible={confirming && !!confirmCopy}
        title={confirmCopy?.title ?? ""}
        consequence={confirmCopy?.consequence}
        confirmLabel={confirmCopy?.confirmLabel}
        tone={confirmCopy?.tone}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void run()}
      />
    </View>
  );
}

