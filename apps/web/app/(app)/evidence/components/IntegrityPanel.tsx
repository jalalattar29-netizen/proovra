import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { getVerificationStatusLabel } from "../lib/evidence-library-status";
import { EVIDENCE_LIBRARY_LEGAL_BOUNDARY, formatUtcDateTime, safeText } from "../lib/evidence-library-formatters";

export function IntegrityPanel({
  item,
  detail,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
}) {
  const evidence = detail.evidence;
  const intelligence = evidence?.evidenceIntelligence ?? null;
  const proof = intelligence?.verificationProof;

  return (
    <section className="evidence-library-panel">
      <div className="evidence-library-panel__header">
        <div>
          <strong>Integrity state</strong>
          <p>{EVIDENCE_LIBRARY_LEGAL_BOUNDARY}</p>
        </div>
      </div>

      <div className="evidence-library-key-grid">
        <div className="evidence-library-key-card">
          <span>Technical verification</span>
          <strong>{getVerificationStatusLabel(evidence?.verificationStatus ?? item.verificationStatus)}</strong>
          <p>
            {evidence?.recordedIntegrityVerifiedAtUtc
              ? `Recorded ${formatUtcDateTime(evidence.recordedIntegrityVerifiedAtUtc)}`
              : "No recorded integrity verification timestamp is available."}
          </p>
        </div>

        <div className="evidence-library-key-card">
          <span>Signature</span>
          <strong>
            {proof?.signatureStatus === "APPLIED"
              ? "Signature applied"
              : proof?.signatureStatus === "MISSING"
                ? "Signature not recorded"
                : "Signature state not recorded"}
          </strong>
          <p>Signature state is shown separately from recorded integrity verification status.</p>
        </div>

        <div className="evidence-library-key-card">
          <span>Timestamp</span>
          <strong>
            {proof?.tsaStatus === "RECORDED"
              ? "Timestamp recorded"
              : proof?.tsaStatus === "PENDING"
                ? "Timestamp pending"
                : proof?.tsaStatus === "FAILED"
                  ? "Timestamp failed"
                  : "Timestamp not recorded"}
          </strong>
          <p>RFC 3161 timestamping is a supporting technical signal, not a legal conclusion.</p>
        </div>

        <div className="evidence-library-key-card">
          <span>Bitcoin anchoring</span>
          <strong>
            {/* Truthful labels: "ANCHORED" alone does not mean Bitcoin
                anchoring is verified; the OTS upgrade pass attaches the
                Bitcoin transaction reference separately. The forensic-detail
                surface (verify page / verification package) carries the
                txid-aware wording. */}
            {proof?.otsStatus === "ANCHORED"
              ? "OpenTimestamps proof present; Bitcoin anchoring status should be confirmed on the public verify surface"
              : proof?.otsStatus === "PENDING"
                ? "OpenTimestamps proof present; Bitcoin anchoring pending"
                : proof?.otsStatus === "FAILED"
                  ? "OpenTimestamps anchoring failed"
                  : "OpenTimestamps not recorded"}
          </strong>
          <p>{safeText(evidence?.anchor?.provider, "Anchor provider not recorded")}</p>
        </div>

        <div className="evidence-library-key-card">
          <span>Storage protection</span>
          <strong>
            {evidence?.storage?.verified ? "Storage protection recorded" : "Protection not recorded"}
          </strong>
          <p>
            {evidence?.storage?.mode
              ? `${evidence.storage.mode}${evidence.storage.retainUntil ? ` • retain until ${formatUtcDateTime(evidence.storage.retainUntil)}` : ""}`
              : "Object Lock or legal hold details are not recorded in this view."}
          </p>
        </div>
      </div>
    </section>
  );
}
