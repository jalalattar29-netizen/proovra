"use client";

/**
 * Phase C3 — Intake Checklist primary driver.
 *
 * Surfaces the EvidenceRequest deliverable checklist with per-item
 * status, count requirements, accepted kinds, and capture guidance.
 * Drives the contributor's understanding of "what is still needed".
 *
 * Source of truth: the public projection from
 * `services/api/src/services/evidence-request.service.ts`
 * (`projectRequestForExternalView`). Phase C3 extended it to expose
 * `status`, `fulfilledCount`, `captureAfterRequest` per deliverable,
 * plus a request-level `status` and `completion` summary.
 *
 * Hard rules:
 *   * Operational language only — never claims authenticity / legal
 *     status / forensic correctness.
 *   * Required vs optional is always visually disambiguated. Optional
 *     items never block submission.
 *   * Empty acceptedKinds → fall back to the workspace-wide policy
 *     ("Photo, Video, Audio, Document"). Never silent.
 *   * Capture-after-request hint becomes a small operational chip,
 *     not a marketing claim about quality.
 *   * No invented guidance — only what's in `description` /
 *     `captureAfterRequest` / `locationRequirement` (all backend
 *     fields that already exist).
 */

export type IntakeDeliverable = {
  id: string;
  title: string;
  description: string;
  required: boolean;
  acceptedKinds: ReadonlyArray<string>;
  minCount: number;
  maxCount: number | null;
  locationRequirement: string;
  captureAfterRequest: boolean;
  workflowStepId: string | null;
  sortOrder: number;
  status: string;
  fulfilledCount: number;
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Not provided",
  PARTIALLY_FULFILLED: "In progress",
  FULFILLED: "Complete",
  WAIVED: "Waived",
  REJECTED: "Reviewer rejected — please re-upload",
};

const STATUS_TONES: Record<string, { bg: string; fg: string; border: string }> = {
  PENDING: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
  PARTIALLY_FULFILLED: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
  FULFILLED: { bg: "#dcfce7", fg: "#166534", border: "#bbf7d0" },
  WAIVED: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
  REJECTED: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
};

const KIND_LABELS: Record<string, string> = {
  PHOTO: "Photo",
  VIDEO: "Video",
  AUDIO: "Audio",
  DOCUMENT: "Document",
};

function StatusChip({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? STATUS_TONES.PENDING!;
  return (
    <span
      data-intake-deliverable-status={status}
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 999,
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
      }}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function CountRequirement({
  fulfilledCount,
  minCount,
  maxCount,
}: {
  fulfilledCount: number;
  minCount: number;
  maxCount: number | null;
}) {
  if (minCount <= 0 && (maxCount ?? 0) <= 0) return null;
  const cap = typeof maxCount === "number" && maxCount > 0 ? maxCount : null;
  return (
    <span
      data-intake-count-requirement
      style={{ fontSize: 12, color: "#475569" }}
    >
      {fulfilledCount} of {minCount} required
      {cap ? ` (up to ${cap})` : ""}
    </span>
  );
}

export function IntakeChecklist({
  deliverables,
  emptyTitle,
  emptyBody,
}: {
  deliverables: ReadonlyArray<IntakeDeliverable>;
  /** Optional override copy when the request has no deliverables (raw upload mode). */
  emptyTitle?: string;
  emptyBody?: string;
}) {
  if (deliverables.length === 0) {
    return (
      <div
        data-intake-checklist-empty
        role="status"
        style={{
          padding: 16,
          border: "1px dashed #cbd5e1",
          borderRadius: 8,
          background: "#f8fafc",
        }}
      >
        <strong style={{ fontSize: 14 }}>
          {emptyTitle ?? "No checklist for this request"}
        </strong>
        <p style={{ fontSize: 13, color: "#475569", margin: "6px 0 0" }}>
          {emptyBody ??
            "This intake accepts free-form uploads. Use the file picker below to add evidence — the workspace will review whatever you provide."}
        </p>
      </div>
    );
  }

  return (
    <ol
      data-intake-checklist
      style={{
        listStyle: "none",
        padding: 0,
        margin: "0 0 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {deliverables.map((d) => {
        const acceptedKinds =
          d.acceptedKinds.length > 0
            ? d.acceptedKinds.map((k) => KIND_LABELS[k] ?? k).join(", ")
            : "Photo, Video, Audio, Document";
        return (
          <li
            key={d.id}
            data-intake-deliverable={d.id}
            data-intake-deliverable-required={d.required ? "true" : "false"}
            style={{
              padding: "10px 12px",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              background:
                d.status === "FULFILLED"
                  ? "#ecfdf5"
                  : d.status === "REJECTED"
                    ? "#fef2f2"
                    : "#fff",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 4,
              }}
            >
              <strong style={{ fontSize: 14 }}>{d.title}</strong>
              {d.required ? (
                <span
                  data-intake-required-chip
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    background: "#fef2f2",
                    color: "#991b1b",
                    borderRadius: 999,
                    fontWeight: 600,
                  }}
                >
                  Required
                </span>
              ) : (
                <span
                  data-intake-optional-chip
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    background: "#f1f5f9",
                    color: "#475569",
                    borderRadius: 999,
                    fontWeight: 600,
                  }}
                >
                  Optional
                </span>
              )}
              <StatusChip status={d.status} />
            </div>
            {d.description ? (
              <p
                style={{
                  margin: "0 0 6px",
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "#334155",
                }}
              >
                {d.description}
              </p>
            ) : null}
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                fontSize: 12,
                color: "#475569",
              }}
            >
              <CountRequirement
                fulfilledCount={d.fulfilledCount}
                minCount={d.minCount}
                maxCount={d.maxCount}
              />
              <span data-intake-accepted-kinds>
                Accepts: {acceptedKinds}
              </span>
              {d.locationRequirement === "required" ? (
                <span data-intake-location-required>
                  Location capture required
                </span>
              ) : null}
              {d.captureAfterRequest ? (
                <span data-intake-capture-hint>
                  Capture fresh — do not reuse old files
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
