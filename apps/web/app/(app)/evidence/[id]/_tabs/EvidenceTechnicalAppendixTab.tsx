/**
 * Phase EVIDENCE-IA-TECHNICAL — Technical Appendix tab.
 *
 * Phase 6 — the single home for advanced technical detail. Everything
 * here is collapsed by default so normal review never trips on raw
 * forensic structures. Forensic / technical auditors expand the
 * blocks they need.
 *
 * Contents (each behind its own `<details>`):
 *
 *   1. Manifest, TSA imprint, hash semantics — moved from the prior
 *      "Reviewer Audit Drilldown" block on the Integrity tab.
 *   2. Forensic event counts at report time vs now + access events
 *      after report — moved from the prior Integrity "Verification
 *      History" KeyValueGrid.
 *   3. Snapshot boundary divergence reasons — moved from the
 *      Integrity tab; the plain "Boundary updated" summary stays on
 *      Integrity, the per-reason list lives here.
 *   4. Custody chain raw mode + reason — moved from the Integrity
 *      drilldown.
 *   5. Raw trust-decision snapshot JSON — kept here as before, still
 *      collapsed by default. Now labelled "Raw technical snapshot".
 *
 * No copy here implies authenticity, court-readiness, or admissibility.
 */

"use client";

import { FileText } from "lucide-react";
import {
  KeyValueGrid,
  SectionHeading,
  type EvidenceDetailCtx,
} from "./_lib";
import {
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";

export function EvidenceTechnicalAppendixTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const { workspace, preservation, trustDecision } = ctx;

  const tm = (workspace.artifactVersions.technicalMaterials ?? {}) as {
    hashSemantics?: string | null;
    multipartManifestSha256?: string | null;
    tsaInputDigestHex?: string | null;
  };

  const consistency = workspace.artifactVersions.trustDecisionConsistency;
  const hasDivergence = consistency?.consistentWithSnapshot === false;
  const hasMultipartContext =
    tm.hashSemantics === "multipart_composite" ||
    tm.hashSemantics === "multipart_composite_legacy";

  return (
    <section
      className="evidence-detail-section"
      data-evidence-section="technical-appendix"
    >
      <div className="evidence-detail-section-header">
        <SectionHeading
          kicker="Technical Appendix · Advanced"
          title="Forensic and technical reviewer details"
          icon={FileText}
        />
      </div>
      <p
        className="evidence-detail-muted"
        style={{ marginTop: 4, marginBottom: 12, fontSize: 12.5 }}
      >
        Advanced detail for forensic or technical reviewers. None of
        this is required to use the record — click each block below to
        expand.
      </p>

      {/* 1. Manifest, TSA imprint, hash semantics */}
      <details data-evidence-technical-block="hashes" style={{ marginBottom: 8 }}>
        <summary className="evidence-detail-raw-summary">
          How verification hashes are computed
        </summary>
        <div style={{ marginTop: 8 }}>
          <KeyValueGrid
            items={[
              {
                label: "Hash semantics",
                value:
                  tm.hashSemantics === "single_file"
                    ? "Single-file SHA-256"
                    : tm.hashSemantics === "multipart_composite"
                      ? "Multipart composite (with reproducible manifest digest)"
                      : tm.hashSemantics === "multipart_composite_legacy"
                        ? "Multipart composite (legacy record — reproduce from per-part hashes in the verification package)"
                        : "Not specified",
              },
              {
                label: "Multipart manifest SHA-256",
                value: tm.multipartManifestSha256 ?? "Not applicable / not stored",
              },
              {
                label: "Time-stamp imprint (TSA accepted message imprint)",
                value: tm.tsaInputDigestHex ?? "TSA token not present",
              },
            ]}
          />
          {hasMultipartContext ? (
            <p className="evidence-detail-muted" style={{ marginTop: 8 }}>
              {PROOVRA_MULTIPART_REVIEWER_EXPLANATION}{" "}
              {PROOVRA_MULTIPART_RECOMPUTATION_NOTE}{" "}
              {PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE}
            </p>
          ) : null}
        </div>
      </details>

      {/* 2. Forensic event counts at report time vs now */}
      <details data-evidence-technical-block="event-counts" style={{ marginBottom: 8 }}>
        <summary className="evidence-detail-raw-summary">
          Event counts (forensic and access)
        </summary>
        <div style={{ marginTop: 8 }}>
          <KeyValueGrid
            items={[
              {
                label: "Forensic events at report time",
                value: String(workspace.custodyDisplayCounts.forensicAtReportGeneration),
              },
              {
                label: "Forensic events now",
                value: String(workspace.custodyDisplayCounts.currentForensicEvents),
              },
              {
                label: "Access / view events after report",
                value: String(workspace.custodyDisplayCounts.accessAfterReportGeneration),
              },
            ]}
          />
          <p className="evidence-detail-muted" style={{ marginTop: 8 }}>
            Forensic custody events are technical chain events (creation, signature,
            retention, timestamp). Access events are read-only views and downloads. The
            two are kept separate so the chain is not diluted by analytics traffic.
          </p>
        </div>
      </details>

      {/* 3. Snapshot boundary divergence reasons */}
      {hasDivergence ? (
        <details data-evidence-technical-block="divergence" style={{ marginBottom: 8 }}>
          <summary className="evidence-detail-raw-summary">
            Boundary divergence detail
          </summary>
          <div style={{ marginTop: 8 }}>
            <p>
              The trust decision shown elsewhere is sourced from the fixed snapshot
              taken at report or package generation time. The reasons below explain
              what changed later in the live state.
            </p>
            {consistency?.reasons?.length ? (
              <ul>
                {consistency.reasons.map((reason, index) => (
                  <li key={`${reason.code ?? "reason"}-${index}`}>
                    <strong>{reason.label ?? "Snapshot difference detected"}.</strong>{" "}
                    {reason.detail ?? "Review the live technical materials for the current state."}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="evidence-detail-muted">No per-reason detail recorded.</p>
            )}
          </div>
        </details>
      ) : null}

      {/* 4. Custody chain raw */}
      <details data-evidence-technical-block="custody-chain" style={{ marginBottom: 8 }}>
        <summary className="evidence-detail-raw-summary">
          Custody chain detail
        </summary>
        <div style={{ marginTop: 8 }}>
          <KeyValueGrid
            items={[
              {
                label: "Custody chain validity",
                value: preservation.custodyChain.valid
                  ? `Continuous (${preservation.custodyChain.mode})`
                  : `Review required (${preservation.custodyChain.reason ?? "unknown"})`,
              },
            ]}
          />
        </div>
      </details>

      {/* 5. Raw trust-decision snapshot JSON */}
      <details data-evidence-raw-appendix>
        <summary className="evidence-detail-raw-summary">
          Raw technical snapshot
        </summary>
        <pre className="evidence-detail-raw-block">
          {JSON.stringify(
            {
              trustDecision,
              trustDecisionConsistency: workspace.artifactVersions.trustDecisionConsistency,
              technicalMaterials: workspace.artifactVersions.technicalMaterials,
              preservationMatrix: preservation,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
