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

import {
  CaptureTemplateCard,
  PreviewWorkspace,
  RecordSummaryGrid,
  type EvidenceDetailCtx,
} from "./_lib";
import ExternalIntakeSourceCard from "../components/ExternalIntakeSourceCard";
import EvidenceRequestPanel from "../components/EvidenceRequestPanel";
import { GovernanceSummary } from "../../../../../components/governance/GovernanceSummary";
import { GovernanceSnapshotPanel } from "../../../../../components/operational";
import GovernanceIndicators from "../components/GovernanceIndicators";
import PublicVerifyPublicationPanel from "../components/PublicVerifyPublicationPanel";
import { EntityChipGroup } from "../../../../../components/intelligence/EntityChipGroup";

export function EvidenceOverviewTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    workspaceCaps,
    evidence,
    evidenceId,
    loadWorkspace,
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
          {/* PHASE 13 — the publication write leg. Everything else on this
              page reads publication posture; these are the only controls
              that change it (POST /v1/governance/evidence/:id/publish and
              .../unpublish). */}
          {/*
            PHASE 13 (NEW-074) — THE TENANT COMES FROM THE RECORD, NOT FROM AN
            OPTIONAL REVIEWER WORKFLOW.

            This passed `workspace.reviewWorkflow?.teamId`, which only exists
            when an EvidenceReviewWorkflow row exists: with none, the API sends
            `reviewWorkflow: { available: false, … }` carrying no `teamId` at
            all (`evidence.routes.ts` → `toWorkflowSummary`). The panel treats a
            null tenant as "not in a workspace" and renders the hard block
            "Open this record inside a workspace to change its public
            verification."

            So public-verify publication was unreachable for every evidence
            record that had never been put through reviewer workflow — even
            though the record IS in a workspace and the operator IS authorized.
            The reviewer workflow is a downstream feature, not the tenancy
            authority.

            `evidence.teamId` IS that authority — the workspace binding the
            write path computed and the column every server-side tenant check
            reads. It is already projected (`toSafeEvidence`) and already typed
            (`EvidenceRecord.teamId`). The workflow value is kept only as a
            fallback, so nothing that worked before can stop working.

            No gate is weakened: `POST /v1/governance/evidence/:id/publish`
            re-checks tenancy, entitlement and step-up server-side, and the
            panel's other three preconditions (plan inclusion, policy enabled,
            a configured verification surface) are untouched.
          */}
          <PublicVerifyPublicationPanel
            evidenceId={evidenceId}
            teamId={
              workspace.evidence.teamId ??
              workspace.reviewWorkflow?.teamId ??
              null
            }
            summary={workspace.publicVerificationSummary}
            publicVerifyIncluded={workspaceCaps?.publicVerifyIncluded ?? false}
            onChanged={loadWorkspace}
          />
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
          <h2 className="evidence-detail-section-title">Capture note (private)</h2>
          <p className="evidence-detail-capture-note">{evidence.internalNotes}</p>
          <p className="evidence-detail-muted evidence-detail-capture-note__hint">
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
        <h2 className="evidence-detail-section-title">Record Summary</h2>
        <RecordSummaryGrid items={overviewMetadataItems} />
      </section>

      {/* Recommended next actions — purple logical-start callout. Rendered
          only from the server-derived list, so it never invents guidance. */}
      {workspace.reviewDecision.nextActions.length > 0 ? (
        <section
          className="evidence-detail-next-actions"
          data-evidence-section="next-actions"
        >
          <h2 className="evidence-detail-next-actions__title">
            Recommended next actions
          </h2>
          <ul className="evidence-detail-next-actions__list">
            {workspace.reviewDecision.nextActions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {canSeeIntelligence ? (
        <section className="evidence-detail-section">
          <h2 className="evidence-detail-section-title">
            Entities and content summaries
          </h2>
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
              {/* Extraction cards use the same canonical card treatment as
                  Record Summary. The previous build styled them inline with a
                  private slate palette; that presentation is retired. */}
              <div className="evidence-detail-extract-grid">
                {(intelligence?.extractedTexts ?? []).length === 0 ? (
                  <p className="evidence-detail-muted">
                    No OCR or transcript extraction has been recorded yet for
                    this record.
                  </p>
                ) : (
                  (intelligence?.extractedTexts ?? []).map((text) => (
                    <div key={text.id} className="evidence-detail-extract-card">
                      <span className="evidence-detail-extract-card__kind">
                        {text.kind.replace(/_/g, " ")}
                      </span>
                      <span className="evidence-detail-extract-card__line">
                        Provider: {text.provider}
                        {text.providerVersion ? ` (${text.providerVersion})` : ""}
                      </span>
                      <span className="evidence-detail-extract-card__line">
                        Status: {text.status}
                        {text.wordCount != null
                          ? ` · ${text.wordCount} words`
                          : ""}
                      </span>
                      {text.confidence != null ? (
                        <span className="evidence-detail-extract-card__line">
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
                <p className="evidence-detail-muted evidence-detail-extract-disclaimer">
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
