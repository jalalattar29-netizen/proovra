/**
 * Phase EVIDENCE-IA-OVERVIEW — Overview tab.
 *
 * Business-facing record summary. Answers:
 *   - What is this record?
 *   - What files are included?
 *   - Is it usable?
 *
 * The hero (action buttons + status pills + legal boundary) lives in
 * the page orchestrator above all tabs. Risk signals are surfaced in
 * the "What needs attention" strip in the page orchestrator, NOT here.
 *
 * Phase 4 — metadata simplification: the prior Overview had two
 * separate panels ("Technical Review Readiness" + "Verification Proof")
 * + a separate "Record state at a glance" KeyValueGrid + a duplicated
 * "Recommended next actions" block. Consolidated into a single
 * "Record summary" panel that answers what / when / who / size.
 *
 * Phase 1 — duplication removal: "Technical review readiness" and
 * verification-status detail moved to the Integrity tab (single home
 * for verification posture). Public verification + report/package
 * status remain on the hero (top) + Artifacts tab; no longer
 * re-rendered as Overview tiles.
 */

"use client";

import { FileText } from "lucide-react";
import {
  CaptureTemplateCard,
  KeyValueGrid,
  PreviewWorkspace,
  SectionHeading,
  type EvidenceDetailCtx,
} from "./_lib";
import ExternalIntakeSourceCard from "../components/ExternalIntakeSourceCard";
import EvidenceRequestPanel from "../components/EvidenceRequestPanel";
import { GovernanceSummary } from "../../../../../components/governance/GovernanceSummary";
import { GovernanceSnapshotPanel } from "../../../../../components/operational";
import GovernanceIndicators from "../components/GovernanceIndicators";
import { EntityChipGroup } from "../../../../../components/intelligence/EntityChipGroup";

export function EvidenceOverviewTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    evidence,
    evidenceId,
    canSeeGovernance,
    canSeeIntelligence,
    canSeeIntakeLinks,
    intelligence,
    intelligenceLoaded,
    overviewMetadataItems,
    openOriginal,
    downloadOriginal,
  } = ctx;

  return (
    <>
      {canSeeGovernance ? (
        <>
          <GovernanceSummary variant="evidence" />
          <GovernanceIndicators
            evidenceId={evidenceId}
            teamId={workspace.reviewWorkflow?.teamId ?? null}
          />
          {workspace.reviewWorkflow?.teamId ? (
            <GovernanceSnapshotPanel
              evidenceId={evidenceId}
              teamId={workspace.reviewWorkflow.teamId}
            />
          ) : null}
        </>
      ) : null}
      <ExternalIntakeSourceCard evidenceId={evidenceId} />
      {canSeeIntakeLinks ? (
        <EvidenceRequestPanel
          evidenceId={evidenceId}
          teamId={workspace.reviewWorkflow?.teamId ?? null}
        />
      ) : null}
      <CaptureTemplateCard
        intakePlanJson={workspace.evidence.intakePlanJson ?? null}
        contentItems={workspace.evidence.contentItems ?? []}
      />
      {evidence.internalNotes ? (
        <section
          className="evidence-detail-section"
          data-evidence-section="capture-note"
        >
          <div className="evidence-detail-section-header">
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 650 }}>
              Capture note (private)
            </h3>
          </div>
          <p style={{ margin: "4px 0 8px 0", whiteSpace: "pre-wrap" }}>
            {evidence.internalNotes}
          </p>
          <p className="evidence-detail-muted" style={{ fontSize: 12 }}>
            Visible only inside the signed-in app. Excluded
            from public verification, the fixed PDF report, and
            the verification package.
          </p>
        </section>
      ) : null}

      <PreviewWorkspace
        workspace={workspace}
        onOpenOriginal={() => void openOriginal()}
        onDownloadOriginal={() => void downloadOriginal()}
      />

      {/* Phase 4 — single consolidated "Record summary" panel.
          Previously split across two panels + a KeyValueGrid; users
          had to read three different cards to answer "what is this
          record". The same fields land in one card now. The Review
          tab still surfaces workflow detail; the Integrity tab still
          owns verification posture. */}
      <section className="evidence-detail-section" data-evidence-section="record-summary">
        <div className="evidence-detail-section-header">
          <SectionHeading
            kicker="Record summary"
            title="At a glance"
            icon={FileText}
          />
        </div>
        <KeyValueGrid items={overviewMetadataItems} />

        {workspace.reviewDecision.nextActions.length > 0 ? (
          <div className="evidence-detail-note-box">
            <strong>Recommended next actions</strong>
            <ul className="evidence-detail-flat-list">
              {workspace.reviewDecision.nextActions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {canSeeIntelligence ? (
        <section className="evidence-detail-section">
          <div className="evidence-detail-section-header">
            <SectionHeading
              kicker="Extracted content"
              title="Entities and content summaries"
              icon={FileText}
            />
          </div>
          {!intelligenceLoaded ? (
            <p className="evidence-detail-muted">
              Loading extracted entity summary…
            </p>
          ) : (
            <>
              <EntityChipGroup
                entities={intelligence?.entities ?? []}
                emptyMessage="No entities have been extracted from this record yet."
              />
              <div
                style={{
                  marginTop: 12,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: 8,
                }}
              >
                {(intelligence?.extractedTexts ?? []).length === 0 ? (
                  <p className="evidence-detail-muted">
                    No OCR or transcript extraction has been recorded yet for
                    this record.
                  </p>
                ) : (
                  (intelligence?.extractedTexts ?? []).map((text) => (
                    <div
                      key={text.id}
                      style={{
                        border: "1px solid #e2e8f0",
                        borderRadius: 8,
                        padding: 10,
                        background: "#f8fafc",
                        fontSize: 12,
                        color: "#0f172a",
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <strong style={{ fontSize: 11, color: "#334155" }}>
                        {text.kind.replace(/_/g, " ")}
                      </strong>
                      <span style={{ color: "#475569" }}>
                        Provider: {text.provider}
                        {text.providerVersion ? ` (${text.providerVersion})` : ""}
                      </span>
                      <span style={{ color: "#475569" }}>
                        Status: {text.status}
                        {text.wordCount != null
                          ? ` · ${text.wordCount} words`
                          : ""}
                      </span>
                      {text.confidence != null ? (
                        <span style={{ color: "#475569" }}>
                          Confidence:{" "}
                          {Math.round(
                            Math.max(0, Math.min(1, text.confidence)) * 100,
                          )}
                          %
                        </span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
              {intelligence?.disclaimer ? (
                <p className="evidence-detail-muted" style={{ marginTop: 8 }}>
                  {intelligence.disclaimer}
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </>
  );
}
