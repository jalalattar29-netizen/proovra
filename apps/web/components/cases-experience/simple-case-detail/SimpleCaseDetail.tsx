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
 * Phase CASE-DETAIL-PROOVRA-UX (visual-only) — the surface is
 * restyled onto the PROOVRA enterprise design system shipped in
 * `cases-experience.css` (translucent `.cases-panel` outer modules,
 * `.cases-inner` inner rows, the #F3F0FF / #D8CCFF / #4F46E5 pill
 * tabs, the shared semantic `.case-status-badge`, and the
 * success/indigo/neutral `.cases-timeline-*` states). This change is
 * layout + colour only: EVERY data-* attribute, testid, API call,
 * handler, capability gate, confirm-flow, and spec-locked copy string
 * is preserved byte-for-byte from the previous revision.
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
import { PageShell } from "../../ui";
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
// Phase CASES-STATUS-LISTBOX (§22) — accessible custom status listbox
// replaces the native status dropdown in the Settings tab.
import { CaseStatusSelect } from "./CaseStatusSelect";
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

// ---------------------------------------------------------------------------
// Phase CASE-DETAIL-PROOVRA-UX — local PROOVRA button styles.
//
// The legacy shared `Button` (btn primary) renders the banned
// coral/pink gradient and the dark-glass secondary, neither of which
// belong on the light translucent `.cases-panel` surfaces. §25 of the
// spec pins the enterprise palette instead:
//   • primary   — #5B4FE8 solid, white text
//   • secondary — white + 1px rgba(79,70,229,0.18) border + #4F46E5 text
//   • text      — bare #4F46E5 label
// These are inline-styled plain <button>s so no test data-* / disabled
// predicate / handler wiring changes. The visible affordance is the
// only thing that moves.
// ---------------------------------------------------------------------------
type CaseButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "text";
};

function CaseButton({
  variant = "primary",
  disabled,
  style,
  children,
  type = "button",
  ...rest
}: CaseButtonProps) {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: 38,
    padding: variant === "text" ? "0 6px" : "0 16px",
    borderRadius: 12,
    fontSize: 13.5,
    fontWeight: 650,
    lineHeight: 1,
    whiteSpace: "nowrap",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    transition:
      "background-color 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease",
  };
  const skin: React.CSSProperties =
    variant === "primary"
      ? {
          background: "#5B4FE8",
          color: "#ffffff",
          border: "1px solid #5B4FE8",
          boxShadow: "0 6px 16px rgba(79, 70, 229, 0.20)",
        }
      : variant === "secondary"
        ? {
            background: "#ffffff",
            color: "#4F46E5",
            border: "1px solid rgba(79, 70, 229, 0.18)",
            boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
          }
        : {
            background: "transparent",
            color: "#4F46E5",
            border: "1px solid transparent",
            boxShadow: "none",
          };
  return (
    <button
      type={type}
      disabled={disabled}
      style={{ ...base, ...skin, ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

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
        <div className="cases-panel" style={{ padding: 24 }}>
          <p style={{ margin: 0, color: "#475569" }}>Loading case…</p>
        </div>
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

      {/* Phase CASE-DETAIL-PROOVRA-UX §12 — restyled pill tab bar,
          sticky beneath the app header while the body scrolls. The
          data-simple-case-tab attributes + role/aria are preserved
          exactly; only the class-driven pill visuals + `.is-active`
          state + sticky positioning are new. */}
      <nav
        className="case-tabs"
        role="tablist"
        aria-label="Case sections"
        data-simple-case-tabs
        style={{
          position: "sticky",
          top: "var(--header-h, 72px)",
          zIndex: 5,
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
              className={isActive ? "case-tab is-active" : "case-tab"}
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
          viewer={viewer}
          onAddEvidence={() => setAttachOpen(true)}
          onGoToTab={setActiveTab}
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
  const { addToast } = useToast();
  // Phase CASE-DETAIL-PROOVRA-UX §11 — structured, compact header.
  // A "Back to cases" link, a case icon + case name + a semantic
  // `.case-status-badge`, the raw case id demoted to SECONDARY
  // monospace metadata, a created/updated/owner/evidence-count
  // metadata row, and the right-aligned primary "Add evidence"
  // action. Every data-* / testid is preserved.
  return (
    <header
      data-simple-case-header
      style={{
        // §3 — grid: full-width breadcrumb row, then [content | action].
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) auto",
        alignItems: "center",
        gap: 32,
        // §3 — slightly taller context header (still not a hero) with room
        // for the in-header breadcrumb.
        padding: "22px 26px",
        minHeight: 148,
        // reserve the right side for the artwork so text never overlaps it.
        paddingRight: 300,
        borderRadius: 18,
        // §1/§5 — dark neutral base with icon-card.png as a clearly-visible
        // RIGHT-side visual at dashboard-card scale (auto 150% — not tiny,
        // not full-cover). A horizontal dark overlay keeps the left content
        // readable while the artwork carries the identity on the right.
        backgroundColor: "#111827",
        backgroundImage:
          "linear-gradient(90deg, rgba(17,24,39,0.97) 0%, rgba(17,24,39,0.90) 46%, rgba(17,24,39,0.50) 100%), url('/assets/cards/icon-card.png')",
        backgroundSize: "auto 150%",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 18px center",
        border: "1px solid rgba(255,255,255,0.08)",
        color: "#ffffff",
      }}
    >
      {/* §2/§10 — breadcrumb lives INSIDE the dark header (the external
          OperationalBreadcrumb is removed for the personal surface). It is
          the ONLY navigation: no internal "Back to cases" link. */}
      <nav
        data-simple-case-breadcrumb
        aria-label="Breadcrumb"
        style={{
          gridColumn: "1 / -1",
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 12,
          fontSize: 12,
          fontWeight: 500,
          color: "rgba(255,255,255,0.62)",
        }}
      >
        <span>Personal Space</span>
        <span aria-hidden style={{ color: "rgba(255,255,255,0.34)" }}>›</span>
        <Link
          href="/cases"
          className="cases-breadcrumb-link"
          style={{ color: "rgba(255,255,255,0.62)", textDecoration: "none" }}
        >
          Cases
        </Link>
        <span aria-hidden style={{ color: "rgba(255,255,255,0.34)" }}>›</span>
        <span aria-current="page" style={{ color: "rgba(255,255,255,0.9)" }}>
          {caseDetail.name}
        </span>
      </nav>
      {/* §4A — no internal "Back to cases" link: the breadcrumb above the
          header owns navigation (its "Cases" segment links to /cases). */}
      <div style={{ minWidth: 0, flex: "1 1 320px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              borderRadius: 9,
              background: "rgba(255,255,255,0.14)",
              border: "1px solid rgba(255,255,255,0.24)",
              color: "#ffffff",
              flexShrink: 0,
            }}
          >
            {/* Simple case/folder glyph. */}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h1
            data-simple-case-title
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 700,
              lineHeight: 1.2,
              letterSpacing: "-0.01em",
              color: "#ffffff",
              minWidth: 0,
              overflowWrap: "anywhere",
            }}
          >
            {caseDetail.name}
          </h1>
          <span
            className="case-status-badge"
            data-status={caseDetail.status}
            data-simple-case-status
          >
            {caseStatusLabel(caseDetail.status)}
          </span>
        </div>

        {/* §4B/§6 — primary metadata: the real reference number (only when
            present), evidence count, created + last-updated. The raw UUID
            is NOT shown here; it moves to a clearly-labelled, copyable
            "Case ID" technical line below. */}
        <div
          data-simple-case-subtitle
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
            marginTop: 9,
            fontSize: 12,
            color: "rgba(255,255,255,0.84)",
          }}
        >
          {caseDetail.referenceNumber ? (
            <>
              <span data-simple-case-reference style={{ fontWeight: 600 }}>
                Ref {caseDetail.referenceNumber}
              </span>
              <span aria-hidden style={{ color: "rgba(255,255,255,0.4)" }}>·</span>
            </>
          ) : null}
          <span data-simple-case-evidence-count>
            {evidenceCount === 1
              ? "1 evidence record"
              : `${evidenceCount} evidence records`}
          </span>
          <span aria-hidden style={{ color: "rgba(255,255,255,0.4)" }}>·</span>
          <span style={{ color: "rgba(255,255,255,0.62)" }}>
            Created {formatRelative(caseDetail.createdAt)}
          </span>
          <span aria-hidden style={{ color: "rgba(255,255,255,0.4)" }}>·</span>
          <span data-simple-case-updated style={{ color: "rgba(255,255,255,0.62)" }}>
            Last updated {formatRelative(caseDetail.updatedAt)}
          </span>
          {isReloading ? (
            <span
              className="cc-muted"
              data-simple-case-reloading
              style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}
            >
              Updating…
            </span>
          ) : null}
        </div>

        {/* §6 — labelled, copyable Case ID (the UUID is the DB primary key
            + the /cases/[id] route param; it doubles as the searchable
            case reference). Monospace, secondary, click-to-copy. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.5)",
            }}
          >
            Case ID
          </span>
          <button
            type="button"
            data-simple-case-id
            title="Copy case ID"
            onClick={() => {
              void navigator.clipboard?.writeText(caseDetail.id);
              addToast("Case ID copied.", "success");
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
              fontSize: 11.5,
              color: "rgba(255,255,255,0.78)",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 7,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            {caseDetail.id}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
              <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {caseDetail.description ? (
          <p
            data-simple-case-description
            style={{
              margin: "10px 0 0",
              fontSize: 13,
              lineHeight: 1.55,
              color: "rgba(255,255,255,0.78)",
              maxWidth: 720,
            }}
          >
            {caseDetail.description}
          </p>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
        }}
      >
        {/* Phase CASES-PERSONAL-UX-CLEANUP (Final) — the header
            now exposes ONLY the primary action ("Add evidence").
            The previous "Case settings" button duplicated the
            Settings tab and was removed per spec — clicking it
            already routed to the tab so there was no second
            destination. */}
        {/* §2 — on the dark header the primary action becomes a light/
            white enterprise button that stays readable over the image. */}
        <CaseButton
          onClick={onAddEvidence}
          disabled={!canLinkEvidence}
          title={linkEvidenceDisabledReason ?? undefined}
          data-simple-case-action="add-evidence"
          style={{
            background: "#ffffff",
            color: "#1F2450",
            border: "1px solid rgba(255,255,255,0.85)",
            boxShadow: "0 6px 16px rgba(15,23,42,0.24)",
          }}
        >
          Add evidence
        </CaseButton>
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
  viewer,
  onAddEvidence,
  onGoToTab,
}: {
  caseDetail: MatterWorkspaceCaseHeader;
  evidenceCount: number;
  deliverables: ReturnType<typeof summariseDeliverables>;
  needsAttention: ReturnType<typeof deriveNeedsAttention>;
  viewer: MatterWorkspaceEnvelope["viewer"];
  onAddEvidence: () => void;
  onGoToTab: (tab: TabId) => void;
}) {
  // Real, envelope-only KPI values (§13). Lighter than Home's dark
  // KPI cards — restrained `.cases-inner` tiles.
  const verificationLinks = deliverables.packagesReady;
  const kpis: Array<{ label: string; value: string; hint: string }> = [
    {
      label: "Evidence records",
      value: String(evidenceCount),
      hint: "Linked to this case",
    },
    {
      label: "End-to-end ready",
      value: `${deliverables.reportsReady + deliverables.packagesReady === 0 ? 0 : Math.min(deliverables.reportsReady, deliverables.packagesReady)} of ${evidenceCount}`,
      hint: "Report + package present",
    },
    {
      label: "Reports",
      value: `${deliverables.reportsReady} of ${evidenceCount}`,
      hint: "Records with a report",
    },
    {
      label: "Verification links",
      value: `${verificationLinks} of ${evidenceCount}`,
      hint: "Records with a package",
    },
  ];

  // Definition-list summary (§14) — real fields only. Priority /
  // classification / tags / workspace are surfaced only when the
  // envelope actually carries them (never fabricated).
  const summaryRows: Array<{ label: string; value: string }> = [
    { label: "Status", value: caseStatusLabel(caseDetail.status) },
    {
      label: "Priority",
      value: caseDetail.priority
        ? caseDetail.priority.charAt(0) +
          caseDetail.priority.slice(1).toLowerCase()
        : "—",
    },
    {
      label: "Reference",
      value: caseDetail.referenceNumber ?? "—",
    },
    { label: "Created", value: formatRelative(caseDetail.createdAt) },
    { label: "Last updated", value: formatRelative(caseDetail.updatedAt) },
  ];

  return (
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Overview"
      data-simple-case-overview
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(240px, 320px)",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* Main column */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        {/* KPI tiles (§13) */}
        <div className="cases-panel" data-simple-case-summary style={{ padding: 16 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 10,
            }}
          >
            {kpis.map((kpi) => (
              <div
                key={kpi.label}
                className="cases-inner"
                style={{ padding: "12px 14px" }}
              >
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    letterSpacing: "-0.01em",
                    color: "#172033",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {kpi.value}
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "#475569",
                    marginTop: 2,
                  }}
                >
                  {kpi.label}
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>
                  {kpi.hint}
                </div>
              </div>
            ))}
          </div>

          {/* Case summary definition list (§14) — subtle separators,
              not a bordered box per value. */}
          <dl
            style={{
              margin: "16px 0 0",
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 0,
            }}
          >
            {summaryRows.length === 0 ? (
              <p style={{ margin: 0, color: "#64748b", fontSize: 13 }}>
                No case summary added.
              </p>
            ) : (
              summaryRows.map((row, idx) => (
                <div
                  key={row.label}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 16,
                    padding: "9px 2px",
                    borderTop:
                      idx === 0
                        ? "none"
                        : "1px solid rgba(15, 23, 42, 0.055)",
                    fontSize: 13,
                  }}
                >
                  <dt style={{ color: "#64748b", margin: 0 }}>{row.label}</dt>
                  <dd
                    style={{
                      color: "#172033",
                      fontWeight: 600,
                      margin: 0,
                      textAlign: "right",
                    }}
                  >
                    {row.value}
                  </dd>
                </div>
              ))
            )}
          </dl>
        </div>

        {/* What needs attention (§15) */}
        <div
          className="cases-panel"
          data-simple-case-needs-attention
          style={{ padding: 16 }}
        >
          <h2
            style={{
              margin: "0 0 10px",
              fontSize: 14,
              fontWeight: 700,
              color: "#172033",
            }}
          >
            What needs attention
          </h2>
          {evidenceCount === 0 ? (
            // Compact, actionable empty state (§15) — not a big white
            // card. Keeps the attention-empty testid.
            <div
              className="cases-inner"
              data-simple-case-attention-empty
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "12px 14px",
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650, color: "#172033", fontSize: 13.5 }}>
                  No evidence linked yet
                </div>
                <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 2 }}>
                  Add evidence to begin building this case workspace.
                </div>
              </div>
              {/* §15 — compact, outlined secondary action with a neutral
                  (slate) plus icon, not a full-purple row. */}
              <CaseButton
                variant="secondary"
                onClick={onAddEvidence}
                disabled={!viewer.canLinkEvidence}
                title={viewer.disabledReasons.linkEvidence ?? undefined}
                style={{ height: 34, padding: "0 12px" }}
              >
                <span
                  aria-hidden
                  style={{ color: "#5F6B7D", display: "inline-flex", flexShrink: 0 }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 5v14M5 12h14"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                Add evidence
              </CaseButton>
            </div>
          ) : needsAttention.length === 0 ? (
            <p
              className="cc-muted"
              data-simple-case-attention-empty
              style={{ margin: 0, color: "#475569", fontSize: 13 }}
            >
              No open issues. Reports and packages are up to date.
            </p>
          ) : (
            <ul
              data-simple-case-attention-items
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {needsAttention.map((item) => (
                <li
                  key={item.key}
                  data-simple-case-attention-key={item.key}
                  className="cases-inner"
                  style={{
                    padding: "10px 12px",
                    fontSize: 13,
                    color: "#334155",
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: "#A86612",
                      marginTop: 6,
                      flexShrink: 0,
                    }}
                  />
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Right sidebar — quick actions only. The former Status/lifecycle
          history card was removed: the case status is already surfaced in
          the header, the Settings status selector, and the metadata row,
          and the history rows read as noise rather than a real workflow. */}
      <aside style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <div className="cases-panel" style={{ padding: 16 }}>
          <h2
            style={{
              margin: "0 0 8px",
              fontSize: 13,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "#64748b",
            }}
          >
            Quick actions
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <QuickAction
              label="Add evidence"
              onClick={onAddEvidence}
              disabled={!viewer.canLinkEvidence}
              title={viewer.disabledReasons.linkEvidence ?? undefined}
              icon="plus"
            />
            {/* §13 — state-aware. With zero evidence, report + package
                generation have no valid input, so they are DISABLED
                with a neutral muted style and an explanatory tooltip
                (not rendered as an active purple link). */}
            <QuickAction
              label="Generate report"
              onClick={() => onGoToTab("reports")}
              disabled={evidenceCount === 0}
              title={
                evidenceCount === 0
                  ? "Add evidence before generating a report."
                  : undefined
              }
              icon="doc"
            />
            <QuickAction
              label="Create verification package"
              onClick={() => onGoToTab("reports")}
              disabled={evidenceCount === 0}
              title={
                evidenceCount === 0
                  ? "A finalized evidence record is required."
                  : undefined
              }
              icon="shield"
            />
            <QuickAction
              label="Share"
              onClick={() => onGoToTab("settings")}
              icon="share"
            />
          </div>
        </div>
      </aside>
    </section>
  );
}

function QuickAction({
  label,
  onClick,
  disabled,
  title,
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  icon: "plus" | "doc" | "shield" | "share";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "9px 10px",
        border: "none",
        background: "transparent",
        borderRadius: 10,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        color: "#334155",
        fontSize: 13,
        fontWeight: 600,
        textAlign: "left",
        transition: "background-color 140ms ease",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "rgba(243, 240, 255, 0.6)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <span
        aria-hidden
        style={{ color: "#4F46E5", display: "inline-flex", flexShrink: 0 }}
      >
        <QuickActionIcon icon={icon} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      <span aria-hidden style={{ color: "#94a3b8", flexShrink: 0 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="m9 6 6 6-6 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
}

function QuickActionIcon({ icon }: { icon: "plus" | "doc" | "shield" | "share" }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (icon === "plus") {
    return (
      <svg {...common}>
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }
  if (icon === "doc") {
    return (
      <svg {...common}>
        <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M14 3v4h4" />
      </svg>
    );
  }
  if (icon === "shield") {
    return (
      <svg {...common}>
        <path d="M12 3 5 6v5c0 4 3 7 7 8 4-1 7-4 7-8V6l-7-3Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="m8 11 8-5M8 13l8 5" />
    </svg>
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
  const [search, setSearch] = useState("");

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

  const trimmed = search.trim().toLowerCase();
  const visibleItems = trimmed
    ? items.filter((item) => {
        const hay = [
          getDisplayTitle(item),
          item.type,
          item.status,
          item.id,
          item.id.slice(0, 8),
        ]
          .join("\n")
          .toLowerCase();
        return hay.includes(trimmed);
      })
    : items;

  return (
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Evidence"
      data-simple-case-evidence
    >
      {/* Phase CASES-ATTACH-PICKER (Final) — the tab body no longer
          renders an Add-evidence button. The page header owns the
          single canonical entry point so the user can attach from
          any tab without duplicate affordances. */}
      {items.length === 0 ? (
        <div
          className="cases-panel"
          data-simple-case-evidence-empty
          style={{ padding: 32 }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              textAlign: "center",
              gap: 6,
              color: "#475569",
            }}
          >
            <strong style={{ color: "#172033", fontSize: 15 }}>
              No evidence linked yet.
            </strong>
            <p style={{ margin: 0, fontSize: 13, maxWidth: "42ch" }}>
              Use <em>Add evidence</em> above to link files, photos,
              videos, or documents to this case.
            </p>
          </div>
        </div>
      ) : (
        // §18 — one `.cases-panel` container with a proper row list
        // (filename + record ID secondary + type + integrity + report
        // + package + added + quick actions). Not one card per record.
        <div className="cases-panel" style={{ padding: 8 }}>
          {/* §8 — the duplicate in-tab "Add evidence" button was removed:
              the case header owns the single canonical Add-evidence action,
              so a second primary button here was a redundant affordance.
              The search (which really filters the list client-side by
              name/type/status/record id) stays and now spans the row. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px 10px",
            }}
          >
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search linked evidence by name, type, or record ID"
              aria-label="Search linked evidence"
              data-simple-case-evidence-search
              className="cases-filter-search"
              style={{ flex: 1, height: 40 }}
            />
          </div>
          <ul
            className="cases-list"
            data-simple-case-evidence-items
          >
            {visibleItems.map((item) => (
              <li
                key={item.id}
                className="cases-row"
                data-simple-case-evidence-item={item.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 12px",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 650,
                      color: "#172033",
                      fontSize: 14,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    data-simple-case-evidence-title
                  >
                    {getDisplayTitle(item)}
                  </div>
                  <div
                    className="cc-muted"
                    style={{
                      fontSize: 12,
                      display: "flex",
                      gap: 8,
                      color: "#64748b",
                      flexWrap: "wrap",
                      alignItems: "center",
                      marginTop: 3,
                    }}
                  >
                    <span
                      style={{
                        fontFamily:
                          'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
                        fontSize: 11,
                        color: "#94a3b8",
                      }}
                    >
                      {item.id.slice(0, 8)}
                    </span>
                    <span aria-hidden>·</span>
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
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <CaseButton
                    variant="secondary"
                    onClick={() => onOpenEvidence(item.id)}
                    data-simple-case-evidence-open={item.id}
                  >
                    Open
                  </CaseButton>
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
                  <button
                    type="button"
                    className="cases-remove-action"
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
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {visibleItems.length === 0 ? (
            <p
              className="cc-muted"
              data-simple-case-evidence-no-match
              style={{ padding: "14px 12px", margin: 0, color: "#64748b", fontSize: 13 }}
            >
              No linked evidence matches your search.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * Phase CASES-ATTACH-PICKER (+ MULTI) — searchable, MULTI-SELECT
 * evidence-picker dialog. Replaces the prior native dropdown AND
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

// §18 — compact semantic pill style for the Add-evidence row metadata.
// Neutral = slate structure; success/warning use the semantic palette.
// Purple is intentionally NOT used here so no single pill dominates.
function attachBadgeStyle(
  tone: "neutral" | "success" | "warning",
): React.CSSProperties {
  const palette: Record<string, { bg: string; border: string; color: string }> = {
    neutral: {
      bg: "rgba(248,250,252,0.68)",
      border: "rgba(15,23,42,0.08)",
      color: "#5F6B7D",
    },
    success: { bg: "#EAF7F1", border: "#C7EBDD", color: "#167A5B" },
    warning: { bg: "#FFF6E5", border: "#F2D8A8", color: "#A86612" },
  };
  const p = palette[tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "1px 7px",
    borderRadius: 999,
    background: p.bg,
    border: `1px solid ${p.border}`,
    color: p.color,
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.5,
    whiteSpace: "nowrap",
  };
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
          borderRadius: 18,
          width: "min(560px, 92vw)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 60px rgba(15,23,42,0.24)",
          border: "1px solid rgba(15, 23, 42, 0.06)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="attach-evidence-title"
          style={{ margin: "0 0 4px 0", color: "#172033" }}
        >
          Link evidence to case
        </h3>
        <p
          className="cc-muted"
          style={{ margin: "0 0 12px 0", color: "#475569" }}
        >
          Choose an existing evidence record from this workspace.
        </p>

        {/* §7C — full-width 42px search with the leading icon the class
            already reserves left padding for. */}
        <div className="cases-search-field" style={{ display: "flex", width: "100%", maxWidth: "100%", marginBottom: 12 }}>
          <span aria-hidden className="cases-search-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search evidence by name, type, or record ID"
            aria-label="Search attachable evidence"
            data-simple-case-attach-search
            className="cases-filter-search"
            style={{ width: "100%", height: 42 }}
            disabled={busy}
          />
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            border: "1px solid rgba(15, 23, 42, 0.08)",
            borderRadius: 12,
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
                    onMouseEnter={(e) => {
                      if (!isSelected)
                        e.currentTarget.style.background =
                          "rgba(248,250,252,0.78)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected)
                        e.currentTarget.style.background = "transparent";
                    }}
                    style={{
                      padding: "10px 12px",
                      cursor: "pointer",
                      // §18 — subtle selected row (not a saturated fill);
                      // unselected transparent; hover a faint slate wash.
                      background: isSelected
                        ? "rgba(243,240,255,0.56)"
                        : "transparent",
                      borderLeft: isSelected
                        ? "2px solid rgba(126,107,255,0.55)"
                        : "2px solid transparent",
                      borderBottom: "1px solid rgba(15,23,42,0.06)",
                      boxShadow: isSelected
                        ? "inset 0 0 0 1px rgba(126,107,255,0.24)"
                        : "none",
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
                          title={getDisplayTitle(c)}
                          style={{
                            fontWeight: 600,
                            color: "#172033",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          data-simple-case-attach-row-title
                        >
                          {getDisplayTitle(c)}
                        </div>
                        {/* §18 + Phase CASES-ATTACH-PICKER-MULTI — line 2
                            is type + short record ID (mono) + integrity +
                            report + package as compact semantic badges
                            (not all purple). The report / package badges
                            are INFORMATIONAL only: a record with "Report
                            missing" / "Package missing" is still
                            attachable (backend has no readiness filter),
                            so they render in neutral slate `#475569` — not
                            a colour that reads as an eligibility error. */}
                        <div
                          className="cc-muted"
                          style={{
                            fontSize: 12,
                            marginTop: 4,
                            display: "flex",
                            gap: 6,
                            flexWrap: "wrap",
                            alignItems: "center",
                          }}
                        >
                          <span style={attachBadgeStyle("neutral")}>{c.type}</span>
                          <span
                            style={{
                              ...attachBadgeStyle("neutral"),
                              fontFamily:
                                'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
                            }}
                          >
                            {c.id.slice(0, 8)}
                          </span>
                          {c.verificationStatus ? (
                            <span
                              style={attachBadgeStyle(
                                c.verificationStatus === "FAILED" ||
                                  c.verificationStatus === "REVIEW_REQUIRED"
                                  ? "warning"
                                  : "success",
                              )}
                            >
                              {c.verificationStatus
                                .replace(/_/g, " ")
                                .toLowerCase()}
                            </span>
                          ) : null}
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
                    {/* §18 — the redundant filled "Selected" pill is
                        gone; selection is shown by the checkbox + the
                        subtle selected-row wash. This affordance is kept
                        (testid + toggle wiring) but demoted to a subtle
                        text toggle so it no longer competes with the
                        primary footer CTA. */}
                    {/* §1/§7B — for an already-linked (selected) record the
                        action is destructive removal → shared danger class.
                        For an unselected record it is a neutral "Select". */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelected(c.id);
                      }}
                      data-simple-case-attach-row-select={c.id}
                      aria-pressed={isSelected}
                      disabled={busy}
                      className={isSelected ? "cases-remove-action" : undefined}
                      style={
                        isSelected
                          ? { flexShrink: 0 }
                          : {
                              border: "none",
                              background: "transparent",
                              color: "#8793A6",
                              borderRadius: 8,
                              padding: "4px 10px",
                              cursor: "pointer",
                              fontSize: 12.5,
                              fontWeight: 600,
                              flexShrink: 0,
                            }
                      }
                    >
                      {isSelected ? "Remove" : "Select"}
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
            <CaseButton variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </CaseButton>
            <CaseButton
              onClick={() => void handleAttach()}
              disabled={selectedCount === 0 || busy}
              data-simple-case-attach-confirm
            >
              {busy
                ? "Linking…"
                : selectedCount <= 1
                  ? "Link selected evidence"
                  : `Link ${selectedCount} selected evidence records`}
            </CaseButton>
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
  // §19 — compact deliverable metrics (real values from the envelope
  // only). "Pending" = records missing a report; "Failed" = records
  // whose verificationStatus signals an integrity failure.
  const reportsReady = deliverables.reportsReady;
  const packagesReady = deliverables.packagesReady;
  const pending = items.filter((i) => !i.reportReady || !i.packageReady).length;
  const failed = items.filter(
    (i) =>
      i.verificationStatus === "FAILED" ||
      i.verificationStatus === "REVIEW_REQUIRED",
  ).length;

  const metrics: Array<{ label: string; value: number; tone: string }> = [
    { label: "Reports ready", value: reportsReady, tone: "#167A5B" },
    { label: "Packages ready", value: packagesReady, tone: "#167A5B" },
    { label: "Pending", value: pending, tone: "#A86612" },
    { label: "Failed", value: failed, tone: "#B9383E" },
  ];

  return (
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Reports & Packages"
      data-simple-case-reports
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      <div
        className="cases-panel"
        data-simple-case-reports-summary
        style={{ padding: 16 }}
      >
        <p
          className="cc-muted"
          style={{ margin: 0, color: "#475569", fontSize: 13 }}
        >
          {items.length === 0
            ? "Add evidence first to generate reports and verification packages."
            : `${deliverables.reportsReady} of ${items.length} evidence records have a report. ${deliverables.packagesReady} have a verification package.`}
        </p>
        {deliverables.needsAttention > 0 ? (
          <p
            className="cc-muted"
            data-simple-case-reports-hint
            style={{ marginTop: 6, color: "#475569", fontSize: 13 }}
          >
            Open the evidence record to generate missing deliverables.
          </p>
        ) : null}
        {items.length > 0 ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 10,
              marginTop: 14,
            }}
          >
            {metrics.map((m) => (
              <div
                key={m.label}
                className="cases-inner"
                style={{ padding: "10px 12px" }}
              >
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    color: m.tone,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {m.value}
                </div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                  {m.label}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {items.length > 0 ? (
        <div className="cases-panel" style={{ padding: 8 }}>
          <div
            style={{
              padding: "8px 12px 10px",
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "#64748b",
            }}
          >
            Reports &amp; verification packages
          </div>
          <ul className="cases-list" data-simple-case-reports-items>
            {items.map((item) => (
              <li
                key={item.id}
                className="cases-row"
                data-simple-case-reports-item={item.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 12px",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 650,
                      color: "#172033",
                      fontSize: 14,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    data-simple-case-reports-title
                  >
                    {getDisplayTitle(item)}
                  </div>
                  <div
                    className="cc-muted"
                    style={{
                      fontSize: 12,
                      display: "flex",
                      gap: 8,
                      color: "#64748b",
                      marginTop: 3,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      data-simple-case-reports-state-report={
                        item.reportReady ? "ready" : "missing"
                      }
                      style={{ color: item.reportReady ? "#167A5B" : "#64748b" }}
                    >
                      {item.reportReady ? "Report ready" : "Report missing"}
                    </span>
                    <span aria-hidden>·</span>
                    <span
                      data-simple-case-reports-state-package={
                        item.packageReady ? "ready" : "missing"
                      }
                      style={{ color: item.packageReady ? "#167A5B" : "#64748b" }}
                    >
                      {item.packageReady ? "Package ready" : "Package missing"}
                    </span>
                  </div>
                </div>
                <CaseButton
                  variant="secondary"
                  onClick={() => onOpenEvidence(item.id)}
                  data-simple-case-reports-open={item.id}
                >
                  Open evidence
                </CaseButton>
              </li>
            ))}
          </ul>
        </div>
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
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Notes"
      data-simple-case-notes
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {/* §20 — header + short text, then a compact composer, then the
          notes list with a proper empty state. */}
      <div className="cases-panel" style={{ padding: 16 }}>
        <h2
          style={{
            margin: "0 0 4px",
            fontSize: 15,
            fontWeight: 700,
            color: "#172033",
          }}
        >
          Private case notes
        </h2>
        <p
          className="cc-muted"
          data-simple-case-notes-boundary
          style={{ margin: "0 0 12px", color: "#475569", fontSize: 13 }}
        >
          Notes are private workspace notes. They do not change the
          recorded evidence integrity state.
        </p>

        {canComment ? (
          <div
            className="cases-inner"
            style={{ padding: 12, display: "grid", gap: 10, background: "rgba(255,255,255,0.82)" }}
          >
            {/* §2 — share the EXACT focus/border/background treatment of
                the Case-name input by reusing `.cases-filter-search`
                (which sets outline:none + the indigo focus ring and thus
                overrides the global teal `textarea:focus-visible`
                outline). Only the multi-line shape is overridden inline. */}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={4000}
              placeholder="Write a private note for this case"
              data-simple-case-notes-input
              className="cases-filter-search"
              rows={3}
              style={{
                width: "100%",
                height: "auto",
                minHeight: 76,
                padding: "10px 12px",
                fontSize: 13.5,
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <CaseButton
                onClick={() => void handleAdd()}
                disabled={!draft.trim() || busy}
                data-simple-case-notes-add
              >
                {busy ? "Adding…" : "Add note"}
              </CaseButton>
            </div>
          </div>
        ) : (
          <p
            className="cc-muted"
            data-simple-case-notes-readonly
            style={{ margin: 0, color: "#475569", fontSize: 13 }}
          >
            You don&apos;t have permission to add notes on this case.
          </p>
        )}
      </div>

      <div className="cases-panel" style={{ padding: comments.length === 0 ? 24 : 8 }}>
        {comments.length === 0 ? (
          <div
            data-simple-case-notes-empty
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              textAlign: "center",
              gap: 4,
              color: "#64748b",
            }}
          >
            <strong style={{ color: "#172033", fontSize: 14 }}>No notes yet.</strong>
            <span style={{ fontSize: 13 }}>
              Notes you add appear here, newest activity first.
            </span>
          </div>
        ) : (
          <ul
            className="cases-list"
            data-simple-case-notes-items
          >
            {comments.map((c) => (
              <li
                key={c.id}
                className="cases-row"
                data-simple-case-notes-item={c.id}
                style={{
                  padding: "12px 12px",
                  opacity: c.resolvedAtUtc ? 0.6 : 1,
                }}
              >
                <p
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    color: "#172033",
                    fontSize: 13.5,
                    lineHeight: 1.5,
                  }}
                >
                  {c.body}
                </p>
                <div
                  className="cc-muted"
                  style={{
                    fontSize: 11,
                    marginTop: 6,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    color: "#64748b",
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
                          color: "#4F46E5",
                          cursor: "pointer",
                          fontSize: 11,
                          fontWeight: 600,
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
                          color: "#B9383E",
                          cursor: "pointer",
                          fontSize: 11,
                          fontWeight: 600,
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
      </div>
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
        toSafeUserError(err, { message: "Could not rename case." }).message,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }, [caseId, nameDraft, caseDetail.name, onReload, addToast]);

  // Phase CASES-STATUS-MANUAL — Status is exposed as one dropdown.
  // Confirmation step is owned here so a misclick on the listbox
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
    <section
      className="cc-section"
      role="tabpanel"
      aria-label="Settings"
      data-simple-case-settings
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {/* §21 — Case details */}
      <div className="cases-panel" data-simple-case-settings-rename style={{ padding: 16 }}>
        <h2
          style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: "#172033" }}
        >
          Case details
        </h2>
        <p className="cc-muted" style={{ margin: "0 0 12px", color: "#475569", fontSize: 13 }}>
          Rename this case. The name appears everywhere the case is referenced.
        </p>
        <label
          htmlFor="simple-case-settings-name-input"
          style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "#475569", marginBottom: 6 }}
        >
          Case name
        </label>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            id="simple-case-settings-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={120}
            disabled={!canRename}
            data-simple-case-settings-name-input
            className="cases-filter-search"
            style={{ flex: 1, minWidth: 0, height: 44 }}
          />
          {/* §21 — Save is DISABLED unless the name actually changed.
              Disabled style: flat lilac-grey, no shadow, not-allowed.
              Enabled style: solid #5B4FE8 (CaseButton primary default). */}
          {(() => {
            const saveDisabled =
              !canRename ||
              busy ||
              nameDraft.trim() === caseDetail.name ||
              nameDraft.trim().length === 0;
            return (
              <CaseButton
                onClick={() => void handleRename()}
                disabled={saveDisabled}
                data-simple-case-settings-rename-save
                style={{
                  height: 44,
                  ...(saveDisabled
                    ? {
                        background: "#E8E7F2",
                        color: "#9A98AA",
                        border: "1px solid #E8E7F2",
                        boxShadow: "none",
                        opacity: 1,
                      }
                    : {}),
                }}
              >
                Save
              </CaseButton>
            );
          })()}
        </div>
      </div>

      {/* Phase CASES-STATUS-MANUAL + CASES-STATUS-LISTBOX (§21/§22) —
          Status is plain organizational metadata. The native dropdown
          has been replaced by the accessible CaseStatusSelect custom
          listbox (portal-rendered, semantic dots, full keyboard). The
          control is still fully controlled by `caseDetail.status`: it
          holds no committed value of its own, so a Cancel or server
          error leaves the visible status untouched. The
          `data-simple-case-settings-status-select` testid is preserved
          on the control wrapper for the existing contract tests. */}
      <div className="cases-panel" data-simple-case-settings-status style={{ padding: 16 }}>
        <h2
          style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: "#172033" }}
        >
          Status &amp; lifecycle
        </h2>
        <span
          style={{ display: "block", fontWeight: 600, fontSize: 12.5, color: "#475569", marginTop: 8 }}
        >
          Case status
        </span>
        <p
          className="cc-muted"
          data-simple-case-settings-status-help
          style={{ marginTop: 4, marginBottom: 0, color: "#475569", fontSize: 13 }}
        >
          Use status to organize this case. Evidence integrity, reports,
          packages, custody, and retention are unchanged.
        </p>
        {/* §10 — a single status control. The current status is
            already represented by the selector trigger (dot + label), so
            the separate current-status badge that used to sit beside it
            was removed to eliminate the duplicate "Closed / Closed"
            display. The `data-simple-case-settings-status-current`
            testid moves onto the control wrapper so contract tests that
            assert the current status is surfaced still resolve. */}
        <div
          data-simple-case-settings-status-select
          data-simple-case-settings-status-current={caseDetail.status}
          style={{ marginTop: 10 }}
        >
          <CaseStatusSelect
            value={caseDetail.status}
            options={CASE_STATUS_OPTIONS}
            disabled={!canChangeStatus || busy}
            title={viewer.disabledReasons.changeStatus ?? undefined}
            onSelect={(next) => {
              // The listbox holds no committed value of its own — the
              // trigger always reflects `caseDetail.status`. Cancelling
              // the confirm or a server error therefore leaves the
              // visible status unchanged with no local-state drift; a
              // confirmed change re-renders from the reloaded envelope.
              void handleStatusChange(next);
            }}
          />
        </div>
      </div>

      {/* Danger zone — clear hierarchy separating it from the routine
          settings above (§21). */}
      <div
        className="cases-panel"
        data-simple-case-settings-delete
        style={{
          padding: 16,
          border: "1px solid #F4C8CE",
          background: "rgba(255, 241, 242, 0.35)",
        }}
      >
        <h2
          style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: "#B23442" }}
        >
          Delete case
        </h2>
        <p
          className="cc-muted"
          style={{ margin: "0 0 12px", color: "#475569", fontSize: 13, lineHeight: 1.55 }}
        >
          Deleting this case will not delete preserved evidence
          records. Evidence remains available in the Evidence Library
          unless separately archived or restricted.
          {evidenceCount > 0
            ? ` ${evidenceCount} evidence record${evidenceCount === 1 ? "" : "s"} will be unlinked from this case but kept in the library.`
            : ""}
        </p>
        {/* §21 — restrained Delete: pale danger surface + red text +
            red border, NOT a full pink fill. */}
        <CaseButton
          variant="secondary"
          onClick={() => void handleDelete()}
          disabled={!canDelete || busy}
          data-simple-case-settings-delete-trigger
          title={
            !canDelete
              ? "Only the case owner or an admin can delete this case."
              : undefined
          }
          style={{
            background: "#FFF1F2",
            color: "#B23442",
            border: "1px solid #F4C8CE",
            boxShadow: "none",
          }}
        >
          Delete case
        </CaseButton>
      </div>
    </section>
  );
}
