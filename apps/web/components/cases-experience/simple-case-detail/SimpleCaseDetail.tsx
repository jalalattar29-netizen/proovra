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
 * `.cases-inner` inner rows, the #F2ECFE / #D9C7FB / #6D28D9 pill
 * tabs, the shared semantic `.app-status-badge`, and the
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

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
// CANONICAL ICON AUTHORITY. `lucide-react` is the repository's single icon
// family (the app shell, capture, marketing and settings surfaces all render
// it). Every glyph below is wrapped in an `aria-hidden` span by its caller —
// the same convention `AppSidebarV2` / `AppAccountToolbar` use — so an icon
// never leaks into an accessible name.
import { Copy, FileText, Plus, Search, Share2, ShieldCheck } from "lucide-react";

import { apiFetch } from "../../../lib/api";
import { useToast } from "../../ui";
// Phase 7B (visual-only) — canonical shared design-system primitives.
// PageShell is the repository's ONE content-plane authority; this surface
// uses its documented `width="full"` option rather than a page-specific
// shell override.
import { PageShell } from "../../ui";
// Phase CASE-DETAIL-PERSONAL-UX — canonical confirmation hook. The
// repo-wide Phase Final-D3 contract forbids raw `window.confirm` in
// apps/web; this is the parity replacement.
import { useConfirmAction } from "../../ui/ConfirmActionModal";
// Phase CASES-EVIDENCE-NAMES — reuse the canonical Evidence Library
// title cascade so Case Detail rows never render "Untitled evidence"
// when filename fields exist on the record.
import { getDisplayTitle } from "../../../app/(app)/evidence/lib/evidence-library-status";
import { CaseCopilotPanel } from "../../ai-copilot/CaseCopilotPanel";
// Phase CASES-STATUS-LISTBOX (§22) — accessible custom status listbox
// replaces the native status dropdown in the Settings tab.
import { CaseStatusSelect } from "./CaseStatusSelect";
// THE canonical dialog for this experience: portal, focus trap, Escape with
// pending-state protection, focus restoration, scroll lock and the shared
// `.app-dialog` anatomy. The Add-evidence dialog described all of that with
// inline hex styles, which is what made it the last surface still wearing the
// pre-redesign modal language.
import { Modal } from "../matter-modals/Modal";
// The one status chip. Tone is its only colour input; the row previously
// carried a private three-tone palette built by hand.
import {
  AppStatusBadge,
  type AppTone,
} from "../../app-primitives/AppStatusBadge";
// CANONICAL PRESENTATION AUTHORITIES (no component imports needed — these are
// classes, not a second component library):
//   surface / card ..... .app-panel / .app-inner-surface  (app-primitives.css)
//   buttons ............ .app-primary-action / .app-secondary-action /
//                        .app-danger-link / .app-header-primary-action
//   tabs ............... .app-tabs / .app-tab            (app-primitives.css)
//   status badge ....... .app-status-badge              (app-primitives.css)
//   search ............. .app-search-field / -icon / -input
//   empty / error ...... .app-empty                       (app-primitives.css)
//   skeleton ........... .app-skeleton                    (app-primitives.css)
//   KPI ................ .app-grid-kpis / .app-kpi-card   (app-primitives.css)
// Case-specific composition (header, split, summary list, attention panel,
// action rail, evidence rows) lives in `cases-experience.css` under
// `.case-detail-*` — the existing Case Details stylesheet, not a new one.
import type {
  MatterWorkspaceCaseHeader,
  MatterWorkspaceEnvelope,
} from "../types";
import {
  CASE_STATUS_OPTIONS,
  caseStatusLabel,
  caseStatusTone,
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
// CaseButton — a local NAME for the canonical actions, not a second button.
//
// It carries no colours, no radius, no shadow and no size of its own: each
// variant resolves to the shared `app-*-action` class defined once in
// `components/app-primitives/app-primitives.css`, which is the same authority
// behind every other internal surface. Keeping the local component preserves
// the existing call sites (and their `style` escape hatches) while leaving
// exactly ONE answer to "which button does this page use?".
// ---------------------------------------------------------------------------
type CaseButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "text";
};

const CASE_BUTTON_CLASS: Record<NonNullable<CaseButtonProps["variant"]>, string> = {
  primary: "app-primary-action",
  secondary: "app-secondary-action",
  text: "app-ghost-action",
};

function CaseButton({
  variant = "primary",
  className,
  children,
  type = "button",
  ...rest
}: CaseButtonProps) {
  return (
    <button
      type={type}
      className={[CASE_BUTTON_CLASS[variant], className].filter(Boolean).join(" ")}
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
      <CaseDetailPlane data-simple-case-detail-loading>
        <div className="app-panel app-panel__body">
          <p className="app-visually-hidden">
            Loading case…
          </p>
          <div
            className="case-detail-skel"
            role="status"
            aria-live="polite"
            aria-label="Loading case"
          >
            <span className="app-skeleton case-detail-skel-bar" />
            <span className="app-skeleton case-detail-skel-bar" />
            <span className="app-skeleton case-detail-skel-bar" />
            <span className="app-skeleton case-detail-skel-bar" />
          </div>
        </div>
      </CaseDetailPlane>
    );
  }
  if (state.status === "auth_error") {
    // RestrictedState — access is decided by the backend + PageRouteGate;
    // this only renders the outcome. No client-side authorization here.
    return (
      <CaseDetailPlane data-simple-case-detail-auth>
        <div className="app-empty" data-tone="restricted">
          <strong>You don&apos;t have access to this case.</strong>
          <p>Ask a workspace owner or administrator if you need access.</p>
        </div>
      </CaseDetailPlane>
    );
  }
  if (state.status === "not_found") {
    return (
      <CaseDetailPlane data-simple-case-detail-not-found>
        <div className="app-empty">
          <strong>Case not found</strong>
          <p>The case may have been deleted or moved.</p>
          <div className="app-empty__actions">
            <Link href="/cases" className="app-secondary-action">
              Back to cases
            </Link>
          </div>
        </div>
      </CaseDetailPlane>
    );
  }
  if (state.status === "unavailable") {
    return (
      <CaseDetailPlane data-simple-case-detail-unavailable>
        <div className="app-empty" data-tone="danger">
          <strong>Case unavailable</strong>
          <p>{state.message}</p>
          <div className="app-empty__actions">
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void reload()}
            >
              Retry
            </button>
          </div>
        </div>
      </CaseDetailPlane>
    );
  }

  const { caseDetail, workspace, isReloading } = state;
  const evidenceItems = workspace.sections.evidence.items ?? [];
  const caseComments = workspace.sections.notes?.caseComments ?? [];
  const deliverables = summariseDeliverables(workspace);
  const needsAttention = deriveNeedsAttention(workspace);
  const viewer = workspace.viewer;

  return (
    <CaseDetailPlane
      data-simple-case-detail
      data-case-id={caseDetail.id}
      data-case-status={caseDetail.status}
    >
      <CaseDetailHeader
        caseDetail={caseDetail}
        evidenceCount={evidenceItems.length}
        isReloading={Boolean(isReloading)}
        canLinkEvidence={viewer.canLinkEvidence}
        linkEvidenceDisabledReason={viewer.disabledReasons.linkEvidence}
        onAddEvidence={() => setAttachOpen(true)}
      />

      {/* CANONICAL TABS — `.app-tabs` / `.app-tab` in app-primitives.css, the
          ONE tab authority for every internal surface. Tab identity and
          routing state are unchanged: `data-simple-case-tab` is still emitted
          per tab and `setActiveTab` is still the only state writer. */}
      <nav
        className="app-tabs"
        role="tablist"
        aria-label="Case sections"
        data-simple-case-tabs
      >
        {TAB_ORDER.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "app-tab is-active" : "app-tab"}
            onClick={() => setActiveTab(tab.id)}
            data-simple-case-tab={tab.id}
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
          viewer={viewer}
          onAddEvidence={() => setAttachOpen(true)}
          onGoToTab={setActiveTab}
        />
      ) : null}
      {activeTab === "evidence" ? (
        // Phase CASE-DETAIL-PROOVRA-V2 §Evidence — Figma places the
        // Copilot in the right rail beside the evidence list instead of
        // stacked underneath. Layout only: the SAME CaseCopilotPanel,
        // the SAME derived `linkedEvidence` projection, the SAME AI
        // policy/disclosure/consent behaviour (the panel still owns its
        // own aiEnabled/policy_denied/provider_unavailable states).
        <div className="case-detail-split case-detail-split--wide-rail">
          <div className="case-detail-split-main">
            <EvidenceTab
              caseId={caseId}
              items={evidenceItems}
              viewer={viewer}
              onOpenEvidence={onOpenEvidence}
              onReload={reload}
              addToast={addToast}
              confirm={confirm}
            />
          </div>
          {/* The SAME panel with the SAME props — only its grid position
              moved. It renders from the canonical primitives and needs no
              wrapper, so no policy, disclosure copy or selection behaviour
              is touched. */}
          <CaseCopilotPanel
            caseId={caseId}
            linkedEvidence={evidenceItems.map((it) => ({
              id: it.id,
              title: getDisplayTitle(it),
              type: (it as { type?: string }).type ?? "EVIDENCE",
              version: (it as { verificationPackageVersion?: number | null }).verificationPackageVersion ?? 0,
              status: (it as { status?: string }).status ?? "",
              // ELIGIBILITY IS DERIVED FROM PERSISTED FIELDS, so the fields it
              // reads are carried rather than defaulted. `lifecycleState` was
              // dropped here, which meant the panel could not tell a live
              // record from one scheduled for destruction.
              lifecycleState: it.lifecycleState ?? null,
              // Every item in this projection IS the case's linked evidence.
              caseLinked: true,
            }))}
            // The server runs the SAME eligibility authority. When it disagrees
            // with this list, the list is stale — so re-read it rather than
            // asking the operator to guess.
            onRefreshEvidence={() => void reload()}
          />
        </div>
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
    </CaseDetailPlane>
  );
}

// ---------------------------------------------------------------------------
// Content plane
// ---------------------------------------------------------------------------

/**
 * Content plane — the canonical `PageShell`, unmodified.
 *
 * The gutter, vertical rhythm and typography all come from the shared page
 * plane (`--page-pad-x`, `--page-pad-y`, `--section-gap`) inside the shared
 * `.app-shell-v2-content` padding, exactly like /cases and every other
 * internal route. The only page-level decision is `width="full"` — a
 * documented `PageShell` option (≈20 admin surfaces use it) that opts out of
 * the 1360px clamp so the two-column workspace fills wide displays.
 *
 * There is deliberately NO shell override here: the previous revision zeroed
 * `.app-shell-v2-content`'s padding for this route only, which made one page
 * disagree with the shell every other page renders inside.
 */
function CaseDetailPlane({
  children,
  ...rest
}: { children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <PageShell width="full" className="cc-page" {...rest}>
      {children}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * CaseDetailHeader — the ONE header for every `/cases/[id]` branch.
 *
 * Personal / Small-Business (`SimpleCaseDetail`) and Enterprise
 * (`MatterWorkspace`) both render THIS component, so the anatomy, order,
 * typography, status authority, Case-ID treatment and primary-action
 * authority are identical by construction rather than by convention:
 *
 *   breadcrumb  →  title + primary action  →  status + metadata  →  Case ID
 *
 * Workspace-specific context is supplied through `scopeLabel` (the leading
 * breadcrumb crumb) and `extraMeta` (additional metadata items such as
 * organization, matter owner or reviewer scope). Neither may introduce a
 * second visual language: they render inside the same canonical classes.
 */
export function CaseDetailHeader({
  caseDetail,
  evidenceCount,
  isReloading,
  canLinkEvidence,
  linkEvidenceDisabledReason,
  onAddEvidence,
  scopeLabel = "Personal Space",
  primaryActionLabel = "Add evidence",
  extraMeta,
  secondaryActions,
  testIdPrefix = "simple",
}: {
  caseDetail: MatterWorkspaceCaseHeader;
  evidenceCount: number;
  isReloading: boolean;
  canLinkEvidence: boolean;
  linkEvidenceDisabledReason: string | null | undefined;
  onAddEvidence: () => void;
  /** Leading breadcrumb crumb — the workspace/organization context. */
  scopeLabel?: string;
  primaryActionLabel?: string;
  /** Workspace-specific metadata items, rendered in the same meta row. */
  extraMeta?: React.ReactNode;
  /** Workspace-specific secondary actions, beside the primary. */
  secondaryActions?: React.ReactNode;
  /** Marks which branch rendered the shared header. */
  testIdPrefix?: "simple" | "matter";
}) {
  const { addToast } = useToast();
  // Case header composition. Every class below resolves to a canonical
  // authority: `.cases-breadcrumb*` and `.case-detail-*` in the existing
  // Case Details stylesheet, `.app-status-badge` for the status pill,
  // `.app-header-primary-action` for the primary and `.app-secondary-action`
  // for the copy control. EVERY data-* attribute, testid, handler, capability
  // gate, tooltip and copy string is preserved byte-for-byte.
  return (
    <header
      data-simple-case-header
      data-case-detail-surface={testIdPrefix}
      className="case-detail-head"
    >
      {/* Breadcrumb — Cases links to /cases; the case name is the
          current, non-clickable segment. The workspace crumb keeps the
          existing label. */}
      <nav
        data-simple-case-breadcrumb
        aria-label="Breadcrumb"
        className="cases-breadcrumb"
      >
        <span>{scopeLabel}</span>
        <span aria-hidden className="cases-breadcrumb-sep">
          /
        </span>
        <Link href="/cases" className="cases-breadcrumb-link">
          Cases
        </Link>
        <span aria-hidden className="cases-breadcrumb-sep">
          /
        </span>
        <span aria-current="page" className="cases-breadcrumb-current">
          {caseDetail.name}
        </span>
      </nav>

      <div className="case-detail-head-top">
        <div className="case-detail-head-titlerow">
          <h1 data-simple-case-title className="case-detail-title">
            {caseDetail.name}
          </h1>
          {/* The single canonical Add-evidence entry point. This is a
              page-level PRIMARY action, so it reuses the app-wide
              `.app-header-primary-action` class — the exact same class the
              "Create case" button on /cases and the global "New Case" button
              use. No colours are redeclared here, so the gradient, border,
              shadow, hover, focus and :disabled treatment stay in lockstep
              with those controls. The capability gate, disabled reason,
              handler and testid are unchanged. */}
          <button
            type="button"
            className="app-header-primary-action"
            onClick={onAddEvidence}
            disabled={!canLinkEvidence}
            title={linkEvidenceDisabledReason ?? undefined}
            data-simple-case-action="add-evidence"
          >
            <Plus size={16} strokeWidth={2} aria-hidden="true" />
            {primaryActionLabel}
          </button>
          {secondaryActions ?? null}
        </div>

        {/* Compact metadata line — status pill, evidence count, created,
            last updated. Reference number is surfaced only when the
            envelope actually carries one (never fabricated). */}
        <div data-simple-case-subtitle className="case-detail-meta">
          {/* CANONICAL STATUS BADGE — `.app-status-badge[data-tone]`, the ONE
              status pill for every internal surface. The status enum is mapped
              to a semantic tone by `caseStatusTone()`; `data-status` is kept
              because it is a load-bearing test hook. */}
          <span
            className="app-status-badge"
            data-tone={caseStatusTone(caseDetail.status)}
            data-status={caseDetail.status}
            data-simple-case-status
          >
            {caseStatusLabel(caseDetail.status)}
          </span>
          {caseDetail.referenceNumber ? (
            <span className="case-detail-meta-item">
              <span className="case-detail-dot" aria-hidden />
              <span data-simple-case-reference style={{ fontWeight: 600 }}>
                Ref {caseDetail.referenceNumber}
              </span>
            </span>
          ) : null}
          <span data-simple-case-evidence-count>
            {evidenceCount === 1
              ? "1 evidence record"
              : `${evidenceCount} evidence records`}
          </span>
          <span className="case-detail-meta-item">
            <span className="case-detail-dot" aria-hidden />
            <span>Created {formatRelative(caseDetail.createdAt)}</span>
          </span>
          <span className="case-detail-meta-item">
            <span className="case-detail-dot" aria-hidden />
            <span data-simple-case-updated>
              Last updated {formatRelative(caseDetail.updatedAt)}
            </span>
          </span>
          {extraMeta ?? null}
          {isReloading ? (
            <span
              className="cc-muted"
              data-simple-case-reloading
              aria-live="polite"
            >
              Updating…
            </span>
          ) : null}
        </div>

        {/* Labelled, copyable Case ID (the UUID is the DB primary key,
            the /cases/[id] route param and the searchable reference).
            Stays LTR + selectable in RTL documents. */}
        <span className="case-detail-idrow">
          <span className="case-detail-idlabel">
            <span className="case-detail-dot" aria-hidden />
            CASE ID :
          </span>
          <button
            type="button"
            className="app-secondary-action case-detail-copy"
            title="Copy case ID"
            data-simple-case-id
            onClick={() => {
              void navigator.clipboard?.writeText(caseDetail.id);
              addToast("Case ID copied.", "success");
            }}
          >
            <span className="case-detail-copy-value">{caseDetail.id}</span>
            <Copy size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </span>
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
  // Real, envelope-only KPI values. Figma's mock shows "3 of 3" for a
  // three-record case; the values below stay derived from the live
  // envelope, so a workspace with different data renders its own truth.
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

  // Definition-list summary — real fields only. Priority /
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
      className="cc-section case-detail-split-main"
      role="tabpanel"
      aria-label="Overview"
      data-simple-case-overview
    >
      {/* [ KPI row + case summary ] | [ action rail ] */}
      <div className="case-detail-split">
        <div className="case-detail-split-main">
          {/* CANONICAL KPI GRID + CARD — `.app-grid-kpis` / `.app-kpi-card`
              from app-primitives.css, the same pair the operational
              dashboards use. */}
          <div data-simple-case-summary>
            <div className="app-grid-kpis">
              {kpis.map((kpi) => (
                <div
                  className="app-kpi-card"
                  key={kpi.label}
                  data-simple-case-kpi={kpi.label}
                >
                  <span className="app-kpi-card__label">{kpi.label}</span>
                  <span className="app-kpi-card__value">{kpi.value}</span>
                  <span className="app-kpi-card__meta">{kpi.hint}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Case summary — canonical panel, page-specific definition list. */}
          <section
            className="app-panel app-panel__body"
            data-simple-case-summary-rows
          >
            <dl className="case-detail-kv">
              {summaryRows.map((row) => (
                <div className="case-detail-kv-row" key={row.label}>
                  <dt className="case-detail-kv-key">{row.label}</dt>
                  <dd className="case-detail-kv-val">{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        {/* Quick actions. The heading keeps the truthful product term:
            PROOVRA reserves risk vocabulary for advisory integrity signals on
            the Evidence Record surface, so labelling ordinary operational
            actions as risk would be materially misleading on a custody
            product. Each control is the canonical secondary action laid out
            block — no second button. */}
        <aside
          className="app-panel app-panel__body case-detail-rail"
          data-simple-case-actions
        >
          <h2 className="case-detail-rail-title">Quick actions</h2>
          {/* THE EVIDENCE INSPECTOR IS THE AUTHORITY for this pair. Its two
              downloads rank the same work the same way, so the case rail
              adopts the same two canonical treatments rather than flattening
              both to the outlined secondary: the leading action is the purple
              primary, the report action the dark filled secondary. Both come
              from app-primitives; `--block` is layout only. */}
          <button
            type="button"
            className="app-primary-action app-primary-action--block"
            onClick={onAddEvidence}
            disabled={!viewer.canLinkEvidence}
            title={viewer.disabledReasons.linkEvidence ?? undefined}
          >
            <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
            Add evidence
          </button>
          {/* State-aware. With zero evidence, report + package
              generation have no valid input, so they are DISABLED
              with an explanatory tooltip. */}
          <button
            type="button"
            className="app-secondary-action app-secondary-action--filled app-secondary-action--block"
            onClick={() => onGoToTab("reports")}
            disabled={evidenceCount === 0}
            title={
              evidenceCount === 0
                ? "Add evidence before generating a report."
                : undefined
            }
          >
            <FileText size={16} strokeWidth={1.9} aria-hidden="true" />
            Generate report
          </button>
          <button
            type="button"
            className="app-secondary-action app-secondary-action--block"
            onClick={() => onGoToTab("reports")}
            disabled={evidenceCount === 0}
            title={
              evidenceCount === 0
                ? "A finalized evidence record is required."
                : undefined
            }
          >
            <ShieldCheck size={16} strokeWidth={1.9} aria-hidden="true" />
            Create verification package
          </button>
          <button
            type="button"
            className="app-secondary-action app-secondary-action--block"
            onClick={() => onGoToTab("settings")}
          >
            <Share2 size={16} strokeWidth={1.9} aria-hidden="true" />
            Share
          </button>
        </aside>
      </div>

      {/* Attention panel — the canonical panel with a 4px amber accent on its
          INLINE-START edge, so it mirrors correctly in Arabic. The heading
          reads `--warning-ink` (the readable amber) while the rail and the
          bullets keep the decorative `--warning`. */}
      <section
        className="app-panel app-panel__body case-detail-attention"
        data-simple-case-needs-attention
      >
        <div className="case-detail-attention-body">
          <h2 className="case-detail-attention-title">What needs attention</h2>
          {evidenceCount === 0 ? (
            <p
              className="case-detail-attention-text"
              data-simple-case-attention-empty
            >
              No evidence linked yet. Add evidence to begin building this case
              workspace.
            </p>
          ) : needsAttention.length === 0 ? (
            <p
              className="case-detail-attention-text"
              data-simple-case-attention-empty
            >
              No open issues. Reports and packages are up to date.
            </p>
          ) : (
            <ul
              className="case-detail-attention-list"
              data-simple-case-attention-items
            >
              {needsAttention.map((item) => (
                <li
                  key={item.key}
                  data-simple-case-attention-key={item.key}
                  className="case-detail-attention-item"
                >
                  <span aria-hidden className="case-detail-attention-bullet" />
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {evidenceCount === 0 ? (
          <button
            type="button"
            className="app-secondary-action"
            onClick={onAddEvidence}
            disabled={!viewer.canLinkEvidence}
            title={viewer.disabledReasons.linkEvidence ?? undefined}
          >
            <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
            Add evidence
          </button>
        ) : null}
      </section>
    </section>
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
        // §5 — removal is destructive at the case-link level: use the same
        // restrained danger system as Delete note / Delete case (red), not
        // the amber warning tone.
        tone: "danger",
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
      className="cc-section case-detail-split-main"
      role="tabpanel"
      aria-label="Evidence"
      data-simple-case-evidence
    >
      {/* Phase CASES-ATTACH-PICKER (Final) — the tab body no longer
          renders an Add-evidence button. The page header owns the
          single canonical entry point so the user can attach from
          any tab without duplicate affordances. */}
      {items.length === 0 ? (
        <div className="app-empty" data-simple-case-evidence-empty>
          <strong>No evidence linked yet.</strong>
          <p>
            Use <em>Add evidence</em> above to link files, photos,
            videos, or documents to this case.
          </p>
        </div>
      ) : (
        <>
          {/* CANONICAL SEARCH FIELD — `.app-search-field` / `-icon` /
              `-input` from app-primitives.css. The search really filters the
              list client-side by name / type / status / record id; semantics
              unchanged. */}
          <div className="app-search-field app-search-field--block">
            <span className="app-search-icon" aria-hidden="true">
              <Search size={16} strokeWidth={1.9} />
            </span>
            <input
              className="app-search-input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search linked evidence by name, type, or record ID"
              aria-label="Search linked evidence"
              data-simple-case-evidence-search
            />
          </div>

          {/* One canonical panel per linked record. */}
          <ul className="case-detail-rows" data-simple-case-evidence-items>
            {visibleItems.map((item) => (
              <li
                className="app-panel case-detail-row"
                key={item.id}
                data-simple-case-evidence-item={item.id}
              >
                <div className="case-detail-row-main">
                  <h3
                    className="case-detail-row-title"
                    data-simple-case-evidence-title
                    title={getDisplayTitle(item)}
                  >
                    {getDisplayTitle(item)}
                  </h3>
                  <div className="cc-muted case-detail-row-meta">
                    <span className="case-detail-row-meta-id">{item.id.slice(0, 8)}</span>
                    <span aria-hidden>•</span>
                    <span>{item.type}</span>
                    <span aria-hidden>•</span>
                    <span>{item.status}</span>
                    {item.verificationStatus ? (
                      <>
                        <span aria-hidden>•</span>
                        <span data-simple-case-evidence-verification={item.verificationStatus}>
                          {item.verificationStatus.replace(/_/g, " ").toLowerCase()}
                        </span>
                      </>
                    ) : null}
                    <span aria-hidden>•</span>
                    <span>
                      {item.reportReady ? "Report ready" : "Report missing"}
                    </span>
                    <span aria-hidden>•</span>
                    <span>
                      {item.packageReady ? "Package ready" : "Package missing"}
                    </span>
                  </div>
                </div>
                <div className="case-detail-row-actions">
                  <button
                    type="button"
                    className="app-secondary-action"
                    onClick={() => onOpenEvidence(item.id)}
                    data-simple-case-evidence-open={item.id}
                  >
                    Open
                  </button>
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
            <div className="app-panel app-panel__body">
              <p
                className="cc-muted case-detail-attention-text"
                data-simple-case-evidence-no-match
                style={{ margin: 0 }}
              >
                No linked evidence matches your search.
              </p>
            </div>
          ) : null}
        </>
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

/**
 * How an evidence KIND is labelled. Classification, never health.
 *
 * `PHOTO`, `DOCUMENT`, `VIDEO`, `AUDIO` say what a record IS. They wear the
 * neutral classification tone, so no kind can be mistaken for a state — the
 * previous row rendered them in the same pill shape as the integrity result,
 * which made "DOCUMENT" and "recorded integrity verified" look like two
 * readings of the same thing.
 */
function attachKindLabel(type: string | null | undefined): string {
  return (type ?? "RECORD").replace(/_/g, " ");
}

/**
 * What the integrity/preservation state MEANS, as a tone.
 *
 * Derived from the state, never from the copy. `FAILED` is red rather than
 * amber: a failed preservation check is not a caution, and the previous row
 * collapsed it onto the same amber as `REVIEW_REQUIRED`, so a broken record
 * and a record awaiting a human read identically.
 */
function attachIntegrityTone(status: string | null | undefined): AppTone {
  if (!status) return "slate";
  if (status === "FAILED") return "red";
  if (status === "REVIEW_REQUIRED") return "amber";
  if (status.startsWith("RECORDED")) return "green";
  return "slate";
}

function attachIntegrityLabel(status: string): string {
  return status.replace(/_/g, " ").toLowerCase();
}

/** What went wrong loading the candidate list, reduced to a rendered state. */
type AttachLoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  /** The actor may not see this workspace's evidence. Not an empty workspace. */
  | { kind: "restricted" }
  /** Anything else. Bounded copy; never the transport's own message. */
  | { kind: "error" };

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
  const [loadState, setLoadState] = useState<AttachLoadState>({ kind: "loading" });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Why the last submission failed, in the dialog.
   *
   * A toast is not enough for a failure the operator has to act on: the
   * selection they need to retry is inside this dialog, and a toast that has
   * already faded leaves a set of checked rows with no explanation.
   */
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * The client half of duplicate-submission protection.
   *
   * `busy` disables the button, but a ref rejects a re-entrant call the
   * disabled attribute cannot catch — Enter held down, a synthetic dispatch,
   * or a second click landing in the same frame as the first state update.
   */
  const submitInFlight = useRef(false);

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
        setLoadState({ kind: "ready" });
      } catch (err) {
        if (cancelled) return;
        // A REFUSAL and an OUTAGE are different answers and must not render
        // the same. The previous handler set `candidates = []` for both, so a
        // workspace the actor may not read announced "no available evidence
        // to link" — a confident statement about a population it never saw.
        const status = (err as { status?: number } | null)?.status;
        const restricted = status === 401 || status === 403;
        setCandidates([]);
        setLoadState({ kind: restricted ? "restricted" : "error" });
        onError(
          restricted
            ? "You do not have access to this workspace's evidence."
            : "Could not load available evidence.",
        );
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
    // Three independent controls, none trusted alone: the button is disabled,
    // this ref rejects re-entry, and the backend attach is idempotent per
    // (case, evidence).
    if (submitInFlight.current) return;
    if (selectedIds.size === 0) return;
    submitInFlight.current = true;
    setBusy(true);
    setSubmitError(null);
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
    if (failed > 0) {
      // The rows that failed are STILL SELECTED, so the message names what is
      // left to retry rather than what was lost.
      setSubmitError(
        failed === 1
          ? "One evidence record could not be linked. It is still selected — try again."
          : `${failed} evidence records could not be linked. They are still selected — try again.`,
      );
    }
    submitInFlight.current = false;
    setBusy(false);
    await onAttached({ succeeded, failed });
  }, [caseId, selectedIds, onAttached]);

  const countMessage =
    selectedCount === 0
      ? "Select one or more evidence records"
      : selectedCount === 1
        ? "1 evidence record selected"
        : `${selectedCount} evidence records selected`;

  return (
    <Modal
      open
      testid="attach-evidence"
      title="Link evidence to case"
      description="Choose an existing evidence record from this workspace to link to this case."
      onClose={onClose}
      // Pending-state dismissal protection: while requests are in flight the
      // overlay, Escape and the close control all stand down, so a half-
      // committed batch cannot be abandoned without its result being shown.
      dismissDisabled={busy}
      footer={
        <div className="attach-evidence__footer">
          <span
            className="attach-evidence__count"
            data-simple-case-attach-selected-count={selectedCount}
            aria-live="polite"
          >
            {countMessage}
          </span>
          <div className="attach-evidence__footer-actions">
            <CaseButton variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </CaseButton>
            <CaseButton
              onClick={() => void handleAttach()}
              disabled={selectedCount === 0 || busy}
              aria-busy={busy}
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
      }
    >
      <p className="attach-evidence__lede" data-simple-case-attach-lede>
        Choose an existing evidence record from this workspace.
      </p>

      <div className="cases-search-field attach-evidence__search">
        <span aria-hidden className="cases-search-icon">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
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
          disabled={busy}
        />
      </div>

      {submitError ? (
        <p
          className="app-alert app-alert--danger attach-evidence__error"
          role="alert"
          data-simple-case-attach-submit-error
        >
          {submitError}
        </p>
      ) : null}

      <div className="attach-evidence__list" data-simple-case-attach-list>
        {loadState.kind === "loading" ? (
          <p
            className="attach-evidence__state"
            data-simple-case-attach-loading
            role="status"
          >
            Loading available evidence…
          </p>
        ) : loadState.kind === "restricted" ? (
          <p
            className="attach-evidence__state"
            data-simple-case-attach-restricted
            role="status"
          >
            You do not have access to this workspace&apos;s evidence. Ask a
            workspace administrator for access.
          </p>
        ) : loadState.kind === "error" ? (
          <p
            className="attach-evidence__state"
            data-simple-case-attach-error
            role="status"
          >
            Could not load available evidence. Close this dialog and try again.
          </p>
        ) : (candidates ?? []).length === 0 ? (
          <p
            className="attach-evidence__state"
            data-simple-case-attach-empty-list
            role="status"
          >
            No available evidence to link. Upload or capture evidence first,
            then return to this case.
          </p>
        ) : visibleCandidates.length === 0 ? (
          <p
            className="attach-evidence__state"
            data-simple-case-attach-no-match
            role="status"
          >
            No matching evidence found. Try a different name or record ID.
          </p>
        ) : (
          <ul className="attach-evidence__rows">
            {visibleCandidates.map((c) => {
              const isSelected = selectedIds.has(c.id);
              const fullTitle = getDisplayTitle(c);
              return (
                <li
                  key={c.id}
                  className="attach-evidence__row"
                  data-simple-case-attach-row={c.id}
                  data-selected={isSelected ? "true" : "false"}
                >
                  {/*
                    ONE control for the whole row.
                    A <label> makes every pixel of the row a target for the
                    checkbox it wraps, with no nested interactive element to
                    trap a click, swallow a keystroke or produce a second
                    tab stop. The previous row was a clickable <li> containing
                    a pointer-events:none checkbox AND a separate button — two
                    affordances for one action, one of them unreachable by
                    keyboard.
                  */}
                  <label className="attach-evidence__row-control">
                    <input
                      type="checkbox"
                      className="app-checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected(c.id)}
                      disabled={busy}
                      data-simple-case-attach-row-checkbox={c.id}
                    />
                    <span className="attach-evidence__row-body">
                      {/*
                        The primary value. Clamped to two lines so a 120-
                        character filename cannot push the metadata out of the
                        row, and carrying the full value in `title` so nothing
                        is destroyed by the clamp.
                      */}
                      <span
                        className="attach-evidence__row-title"
                        title={fullTitle}
                        data-simple-case-attach-row-title
                      >
                        {fullTitle}
                      </span>

                      {/* Classification and identity. */}
                      <span className="attach-evidence__row-meta">
                        <AppStatusBadge
                          tone="slate"
                          className="attach-evidence__kind"
                          data-simple-case-attach-row-kind={c.type}
                        >
                          {attachKindLabel(c.type)}
                        </AppStatusBadge>
                        <code
                          className="attach-evidence__row-id"
                          data-simple-case-attach-row-id={c.id}
                        >
                          {c.id.slice(0, 8)}
                        </code>
                        {c.verificationStatus ? (
                          <AppStatusBadge
                            tone={attachIntegrityTone(c.verificationStatus)}
                            data-simple-case-attach-row-integrity={
                              c.verificationStatus
                            }
                          >
                            {attachIntegrityLabel(c.verificationStatus)}
                          </AppStatusBadge>
                        ) : null}
                      </span>

                      {/*
                        Deliverable availability. INFORMATIONAL: a record with
                        no report is still linkable, so this is stated as text
                        rather than as a pill that would read as an eligibility
                        error. "Missing" is muted, never a success tone.
                      */}
                      <span className="attach-evidence__row-deliverables">
                        <span
                          data-simple-case-attach-row-report={
                            c.reportReady ? "ready" : "missing"
                          }
                          data-state={c.reportReady ? "ready" : "missing"}
                        >
                          {c.reportReady ? "Report ready" : "Report missing"}
                        </span>
                        <span
                          data-simple-case-attach-row-package={
                            c.packageReady ? "ready" : "missing"
                          }
                          data-state={c.packageReady ? "ready" : "missing"}
                        >
                          {c.packageReady ? "Package ready" : "Package missing"}
                        </span>
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
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
                          color: "#6D28D9",
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
              Enabled style: solid #7C3AED (CaseButton primary default). */}
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
