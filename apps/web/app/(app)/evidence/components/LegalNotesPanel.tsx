"use client";

import { AppListbox } from "../../../../components/app-primitives";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import type { LegalNote, LegalNotesResponse } from "../lib/evidence-library-types";
import { PANEL_LOAD_FAILED, panelWriteError } from "./panelFeedback";

const NOTE_TYPES = ["GENERAL", "PRIVILEGED", "DISCLOSURE", "REVIEW_BOUNDARY", "HANDOFF"] as const;

export function LegalNotesPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LegalNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [draft, setDraft] = useState("");
  const [noteType, setNoteType] = useState<(typeof NOTE_TYPES)[number]>("GENERAL");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [editingType, setEditingType] = useState<(typeof NOTE_TYPES)[number]>("GENERAL");
  // PRO-E1C-01 — a failed read is not "no legal notes"; a refused write is said.
  const [loadFailed, setLoadFailed] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const data = (await apiFetch(`/v1/evidence/${evidenceId}/legal-notes`)) as LegalNotesResponse;
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

  const createNote = async () => {
    setWriteError(null);
    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/legal-notes`, {
        method: "POST",
        body: JSON.stringify({ body: draft, noteType }),
      })) as LegalNotesResponse;
      if (data.legalNote) {
        setItems((current) => [data.legalNote!, ...current]);
        setDraft("");
      }
    } catch (err) {
      setWriteError(panelWriteError(err, "The legal note was not saved."));
    }
  };

  const deleteNote = async (noteId: string) => {
    setWriteError(null);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/legal-notes/${noteId}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== noteId));
    } catch (err) {
      setWriteError(panelWriteError(err, "The legal note was not deleted."));
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setWriteError(null);
    try {
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
    } catch (err) {
      setWriteError(panelWriteError(err, "The edit was not saved."));
    }
  };

  return (
    <section className="evidence-library-panel evidence-library-panel--caution">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="evidence-library-expand-summary">Legal notes</summary>
        <p className="evidence-library-muted">
          Legal notes are internal workspace notes. They do not determine legal outcome or evidentiary weight.
        </p>
        {canWrite ? (
          <>
        <div className="evidence-library-case-toolbar evd-block--tight">
          <AppListbox
            value={noteType}
            ariaLabel="Legal note type"
            onChange={(next) => setNoteType(next as typeof noteType)}
            options={NOTE_TYPES.map((item) => ({
              value: item,
              label: item.replace(/_/g, " "),
            }))}
          />
        </div>
        <textarea
          className="evidence-library-textarea"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}

        />
        <div className="evidence-library-panel__actions evd-block--tight">
          <button type="button" className="app-secondary-action app-secondary-action--filled" onClick={() => void createNote()} disabled={!draft.trim()}>
            Save Legal Note
          </button>
        </div>
          </>
        ) : null}
        {writeError ? (
          <p role="alert" className="evidence-library-muted" data-panel-write-error>
            {writeError}
          </p>
        ) : null}
        {loading ? <p className="evidence-library-muted">Loading legal notes...</p> : null}
        {!loading && loadFailed ? (
          <p role="alert" className="evidence-library-muted" data-panel-load-failed>
            {PANEL_LOAD_FAILED}{" "}
            <button type="button" className="app-secondary-action" onClick={() => setReloadKey((n) => n + 1)}>
              Try again
            </button>
          </p>
        ) : null}
        {!loading && !loadFailed && items.length === 0 ? <p className="evidence-library-muted">No legal notes yet.</p> : null}
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
                  <AppListbox
                    value={editingType}
                    ariaLabel="Legal note type"
                    onChange={(next) => setEditingType(next as typeof editingType)}
                    options={NOTE_TYPES.map((typeOption) => ({
                      value: typeOption,
                      label: typeOption.replace(/_/g, " "),
                    }))}
                  />
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
                  {canWrite ? (
                    <div className="evidence-library-panel__actions evd-block--tight">
                      <button type="button" className="app-secondary-action"
                        onClick={() => {
                          setEditingId(item.id);
                          setEditingBody(item.body);
                          setEditingType(item.noteType);
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className="app-ghost-action evidence-detail-destructive-action" onClick={() => void deleteNote(item.id)}>Delete</button>
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
