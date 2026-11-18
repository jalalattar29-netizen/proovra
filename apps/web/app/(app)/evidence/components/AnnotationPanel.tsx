"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import type { EvidenceAnnotationsResponse, EvidenceAnnotation } from "../lib/evidence-library-types";
import { PANEL_LOAD_FAILED, panelWriteError } from "./panelFeedback";

export function AnnotationPanel({
  evidenceId,
  defaultPartId,
}: {
  evidenceId: string;
  defaultPartId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EvidenceAnnotation[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  // PRO-E1C-01 — a failed read is not "no annotations"; a refused write is said.
  const [loadFailed, setLoadFailed] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const data = (await apiFetch(`/v1/evidence/${evidenceId}/annotations`)) as EvidenceAnnotationsResponse;
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

  const createAnnotation = async () => {
    setWriteError(null);
    try {
      const data = (await apiFetch(`/v1/evidence/${evidenceId}/annotations`, {
        method: "POST",
        body: JSON.stringify({
          evidencePartId: defaultPartId ?? null,
          annotationType: "TEXT",
          body,
          coordinateSpace: "NORMALIZED",
        }),
      })) as EvidenceAnnotationsResponse;
      if (data.annotation) {
        setItems((current) => [data.annotation!, ...current]);
        setBody("");
      }
    } catch (err) {
      setWriteError(panelWriteError(err, "The annotation was not saved."));
    }
  };

  const deleteAnnotation = async (annotationId: string) => {
    setWriteError(null);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/annotations/${annotationId}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== annotationId));
    } catch (err) {
      setWriteError(panelWriteError(err, "The annotation was not deleted."));
    }
  };

  return (
    <section className="evidence-library-panel">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="evidence-library-expand-summary">Annotations</summary>
        <p className="evidence-library-muted">
          Annotations are reviewer notes layered over the review surface. They do not modify preserved evidence.
        </p>
        {canWrite ? (
          <>
            <textarea
              className="evidence-library-textarea"
              value={body}
              onChange={(event) => setBody(event.target.value)}

            />
            <div className="evidence-library-panel__actions evd-block--tight">
              <button type="button" className="app-secondary-action app-secondary-action--filled" onClick={() => void createAnnotation()} disabled={!body.trim()}>
                Add Text Annotation
              </button>
            </div>
          </>
        ) : null}
        {writeError ? (
          <p role="alert" className="evidence-library-muted" data-panel-write-error>
            {writeError}
          </p>
        ) : null}
        {loading ? <p className="evidence-library-muted">Loading annotations...</p> : null}
        {!loading && loadFailed ? (
          <p role="alert" className="evidence-library-muted" data-panel-load-failed>
            {PANEL_LOAD_FAILED}{" "}
            <button type="button" className="app-secondary-action" onClick={() => setReloadKey((n) => n + 1)}>
              Try again
            </button>
          </p>
        ) : null}
        {!loading && !loadFailed && items.length === 0 ? <p className="evidence-library-muted">No annotations yet.</p> : null}
        <div className="evidence-library-note-grid">
          {items.map((item) => (
            <div key={item.id} className="evidence-library-note-card">
              <strong>{item.annotationType}</strong>
              <p className="evidence-library-muted">
                {item.author.displayName || item.author.email || "Reviewer"} •{" "}
                {formatUserDateTime(item.createdAt)}
              </p>
              <p>{item.body || "Annotation metadata recorded."}</p>
              {canWrite ? (
                <div className="evidence-library-panel__actions evd-block--tight">
                  <button type="button" className="app-ghost-action evidence-detail-destructive-action" onClick={() => void deleteAnnotation(item.id)}>Delete</button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
