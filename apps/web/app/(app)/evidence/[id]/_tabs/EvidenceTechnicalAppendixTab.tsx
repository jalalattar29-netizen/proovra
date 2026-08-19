/**
 * Phase EVIDENCE-IA-TECHNICAL — Technical Appendix tab.
 *
 * Phase 6 — the single home for advanced technical detail. Everything except
 * the trust decision is collapsed by default so normal review never trips on
 * raw forensic structures; technical auditors expand what they need.
 *
 * Phase EVIDENCE-TRUSTDECISION-STRUCTURED — the raw `trustDecisionSnapshot`
 * JSON dump that used to sit at the bottom was replaced by a structured
 * summary built from the same `trustDecision` object the worker generates.
 * The raw JSON is GATED behind `?debug=1` so support can still inspect it,
 * but the production UI no longer leaks the internal projection shape.
 *
 * Phase EVIDENCE-DETAIL-REDESIGN — presentation only. Every disclosure on
 * this tab now uses ONE anatomy (TechnicalDisclosure) and the decision
 * presentation moved into its own file, so the orchestrator orchestrates
 * instead of carrying ~250 lines of inline-styled markup. No technical value
 * is re-derived, re-thresholded or re-interpreted here.
 *
 * Live modules, in order:
 *   1. Trust decision summary + per-signal detail (default-expanded)
 *   2. Technical Evidence Context — the ten context cards
 *   3. How verification hashes are computed
 *   4. Event counts (forensic and access)
 *   5. Boundary divergence detail (only when a divergence is recorded)
 *   6. Custody chain detail
 *   7. Raw technical snapshot (DEV/SUPPORT only, behind ?debug=1)
 *   8. Media intelligence advisory panel (only with a projected workspace id)
 *
 * No copy here implies authenticity, court-readiness, or admissibility.
 */

"use client";

import { useSearchParams } from "next/navigation";
import { FileText } from "lucide-react";
import { type EvidenceDetailCtx } from "./_lib";
import { EvidenceTechnicalAppendix } from "./technical-appendix/EvidenceTechnicalAppendix";
import { TechnicalDisclosure } from "./technical-appendix/TechnicalDisclosure";
import {
  TrustDecisionSummary,
  type TrustDecisionForRender,
} from "./technical-appendix/TrustDecisionSummary";
import { MetadataRows } from "./technical-appendix/MetadataRow";
import MediaIntelligencePanel from "../../../../../components/media-intelligence/MediaIntelligencePanel";
import {
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";

export function EvidenceTechnicalAppendixTab({
  ctx,
  onGoToCustody,
}: {
  ctx: EvidenceDetailCtx;
  onGoToCustody?: () => void;
}) {
  const { workspace, preservation, trustDecision, evidenceId } = ctx;
  // Server-projected workspace id — the same field every other panel on this
  // page uses. The frontend never derives tenancy itself.
  const mediaIntelligenceTeamId = workspace.reviewWorkflow?.teamId ?? null;
  const searchParams = useSearchParams();
  // Phase EVIDENCE-TRUSTDECISION-STRUCTURED — raw-JSON debug gate. The
  // previous always-on dump exposed internal projection shape
  // (signatureBase64, publicKeyPem, signingKeyId, …) to every viewer. It now
  // renders only when `?debug=1` is on the URL, for support/dev who opted in.
  const showRawDebugJson = searchParams?.get("debug") === "1";

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

  const trustForRender = trustDecision as TrustDecisionForRender | null | undefined;

  return (
    <section
      className="evidence-detail-appendix"
      data-evidence-section="technical-appendix"
    >
      <div className="ta-intro">
        <span className="ta-intro-icon" aria-hidden="true">
          <FileText size={20} strokeWidth={2} />
        </span>
        <div className="ta-intro-copy">
          <h2 className="ta-intro-title">Technical Appendix • Advanced</h2>
          <p className="ta-intro-sub">Forensic and technical reviewer details</p>
        </div>
      </div>
      <p className="ta-lede">
        Advanced detail for forensic or technical reviewers. None of this is
        required to use the record — expand each block below for the underlying
        material.
      </p>

      {/* 1. Trust decision summary + per-signal detail. */}
      <TrustDecisionSummary trust={trustForRender ?? null} />

      {/* 2. Enterprise Technical Evidence Context — the primary
          reviewer-facing source of truth for acquisition, device, camera/EXIF,
          exposure, location, client environment, upload session, per-part
          technical metadata, security & integrity, and custody summary.
          Mirrors the PDF report + Verification Package. Self-fetches the
          privacy-safe internal projection; location/integrity/custody come
          from the workspace. */}
      <EvidenceTechnicalAppendix
        evidenceId={evidenceId}
        workspace={workspace}
        onOpenCustody={onGoToCustody}
      />

      <div className="ta-blocks">
        {/* 3. Manifest, TSA imprint, hash semantics. */}
        <TechnicalDisclosure
          title="How verification hashes are computed"
          data-evidence-technical-block="hashes"
        >
          <MetadataRows
            rows={[
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
                mono: Boolean(tm.multipartManifestSha256),
                copyable: Boolean(tm.multipartManifestSha256),
              },
              {
                label: "Time-stamp imprint (TSA accepted message imprint)",
                value: tm.tsaInputDigestHex ?? "TSA token not present",
                mono: Boolean(tm.tsaInputDigestHex),
                copyable: Boolean(tm.tsaInputDigestHex),
              },
            ]}
            empty="No hash material was recorded for this record."
          />
          {hasMultipartContext ? (
            <p className="ta-advisory">
              {PROOVRA_MULTIPART_REVIEWER_EXPLANATION}{" "}
              {PROOVRA_MULTIPART_RECOMPUTATION_NOTE}{" "}
              {PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE}
            </p>
          ) : null}
        </TechnicalDisclosure>

        {/* 4. Forensic event counts at report time vs now. */}
        <TechnicalDisclosure
          title="Event counts (forensic and access)"
          data-evidence-technical-block="event-counts"
        >
          <MetadataRows
            rows={[
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
            empty="No event counts were recorded for this record."
          />
          <p className="ta-advisory">
            Forensic custody events are technical chain events (creation,
            signature, retention, timestamp). Access events are read-only views
            and downloads. The two are kept separate so the chain is not diluted
            by analytics traffic.
          </p>
        </TechnicalDisclosure>

        {/* 5. Snapshot boundary divergence reasons. */}
        {hasDivergence ? (
          <TechnicalDisclosure
            title="Boundary divergence detail"
            data-evidence-technical-block="divergence"
          >
            <p className="ta-advisory">
              The trust decision shown elsewhere is sourced from the fixed
              snapshot taken at report or package generation time. The reasons
              below explain what changed later in the live state.
            </p>
            {consistency?.reasons?.length ? (
              <ul className="ta-reasons">
                {consistency.reasons.map((reason, index) => (
                  <li key={`${reason.code ?? "reason"}-${index}`}>
                    <strong>{reason.label ?? "Snapshot difference detected"}.</strong>{" "}
                    {reason.detail ??
                      "Review the live technical materials for the current state."}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ta-empty">No per-reason detail recorded.</p>
            )}
          </TechnicalDisclosure>
        ) : null}

        {/* 6. Custody chain raw. */}
        <TechnicalDisclosure
          title="Custody chain detail"
          data-evidence-technical-block="custody-chain"
        >
          <MetadataRows
            rows={[
              {
                label: "Custody chain validity",
                value: preservation.custodyChain.valid
                  ? `Continuous (${preservation.custodyChain.mode})`
                  : `Review required (${preservation.custodyChain.reason ?? "unknown"})`,
              },
            ]}
            empty="No custody chain state was recorded for this record."
          />
        </TechnicalDisclosure>

        {/* 7. Raw technical snapshot — DEV/SUPPORT ONLY (behind ?debug=1).
            The structured summary above renders the same data for everyone.
            The raw JSON exposes the internal projection shape
            (signatureBase64, publicKeyPem, signingKeyId, signingKeyVersion,
            tsaMessageImprint, …) and is opaque to non-technical users; gating
            it behind a query parameter keeps it reachable for support
            investigations without surfacing it to normal users. */}
        {showRawDebugJson ? (
          <TechnicalDisclosure
            title="Raw technical snapshot · debug"
            data-evidence-raw-appendix="true"
            data-evidence-raw-debug-gated="true"
          >
            <p className="ta-advisory">
              Internal projection shape. Visible because the URL carries{" "}
              <code>?debug=1</code>. Not intended for normal review.
            </p>
            <pre className="evidence-detail-raw-block">
              {JSON.stringify(
                {
                  trustDecision,
                  trustDecisionConsistency:
                    workspace.artifactVersions.trustDecisionConsistency,
                  technicalMaterials: workspace.artifactVersions.technicalMaterials,
                  preservationMatrix: preservation,
                },
                null,
                2,
              )}
            </pre>
          </TechnicalDisclosure>
        ) : null}
      </div>

      {/* 8. Phase 12 Point 4 — Honest-MI operator panel. `honest-mi-decision.md`
          records this panel as the evidence-detail surface for advisory
          media-intelligence signals. Signals are deterministic heuristics
          rendered with the catalog's safe wording — the panel never claims
          extraction, authenticity, or a forensic finding. It renders nothing
          actionable without a server-projected workspace id. */}
      {mediaIntelligenceTeamId ? (
        <MediaIntelligencePanel
          evidenceId={evidenceId}
          teamId={mediaIntelligenceTeamId}
        />
      ) : null}
    </section>
  );
}
