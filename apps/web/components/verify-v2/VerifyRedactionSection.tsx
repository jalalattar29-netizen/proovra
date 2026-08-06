/**
 * PHASE 12B (Evidence Operations) — Verify page redaction section.
 *
 * Renders the public-safe redaction verification badge that now arrives
 * on the canonical token-bound Verify projection
 * (`GET /public/verify/:id` → `redaction`). It REPLACES the anonymous
 * `GET /v1/redaction/public/verify/:evidenceId` probe, which the page
 * never consumed and which answered for records this page refuses.
 *
 * Contract:
 *   * Renders nothing when the projection is absent — the page never
 *     fabricates a "not redacted" claim for records where we simply
 *     have no redaction data.
 *   * Counts + bounded codes only. Never region geometry, never
 *     detection text, never rationale, never approver identity.
 *   * The limitation codes are rendered through a bounded copy map so
 *     no raw enum leaks to a public visitor.
 */

import type { CSSProperties } from "react";

import { formatDateTime } from "./_helpers";

export type VerifyRedaction = {
  hasPublishedDerivative: boolean;
  publishedVersionOrdinal: number | null;
  publishedAtUtc: string | null;
  approvalCount: number;
  videoProvenance: { totalFrames: number; acceptedTracks: number } | null;
  limitations: ReadonlyArray<string>;
};

const LIMITATION_COPY: Record<string, string> = {
  REDACTION_NEVER_MODIFIES_ORIGINAL:
    "The original file is never changed. A redacted copy is produced alongside it.",
  REDACTION_DERIVATIVE_IS_NOT_ORIGINAL:
    "A redacted copy is a separate file. It is not the original record.",
  REDACTION_APPROVAL_IS_HUMAN_JUDGEMENT:
    "Redactions are approved by a person. PROOVRA records that decision; it does not make it.",
  REDACTION_TRACKING_IS_PROVENANCE_ONLY:
    "Automatic detection in video is a record of what was reviewed, not a guarantee that everything sensitive was found.",
};

export function VerifyRedactionSection({
  redaction,
  typo,
  brand,
}: {
  redaction: VerifyRedaction | null;
  typo: Record<string, CSSProperties>;
  brand: Record<string, string>;
}) {
  if (!redaction) return null;

  const rows: Array<{ label: string; value: string }> = [];
  if (redaction.hasPublishedDerivative) {
    rows.push({
      label: "Redacted copy published",
      value:
        redaction.publishedVersionOrdinal !== null
          ? `Version ${redaction.publishedVersionOrdinal}`
          : "Yes",
    });
    if (redaction.publishedAtUtc) {
      rows.push({
        label: "Published on",
        value: safeDate(redaction.publishedAtUtc),
      });
    }
    rows.push({
      label: "Approvals recorded",
      value: String(redaction.approvalCount),
    });
  } else {
    rows.push({
      label: "Redacted copy published",
      value: "None",
    });
  }
  if (redaction.videoProvenance) {
    rows.push({
      label: "Video frames reviewed",
      value: String(redaction.videoProvenance.totalFrames),
    });
    rows.push({
      label: "Regions approved for masking",
      value: String(redaction.videoProvenance.acceptedTracks),
    });
  }

  return (
    <section
      data-testid="verify-redaction"
      data-verify-redaction-published={
        redaction.hasPublishedDerivative ? "true" : "false"
      }
      style={{
        border: "1px solid rgba(11,46,39,0.12)",
        borderRadius: 14,
        padding: "14px 16px",
      }}
    >
      <h3 style={{ ...typo.small, color: brand.ink, margin: 0, fontWeight: 700 }}>
        Redaction
      </h3>
      <p style={{ ...typo.small, fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>
        Whether a redacted copy of this record has been published, and what
        was reviewed before it was.
      </p>

      <dl
        data-testid="verify-redaction-rows"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
          gap: 10,
          margin: "10px 0 0",
        }}
      >
        {rows.map((r) => (
          <div key={r.label}>
            <dt style={{ ...typo.small, fontSize: 11.5, opacity: 0.75 }}>
              {r.label}
            </dt>
            <dd style={{ ...typo.small, fontSize: 13, margin: "2px 0 0", fontWeight: 600 }}>
              {r.value}
            </dd>
          </div>
        ))}
      </dl>

      {redaction.limitations.length > 0 ? (
        <ul
          data-testid="verify-redaction-limitations"
          style={{
            ...typo.small,
            fontSize: 12,
            lineHeight: 1.5,
            margin: "12px 0 0",
            paddingLeft: 18,
            display: "grid",
            gap: 4,
          }}
        >
          {redaction.limitations.map((code) => (
            <li key={code}>{LIMITATION_COPY[code] ?? humanise(code)}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function humanise(code: string): string {
  const spaced = code.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Timestamps route through the ONE shared formatting layer (Global Timestamp
 * Display Policy): `new Date(iso).toLocaleString()` rendered in the machine's
 * locale and an unlabelled offset, so the same instant read differently for
 * every viewer and the zone was never stated. This surface already has a
 * canonical helper — reuse it rather than keeping a second local one.
 */
const safeDate = formatDateTime;
