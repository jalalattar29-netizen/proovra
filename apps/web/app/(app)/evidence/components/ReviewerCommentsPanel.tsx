"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import type { ReviewerComment, ReviewerCommentsResponse } from "../lib/evidence-library-types";
import { PANEL_LOAD_FAILED, panelWriteError } from "./panelFeedback";

export function ReviewerCommentsPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ReviewerComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  // PRO-E1C-01 — a failed read is not "none yet"; a refused write is said.
  const [loadFailed, setLoadFailed] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const data = (await apiFetch(`/v1/evidence/${evidenceId}/comments`)) as ReviewerCommentsResponse;
        if (!cancelled) {
          setItems(Array.isArray(data.items) ? data.items : []);
          setCanWrite(data.canWrite === true);
          setLoadFailed(false);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [evidenceId, open, reloadKey]);

  const createComment = async () => {
    setWriteError(null);
    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: draft, visibility: "INTERNAL" }),
      })) as ReviewerCommentsResponse;
      if (data.comment) {
        setItems((current) => [data.comment!, ...current]);
        setDraft("");
      }
    } catch (err) {
      setWriteError(panelWriteError(err, "The comment was not saved."));
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setWriteError(null);
    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/comments/${editingId}`, {
        method: "PATCH",
        body: JSON.stringify({ body: editingBody }),
      })) as ReviewerCommentsResponse;
      if (data.comment) {
        setItems((current) => current.map((item) => (item.id === editingId ? data.comment! : item)));
        setEditingId(null);
        setEditingBody("");
      }
    } catch (err) {
      setWriteError(panelWriteError(err, "The edit was not saved."));
    }
  };

  const deleteComment = async (commentId: string) => {
    setWriteError(null);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/comments/${commentId}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== commentId));
    } catch (err) {
      setWriteError(panelWriteError(err, "The comment was not deleted."));
    }
  };

  return (
    <section className="evidence-library-panel">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="evidence-library-expand-summary">Reviewer comments</summary>
        <p className="evidence-library-muted">
          Reviewer comments are operational notes and do not alter the recorded integrity state.
        </p>
        {canWrite ? (
          <div className="evidence-library-filter-group evd-block--tight">
            <label htmlFor={`comment-${evidenceId}`}>Add comment</label>
            <textarea
              id={`comment-${evidenceId}`}
              className="evidence-library-textarea"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="evidence-library-panel__actions evd-block--tight">
              <button type="button" className="app-secondary-action app-secondary-action--filled" onClick={() => void createComment()} disabled={!draft.trim()}>
                Save Comment
              </button>
            </div>
          </div>
        ) : null}

        {writeError ? (
          <p role="alert" className="evidence-library-muted" data-panel-write-error>
            {writeError}
          </p>
        ) : null}
        {loading ? <p className="evidence-library-muted">Loading comments...</p> : null}
        {!loading && loadFailed ? (
          <p role="alert" className="evidence-library-muted" data-panel-load-failed>
            {PANEL_LOAD_FAILED}{" "}
            <button type="button" className="app-secondary-action" onClick={() => setReloadKey((n) => n + 1)}>
              Try again
            </button>
          </p>
        ) : null}
        {!loading && !loadFailed && items.length === 0 ? (
          <p className="evidence-library-muted">No reviewer comments yet.</p>
        ) : null}

        <div className="evidence-library-note-grid">
          {items.map((item) => (
            <div key={item.id} className="evidence-library-note-card">
              <strong>{item.author.displayName || item.author.email || "Reviewer"}</strong>
              <p className="evidence-library-muted">
                {formatUserDateTime(item.createdAt)} {item.edited ? "• Edited" : ""}
              </p>
              {editingId === item.id ? (
                <>
                  <textarea
                    className="evidence-library-textarea"
                    value={editingBody}
                    onChange={(event) => setEditingBody(event.target.value)}
                  />
                  <div className="evidence-library-panel__actions evd-block--tight">
                    <button type="button" className="app-secondary-action app-secondary-action--filled" onClick={() => void saveEdit()} disabled={!editingBody.trim()}>
                      Save
                    </button>
                    <button type="button" className="app-secondary-action" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>{item.body}</p>
                  {/* PRO-E2-09 — per item: the author or a manager (server-projected). */}
                  {canWrite && item.canManage !== false ? (
                    <div className="evidence-library-panel__actions evd-block--tight">
                      {item.viewerCanEdit !== false ? (
                      <button type="button" className="app-secondary-action"
                        onClick={() => {
                          setEditingId(item.id);
                          setEditingBody(item.body);
                        }}
                      >
                        Edit
                      </button>
                      ) : null}
                      <button type="button" className="app-ghost-action evidence-detail-destructive-action" onClick={() => void deleteComment(item.id)}>Delete</button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
