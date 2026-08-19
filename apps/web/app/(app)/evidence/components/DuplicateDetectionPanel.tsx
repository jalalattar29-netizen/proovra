"use client";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

/**
 * Phase EVIDENCE-DUPLICATES-GROUPING — Duplicate Detection panel.
 *
 * Before this pass the panel rendered the four per-category arrays
 * the backend returns (exact / fingerprint / part / metadata). Two
 * problems:
 *   1. The backend pre-substituted "Digital Evidence Record" for
 *      every null/empty title via `resolveEvidenceTitle`, so the
 *      UI's filename/type cascade never ran. Every row showed the
 *      same fallback.
 *   2. The same record could appear in 2–3 of the four arrays and
 *      the part-level array repeated a parent record once per
 *      matching part — so a single duplicate with 8 matching parts
 *      produced 8 identical rows.
 *
 * This pass consumes the new `groupedMatches` view that the
 * `/v1/evidence/:id/duplicates` endpoint returns. Each record
 * appears ONCE with its real title (or filename / type / shortId
 * fallback) and the combined list of match reasons. Legacy
 * per-category arrays in the response are ignored by the UI but
 * kept on the wire for any other consumer.
 */

import { ChevronDown, CopyCheck } from "lucide-react";
import { useId, useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import type {
  EvidenceDuplicateGroupedMatch,
  EvidenceDuplicateMatchReason,
  EvidenceDuplicatesResponse,
} from "../lib/evidence-library-types";
import { shortId } from "../lib/evidence-library-formatters";
import { formatUserDateTime } from "../../../../lib/date";

const MATCH_REASON_LABELS: Record<EvidenceDuplicateMatchReason, string> = {
  exact_hash: "Exact file hash",
  fingerprint: "Fingerprint",
  part_hash: "Part-level hash",
  metadata: "Filename + size",
};

/**
 * Phase EVIDENCE-DUPLICATES-GROUPING — frontend title cascade.
 *
 * Runs the cascade the original UI was supposed to run before the
 * backend pre-substituted "Digital Evidence Record":
 *   1. rawTitle (user-provided + non-generic)
 *   2. displayFileName
 *   3. originalFileName
 *   4. Evidence-type label ("Photo", "Document", etc.)
 *   5. Shortened evidence id (last resort)
 *
 * Skips the title if it matches the historical "Digital Evidence
 * Record" sentinel (legacy data may carry this verbatim because of
 * the prior fallback being persisted somewhere upstream).
 */
function chooseDisplayTitle(match: EvidenceDuplicateGroupedMatch): string {
  const t = match.rawTitle?.trim();
  if (t && t !== "Digital Evidence Record") return t;
  const display = match.displayFileName?.trim();
  if (display) return display;
  const original = match.originalFileName?.trim();
  if (original) return original;
  const typeLabel = humaniseType(match.type, match.mimeType, match.itemCount);
  if (typeLabel) return typeLabel;
  return shortId(match.evidenceId);
}

function humaniseType(
  type: string,
  mimeType: string | null,
  itemCount: number,
): string {
  const upper = String(type ?? "").toUpperCase();
  const multipart = itemCount > 1 ? ` · ${itemCount} items` : "";
  switch (upper) {
    case "PHOTO":
      return `Photo${multipart}`;
    case "VIDEO":
      return `Video${multipart}`;
    case "AUDIO":
      return `Audio${multipart}`;
    case "DOCUMENT":
      return `Document${multipart}`;
    case "SCREEN":
      return `Screen capture${multipart}`;
    default:
      if (mimeType) return `${mimeType}${multipart}`;
      return itemCount > 1 ? `Multipart record · ${itemCount} items` : "";
  }
}

function MatchReasonsRow({ match }: { match: EvidenceDuplicateGroupedMatch }) {
  return (
    <div
      data-evidence-duplicate-match-reasons
      className="evd-actions evd-block--tight"
    >
      {match.matchReasons.map((reason) => (
        <span
          key={reason}
          data-evidence-duplicate-match-reason={reason}
          className="evidence-detail-pill neutral"
        >
          {MATCH_REASON_LABELS[reason] ?? reason}
          {reason === "part_hash" && match.matchedPartsCount > 1
            ? ` × ${match.matchedPartsCount}`
            : ""}
        </span>
      ))}
    </div>
  );
}

function DuplicateRecordCard({ match }: { match: EvidenceDuplicateGroupedMatch }) {
  const title = chooseDisplayTitle(match);
  return (
    <article
      data-evidence-duplicate-record={match.evidenceId}
      className="evidence-library-result-row evd-card"
    >
      <div className="evd-card-header">
        <strong className="evd-strong">{title}</strong>
        <span
          className="evidence-detail-muted evd-muted--small"
          data-evidence-duplicate-record-id
        >
          {shortId(match.evidenceId)}
        </span>
        <span
          className="evidence-detail-muted evd-muted--small evd-push-end"
          data-evidence-duplicate-record-created-at
        >
          {match.createdAt ? formatUserDateTime(match.createdAt) : ""}
        </span>
      </div>
      <MatchReasonsRow match={match} />
      <div className="evd-actions evd-actions--end evd-block--tight">
        <a
          href={`/evidence/${encodeURIComponent(match.evidenceId)}`}
          target="_blank"
          rel="noreferrer"
          data-evidence-duplicate-open
          className="evd-link"
        >
          Open record →
        </a>
      </div>
    </article>
  );
}

export function DuplicateDetectionPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
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
          `/v1/evidence/${evidenceId}/duplicates`,
        )) as EvidenceDuplicatesResponse;
        if (!cancelled) setData(response);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            toSafeUserError(loadError, { message: "Duplicate detection unavailable" }).message,
          );
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

  const groupedMatches = data?.groupedMatches ?? [];
  const totalRecords = data?.totalRecords ?? groupedMatches.length;

  return (
    <section className="evidence-detail-tool" data-evidence-tool="duplicate-detection">
      <details
        open={open}
        onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary
          className="evidence-detail-tool__summary"
          aria-expanded={open}
          aria-controls={panelId}
        >
          <CopyCheck
            size={18}
            strokeWidth={2}
            aria-hidden="true"
            className="evidence-detail-tool__icon"
          />
          <span className="evidence-detail-tool__title">Duplicate detection</span>
          <ChevronDown
            size={18}
            strokeWidth={2}
            aria-hidden="true"
            className="evidence-detail-tool__chevron"
          />
        </summary>
        <div
          id={panelId}
          role="region"
          aria-label="Duplicate detection"
          className="evidence-detail-tool__panel"
        >
        <p className="evidence-library-muted">
          Duplicate detection is limited to accessible records and recorded
          hashes or metadata.
        </p>

        {loading ? (
          <p className="evidence-library-muted">
            Checking accessible duplicates...
          </p>
        ) : null}
        {error ? <p className="evidence-library-muted">{error}</p> : null}

        {!loading && !error && data && totalRecords === 0 ? (
          <p
            className="evidence-library-muted"
            data-evidence-duplicate-empty
          >
            No accessible duplicate or related records found.
          </p>
        ) : null}

        {!loading && !error && data && totalRecords > 0 ? (
          <>
            <p
              className="evidence-detail-muted"
              data-evidence-duplicate-summary
            >
              {totalRecords === 1
                ? "1 record shares one or more file hashes or metadata."
                : `${totalRecords} records share one or more file hashes or metadata.`}
            </p>
            <div
              data-evidence-duplicate-records
              className="evd-list evd-block--tight"
            >
              {groupedMatches.map((match) => (
                <DuplicateRecordCard key={match.evidenceId} match={match} />
              ))}
            </div>
          </>
        ) : null}
        </div>
      </details>
    </section>
  );
}
