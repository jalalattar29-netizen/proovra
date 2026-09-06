"use client";

/**
 * Discussion — the Collaboration Hub's one surviving job, now a tab.
 *
 * =============================================================================
 * WHY IT MOVED
 * =============================================================================
 * `/collaboration-teams/:teamId/collaboration` was a second destination for
 * one group, holding five panels. Three of them did nothing:
 *
 *   - Guests wrote a row and sent no invitation and granted no access;
 *   - Access review recorded decisions and enforced none of them;
 *   - the Daily digest had no consumer anywhere in the worker.
 *
 * The other two duplicated surfaces that already exist: the notification list
 * showed rows the global inbox already reads, and per-team notification
 * preferences were a third preference store with no stated precedence against
 * workspace and organization policy.
 *
 * What was left is a conversation among the people in a group, which belongs
 * beside that group's members and its work rather than behind a second link.
 *
 * =============================================================================
 * WHY IT IS NOT `DiscussionThread`
 * =============================================================================
 * The canonical thread system is EVIDENCE-ANCHORED: `DiscussionThread.evidenceId`
 * is NOT NULL, because a thread there is a conversation ABOUT A RECORD. A group
 * discussion is anchored to the group and frequently concerns no record at all.
 * They are not two implementations of one thing; they are two containments, and
 * merging them means making `evidenceId` nullable and adding a group anchor —
 * a model change with real cascade consequences, not a refactor.
 *
 * What WAS duplicated is the authorization posture, and that is now shared: both
 * bind to the proven workspace and both conceal a resource the caller may not
 * reach behind the same 404.
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";

import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { useToast } from "../../../../../components/ui";
import { useAccount } from "../../../../../lib/platform-context";
import { formatUserDateTime } from "../../../../../lib/date";
import type { CollaborationTeamDetail } from "../../../../../lib/api/collaboration-teams";
import {
  type Comment,
  createComment,
  deleteComment,
  editComment,
  listComments,
} from "../../../../../lib/api/collaboration-completion";
import type { CollaborationTeamUserDirectoryEntry } from "@proovra/shared";

export { DiscussionPanel };

/** Inline literal for an @mention hint. Canonical surface tokens, no hexes. */
const inlineCode: React.CSSProperties = {
  background: "var(--app-surface-sunken, rgba(15,23,42,0.05))",
  color: "var(--text-secondary, #475569)",
  padding: "1px 6px",
  borderRadius: 6,
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "0.86rem",
};

function DiscussionPanel({
  team,
  onError,
}: {
  team: CollaborationTeamDetail;
  onError: (err: unknown) => void;
}) {
  const [items, setItems] = useState<ReadonlyArray<Comment>>([]);
  const [directory, setDirectory] = useState<
    Record<string, CollaborationTeamUserDirectoryEntry>
  >({});
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listComments(team.id);
      setItems(res.items);
      setDirectory(res.directory);
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  }, [team.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await createComment(team.id, { targetType: "TEAM", body });
      setBody("");
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="app-panel" data-testid="comments-panel">
      <div className="app-panel__head">
        <h2 className="app-panel__title">Team discussion</h2>
      </div>
      <div className="app-panel__body">
        <p
          style={{
            color: "#5F6878",
            margin: "0 0 1rem",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          Comments are visible to active team members only. Use{" "}
          <code style={inlineCode}>@team</code> to notify everyone,{" "}
          <code style={inlineCode}>@lead</code> for leadership, or{" "}
          <code style={inlineCode}>@handle</code> for a specific member.
        </p>

        <form
          onSubmit={onSubmit}
          data-testid="comment-create-form"
          className="app-inner-surface"
          style={{ padding: "1rem", marginBottom: "1.25rem" }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span className="app-avatar" aria-hidden>
              You
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={4000}
                rows={3}
                placeholder="Write a comment for the team…"
                data-testid="comment-body-input"
                className="app-form-input"
                aria-label="Write a comment for the team"
                aria-describedby="comment-mention-hint"
              />
              <p
                className="app-field-help"
                id="comment-mention-hint"
                data-testid="comment-mention-hint"
              >
                Mention teammates with{" "}
                <code style={inlineCode}>@handle</code> to notify them directly.
              </p>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  marginTop: "0.75rem",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="submit"
                  disabled={!body.trim() || busy}
                  className="app-primary-action"
                  data-testid="comment-submit"
                >
                  {busy ? "Posting…" : "Post comment"}
                </button>
              </div>
            </div>
          </div>
        </form>

        {loading ? (
          <p style={{ color: "#5F6878" }}>Loading comments…</p>
        ) : items.length === 0 ? (
          <div className="app-empty" data-testid="comments-empty">
            <div className="app-empty__icon" aria-hidden>
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <strong>No comments yet</strong>
            <p>Start the conversation with your team.</p>
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((c) => (
              <CommentRow
                key={c.id}
                comment={c}
                directory={directory}
                teamId={team.id}
                canModerate={team.viewerCapabilities?.canModerateComments === true}
                onRefresh={refresh}
                onError={onError}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function CommentRow({
  comment,
  directory,
  teamId,
  canModerate,
  onRefresh,
  onError,
}: {
  comment: Comment;
  directory: Record<string, CollaborationTeamUserDirectoryEntry>;
  teamId: string;
  /** SERVER-projected comment-moderation authority (viewerCapabilities). */
  canModerate: boolean;
  onRefresh: () => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const author = directory[comment.authorUserId];
  // PHASE 12 POINT 4 STEP 1 — authorship is decided against the VIEWER's own
  // account id. The previous condition compared the comment's author id to
  // `author?.userId`, which is that same author's directory entry — always
  // true — so Edit/Delete were offered on every comment to every member and
  // only the API's 403 stopped them. `editComment`/`deleteComment` allow
  // `isAuthor || isModerator`; this now mirrors that exactly.
  const viewerUserId = useAccount()?.userId ?? null;
  const isAuthor =
    viewerUserId !== null && comment.authorUserId === viewerUserId;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);

  const onSaveEdit = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await editComment(teamId, comment.id, draft);
      addToast("Comment updated.", "success");
      setEditing(false);
      await onRefresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: "Delete this comment?",
      description: "This action is permanent.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteComment(teamId, comment.id);
      addToast("Comment deleted.", "success");
      await onRefresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      data-testid={`comment-row-${comment.id}`}
      className="app-inner-surface"
      style={{ padding: "0.9rem 1rem", marginBottom: "0.6rem" }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Avatar entry={author} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontWeight: 650, color: "#172033" }}>
              {author?.displayName ?? "Team member"}
            </span>
            <span style={{ color: "#5F6878", fontSize: "0.78rem" }}>
              {formatUserDateTime(comment.createdAt)}
              {comment.status === "EDITED" ? " · edited" : ""}
            </span>
          </div>
          {editing ? (
            <div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={4000}
                rows={3}
                className="app-form-input"
                style={{ marginTop: 6 }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => void onSaveEdit()}
                  disabled={busy}
                  className="app-primary-action"
                  data-testid={`comment-save-${comment.id}`}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(comment.body);
                  }}
                  disabled={busy}
                  className="app-ghost-action"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p
              style={{
                margin: "0.4rem 0",
                color: "#475569",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {renderBodyWithMentions(comment.body)}
            </p>
          )}
          {!editing && (canModerate || isAuthor) ? (
            <div style={{ display: "flex", gap: 4, marginLeft: -6 }}>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="app-ghost-action"
                data-testid={`comment-edit-${comment.id}`}
              >
                Edit
              </button>
              {canModerate || isAuthor ? (
                <button
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={busy}
                  className="app-danger-link"
                  data-testid={`comment-delete-${comment.id}`}
                >
                  Delete
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function renderBodyWithMentions(body: string): React.ReactNode {
  // Lightweight inline rendering — bold `@handle` tokens.
  const parts = body.split(/(@[a-zA-Z0-9._-]{1,80})/g);
  return parts.map((p, i) =>
    p.startsWith("@") ? (
      <strong
        key={i}
        data-testid="mention-token"
        style={{
          color: "#6D28D9",
          background: "rgba(109, 40, 217, 0.09)",
          borderRadius: 5,
          padding: "0 4px",
          fontWeight: 650,
        }}
      >
        {p}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function Avatar({ entry }: { entry?: CollaborationTeamUserDirectoryEntry }) {
  return (
    <span className="app-avatar" aria-hidden>
      {entry?.initials ?? "??"}
    </span>
  );
}
