"use client";

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
      <main className="cc-page" data-simple-case-detail-loading>
        <div className="cc-section">Loading case…</div>
      </main>
    );
  }
  if (state.status === "auth_error") {
    return (
      <main className="cc-page" data-simple-case-detail-auth>
        <div className="cc-section">
          You don&apos;t have access to this case.
        </div>
      </main>
    );
  }
  if (state.status === "not_found") {
    return (
      <main className="cc-page" data-simple-case-detail-not-found>
        <div className="cc-section">
          <strong>Case not found</strong>
          <p>
            The case may have been deleted or moved.{" "}
            <Link href="/cases">Back to cases</Link>
          </p>
        </div>
      </main>
    );
  }
  if (state.status === "unavailable") {
    return (
      <main className="cc-page" data-simple-case-detail-unavailable>
        <div className="cc-section">
          {state.message}
          <div style={{ marginTop: 8 }}>
            <Button variant="secondary" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        </div>
      </main>
    );
  }

  const { caseDetail, workspace, isReloading } = state;
  const evidenceItems = workspace.sections.evidence.items ?? [];
  const caseComments = workspace.sections.notes?.caseComments ?? [];
  const deliverables = summariseDeliverables(workspace);
  const needsAttention = deriveNeedsAttention(workspace);
  const viewer = workspace.viewer;

  return (
    <main
      className="cc-page"
      data-simple-case-detail
      data-case-id={caseDetail.id}
      data-case-status={caseDetail.status}
    >
      <SimpleCaseHeader
        caseDetail={caseDetail}
        evidenceCount={evidenceItems.length}
        isReloading={Boolean(isReloading)}
        onAddEvidence={() => setActiveTab("evidence")}
      />

      <nav
        className="cc-tabs"
        role="tablist"
        aria-label="Case sections"
        data-simple-case-tabs
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
          marginBottom: 16,
        }}
      >
        {TAB_ORDER.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            data-simple-case-tab={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "8px 14px",
              border: "none",
              background: "transparent",
              fontWeight: activeTab === tab.id ? 600 : 400,
              borderBottom:
                activeTab === tab.id
                  ? "2px solid currentColor"
                  : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        ))}
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
    </main>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function SimpleCaseHeader({
  caseDetail,
  evidenceCount,
  isReloading,
  onAddEvidence,
}: {
  caseDetail: MatterWorkspaceCaseHeader;
  evidenceCount: number;
  isReloading: boolean;
  onAddEvidence: () => void;
}) {
  return (
    <header className="cc-page-header" data-simple-case-header>
      <div>
        <p className="cc-kicker">
          <Link href="/cases" data-simple-case-back>
            ← Back to cases
          </Link>
        </p>
        <h1 className="cc-title" data-simple-case-title>
          {caseDetail.name}
        </h1>
        <p
          className="cc-subtitle"
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
              style={{ fontSize: 12 }}
            >
              Updating…
            </span>
          ) : null}
        </p>
        {caseDetail.description ? (
          <p
            className="cc-muted"
            data-simple-case-description
            style={{ marginTop: 6 }}
          >
            {caseDetail.description}
          </p>
        ) : null}
      </div>
      <div className="cc-meta">
        {/* Phase CASES-PERSONAL-UX-CLEANUP (Final) — the header
            now exposes ONLY the primary action ("Add evidence").
            The previous "Case settings" button duplicated the
            Settings tab and was removed per spec — clicking it
            already routed to the tab so there was no second
            destination. */}
        <Button
          onClick={onAddEvidence}
          data-simple-case-action="add-evidence"
        >
          Add evidence
        </Button>
      </div>
    </header>
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
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Overview"
      data-simple-case-overview
    >
      <div
        className="cc-card"
        data-simple-case-summary
        style={{ display: "grid", gap: 8 }}
      >
        <strong>Case summary</strong>
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
      </div>

      <div
        className="cc-card"
        data-simple-case-needs-attention
        style={{ marginTop: 16 }}
      >
        <strong>What needs attention</strong>
        {needsAttention.length === 0 ? (
          <p
            className="cc-muted"
            data-simple-case-attention-empty
            style={{ marginTop: 6 }}
          >
            No open issues. Reports and packages are up to date.
          </p>
        ) : (
          <ul
            data-simple-case-attention-items
            style={{ marginTop: 6, paddingLeft: 18 }}
          >
            {needsAttention.map((item) => (
              <li key={item.key} data-simple-case-attention-key={item.key}>
                {item.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Phase CASES-PERSONAL-UX-CLEANUP — the prior CTA card
          duplicated the tab strip and was removed per spec. The
          tab bar above the Overview body is the canonical
          navigation; no second surface is needed. */}
    </section>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="cc-stat-cell"
      style={{
        padding: "8px 10px",
        background: "rgba(15, 23, 42, 0.04)",
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 12, color: "#475569" }}>{label}</div>
      <div style={{ fontWeight: 600 }}>{value}</div>
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
  const [attachOpen, setAttachOpen] = useState(false);
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
          err instanceof Error ? err.message : "Could not remove evidence.",
          "error",
        );
      } finally {
        setBusyId(null);
      }
    },
    [caseId, onReload, addToast, confirm],
  );

  return (
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Evidence"
      data-simple-case-evidence
    >
      <header
        className="cc-section-header"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <h2 className="cc-section-title">
          Evidence · {items.length}
        </h2>
        <Button
          onClick={() => setAttachOpen(true)}
          disabled={!viewer.canLinkEvidence}
          data-simple-case-attach-trigger
          title={viewer.disabledReasons.linkEvidence ?? undefined}
        >
          Add evidence
        </Button>
      </header>

      {items.length === 0 ? (
        <div
          className="cc-section-note"
          data-simple-case-evidence-empty
          style={{ padding: 16 }}
        >
          <strong>No evidence linked yet.</strong>
          <p>
            Add evidence to group related files, photos, videos, or
            documents in this case.
          </p>
          <Button
            onClick={() => setAttachOpen(true)}
            disabled={!viewer.canLinkEvidence}
            data-simple-case-attach-empty
          >
            Add evidence
          </Button>
        </div>
      ) : (
        <ul
          className="cases-list"
          data-simple-case-evidence-items
          style={{ display: "grid", gap: 8 }}
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
                border: "1px solid rgba(15, 23, 42, 0.08)",
                borderRadius: 8,
              }}
            >
              <div>
                <div
                  style={{ fontWeight: 600 }}
                  data-simple-case-evidence-title
                >
                  {getDisplayTitle(item)}
                </div>
                <div
                  className="cc-muted"
                  style={{ fontSize: 12, display: "flex", gap: 8 }}
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

      {attachOpen ? (
        <AttachEvidenceModal
          caseId={caseId}
          existingEvidenceIds={new Set(items.map((i) => i.id))}
          onClose={() => setAttachOpen(false)}
          onAttached={async () => {
            setAttachOpen(false);
            await onReload();
            addToast("Evidence added to this case.", "success");
          }}
          onError={(msg) => addToast(msg, "error")}
        />
      ) : null}
    </section>
  );
}

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
  onAttached: () => Promise<void>;
  onError: (message: string) => void;
}) {
  type Candidate = { id: string; type: string; status: string; createdAt: string };
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = (await apiFetch(
          `/v1/cases/${caseId}/available-evidence`,
        )) as { items: Candidate[] };
        if (cancelled) return;
        // Backend already excludes attached evidence (`caseId: null`
        // predicate). The Set filter is a defensive client-side
        // dedupe in case stale state lingers — backend stays the
        // authority.
        const filtered = (res.items ?? []).filter(
          (i) => !existingEvidenceIds.has(i.id),
        );
        setCandidates(filtered);
      } catch (err) {
        if (cancelled) return;
        onError(
          err instanceof Error
            ? "Could not load available evidence."
            : "Could not load available evidence.",
        );
        setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId, existingEvidenceIds, onError]);

  const handleAttach = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      // Backend enforces `evaluateCrossTeamAttach` strict same-team
      // equality. Frontend just sends the picked id.
      await apiFetch(`/v1/cases/${caseId}/evidence`, {
        method: "POST",
        body: JSON.stringify({ evidenceId: selected }),
      });
      await onAttached();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not attach evidence.");
    } finally {
      setBusy(false);
    }
  }, [caseId, selected, onAttached, onError]);

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
          background: "#fff",
          padding: 16,
          borderRadius: 8,
          minWidth: 320,
          maxWidth: 480,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="attach-evidence-title" style={{ marginTop: 0 }}>
          Add evidence to this case
        </h3>
        {candidates === null ? (
          <p>Loading…</p>
        ) : candidates.length === 0 ? (
          <p data-simple-case-attach-empty-list>
            No unassigned evidence is available in this workspace.
          </p>
        ) : (
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            data-simple-case-attach-select
            style={{ width: "100%", padding: 6 }}
          >
            <option value="">Select evidence</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.type} — {c.status} — {c.id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleAttach()}
            disabled={!selected || busy}
            data-simple-case-attach-confirm
          >
            {busy ? "Adding…" : "Add evidence"}
          </Button>
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
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Reports & Packages"
      data-simple-case-reports
    >
      <div className="cc-card" data-simple-case-reports-summary>
        <strong>Deliverable summary</strong>
        <p className="cc-muted" style={{ marginTop: 4 }}>
          {items.length === 0
            ? "Add evidence first to generate reports and verification packages."
            : `${deliverables.reportsReady} of ${items.length} evidence records have a report. ${deliverables.packagesReady} have a verification package.`}
        </p>
        {deliverables.needsAttention > 0 ? (
          <p className="cc-muted" data-simple-case-reports-hint>
            Open the evidence record to generate missing deliverables.
          </p>
        ) : null}
      </div>

      {items.length > 0 ? (
        <ul
          className="cases-list"
          data-simple-case-reports-items
          style={{ marginTop: 12, display: "grid", gap: 8 }}
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
                border: "1px solid rgba(15, 23, 42, 0.08)",
                borderRadius: 8,
              }}
            >
              <div>
                <div
                  style={{ fontWeight: 600 }}
                  data-simple-case-reports-title
                >
                  {getDisplayTitle(item)}
                </div>
                <div
                  className="cc-muted"
                  style={{ fontSize: 12, display: "flex", gap: 8 }}
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
    </section>
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
        err instanceof Error ? err.message : "Could not add note.",
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
          err instanceof Error ? err.message : "Could not resolve note.",
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
          err instanceof Error ? err.message : "Could not delete note.",
          "error",
        );
      } finally {
        setBusy(false);
      }
    },
    [caseId, onReload, addToast, confirm],
  );

  return (
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Notes"
      data-simple-case-notes
    >
      <p className="cc-muted" data-simple-case-notes-boundary>
        Notes are private workspace notes. They do not change the
        recorded evidence integrity state.
      </p>
      {canComment ? (
        <div
          className="cc-card"
          style={{ display: "grid", gap: 8, marginTop: 8 }}
        >
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
              borderRadius: 4,
              border: "1px solid rgba(15, 23, 42, 0.2)",
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
      ) : (
        <p
          className="cc-muted"
          data-simple-case-notes-readonly
          style={{ marginTop: 8 }}
        >
          You don&apos;t have permission to add notes on this case.
        </p>
      )}

      {comments.length === 0 ? (
        <p
          className="cc-muted"
          data-simple-case-notes-empty
          style={{ marginTop: 12 }}
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
                border: "1px solid rgba(15, 23, 42, 0.08)",
                borderRadius: 8,
                padding: "8px 10px",
                opacity: c.resolvedAtUtc ? 0.6 : 1,
              }}
            >
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{c.body}</p>
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
                        color: "#1e40af",
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
                        color: "#b91c1c",
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
    </section>
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
        err instanceof Error ? err.message : "Could not rename case.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }, [caseId, nameDraft, caseDetail.name, onReload, addToast]);

  const handleStatusChange = useCallback(
    async (toStatus: string) => {
      setBusy(true);
      try {
        await apiFetch(`/v1/cases/${caseId}/status`, {
          method: "POST",
          body: JSON.stringify({ toStatus }),
        });
        await onReload();
        addToast(`Case moved to ${caseStatusLabel(toStatus)}.`, "success");
      } catch (err) {
        addToast(
          err instanceof Error ? err.message : "Could not change status.",
          "error",
        );
      } finally {
        setBusy(false);
      }
    },
    [caseId, onReload, addToast],
  );

  // Phase CASES-PERSONAL-UX-CLEANUP — restore now lands the case in
  // OPEN (the personal-user mental model: Open ↔ Archived). The
  // backend state machine accepts ARCHIVED → OPEN and emits the
  // same `cases.restored` audit event. Same canonical confirm modal
  // with spec-locked copy.
  const handleRestore = useCallback(async () => {
    const ok = await confirm({
      title: "Restore Case",
      description:
        "This will return the case to the active case list. Linked evidence, reports, verification packages, comments, notes, and audit history remain unchanged.",
      confirmLabel: "Restore Case",
      tone: "neutral",
      testId: "simple-case-settings-restore",
    });
    if (!ok) return;
    await handleStatusChange("OPEN");
  }, [confirm, handleStatusChange]);

  // Phase CASES-PERSONAL-UX-CLEANUP — single Archive action wraps the
  // existing status-change mutation with toStatus: "ARCHIVED". The
  // backend now accepts this from any non-archived state, so the
  // user clicks once. Confirmation copy explains the reversibility
  // explicitly so the user understands it's not a delete.
  const handleArchive = useCallback(async () => {
    const ok = await confirm({
      title: "Archive Case",
      description:
        "This hides the case from the active list. Linked evidence, reports, verification packages, comments, notes, and audit history remain preserved and unchanged. You can restore the case from the Archived filter at any time.",
      confirmLabel: "Archive Case",
      tone: "neutral",
      testId: "simple-case-settings-archive",
    });
    if (!ok) return;
    await handleStatusChange("ARCHIVED");
  }, [confirm, handleStatusChange]);

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
        err instanceof Error ? err.message : "Could not delete case.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }, [caseId, onDeleted, addToast, confirm]);

  return (
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Settings"
      data-simple-case-settings
    >
      <div className="cc-card" data-simple-case-settings-rename>
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
              border: "1px solid rgba(15, 23, 42, 0.2)",
              borderRadius: 4,
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
      </div>

      {/* Phase CASES-PERSONAL-UX-CLEANUP — Status card now exposes
          ONLY the simplified Archive ↔ Restore toggle. The previous
          enterprise transition buttons led nowhere meaningful for
          personal/SB users and were removed per spec. The backend
          state machine still accepts every transition; intermediate
          states remain reachable for enterprise callers via the
          matter-queue / status API directly. */}
      <div
        className="cc-card"
        data-simple-case-settings-status
        style={{ marginTop: 16 }}
      >
        <strong>Status</strong>
        <p className="cc-muted" style={{ marginTop: 4 }}>
          Current status: {caseStatusLabel(caseDetail.status)}
        </p>
        <div
          style={{
            marginTop: 6,
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          {caseDetail.status === "ARCHIVED" ? (
            <Button
              onClick={() => void handleRestore()}
              disabled={!canChangeStatus || busy}
              data-simple-case-settings-status-restore
              data-simple-case-settings-status-to="OPEN"
              title={viewer.disabledReasons.changeStatus ?? undefined}
            >
              Restore Case
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => void handleArchive()}
              disabled={!canChangeStatus || busy}
              data-simple-case-settings-status-archive
              data-simple-case-settings-status-to="ARCHIVED"
              title={viewer.disabledReasons.changeStatus ?? undefined}
            >
              Archive Case
            </Button>
          )}
        </div>
      </div>

      <div
        className="cc-card"
        data-simple-case-settings-delete
        style={{ marginTop: 16 }}
      >
        <strong>Delete case</strong>
        <p className="cc-muted" style={{ marginTop: 4 }}>
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
      </div>
    </section>
  );
}
