"use client";

import { useEffect, useState } from "react";
import { Button } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import type { ReviewerComment, ReviewerCommentsResponse } from "../lib/evidence-library-types";

export function ReviewerCommentsPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ReviewerComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const data = (await apiFetch(`/v1/evidence/${evidenceId}/comments`)) as ReviewerCommentsResponse;
        if (!cancelled) {
          setItems(Array.isArray(data.items) ? data.items : []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [evidenceId, open]);

  const createComment = async () => {
    const data = (await apiFetch(`/v1/evidence/${evidenceId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: draft, visibility: "INTERNAL" }),
    })) as ReviewerCommentsResponse;
    if (data.comment) {
      setItems((current) => [data.comment!, ...current]);
      setDraft("");
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const data = (await apiFetch(`/v1/evidence/${evidenceId}/comments/${editingId}`, {
      method: "PATCH",
      body: JSON.stringify({ body: editingBody }),
    })) as ReviewerCommentsResponse;
    if (data.comment) {
      setItems((current) => current.map((item) => (item.id === editingId ? data.comment! : item)));
      setEditingId(null);
      setEditingBody("");
    }
  };

  const deleteComment = async (commentId: string) => {
    await apiFetch(`/v1/evidence/${evidenceId}/comments/${commentId}`, { method: "DELETE" });
    setItems((current) => current.filter((item) => item.id !== commentId));
  };

  return (
    <section className="evidence-library-panel">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="evidence-library-expand-summary">Reviewer comments</summary>
        <p className="evidence-library-muted">
          Reviewer comments are operational notes and do not alter the recorded integrity state.
        </p>
        <div className="evidence-library-filter-group" style={{ marginTop: 12 }}>
          <label htmlFor={`comment-${evidenceId}`}>Add comment</label>
          <textarea
            id={`comment-${evidenceId}`}
            className="evidence-library-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="evidence-library-panel__actions">
            <Button onClick={() => void createComment()} disabled={!draft.trim()}>
              Save Comment
            </Button>
          </div>
        </div>

        {loading ? <p className="evidence-library-muted">Loading comments...</p> : null}
        {!loading && items.length === 0 ? (
          <p className="evidence-library-muted">No reviewer comments yet.</p>
        ) : null}

        <div className="evidence-library-note-grid">
          {items.map((item) => (
            <div key={item.id} className="evidence-library-note-card">
              <strong>{item.author.displayName || item.author.email || "Reviewer"}</strong>
              <p className="evidence-library-muted">
                {new Date(item.createdAt).toLocaleString()} {item.edited ? "• Edited" : ""}
              </p>
              {editingId === item.id ? (
                <>
                  <textarea
                    className="evidence-library-textarea"
                    value={editingBody}
                    onChange={(event) => setEditingBody(event.target.value)}
                  />
                  <div className="evidence-library-panel__actions">
                    <Button onClick={() => void saveEdit()} disabled={!editingBody.trim()}>
                      Save
                    </Button>
                    <Button variant="secondary" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p>{item.body}</p>
                  <div className="evidence-library-panel__actions">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEditingId(item.id);
                        setEditingBody(item.body);
                      }}
                    >
                      Edit
                    </Button>
                    <Button onClick={() => void deleteComment(item.id)}>Delete</Button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
