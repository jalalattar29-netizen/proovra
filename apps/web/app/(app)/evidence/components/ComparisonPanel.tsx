"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import type { EvidenceComparisonResponse } from "../lib/evidence-library-types";

function renderValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" || typeof value === "string") return String(value);
  return JSON.stringify(value);
}

function renderGroup(
  title: string,
  group: Record<string, unknown> | null | undefined
) {
  if (!group) {
    return (
      <div className="evidence-library-note-card is-disabled">
        <strong>{title}</strong>
        <p>Comparison not available.</p>
      </div>
    );
  }

  return (
    <div className="evidence-library-note-card">
      <strong>{title}</strong>
      <div className="evidence-library-definition-grid">
        {Object.entries(group).map(([key, value]) => (
          <div key={key}>
            <span>{key}</span>
            <strong>{renderValue(value)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ComparisonPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<EvidenceComparisonResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = (await apiFetch(
          `/v1/evidence/${evidenceId}/comparison`
        )) as EvidenceComparisonResponse;
        if (!cancelled) {
          setData(response);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Comparison unavailable");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [evidenceId, open]);

  return (
    <section className="evidence-library-panel">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="evidence-library-expand-summary">Comparison mode</summary>
        <p className="evidence-library-muted">
          Comparison uses recorded metadata and export references only. It does not establish factual truth,
          authorship, or legal outcome.
        </p>

        {loading ? <p className="evidence-library-muted">Loading comparison data...</p> : null}
        {error ? <p className="evidence-library-muted">{error}</p> : null}

        {!loading && !error && data ? (
          <div className="evidence-library-note-grid">
            {renderGroup("Original record", data.original as Record<string, unknown> | null)}
            {renderGroup(
              "Reviewer preview",
              data.previewRepresentation as Record<string, unknown> | null
            )}
            {renderGroup("Report artifact", data.reportArtifact as Record<string, unknown> | null)}
            {renderGroup(
              "Verification package",
              data.verificationPackage as Record<string, unknown> | null
            )}
            {renderGroup("Mismatch flags", data.mismatchFlags as Record<string, unknown> | null)}
          </div>
        ) : null}
      </details>
    </section>
  );
}
