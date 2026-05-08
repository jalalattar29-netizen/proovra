"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import type {
  EvidenceDuplicatesResponse,
  EvidenceListItem,
} from "../lib/evidence-library-types";
import { shortId } from "../lib/evidence-library-formatters";
import { getDisplayTitle } from "../lib/evidence-library-status";

function DuplicateGroup({
  title,
  items,
}: {
  title: string;
  items: EvidenceListItem[];
}) {
  return (
    <div className="evidence-library-note-card">
      <strong>{title}</strong>
      {items.length === 0 ? (
        <p>No accessible matches recorded.</p>
      ) : (
        <div className="evidence-library-result-list">
          {items.map((item) => (
            <div key={item.id} className="evidence-library-result-row">
              <strong>{getDisplayTitle(item)}</strong>
              <span>{shortId(item.id)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DuplicateDetectionPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<EvidenceDuplicatesResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = (await apiFetch(
          `/v1/evidence/${evidenceId}/duplicates`
        )) as EvidenceDuplicatesResponse;
        if (!cancelled) {
          setData(response);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Duplicate detection unavailable");
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

  const totalMatches =
    (data?.exactHashMatches?.length ?? 0) +
    (data?.fingerprintMatches?.length ?? 0) +
    (data?.partHashMatches?.length ?? 0) +
    (data?.possibleMetadataMatches?.length ?? 0);

  return (
    <section className="evidence-library-panel">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="evidence-library-expand-summary">Duplicate detection</summary>
        <p className="evidence-library-muted">
          Duplicate detection is limited to accessible records and recorded hashes or metadata.
        </p>

        {loading ? <p className="evidence-library-muted">Checking accessible duplicates...</p> : null}
        {error ? <p className="evidence-library-muted">{error}</p> : null}
        {!loading && !error && data && totalMatches === 0 ? (
          <p className="evidence-library-muted">No accessible duplicates detected.</p>
        ) : null}

        {!loading && !error && data ? (
          <div className="evidence-library-note-grid">
            <DuplicateGroup title="Exact hash matches" items={data.exactHashMatches ?? []} />
            <DuplicateGroup title="Fingerprint matches" items={data.fingerprintMatches ?? []} />
            <DuplicateGroup title="Part-level hash matches" items={data.partHashMatches ?? []} />
            <DuplicateGroup
              title="Possible metadata duplicates"
              items={data.possibleMetadataMatches ?? []}
            />
          </div>
        ) : null}
      </details>
    </section>
  );
}
