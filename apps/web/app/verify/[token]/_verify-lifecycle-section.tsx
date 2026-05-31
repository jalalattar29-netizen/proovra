"use client";

import type { VerifyLifecycleTransparency } from "./_verify-types";

const ACCENT2 = "#12315A";
const INK = "#10201d";
const MUTED = "rgba(16, 32, 29, 0.68)";

export function VerifyLifecycleSection({
  lifecycleTransparency,
}: {
  lifecycleTransparency: VerifyLifecycleTransparency;
}) {
  return (
    <section
      data-verify-lifecycle-transparency
      data-testid="verify-lifecycle-transparency"
      style={{
        border: "1px solid rgba(11,46,39,0.16)",
        borderLeft: `5px solid ${ACCENT2}`,
        background: "rgba(11,46,39,0.035)",
        borderRadius: 18,
        padding: "14px 18px",
        marginTop: 14,
        display: "grid",
        gap: 10,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ fontSize: 14, color: INK }}>
        Evidence Lifecycle Transparency
      </strong>
      <p style={{ margin: 0, fontSize: 11, color: MUTED }}>
        Bounded governance signals from PROOVRA. No raw reasons. No
        PII. Workspace-anchored.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 8,
        }}
      >
        {lifecycleTransparency.retention ? (
          <div
            data-verify-lifecycle-section="retention"
            data-testid="verify-lifecycle-retention"
          >
            <em>Retention policy:</em>{" "}
            <code>{lifecycleTransparency.retention.policyName}</code>{" "}
            ({lifecycleTransparency.retention.years} yr)
          </div>
        ) : null}
        {lifecycleTransparency.legalHold ? (
          <div
            data-verify-lifecycle-section="legal-hold"
            data-testid="verify-lifecycle-legal-hold"
          >
            <em>Legal hold:</em>{" "}
            <code>{lifecycleTransparency.legalHold.state}</code> ·{" "}
            <code>{lifecycleTransparency.legalHold.kind}</code>
          </div>
        ) : null}
        {lifecycleTransparency.archive ? (
          <div
            data-verify-lifecycle-section="archive"
            data-testid="verify-lifecycle-archive"
          >
            <em>Archive tier:</em>{" "}
            <code>{lifecycleTransparency.archive.currentTier}</code>
          </div>
        ) : null}
        {lifecycleTransparency.transfer ? (
          <div
            data-verify-lifecycle-section="transfer"
            data-testid="verify-lifecycle-transfer"
          >
            <em>Transfer:</em>{" "}
            <code>{lifecycleTransparency.transfer.state}</code> to{" "}
            <code>{lifecycleTransparency.transfer.toOrganizationSlug}</code>
          </div>
        ) : null}
        {lifecycleTransparency.destruction ? (
          <div
            data-verify-lifecycle-section="destruction"
            data-testid="verify-lifecycle-destruction"
          >
            <em>Destruction:</em>{" "}
            <code>{lifecycleTransparency.destruction.state}</code>
            {lifecycleTransparency.destruction.certificateHashPrefix ? (
              <>
                {" "}
                ·{" "}
                <code>
                  {lifecycleTransparency.destruction.certificateHashPrefix}&hellip;
                </code>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
