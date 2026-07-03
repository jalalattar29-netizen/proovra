"use client";

import { useEffect, useState } from "react";
import { Button } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import type { LegalNote, LegalNotesResponse } from "../lib/evidence-library-types";

const NOTE_TYPES = ["GENERAL", "PRIVILEGED", "DISCLOSURE", "REVIEW_BOUNDARY", "HANDOFF"] as const;

export function LegalNotesPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LegalNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [noteType, setNoteType] = useState<(typeof NOTE_TYPES)[number]>("GENERAL");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [editingType, setEditingType] = useState<(typeof NOTE_TYPES)[number]>("GENERAL");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const data = (await apiFetch(`/v1/evidence/${evidenceId}/legal-notes`)) as LegalNotesResponse;
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

  const createNote = async () => {
    const data = (await apiFetch(`/v1/evidence/${evidenceId}/legal-notes`, {
      method: "POST",
      body: JSON.stringify({ body: draft, noteType }),
    })) as LegalNotesResponse;
    if (data.legalNote) {
      setItems((current) => [data.legalNote!, ...current]);
      setDraft("");
    }
  };

  const deleteNote = async (noteId: string) => {
    await apiFetch(`/v1/evidence/${evidenceId}/legal-notes/${noteId}`, { method: "DELETE" });
    setItems((current) => current.filter((item) => item.id !== noteId));
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const data = (await apiFetch(`/v1/evidence/${evidenceId}/legal-notes/${editingId}`, {
      method: "PATCH",
      body: JSON.stringify({ body: editingBody, noteType: editingType }),
    })) as LegalNotesResponse;
    if (data.legalNote) {
      setItems((current) => current.map((item) => (item.id === editingId ? data.legalNote! : item)));
      setEditingId(null);
      setEditingBody("");
      setEditingType("GENERAL");
    }
  };

  return (
    <section className="evidence-library-panel evidence-library-panel--caution">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="evidence-library-expand-summary">Legal notes</summary>
        <p className="evidence-library-muted">
          Legal notes are internal workspace notes. They do not determine legal outcome or evidentiary weight.
        </p>
        <div className="evidence-library-case-toolbar" style={{ marginTop: 12 }}>
          <select value={noteType} onChange={(event) => setNoteType(event.target.value as typeof noteType)}>
            {NOTE_TYPES.map((item) => (
              <option key={item} value={item}>
                {item.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <textarea
          className="evidence-library-textarea"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          style={{ marginTop: 12 }}
        />
        <div className="evidence-library-panel__actions" style={{ marginTop: 12 }}>
          <Button onClick={() => void createNote()} disabled={!draft.trim()}>
            Save Legal Note
          </Button>
        </div>
        {loading ? <p className="evidence-library-muted">Loading legal notes...</p> : null}
        {!loading && items.length === 0 ? <p className="evidence-library-muted">No legal notes yet.</p> : null}
        <div className="evidence-library-note-grid">
          {items.map((item) => (
            <div key={item.id} className="evidence-library-note-card">
              <strong>{item.noteType.replace(/_/g, " ")}</strong>
              <p className="evidence-library-muted">
                {item.author.displayName || item.author.email || "Legal reviewer"} •{" "}
                {formatUserDateTime(item.createdAt)} {item.edited ? "• Edited" : ""}
              </p>
              {editingId === item.id ? (
                <>
                  <select
                    value={editingType}
                    onChange={(event) => setEditingType(event.target.value as typeof editingType)}
                  >
                    {NOTE_TYPES.map((typeOption) => (
                      <option key={typeOption} value={typeOption}>
                        {typeOption.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                  <textarea
                    className="evidence-library-textarea"
                    value={editingBody}
                    onChange={(event) => setEditingBody(event.target.value)}
                    style={{ marginTop: 12 }}
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
                        setEditingType(item.noteType);
                      }}
                    >
                      Edit
                    </Button>
                    <Button onClick={() => void deleteNote(item.id)}>Delete</Button>
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
