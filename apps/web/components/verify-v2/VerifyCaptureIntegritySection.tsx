/**
 * Verify token page — Capture Integrity (at submission) section (CR4
 * extraction).
 *
 * Extracted VERBATIM from `apps/web/app/verify/[token]/page.tsx` to keep
 * the orchestrator under its byte-pin. ZERO behaviour change.
 *
 * Gating contract (unchanged): the full panel renders ONLY when there is
 * a POSITIVE capture-side signal (client signature, device attestation,
 * capture-side countersignature, or capture-side RFC3161/OTS). Otherwise
 * a short, reassuring Advanced details accordion is shown with human
 * wording (no terse "absent" constants). The CURRENT preservation
 * verification (trusted timestamp + blockchain anchoring) is shown
 * prominently ABOVE this and is the authoritative integrity verdict.
 * Renders nothing when the API returned no capture-trust projection.
 *
 * `typo` / `brand` are passed in from the orchestrator so the verify
 * design tokens stay single-source on the page.
 */

import type { CSSProperties } from "react";

export type VerifyCaptureTrust = {
  provenanceClassLabel: string;
  signatureVerdict: string;
  attestationVerdict: string;
  serverCountersigned: boolean;
  rfc3161Applied: boolean;
  otsApplied: boolean;
  limitations: ReadonlyArray<string>;
};

export function VerifyCaptureIntegritySection({
  captureTrust,
  typo,
  brand,
}: {
  captureTrust: VerifyCaptureTrust | null;
  typo: Record<string, CSSProperties>;
  brand: Record<string, string>;
}) {
  if (!captureTrust) return null;

  const hasPositiveCaptureSignal =
    captureTrust.signatureVerdict !== "MISSING" ||
    captureTrust.attestationVerdict !== "NOT_ATTEMPTED" ||
    captureTrust.serverCountersigned ||
    captureTrust.rfc3161Applied ||
    captureTrust.otsApplied;

  if (!hasPositiveCaptureSignal) {
    return (
      <details
        data-testid="verify-capture-trust-advanced"
        style={{
          border: "1px solid rgba(11,46,39,0.12)",
          borderRadius: 14,
          padding: "10px 14px",
        }}
      >
        <summary style={{ ...typo.small, cursor: "pointer", color: brand.ink }}>
          Advanced: capture-side integrity
        </summary>
        <div style={{ ...typo.small, fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>
          No capture-side timestamp, signature, or device attestation was
          supplied by the client for this submission. This is normal for a
          standard upload and does not reduce the recorded preservation
          integrity verdict. PROOVRA preservation timestamping and
          blockchain anchoring are shown in the verified preservation
          section above.
        </div>
      </details>
    );
  }

  return (
    <div
      data-testid="verify-capture-trust"
      role="status"
      style={{
        border: "1px solid rgba(11,46,39,0.16)",
        borderLeft: `5px solid ${brand.accent}`,
        background: "rgba(11,46,39,0.045)",
        borderRadius: 18,
        padding: 18,
        display: "grid",
        gap: 8,
      }}
    >
      <div
        data-testid="verify-capture-trust-class"
        style={{ ...typo.kicker, fontSize: 10.5, color: brand.accent }}
      >
        Capture integrity at submission — {captureTrust.provenanceClassLabel || "Unclassified"}
      </div>
      <div
        style={{ ...typo.small, fontSize: 12, color: brand.ink, opacity: 0.8 }}
      >
        This describes the integrity primitives the client supplied at
        the moment of submission. Current preservation verification is
        shown separately above and is the authoritative integrity
        verdict; it is applied by PROOVRA after submission.
      </div>
      {captureTrust.signatureVerdict !== "MISSING" ? (
        <div data-testid="verify-capture-trust-signature" style={typo.small}>
          A source signature was supplied at capture.
        </div>
      ) : (
        <div data-testid="verify-capture-trust-signature" style={{ display: "none" }} />
      )}
      {captureTrust.attestationVerdict !== "NOT_ATTEMPTED" ? (
        <div data-testid="verify-capture-trust-attestation" style={typo.small}>
          A device attestation was provided for this submission.
        </div>
      ) : (
        <div data-testid="verify-capture-trust-attestation" style={{ display: "none" }} />
      )}
      {captureTrust.rfc3161Applied || captureTrust.otsApplied ? (
        <div data-testid="verify-capture-trust-time" style={typo.small}>
          {captureTrust.rfc3161Applied
            ? "A trusted timestamp was applied at capture."
            : "OpenTimestamps anchoring was initiated at capture."}
        </div>
      ) : (
        <div data-testid="verify-capture-trust-time" style={{ display: "none" }} />
      )}
      {captureTrust.serverCountersigned ? (
        <div style={typo.small}>
          A server countersignature with trusted time was recorded at submission.
        </div>
      ) : null}
      {captureTrust.limitations.length > 0 ? (
        <ul
          data-testid="verify-capture-trust-limitations"
          style={{ ...typo.small, margin: 0, paddingLeft: 18 }}
        >
          {captureTrust.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <div data-testid="verify-capture-trust-limitations" style={{ display: "none" }} />
      )}
    </div>
  );
}
