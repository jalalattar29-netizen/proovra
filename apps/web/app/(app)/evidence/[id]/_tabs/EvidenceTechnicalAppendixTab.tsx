/**
 * Phase EVIDENCE-IA-TECHNICAL — Technical Appendix tab.
 *
 * Phase 6 — the single home for advanced technical detail. Everything
 * here is collapsed by default so normal review never trips on raw
 * forensic structures. Forensic / technical auditors expand the
 * blocks they need.
 *
 * Phase EVIDENCE-TRUSTDECISION-STRUCTURED (this pass) — the raw
 * `trustDecisionSnapshot` JSON dump that previously sat at the
 * bottom of the page has been replaced by a structured
 * `TrustDecisionSummary` panel that uses the same `trustDecision`
 * object the worker generates. Reviewers now see the verdict +
 * score + per-signal rows instead of a `JSON.stringify(..., null, 2)`
 * blob. The raw JSON is GATED behind a `?debug=1` URL param so
 * support / dev can still inspect it on demand, but the production
 * UI no longer leaks the internal projection shape.
 *
 * Contents (each behind its own `<details>`):
 *
 *   1. Trust decision summary  — verdict, score, per-signal rows.
 *      Default-EXPANDED because it's the single most useful section.
 *   2. Manifest, TSA imprint, hash semantics.
 *   3. Forensic event counts at report time vs now + access events
 *      after report.
 *   4. Snapshot boundary divergence reasons.
 *   5. Custody chain raw mode + reason.
 *   6. Raw technical snapshot (DEV/SUPPORT only, behind ?debug=1).
 *
 * No copy here implies authenticity, court-readiness, or admissibility.
 */

"use client";

import { useSearchParams } from "next/navigation";
import { FileText } from "lucide-react";
import {
  KeyValueGrid,
  SectionHeading,
  type EvidenceDetailCtx,
} from "./_lib";
import { EvidenceTechnicalAppendix } from "./technical-appendix/EvidenceTechnicalAppendix";
import MediaIntelligencePanel from "../../../../../components/media-intelligence/MediaIntelligencePanel";
import {
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";

type TrustSignalForRender = {
  key: string;
  label: string;
  status: string;
  tone: string;
  points: number;
  maxPoints: number;
  summary: string;
  detail: string;
};

type TrustDecisionForRender = {
  verdictLabel?: string;
  shortLabel?: string;
  scoreLabel?: string;
  score?: number;
  maxScore?: number;
  confidenceLabel?: string;
  relianceLevel?: string;
  anchoringStatusLabel?: string;
  summary?: string;
  primaryReason?: string;
  reviewerAction?: string;
  passedSignals?: number;
  degradedSignals?: number;
  failedSignals?: number;
  signals?: TrustSignalForRender[];
};

/**
 * Phase EVIDENCE-TRUSTDECISION-STRUCTURED — structured replacement
 * for the prior raw-JSON dump. Reads the same `trustDecision`
 * object the worker generates (and the report renderer consumes)
 * and surfaces it as a verdict band + per-signal rows.
 *
 * Every signal row shows: label, status pill, points/maxPoints,
 * one-line summary, and a collapsed `<details>` with the longer
 * `detail` text. No raw JSON, no internal projection shape.
 *
 * If `trustDecision` is null/undefined the panel renders a single
 * neutral "Trust decision is not yet available" line — never an
 * empty card or a broken-looking grid.
 */
function TrustDecisionSummary({ trust }: { trust: TrustDecisionForRender | null }) {
  if (!trust || (!trust.verdictLabel && (trust.signals ?? []).length === 0)) {
    return (
      <p
        className="evidence-detail-muted"
        data-trust-summary-empty
        style={{ marginTop: 8 }}
      >
        Trust decision is not yet available for this record.
      </p>
    );
  }

  const headerRows: Array<{ label: string; value: string }> = [];
  if (trust.verdictLabel) headerRows.push({ label: "Verdict", value: trust.verdictLabel });
  if (trust.scoreLabel) headerRows.push({ label: "Score", value: trust.scoreLabel });
  if (trust.confidenceLabel) {
    headerRows.push({ label: "Confidence", value: trust.confidenceLabel });
  }
  if (trust.relianceLevel) {
    headerRows.push({ label: "Reliance level", value: capitalise(trust.relianceLevel) });
  }
  if (trust.anchoringStatusLabel) {
    headerRows.push({ label: "Anchoring", value: trust.anchoringStatusLabel });
  }

  const counts: Array<{ label: string; value: string }> = [
    { label: "Passed signals", value: String(trust.passedSignals ?? 0) },
    { label: "Degraded signals", value: String(trust.degradedSignals ?? 0) },
    { label: "Failed signals", value: String(trust.failedSignals ?? 0) },
  ];

  return (
    <div data-trust-summary>
      {headerRows.length > 0 ? <KeyValueGrid items={headerRows} /> : null}
      <div style={{ marginTop: 12 }}>
        <KeyValueGrid items={counts} />
      </div>
      {trust.primaryReason ? (
        <div className="evidence-detail-note-box" data-trust-summary-primary-reason>
          <strong>Primary reason</strong>
          <p>{trust.primaryReason}</p>
        </div>
      ) : null}
      {trust.reviewerAction ? (
        <div className="evidence-detail-note-box" data-trust-summary-reviewer-action>
          <strong>Reviewer next step</strong>
          <p>{trust.reviewerAction}</p>
        </div>
      ) : null}
      {trust.summary ? (
        <p className="evidence-detail-muted" data-trust-summary-narrative style={{ marginTop: 8 }}>
          {trust.summary}
        </p>
      ) : null}

      {(trust.signals ?? []).length > 0 ? (
        <div data-trust-summary-signals style={{ marginTop: 14 }}>
          <h3 style={{ margin: "0 0 6px 0", fontSize: 13, fontWeight: 650 }}>
            Per-signal detail
          </h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
            {(trust.signals ?? []).map((signal) => (
              <li
                key={signal.key}
                data-trust-signal-key={signal.key}
                data-trust-signal-status={signal.status}
                style={{
                  border: "1px solid rgba(15, 23, 42, 0.08)",
                  borderRadius: 6,
                  padding: "8px 10px",
                  background: "#ffffff",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <strong style={{ fontSize: 13 }}>{signal.label}</strong>
                  <span
                    data-trust-signal-pill
                    className={`evidence-detail-pill ${pillToneFromTrustTone(signal.tone)}`}
                  >
                    {humaniseStatus(signal.status)}
                  </span>
                  <span
                    className="evidence-detail-muted"
                    style={{ marginLeft: "auto", fontSize: 12 }}
                  >
                    {signal.points}/{signal.maxPoints}
                  </span>
                </div>
                {signal.summary ? (
                  <p style={{ margin: "4px 0 0 0", fontSize: 12.5, color: "#475569" }}>
                    {signal.summary}
                  </p>
                ) : null}
                {signal.detail ? (
                  <details
                    data-trust-signal-detail
                    style={{ marginTop: 4 }}
                  >
                    <summary
                      style={{
                        fontSize: 12,
                        color: "#475569",
                        cursor: "pointer",
                      }}
                    >
                      Why this status
                    </summary>
                    <p style={{ margin: "4px 0 0 0", fontSize: 12.5, color: "#334155" }}>
                      {signal.detail}
                    </p>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function humaniseStatus(status: string): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "partial":
      return "Partial";
    case "pending":
      return "Pending";
    case "missing":
      return "Missing";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function pillToneFromTrustTone(tone: string | undefined): string {
  // Map TrustDecisionTone → existing evidence-detail-pill classes.
  // Keeps the visual taxonomy consistent across the page.
  switch (tone) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "danger":
      return "danger";
    case "neutral":
    default:
      return "neutral";
  }
}

export function EvidenceTechnicalAppendixTab({
  ctx,
  onGoToCustody,
}: {
  ctx: EvidenceDetailCtx;
  onGoToCustody?: () => void;
}) {
  const { workspace, preservation, trustDecision, evidenceId } = ctx;
  // Server-projected workspace id — the same field every other panel on
  // this page uses. The frontend never derives tenancy itself.
  const mediaIntelligenceTeamId = workspace.reviewWorkflow?.teamId ?? null;
  const searchParams = useSearchParams();
  // Phase EVIDENCE-TRUSTDECISION-STRUCTURED — raw-JSON debug gate.
  // The previous always-on raw-JSON dump exposed internal projection
  // shape (signatureBase64, publicKeyPem, signingKeyId, etc.) to every
  // viewer of the page. Now it only renders when `?debug=1` is on the
  // URL, intended for PROOVRA support / dev who explicitly opted in.
  // Normal users (Personal / Small Team / Professional / Enterprise
  // Reviewer) never see it.
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

      {/* 1. Trust decision summary — structured, default-EXPANDED. */}
      <details
        data-evidence-technical-block="trust-decision-summary"
        open
        style={{ marginBottom: 8 }}
      >
        <summary className="evidence-detail-raw-summary">
          Trust decision summary
        </summary>
        <div style={{ marginTop: 8 }}>
          <TrustDecisionSummary trust={trustForRender ?? null} />
        </div>
      </details>

      {/* Enterprise Technical Evidence Context — the primary reviewer-facing
          source of truth for acquisition, device, camera/EXIF, exposure,
          location, client environment, upload session, per-part technical
          metadata, security & integrity, and custody summary. Mirrors the PDF
          report + Verification Package. Self-fetches the privacy-safe internal
          projection; location/integrity/custody come from the workspace. */}
      <EvidenceTechnicalAppendix
        evidenceId={evidenceId}
        workspace={workspace}
        onOpenCustody={onGoToCustody}
      />

      {/* 2. Manifest, TSA imprint, hash semantics */}
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

      {/* 3. Forensic event counts at report time vs now */}
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

      {/* 4. Snapshot boundary divergence reasons */}
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

      {/* 5. Custody chain raw */}
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

      {/* 6. Raw technical snapshot — DEV/SUPPORT ONLY (behind ?debug=1).
          The trust-decision summary above renders the same data in
          structured form for everyone. The raw JSON exposes the
          internal projection shape (signatureBase64, publicKeyPem,
          signingKeyId, signingKeyVersion, tsaMessageImprint, etc.) and
          is opaque to non-technical users; gating behind a query
          parameter keeps it reachable for support investigations
          without surfacing it to normal users. */}
      {showRawDebugJson ? (
        <details data-evidence-raw-appendix data-evidence-raw-debug-gated>
          <summary className="evidence-detail-raw-summary">
            Raw technical snapshot · debug
          </summary>
          <p
            className="evidence-detail-muted"
            style={{ marginTop: 4, marginBottom: 8, fontSize: 12 }}
          >
            Internal projection shape. Visible because the URL carries
            <code> ?debug=1</code>. Not intended for normal review.
          </p>
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
      ) : null}

      {/* Phase 12 Point 4 — Honest-MI operator panel. `honest-mi-decision.md`
          records this panel as the evidence-detail surface for advisory
          media-intelligence signals; it had lost its mount. Signals are
          deterministic heuristics rendered with the catalog's safe
          wording — the panel never claims extraction, authenticity, or a
          forensic finding. It renders nothing actionable without a
          server-projected workspace id. */}
      {mediaIntelligenceTeamId ? (
        <MediaIntelligencePanel
          evidenceId={evidenceId}
          teamId={mediaIntelligenceTeamId}
        />
      ) : null}
    </section>
  );
}
