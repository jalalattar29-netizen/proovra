"use client";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

/**
 * Phase CASE-DETAIL-PERSONAL-UX — simplified Case Detail page for
 * Personal / Small-Business workspaces.
 *
 * Five primary tabs only: Overview, Evidence, Reports & Packages,
 * Notes, Settings. The enterprise MatterWorkspace surface (12 tabs)
 * is preserved verbatim for ENTERPRISE / investigation tier
 * workspaces; the page wrapper switches between the two based on
 * `canAccessSurface("/investigation")`.
 *
 * Hard rules:
 *   - NO new backend endpoints. Every action wires to an existing
 *     route from the audit:
 *       GET    /v1/cases/:id                          — header
 *       GET    /v1/cases/:id/matter-workspace          — body (evidence, comments, status, etc.)
 *       GET    /v1/cases/:id/available-evidence        — Add evidence picker
 *       POST   /v1/cases/:id/evidence    body {evidenceId}        — Attach
 *       DELETE /v1/cases/:id/evidence/:evidenceId       — Remove from case (unlink, NEVER deletes)
 *       PATCH  /v1/cases/:id             body {name}              — Rename
 *       POST   /v1/cases/:id/status      body {toStatus, reason?} — Change status / Close / Reopen / Archive
 *       DELETE /v1/cases/:id                                       — Delete (OWNER-only, legal-hold-gated)
 *       POST   /v1/cases/:id/comments    body {body, visibility?}  — Add note
 *       POST   /v1/cases/:id/comments/:commentId/resolve            — Resolve note
 *   - Attach + delete + status change all run through the existing
 *     backend guards (`evaluateCrossTeamAttach`, `gateCaseMutation`,
 *     legal-hold check). The UI is just the spec's polished veneer.
 *   - "Delete case" never deletes preserved evidence — the backend
 *     `DELETE /v1/cases/:id` unlinks evidence by NULLing `caseId`,
 *     evidence rows survive.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { apiFetch } from "../../../lib/api";
import { Button, useToast } from "../../ui";
// Phase 7B (visual-only) — canonical shared design-system primitives.
// PageShell/PageHeader/PageSection from the barrel; Card / EmptyState /
// Badge DEEP-imported (barrel serves the LEGACY four). The existing
// legacy `Button` + `useToast` barrel import above is kept unchanged.
import { PageShell, PageHeader, PageSection } from "../../ui";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
// Phase CASE-DETAIL-PERSONAL-UX — canonical confirmation hook. The
// repo-wide Phase Final-D3 contract forbids raw `window.confirm` in
// apps/web; this is the parity replacement.
import { useConfirmAction } from "../../ui/ConfirmActionModal";
// Phase CASES-EVIDENCE-NAMES — reuse the canonical Evidence Library
// title cascade so Case Detail rows never render "Untitled evidence"
// when filename fields exist on the record.
import { getDisplayTitle } from "../../../app/(app)/evidence/lib/evidence-library-status";
import type {
  MatterWorkspaceCaseHeader,
  MatterWorkspaceEnvelope,
} from "../types";
import {
  CASE_STATUS_OPTIONS,
  caseStatusLabel,
  deriveNeedsAttention,
  formatRelative,
  summariseDeliverables,
} from "./helpers";

type TabId = "overview" | "evidence" | "reports" | "notes" | "settings";

const TAB_ORDER: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "reports", label: "Reports & Packages" },
  { id: "notes", label: "Notes" },
  { id: "settings", label: "Settings" },
];

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      caseDetail: MatterWorkspaceCaseHeader;
      workspace: MatterWorkspaceEnvelope;
      isReloading?: boolean;
    }
  | { status: "auth_error" }
  | { status: "not_found" }
  | { status: "unavailable"; message: string };

export function SimpleCaseDetail({
  caseId,
  onOpenEvidence,
}: {
  caseId: string;
  onOpenEvidence: (evidenceId: string) => void;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  // Single confirmation provider hook reused by both destructive
  // flows (remove-from-case + delete-case). Mounted at the
  // ConfirmActionProvider that lives in app/providers.tsx. MUST be
  // called unconditionally (React rules of hooks) — the consumer
  // tabs receive `confirm` via prop drilling.
  const { confirm } = useConfirmAction();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  // Phase CASES-ATTACH-PICKER — `attachOpen` lives at page level so
  // the single header "Add evidence" button can open the dialog
  // from any tab. The previous implementation kept this state
  // inside `EvidenceTab`, which left the header button effectively
  // dead unless the user happened to already be on the Evidence
  // tab. Lifting state also lets us remove the duplicate Add
  // buttons that lived in the tab body + empty state.
  const [attachOpen, setAttachOpen] = useState(false);

  const reload = useCallback(async () => {
    setState((prev) =>
      prev.status === "ready"
        ? { ...prev, isReloading: true }
        : { status: "loading" },
    );
    try {
      // matter-workspace already includes the case header (name,
      // status, dates, owner, description) — no need to also hit
      // /v1/cases/:id. That saves one round-trip and one auth check.
      const workspaceRes = (await apiFetch(
        `/v1/cases/${caseId}/matter-workspace`,
      )) as MatterWorkspaceEnvelope;
      setState({
        status: "ready",
        caseDetail: workspaceRes.case,
        workspace: workspaceRes,
      });
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      if (e.statusCode === 401) {
        setState({ status: "auth_error" });
      } else if (e.statusCode === 404) {
        setState({ status: "not_found" });
      } else {
        setState({
          status: "unavailable",
          message: "Unable to load the case right now. Try again.",
        });
      }
    }
  }, [caseId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (state.status === "loading") {
    return (
      <PageShell className="cc-page" data-simple-case-detail-loading>
        <Card variant="summary">
          <p style={{ margin: 0, color: "var(--ink-secondary, #475569)" }}>
            Loading case…
          </p>
        </Card>
      </PageShell>
    );
  }
  if (state.status === "auth_error") {
    return (
      <PageShell className="cc-page" data-simple-case-detail-auth>
        <Card variant="status" tone="risk">
          You don&apos;t have access to this case.
        </Card>
      </PageShell>
    );
  }
  if (state.status === "not_found") {
    return (
      <PageShell className="cc-page" data-simple-case-detail-not-found>
        <EmptyState
          framed
          title="Case not found"
          purpose="The case may have been deleted or moved."
          action={
            <Link href="/cases">
              <Button variant="secondary">Back to cases</Button>
            </Link>
          }
        />
      </PageShell>
    );
  }
  if (state.status === "unavailable") {
    return (
      <PageShell className="cc-page" data-simple-case-detail-unavailable>
        <Card variant="status" tone="risk">
          {state.message}
          <div style={{ marginTop: 8 }}>
            <Button variant="secondary" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        </Card>
      </PageShell>
    );
  }

  const { caseDetail, workspace, isReloading } = state;
  const evidenceItems = workspace.sections.evidence.items ?? [];
  const caseComments = workspace.sections.notes?.caseComments ?? [];
  const deliverables = summariseDeliverables(workspace);
  const needsAttention = deriveNeedsAttention(workspace);
  const viewer = workspace.viewer;

  return (
    <PageShell
      className="cc-page"
      data-simple-case-detail
      data-case-id={caseDetail.id}
      data-case-status={caseDetail.status}
    >
      <SimpleCaseHeader
        caseDetail={caseDetail}
        evidenceCount={evidenceItems.length}
        isReloading={Boolean(isReloading)}
        canLinkEvidence={viewer.canLinkEvidence}
        linkEvidenceDisabledReason={viewer.disabledReasons.linkEvidence}
        onAddEvidence={() => setAttachOpen(true)}
      />

      <nav
        className="cc-tabs"
        role="tablist"
        aria-label="Case sections"
        data-simple-case-tabs
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.09))",
          marginBottom: 4,
        }}
      >
        {TAB_ORDER.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-simple-case-tab={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "8px 14px",
                border: "none",
                background: "transparent",
                fontSize: 13,
                fontWeight: isActive ? 650 : 500,
                color: isActive
                  ? "var(--ink-primary, #0f172a)"
                  : "var(--ink-secondary, #475569)",
                borderBottom: isActive
                  ? "2px solid var(--brand-accent, #0f172a)"
                  : "2px solid transparent",
                marginBottom: -1,
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {activeTab === "overview" ? (
        <OverviewTab
          caseDetail={caseDetail}
          evidenceCount={evidenceItems.length}
          deliverables={deliverables}
          needsAttention={needsAttention}
        />
      ) : null}
      {activeTab === "evidence" ? (
        <EvidenceTab
          caseId={caseId}
          items={evidenceItems}
          viewer={viewer}
          onOpenEvidence={onOpenEvidence}
          onReload={reload}
          addToast={addToast}
          confirm={confirm}
        />
      ) : null}
      {activeTab === "reports" ? (
        <ReportsPackagesTab
          items={evidenceItems}
          deliverables={deliverables}
          onOpenEvidence={onOpenEvidence}
        />
      ) : null}
      {activeTab === "notes" ? (
        <NotesTab
          caseId={caseId}
          comments={caseComments}
          canComment={viewer.canComment}
          canResolveComment={viewer.canResolveComment}
          viewerUserId={viewer.userId}
          onReload={reload}
          addToast={addToast}
          confirm={confirm}
        />
      ) : null}
      {activeTab === "settings" ? (
        <SettingsTab
          caseId={caseId}
          caseDetail={caseDetail}
          evidenceCount={evidenceItems.length}
          viewer={viewer}
          onReload={reload}
          onDeleted={() => router.push("/cases")}
          addToast={addToast}
          confirm={confirm}
        />
      ) : null}

      {/* Phase CASES-ATTACH-PICKER — single page-level modal mount.
          Triggered exclusively by the header "Add evidence" button
          (no duplicate triggers in the tab body or empty state). */}
      {attachOpen ? (
        <AttachEvidenceModal
          caseId={caseId}
          existingEvidenceIds={new Set(evidenceItems.map((i) => i.id))}
          onClose={() => setAttachOpen(false)}
          onAttached={async ({ succeeded, failed }) => {
            // Phase CASES-ATTACH-PICKER-MULTI — partial-success
            // aware toast. Close only when at least one row landed;
            // when EVERY row failed we keep the dialog open so the
            // user can retry without losing the selection.
            if (succeeded === 0 && failed > 0) {
              addToast(
                failed === 1
                  ? "Could not link the selected evidence record."
                  : `Could not link the ${failed} selected evidence records.`,
                "error",
              );
              return;
            }
            setAttachOpen(false);
            await reload();
            if (failed === 0) {
              addToast(
                succeeded === 1
                  ? "Evidence linked to case."
                  : `${succeeded} evidence records linked to case.`,
                "success",
              );
            } else {
              addToast(
                `${succeeded} evidence record${succeeded === 1 ? "" : "s"} linked. ${failed} could not be linked.`,
                "error",
              );
            }
          }}
          onError={(msg) => addToast(msg, "error")}
        />
      ) : null}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function SimpleCaseHeader({
  caseDetail,
  evidenceCount,
  isReloading,
  canLinkEvidence,
  linkEvidenceDisabledReason,
  onAddEvidence,
}: {
  caseDetail: MatterWorkspaceCaseHeader;
  evidenceCount: number;
  isReloading: boolean;
  canLinkEvidence: boolean;
  linkEvidenceDisabledReason: string | null | undefined;
  onAddEvidence: () => void;
}) {
  return (
    <PageHeader
      className="cc-page-header"
      data-simple-case-header
      eyebrow={
        <Link
          href="/cases"
          data-simple-case-back
          style={{ color: "inherit", textDecoration: "none" }}
        >
          ← Back to cases
        </Link>
      }
      title={<span data-simple-case-title>{caseDetail.name}</span>}
      subtitle={
        <span
          data-simple-case-subtitle
          style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
        >
          <span data-simple-case-status>
            {caseStatusLabel(caseDetail.status)}
          </span>
          <span aria-hidden>·</span>
          <span data-simple-case-evidence-count>
            {evidenceCount === 1
              ? "1 evidence record"
              : `${evidenceCount} evidence records`}
          </span>
          <span aria-hidden>·</span>
          <span data-simple-case-updated>
            Last updated {formatRelative(caseDetail.updatedAt)}
          </span>
          {isReloading ? (
            <span
              className="cc-muted"
              data-simple-case-reloading
              style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}
            >
              Updating…
            </span>
          ) : null}
        </span>
      }
      contextStrip={
        caseDetail.description ? (
          <p
            className="cc-muted"
            data-simple-case-description
            style={{
              margin: 0,
              fontSize: 13,
              color: "var(--ink-secondary, #475569)",
            }}
          >
            {caseDetail.description}
          </p>
        ) : undefined
      }
      primaryAction={
        /* Phase CASES-PERSONAL-UX-CLEANUP (Final) — the header
           now exposes ONLY the primary action ("Add evidence").
           The previous "Case settings" button duplicated the
           Settings tab and was removed per spec — clicking it
           already routed to the tab so there was no second
           destination. */
        <Button
          onClick={onAddEvidence}
          disabled={!canLinkEvidence}
          title={linkEvidenceDisabledReason ?? undefined}
          data-simple-case-action="add-evidence"
        >
          Add evidence
        </Button>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({
  caseDetail,
  evidenceCount,
  deliverables,
  needsAttention,
}: {
  caseDetail: MatterWorkspaceCaseHeader;
  evidenceCount: number;
  deliverables: ReturnType<typeof summariseDeliverables>;
  needsAttention: ReturnType<typeof deriveNeedsAttention>;
}) {
  return (
    <PageSection
      className="cc-section"
      role="tabpanel"
      aria-label="Overview"
      data-simple-case-overview
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      <Card
        className="cc-card"
        data-simple-case-summary
        title="Case summary"
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 8,
          }}
        >
          <SummaryCell
            label="Status"
            value={caseStatusLabel(caseDetail.status)}
          />
          <SummaryCell
            label="Evidence records"
            value={String(evidenceCount)}
          />
          <SummaryCell
            label="Reports ready"
            value={`${deliverables.reportsReady} of ${evidenceCount}`}
          />
          <SummaryCell
            label="Packages ready"
            value={`${deliverables.packagesReady} of ${evidenceCount}`}
          />
          <SummaryCell
            label="Created"
            value={formatRelative(caseDetail.createdAt)}
          />
          <SummaryCell
            label="Last updated"
            value={formatRelative(caseDetail.updatedAt)}
          />
        </div>
      </Card>

      <Card
        className="cc-card"
        data-simple-case-needs-attention
        title="What needs attention"
      >
        {needsAttention.length === 0 ? (
          <p
            className="cc-muted"
            data-simple-case-attention-empty
            style={{ margin: 0, color: "var(--ink-secondary, #475569)" }}
          >
            No open issues. Reports and packages are up to date.
          </p>
        ) : (
          <ul
            data-simple-case-attention-items
            style={{ margin: 0, paddingLeft: 18 }}
          >
            {needsAttention.map((item) => (
              <li key={item.key} data-simple-case-attention-key={item.key}>
                {item.label}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Phase CASES-PERSONAL-UX-CLEANUP — the prior CTA card
          duplicated the tab strip and was removed per spec. The
          tab bar above the Overview body is the canonical
          navigation; no second surface is needed. */}
    </PageSection>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="cc-stat-cell"
      style={{
        padding: "8px 10px",
        background: "var(--surface-muted, #f1f4f9)",
        borderRadius: "var(--radius-sm, 6px)",
      }}
    >
      <div style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
        {label}
      </div>
      <div
        style={{ fontWeight: 600, color: "var(--ink-primary, #0f172a)" }}
      >
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence tab
// ---------------------------------------------------------------------------

type ToastFn = ReturnType<typeof useToast>["addToast"];
type ConfirmFn = ReturnType<typeof useConfirmAction>["confirm"];

function EvidenceTab({
  caseId,
  items,
  viewer,
  onOpenEvidence,
  onReload,
  addToast,
  confirm,
}: {
  caseId: string;
  items: MatterWorkspaceEnvelope["sections"]["evidence"]["items"];
  viewer: MatterWorkspaceEnvelope["viewer"];
  onOpenEvidence: (evidenceId: string) => void;
  onReload: () => Promise<void>;
  addToast: ToastFn;
  confirm: ConfirmFn;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleRemove = useCallback(
    async (evidenceId: string, title: string) => {
      // Phase CASE-DETAIL-PERSONAL-UX — canonical ConfirmActionModal.
      // Spec-locked copy explicitly says the evidence record itself
      // is preserved. Backend `DELETE /v1/cases/:id/evidence/:evidenceId`
      // only NULLs caseId; never deletes evidence.
      const ok = await confirm({
        title: `Remove "${title}" from this case?`,
        description:
          "This removes the evidence from this case only. The evidence record itself will remain preserved.",
        confirmLabel: "Remove from case",
        tone: "warning",
        testId: "simple-case-evidence-remove",
      });
      if (!ok) return;
      setBusyId(evidenceId);
      try {
        await apiFetch(`/v1/cases/${caseId}/evidence/${evidenceId}`, {
          method: "DELETE",
        });
        addToast("Evidence removed from this case.", "success");
        await onReload();
      } catch (err) {
        addToast(
          toSafeUserError(err, { message: "Could not remove evidence." }).message,
          "error",
        );
      } finally {
        setBusyId(null);
      }
    },
    [caseId, onReload, addToast, confirm],
  );

  return (
    <PageSection
      className="cc-section"
      role="tabpanel"
      aria-label="Evidence"
      data-simple-case-evidence
      title={<>Evidence · {items.length}</>}
    >
      {/* Phase CASES-ATTACH-PICKER (Final) — the tab body no longer
          renders an Add-evidence button. The page header owns the
          single canonical entry point so the user can attach from
          any tab without duplicate affordances. */}
      {items.length === 0 ? (
        <div className="cc-section-note" data-simple-case-evidence-empty>
          <EmptyState
            framed
            title="No evidence linked yet."
            purpose={
              <>
                Use <em>Add evidence</em> above to link files, photos,
                videos, or documents to this case.
              </>
            }
          />
        </div>
      ) : (
        <ul
          className="cases-list"
          data-simple-case-evidence-items
          style={{ display: "grid", gap: 8, listStyle: "none", margin: 0, padding: 0 }}
        >
          {items.map((item) => (
            <li
              key={item.id}
              className="cases-row"
              data-simple-case-evidence-item={item.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                alignItems: "center",
                padding: "10px 12px",
                border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                borderRadius: "var(--radius-md, 10px)",
                background: "var(--surface-card, #ffffff)",
              }}
            >
              <div>
                <div
                  style={{ fontWeight: 600, color: "var(--ink-primary, #0f172a)" }}
                  data-simple-case-evidence-title
                >
                  {getDisplayTitle(item)}
                </div>
                <div
                  className="cc-muted"
                  style={{ fontSize: 12, display: "flex", gap: 8, color: "var(--ink-secondary, #475569)" }}
                >
                  <span>{item.type}</span>
                  <span aria-hidden>·</span>
                  <span>{item.status}</span>
                  {item.verificationStatus ? (
                    <>
                      <span aria-hidden>·</span>
                      <span data-simple-case-evidence-verification={item.verificationStatus}>
                        {item.verificationStatus.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </>
                  ) : null}
                  <span aria-hidden>·</span>
                  <span>
                    {item.reportReady ? "Report ready" : "Report missing"}
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    {item.packageReady ? "Package ready" : "Package missing"}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  variant="secondary"
                  onClick={() => onOpenEvidence(item.id)}
                  data-simple-case-evidence-open={item.id}
                >
                  Open
                </Button>
                {/* Phase CASES-PERSONAL-UX-CLEANUP — the previous
                    code disabled this button when `linkId === null`
                    (legacy `Evidence.caseId` attachment, common for
                    Personal users who never used the CaseEvidenceLink
                    table). The backend DELETE route at
                    /v1/cases/:id/evidence/:evidenceId already handles
                    both attachment paths — it unconditionally NULLs
                    `evidence.caseId` (and `teamId`). The defensive
                    disable was wrong and left personal-user evidence
                    permanently un-removable from the UI. Enable for
                    every linked evidence row; backend authorization
                    stays authoritative. */}
                <Button
                  variant="secondary"
                  disabled={
                    busyId === item.id ||
                    // Allow either the canonical or the legacy unlink
                    // permission. The DELETE route below handles both
                    // attachment paths the same way (sets
                    // `evidence.caseId = null`); the viewer.* flags
                    // are computed by the case-permission matrix so
                    // either flag being true means the user can
                    // unlink this row.
                    !(
                      viewer.canUnlinkEvidence ||
                      viewer.canUnlinkLegacyEvidence
                    )
                  }
                  title={
                    viewer.disabledReasons.unlinkEvidence ??
                    viewer.disabledReasons.unlinkLegacyEvidence ??
                    undefined
                  }
                  onClick={() => void handleRemove(item.id, getDisplayTitle(item))}
                  data-simple-case-evidence-remove={item.id}
                >
                  Remove from case
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

    </PageSection>
  );
}

/**
 * Phase CASES-ATTACH-PICKER (+ MULTI) — searchable, MULTI-SELECT
 * evidence-picker dialog. Replaces the prior native <select> AND
 * the single-select v1 of this dialog. The picker:
 *
 *   - renders one row per attachable evidence record using the
 *     canonical `getDisplayTitle()` cascade (real filenames),
 *   - supports selecting MULTIPLE rows in one pass (checkbox +
 *     row-click toggle); selection persists while the user types
 *     in the search box (search only filters the visible rows),
 *   - filters client-side as the user types (the backend already
 *     scopes by owner + not-attached + not-deleted + not-archived,
 *     so the candidate set is small and client filtering keeps
 *     the UI responsive without input-focus churn),
 *   - shows informational "Report ready / missing" + "Package
 *     ready / missing" hints per row. These are NEVER eligibility
 *     conditions: a record without a report or verification
 *     package is still attachable (per phase spec — backend has no
 *     readiness filter either),
 *   - keeps the footer button disabled until at least one row is
 *     selected and shows the live count ("Link 3 selected evidence
 *     records"),
 *   - submits via the existing `POST /v1/cases/:id/evidence`
 *     attach endpoint once per selected record (the backend has
 *     no batch attach endpoint — see audit). Each request is
 *     run via `Promise.allSettled`; the parent toast handles
 *     all-ok / partial / all-failed cases.
 *   - cross-workspace attach is still blocked at the backend by
 *     `evaluateCrossTeamAttach` — frontend just sends the ids.
 */
type AttachCandidate = {
  id: string;
  title: string | null;
  displayFileName: string | null;
  originalFileName: string | null;
  mimeType: string | null;
  itemCount: number;
  type: string;
  status: string;
  verificationStatus: string | null;
  createdAt: string;
  reportReady: boolean;
  packageReady: boolean;
};

function AttachEvidenceModal({
  caseId,
  existingEvidenceIds,
  onClose,
  onAttached,
  onError,
}: {
  caseId: string;
  existingEvidenceIds: Set<string>;
  onClose: () => void;
  onAttached: (result: {
    succeeded: number;
    failed: number;
  }) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [candidates, setCandidates] = useState<AttachCandidate[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedCount = selectedIds.size;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = (await apiFetch(
          `/v1/cases/${caseId}/available-evidence`,
        )) as { items: AttachCandidate[] };
        if (cancelled) return;
        // Backend already excludes attached / deleted / archived
        // and scopes to the owner. The Set filter is a defensive
        // client-side dedupe in case stale state lingers — backend
        // stays the authority for security.
        const filtered = (res.items ?? []).filter(
          (i) => !existingEvidenceIds.has(i.id),
        );
        setCandidates(filtered);
      } catch {
        if (cancelled) return;
        onError("Could not load available evidence.");
        setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId, existingEvidenceIds, onError]);

  const trimmedQuery = query.trim().toLowerCase();
  const visibleCandidates = (candidates ?? []).filter((c) => {
    if (!trimmedQuery) return true;
    const name = getDisplayTitle(c).toLowerCase();
    const hay = [
      name,
      c.title ?? "",
      c.displayFileName ?? "",
      c.originalFileName ?? "",
      c.type,
      c.status,
      c.id,
      c.id.slice(0, 8),
    ]
      .join("\n")
      .toLowerCase();
    return hay.includes(trimmedQuery);
  });

  const handleAttach = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setBusy(true);
    const ids = Array.from(selectedIds);
    // Backend has no batch attach endpoint (audit confirmed —
    // POST /v1/cases/:id/evidence takes a single evidenceId).
    // Fire concurrently via Promise.allSettled so a single
    // rejection doesn't abort the rest; we surface partial
    // success through the parent's onAttached callback.
    const results = await Promise.allSettled(
      ids.map((evidenceId) =>
        apiFetch(`/v1/cases/${caseId}/evidence`, {
          method: "POST",
          body: JSON.stringify({ evidenceId }),
        }),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - succeeded;
    // Drop the just-attached ids from the selection so the user
    // can retry only the failed rows if they want.
    if (succeeded > 0) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        results.forEach((r, idx) => {
          if (r.status === "fulfilled") next.delete(ids[idx]);
        });
        return next;
      });
      setQuery("");
    }
    setBusy(false);
    await onAttached({ succeeded, failed });
  }, [caseId, selectedIds, onAttached]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="attach-evidence-title"
      data-simple-case-attach-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.4)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--surface-card, #ffffff)",
          padding: 20,
          borderRadius: "var(--radius-card, 14px)",
          width: "min(560px, 92vw)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "var(--shadow-elevated, 0 20px 48px rgba(15,23,42,0.18))",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="attach-evidence-title"
          style={{ margin: "0 0 4px 0", color: "var(--ink-primary, #0f172a)" }}
        >
          Link evidence to case
        </h3>
        <p
          className="cc-muted"
          style={{ margin: "0 0 12px 0", color: "var(--ink-secondary, #475569)" }}
        >
          Choose an existing evidence record from this workspace.
        </p>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search evidence by name, type, or record ID"
          aria-label="Search attachable evidence"
          data-simple-case-attach-search
          style={{
            width: "100%",
            padding: "8px 10px",
            border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
            borderRadius: "var(--radius-sm, 6px)",
            marginBottom: 12,
          }}
          disabled={busy}
        />

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
            borderRadius: "var(--radius-md, 10px)",
            minHeight: 120,
          }}
          data-simple-case-attach-list
        >
          {candidates === null ? (
            <p
              className="cc-muted"
              data-simple-case-attach-loading
              style={{ padding: 16 }}
            >
              Loading available evidence…
            </p>
          ) : candidates.length === 0 ? (
            <p
              className="cc-muted"
              data-simple-case-attach-empty-list
              style={{ padding: 16 }}
            >
              No available evidence to link. Upload or capture
              evidence first, then return to this case.
            </p>
          ) : visibleCandidates.length === 0 ? (
            <p
              className="cc-muted"
              data-simple-case-attach-no-match
              style={{ padding: 16 }}
            >
              No matching evidence found. Try a different name or
              record ID.
            </p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
              }}
            >
              {visibleCandidates.map((c) => {
                const isSelected = selectedIds.has(c.id);
                return (
                  <li
                    key={c.id}
                    data-simple-case-attach-row={c.id}
                    data-selected={isSelected ? "true" : "false"}
                    onClick={() => toggleSelected(c.id)}
                    style={{
                      padding: "10px 12px",
                      cursor: "pointer",
                      background: isSelected
                        ? "var(--status-info-bg, #eff6ff)"
                        : "transparent",
                      borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        aria-label={`Select ${getDisplayTitle(c)}`}
                        data-simple-case-attach-row-checkbox={c.id}
                        disabled={busy}
                        style={{
                          width: 16,
                          height: 16,
                          flexShrink: 0,
                          cursor: "pointer",
                          pointerEvents: "none",
                        }}
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          data-simple-case-attach-row-title
                        >
                          {getDisplayTitle(c)}
                        </div>
                        {/* Phase CASES-ATTACH-PICKER-MULTI — these
                            badges are INFORMATIONAL only. A record
                            with "Report missing" or "Package missing"
                            is still attachable; backend has no
                            readiness filter on attach. Color is
                            kept neutral muted so the badges don't
                            read as eligibility errors. */}
                        <div
                          className="cc-muted"
                          style={{
                            fontSize: 12,
                            marginTop: 2,
                            display: "flex",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <span>{c.type}</span>
                          <span aria-hidden>·</span>
                          <span>{c.status}</span>
                          <span aria-hidden>·</span>
                          <span>{c.id.slice(0, 8)}</span>
                          <span
                            data-simple-case-attach-row-report={
                              c.reportReady ? "ready" : "missing"
                            }
                            style={{ color: "#475569" }}
                          >
                            {c.reportReady ? "Report ready" : "Report missing"}
                          </span>
                          <span
                            data-simple-case-attach-row-package={
                              c.packageReady ? "ready" : "missing"
                            }
                            style={{ color: "#475569" }}
                          >
                            {c.packageReady ? "Package ready" : "Package missing"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelected(c.id);
                      }}
                      data-simple-case-attach-row-select={c.id}
                      disabled={busy}
                      style={{
                        border: "1px solid var(--status-info-border, #bfdbfe)",
                        background: isSelected
                          ? "var(--status-info-solid, #2563eb)"
                          : "var(--surface-card, #ffffff)",
                        color: isSelected
                          ? "#ffffff"
                          : "var(--status-info-fg, #1e40af)",
                        borderRadius: "var(--radius-sm, 6px)",
                        padding: "4px 10px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {isSelected ? "Selected" : "Select"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div
          style={{
            marginTop: 16,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            className="cc-muted"
            data-simple-case-attach-selected-count={selectedCount}
            style={{ fontSize: 12 }}
          >
            {selectedCount === 0
              ? "Select one or more evidence records"
              : selectedCount === 1
                ? "1 evidence record selected"
                : `${selectedCount} evidence records selected`}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleAttach()}
              disabled={selectedCount === 0 || busy}
              data-simple-case-attach-confirm
            >
              {busy
                ? "Linking…"
                : selectedCount <= 1
                  ? "Link selected evidence"
                  : `Link ${selectedCount} selected evidence records`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports & Packages tab
// ---------------------------------------------------------------------------

function ReportsPackagesTab({
  items,
  deliverables,
  onOpenEvidence,
}: {
  items: MatterWorkspaceEnvelope["sections"]["evidence"]["items"];
  deliverables: ReturnType<typeof summariseDeliverables>;
  onOpenEvidence: (evidenceId: string) => void;
}) {
  return (
    <PageSection
      className="cc-section"
      role="tabpanel"
      aria-label="Reports & Packages"
      data-simple-case-reports
    >
      <Card
        className="cc-card"
        data-simple-case-reports-summary
        title="Deliverable summary"
      >
        <p
          className="cc-muted"
          style={{ margin: 0, color: "var(--ink-secondary, #475569)" }}
        >
          {items.length === 0
            ? "Add evidence first to generate reports and verification packages."
            : `${deliverables.reportsReady} of ${items.length} evidence records have a report. ${deliverables.packagesReady} have a verification package.`}
        </p>
        {deliverables.needsAttention > 0 ? (
          <p
            className="cc-muted"
            data-simple-case-reports-hint
            style={{ marginTop: 4, color: "var(--ink-secondary, #475569)" }}
          >
            Open the evidence record to generate missing deliverables.
          </p>
        ) : null}
      </Card>

      {items.length > 0 ? (
        <ul
          className="cases-list"
          data-simple-case-reports-items
          style={{ marginTop: 12, display: "grid", gap: 8, listStyle: "none", padding: 0 }}
        >
          {items.map((item) => (
            <li
              key={item.id}
              className="cases-row"
              data-simple-case-reports-item={item.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                padding: "10px 12px",
                border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                borderRadius: "var(--radius-md, 10px)",
                background: "var(--surface-card, #ffffff)",
              }}
            >
              <div>
                <div
                  style={{ fontWeight: 600, color: "var(--ink-primary, #0f172a)" }}
                  data-simple-case-reports-title
                >
                  {getDisplayTitle(item)}
                </div>
                <div
                  className="cc-muted"
                  style={{ fontSize: 12, display: "flex", gap: 8, color: "var(--ink-secondary, #475569)" }}
                >
                  <span
                    data-simple-case-reports-state-report={
                      item.reportReady ? "ready" : "missing"
                    }
                  >
                    {item.reportReady ? "Report ready" : "Report missing"}
                  </span>
                  <span aria-hidden>·</span>
                  <span
                    data-simple-case-reports-state-package={
                      item.packageReady ? "ready" : "missing"
                    }
                  >
                    {item.packageReady ? "Package ready" : "Package missing"}
                  </span>
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={() => onOpenEvidence(item.id)}
                data-simple-case-reports-open={item.id}
              >
                Open evidence
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </PageSection>
  );
}

// ---------------------------------------------------------------------------
// Notes tab
// ---------------------------------------------------------------------------

function NotesTab({
  caseId,
  comments,
  canComment,
  canResolveComment,
  viewerUserId,
  onReload,
  addToast,
  confirm,
}: {
  caseId: string;
  comments: NonNullable<MatterWorkspaceEnvelope["sections"]["notes"]>["caseComments"];
  canComment: boolean;
  canResolveComment: boolean;
  /**
   * Phase CASES-PERSONAL-UX-CLEANUP — used to gate the per-row
   * "Delete" affordance on author-only notes. Backend
   * `DELETE /v1/cases/:id/comments/:commentId` enforces the same
   * predicate (returns 403 `comment_forbidden` otherwise); this is
   * the corresponding UI hint, not a substitute.
   */
  viewerUserId: string;
  onReload: () => Promise<void>;
  addToast: ToastFn;
  confirm: ConfirmFn;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const handleAdd = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/cases/${caseId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body, visibility: "INTERNAL" }),
      });
      setDraft("");
      await onReload();
      addToast("Note added.", "success");
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "Could not add note." }).message,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }, [caseId, draft, onReload, addToast]);

  const handleResolve = useCallback(
    async (commentId: string) => {
      setBusy(true);
      try {
        await apiFetch(`/v1/cases/${caseId}/comments/${commentId}/resolve`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        await onReload();
        addToast("Note marked as resolved.", "success");
      } catch (err) {
        addToast(
          toSafeUserError(err, { message: "Could not resolve note." }).message,
          "error",
        );
      } finally {
        setBusy(false);
      }
    },
    [caseId, onReload, addToast],
  );

  // Phase CASES-PERSONAL-UX-CLEANUP — author-only delete. Confirms
  // via the canonical ConfirmActionModal, then DELETE through the
  // new backend route. Backend re-validates author identity; this
  // hook only renders the affordance when the viewer wrote the
  // note (see the per-row `c.authorUserId === viewerUserId` check
  // below).
  const handleDelete = useCallback(
    async (commentId: string) => {
      const ok = await confirm({
        title: "Delete this note?",
        description:
          "Notes are private workspace notes. Deleting removes it from the case. Linked evidence, reports, and verification packages are not affected.",
        confirmLabel: "Delete note",
        tone: "danger",
        testId: "simple-case-notes-delete",
      });
      if (!ok) return;
      setBusy(true);
      try {
        await apiFetch(`/v1/cases/${caseId}/comments/${commentId}`, {
          method: "DELETE",
        });
        await onReload();
        addToast("Note deleted.", "success");
      } catch (err) {
        addToast(
          toSafeUserError(err, { message: "Could not delete note." }).message,
          "error",
        );
      } finally {
        setBusy(false);
      }
    },
    [caseId, onReload, addToast, confirm],
  );

  return (
    <PageSection
      className="cc-section"
      role="tabpanel"
      aria-label="Notes"
      data-simple-case-notes
    >
      <p
        className="cc-muted"
        data-simple-case-notes-boundary
        style={{ margin: "0 0 8px", color: "var(--ink-secondary, #475569)" }}
      >
        Notes are private workspace notes. They do not change the
        recorded evidence integrity state.
      </p>
      {canComment ? (
        <Card className="cc-card">
          <div style={{ display: "grid", gap: 8 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={4000}
            placeholder="Write a private note for this case"
            data-simple-case-notes-input
            rows={3}
            style={{
              width: "100%",
              padding: 8,
              borderRadius: "var(--radius-sm, 6px)",
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              onClick={() => void handleAdd()}
              disabled={!draft.trim() || busy}
              data-simple-case-notes-add
            >
              {busy ? "Adding…" : "Add note"}
            </Button>
          </div>
          </div>
        </Card>
      ) : (
        <p
          className="cc-muted"
          data-simple-case-notes-readonly
          style={{ marginTop: 8, color: "var(--ink-secondary, #475569)" }}
        >
          You don&apos;t have permission to add notes on this case.
        </p>
      )}

      {comments.length === 0 ? (
        <p
          className="cc-muted"
          data-simple-case-notes-empty
          style={{ marginTop: 12, color: "var(--ink-muted, #94a3b8)" }}
        >
          No notes yet.
        </p>
      ) : (
        <ul
          data-simple-case-notes-items
          style={{ marginTop: 12, listStyle: "none", padding: 0, display: "grid", gap: 8 }}
        >
          {comments.map((c) => (
            <li
              key={c.id}
              data-simple-case-notes-item={c.id}
              style={{
                border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                borderRadius: "var(--radius-md, 10px)",
                padding: "8px 10px",
                background: "var(--surface-card, #ffffff)",
                opacity: c.resolvedAtUtc ? 0.6 : 1,
              }}
            >
              <p
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                {c.body}
              </p>
              <div
                className="cc-muted"
                style={{
                  fontSize: 11,
                  marginTop: 4,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>
                  {formatRelative(c.createdAt)}
                  {c.resolvedAtUtc ? ` · resolved ${formatRelative(c.resolvedAtUtc)}` : ""}
                </span>
                <div style={{ display: "flex", gap: 12 }}>
                  {!c.resolvedAtUtc && canResolveComment ? (
                    <button
                      type="button"
                      onClick={() => void handleResolve(c.id)}
                      data-simple-case-notes-resolve={c.id}
                      disabled={busy}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--status-info-fg, #1e40af)",
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      Mark resolved
                    </button>
                  ) : null}
                  {c.authorUserId === viewerUserId ? (
                    <button
                      type="button"
                      onClick={() => void handleDelete(c.id)}
                      data-simple-case-notes-delete={c.id}
                      disabled={busy}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--status-risk-fg, #991b1b)",
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageSection>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function SettingsTab({
  caseId,
  caseDetail,
  evidenceCount,
  viewer,
  onReload,
  onDeleted,
  addToast,
  confirm,
}: {
  caseId: string;
  caseDetail: MatterWorkspaceCaseHeader;
  evidenceCount: number;
  viewer: MatterWorkspaceEnvelope["viewer"];
  onReload: () => Promise<void>;
  onDeleted: () => void;
  addToast: ToastFn;
  confirm: ConfirmFn;
}) {
  const [nameDraft, setNameDraft] = useState(caseDetail.name);
  const [busy, setBusy] = useState(false);
  // Settings is allowed when canMutate (rename) or canChangeStatus or canManage (delete).
  const canRename = viewer.canMutate;
  const canChangeStatus = viewer.canChangeStatus;
  // Delete is OWNER/ADMIN only at the backend — the envelope exposes
  // `canManage` which corresponds to MANAGE_SETTINGS in the
  // permission resolver (same predicate that gates the DELETE route).
  const canDelete = viewer.canManage;

  const handleRename = useCallback(async () => {
    const next = nameDraft.trim();
    if (!next || next === caseDetail.name) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/cases/${caseId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: next }),
      });
      await onReload();
      addToast("Case name updated.", "success");
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "Could not rename case." }).message,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }, [caseId, nameDraft, caseDetail.name, onReload, addToast]);

  // Phase CASES-STATUS-MANUAL — Status is exposed as one dropdown.
  // Confirmation step is owned here so a misclick on the <select>
  // never silently mutates the case. The user-visible message
  // explicitly states the change is organizational only — no
  // evidence / report / package / notes / audit-history change.
  // Backend audit logging is unchanged: every status change still
  // appends `cases.status_changed`, and ARCHIVED → OPEN still
  // appends the `cases.restored` event for analytics back-compat.
  const handleStatusChange = useCallback(
    async (toStatus: string): Promise<boolean> => {
      if (toStatus === caseDetail.status) return false;
      const ok = await confirm({
        title: "Change case status",
        description: `Change this case from ${caseStatusLabel(
          caseDetail.status,
        )} to ${caseStatusLabel(
          toStatus,
        )}? This only updates case organization. Linked evidence, reports, verification packages, notes, and audit history remain unchanged.`,
        confirmLabel: "Change status",
        tone: "neutral",
        testId: "simple-case-settings-status",
      });
      if (!ok) return false;
      setBusy(true);
      try {
        await apiFetch(`/v1/cases/${caseId}/status`, {
          method: "POST",
          body: JSON.stringify({ toStatus }),
        });
        await onReload();
        addToast("Case status updated.", "success");
        return true;
      } catch (err) {
        addToast(
          toSafeUserError(err, { message: "Could not change status." }).message,
          "error",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [caseId, caseDetail.status, onReload, addToast, confirm],
  );

  const handleDelete = useCallback(async () => {
    // Phase CASE-DETAIL-PERSONAL-UX — canonical ConfirmActionModal.
    // Copy explicitly says preserved evidence is NOT deleted. Backend
    // `DELETE /v1/cases/:id` unlinks evidence via `updateMany`
    // (caseId = null) and never deletes evidence rows.
    const ok = await confirm({
      title: "Delete this case?",
      description:
        "Deleting this case will not delete preserved evidence records. Evidence remains available in the Evidence Library unless separately archived or restricted.",
      confirmLabel: "Delete case",
      tone: "danger",
      testId: "simple-case-settings-delete",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/cases/${caseId}`, { method: "DELETE" });
      addToast("Case deleted. Evidence records were preserved.", "success");
      onDeleted();
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "Could not delete case." }).message,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }, [caseId, onDeleted, addToast, confirm]);

  return (
    <PageSection
      className="cc-section"
      role="tabpanel"
      aria-label="Settings"
      data-simple-case-settings
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      <Card className="cc-card" data-simple-case-settings-rename>
        <strong>Case name</strong>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={120}
            disabled={!canRename}
            data-simple-case-settings-name-input
            style={{
              flex: 1,
              padding: 8,
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
              borderRadius: "var(--radius-sm, 6px)",
            }}
          />
          <Button
            onClick={() => void handleRename()}
            disabled={
              !canRename ||
              busy ||
              nameDraft.trim() === caseDetail.name ||
              nameDraft.trim().length === 0
            }
            data-simple-case-settings-rename-save
          >
            Save
          </Button>
        </div>
      </Card>

      {/* Phase CASES-STATUS-MANUAL — Status is plain organizational
          metadata. One dropdown lets the user pick any status from
          any other status. Archive / Restore are no longer separate
          buttons — Archived is just one option in this list. The
          dropdown is controlled: on change we open the canonical
          confirm modal; on cancel/error the <select>'s `value` is
          driven from `caseDetail.status` so it snaps back to the
          current status without extra local state. */}
      <Card className="cc-card" data-simple-case-settings-status>
        <label
          htmlFor="simple-case-settings-status-select"
          style={{ display: "block", fontWeight: 600 }}
        >
          Case status
        </label>
        <p
          className="cc-muted"
          data-simple-case-settings-status-help
          style={{ marginTop: 4, color: "var(--ink-secondary, #475569)" }}
        >
          Use status to organize your case. This does not change
          evidence integrity, reports, packages, or retention.
        </p>
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <select
            id="simple-case-settings-status-select"
            data-simple-case-settings-status-select
            value={caseDetail.status}
            disabled={!canChangeStatus || busy}
            title={viewer.disabledReasons.changeStatus ?? undefined}
            onChange={(e) => {
              const next = e.target.value;
              // Reset the visible value immediately so a Cancel or
              // server error doesn't leave the dropdown stuck on
              // the rejected option. `value` is bound to the
              // envelope; once the change is confirmed and the
              // envelope reloads, the dropdown re-renders to the
              // new status.
              e.target.value = caseDetail.status;
              void handleStatusChange(next);
            }}
            style={{
              padding: "6px 10px",
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
              borderRadius: "var(--radius-sm, 6px)",
              minWidth: 180,
            }}
          >
            {CASE_STATUS_OPTIONS.map((opt) => (
              <option
                key={opt.value}
                value={opt.value}
                data-simple-case-settings-status-option={opt.value}
              >
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <Card className="cc-card" data-simple-case-settings-delete>
        <strong>Delete case</strong>
        <p
          className="cc-muted"
          style={{ marginTop: 4, color: "var(--ink-secondary, #475569)" }}
        >
          Deleting this case will not delete preserved evidence
          records. Evidence remains available in the Evidence Library
          unless separately archived or restricted.
          {evidenceCount > 0
            ? ` ${evidenceCount} evidence record${evidenceCount === 1 ? "" : "s"} will be unlinked from this case but kept in the library.`
            : ""}
        </p>
        <div style={{ marginTop: 6 }}>
          <Button
            variant="secondary"
            onClick={() => void handleDelete()}
            disabled={!canDelete || busy}
            data-simple-case-settings-delete-trigger
            title={
              !canDelete
                ? "Only the case owner or an admin can delete this case."
                : undefined
            }
          >
            Delete case
          </Button>
        </div>
      </Card>
    </PageSection>
  );
}
