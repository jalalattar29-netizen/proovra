"use client";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

import { ChevronDown, Columns2 } from "lucide-react";
import { useId, useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import type { EvidenceComparisonResponse } from "../lib/evidence-library-types";

function renderValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" || typeof value === "string") return String(value);
  return JSON.stringify(value);
}

/**
 * Phase EVIDENCE-COMPARISON-CLEANUP (FIX 4) — humanise the comparison
 * payload. Each card now renders a short summary line up front
 * (presence + size + integrity hint) and tucks the full raw
 * key/value grid behind a "Technical details" `<details>` block.
 *
 * The data is NOT removed — every field that previously rendered
 * still renders, just one click deeper. This keeps engineering
 * access to the raw structure while normal reviewers see only the
 * one-line summary by default.
 */
function summariseGroup(group: Record<string, unknown> | null | undefined): string {
  if (!group) return "Comparison not available";
  const sha256 =
    typeof group.sha256 === "string"
      ? group.sha256
      : typeof group.fileSha256 === "string"
        ? group.fileSha256
        : null;
  const sizeBytes =
    typeof group.sizeBytes === "number" || typeof group.sizeBytes === "string"
      ? group.sizeBytes
      : typeof group.bytes === "number" || typeof group.bytes === "string"
        ? group.bytes
        : null;
  const mimeType =
    typeof group.mimeType === "string"
      ? group.mimeType
      : typeof group.contentType === "string"
        ? group.contentType
        : null;
  const fragments: string[] = [];
  if (mimeType) fragments.push(mimeType);
  if (sizeBytes) fragments.push(`${sizeBytes} B`);
  if (sha256) fragments.push(`SHA-256 ${String(sha256).slice(0, 8)}…`);
  if (fragments.length === 0) {
    const keyCount = Object.keys(group).length;
    return keyCount > 0 ? `${keyCount} recorded field${keyCount === 1 ? "" : "s"}` : "Recorded";
  }
  return fragments.join(" · ");
}

function renderGroup(
  title: string,
  group: Record<string, unknown> | null | undefined,
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
    <div className="evidence-library-note-card" data-comparison-card={title}>
      <strong>{title}</strong>
      <p className="evd-muted evd-block--tight">
        {summariseGroup(group)}
      </p>
      {/* FIX 4 — the raw key/value grid moves behind a collapsed
          `<details>` so the comparison card no longer dumps the full
          backend payload (and any stray `JSON.stringify(...)` cell
          value) into the default view. Engineering can still expand
          it on demand; the data is preserved, just one click deeper. */}
      <details data-comparison-technical-details>
        <summary className="evd-disclosure-summary">
          Technical details
        </summary>
        <div className="evidence-library-definition-grid evd-block--tight">
          {Object.entries(group).map(([key, value]) => (
            <div key={key}>
              <span>{key}</span>
              <strong>{renderValue(value)}</strong>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * Phase EVIDENCE-MISMATCH-HIDE — the backend currently hardcodes
 * every `mismatchFlags.*` value to `null` (dead scaffolding for a
 * future forensic comparison feature). Showing a card titled
 * "Mismatch flags" with three blank `originalVsRecordedHash` /
 * `originalVsVerificationPackageManifest` / `previewVsOriginal`
 * rows leaks raw field names to normal users and signals broken
 * UI. Hide the card entirely while every flag is null/undefined;
 * when the backend actually populates them, the card will render
 * automatically.
 *
 * NOT a backend change — backend stays exactly as it is. We just
 * stop surfacing the scaffolding in the UI.
 */
function hasAnyMismatchFlag(group: Record<string, unknown> | null | undefined): boolean {
  if (!group) return false;
  for (const value of Object.values(group)) {
    if (value !== null && value !== undefined) return true;
  }
  return false;
}

export function ComparisonPanel({ evidenceId }: { evidenceId: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
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
          setError(toSafeUserError(loadError, { message: "Comparison unavailable" }).message);
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
    <section className="evidence-detail-tool" data-evidence-tool="comparison">
      <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary
          className="evidence-detail-tool__summary"
          aria-expanded={open}
          aria-controls={panelId}
        >
          <Columns2
            size={18}
            strokeWidth={2}
            aria-hidden="true"
            className="evidence-detail-tool__icon"
          />
          <span className="evidence-detail-tool__title">Comparison mode</span>
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
          aria-label="Comparison mode"
          className="evidence-detail-tool__panel"
        >
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
            {hasAnyMismatchFlag(data.mismatchFlags as Record<string, unknown> | null)
              ? renderGroup(
                  "Mismatch flags",
                  data.mismatchFlags as Record<string, unknown> | null,
                )
              : null}
          </div>
        ) : null}
        </div>
      </details>
    </section>
  );
}
