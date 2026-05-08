"use client";

import { useEffect, useState } from "react";
import { Button } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import type { EvidenceAnnotationsResponse, EvidenceAnnotation } from "../lib/evidence-library-types";

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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const data = (await apiFetch(`/v1/evidence/${evidenceId}/annotations`)) as EvidenceAnnotationsResponse;
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

  const createAnnotation = async () => {
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
  };

  const deleteAnnotation = async (annotationId: string) => {
    await apiFetch(`/v1/evidence/${evidenceId}/annotations/${annotationId}`, { method: "DELETE" });
    setItems((current) => current.filter((item) => item.id !== annotationId));
  };

  return (
    <section className="evidence-library-panel">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="evidence-library-expand-summary">Annotations</summary>
        <p className="evidence-library-muted">
          Annotations are reviewer notes layered over the review surface. They do not modify preserved evidence.
        </p>
        <textarea
          className="evidence-library-textarea"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          style={{ marginTop: 12 }}
        />
        <div className="evidence-library-panel__actions" style={{ marginTop: 12 }}>
          <Button onClick={() => void createAnnotation()} disabled={!body.trim()}>
            Add Text Annotation
          </Button>
        </div>
        {loading ? <p className="evidence-library-muted">Loading annotations...</p> : null}
        {!loading && items.length === 0 ? <p className="evidence-library-muted">No annotations yet.</p> : null}
        <div className="evidence-library-note-grid">
          {items.map((item) => (
            <div key={item.id} className="evidence-library-note-card">
              <strong>{item.annotationType}</strong>
              <p className="evidence-library-muted">
                {item.author.displayName || item.author.email || "Reviewer"} •{" "}
                {new Date(item.createdAt).toLocaleString()}
              </p>
              <p>{item.body || "Annotation metadata recorded."}</p>
              <div className="evidence-library-panel__actions">
                <Button onClick={() => void deleteAnnotation(item.id)}>Delete</Button>
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
