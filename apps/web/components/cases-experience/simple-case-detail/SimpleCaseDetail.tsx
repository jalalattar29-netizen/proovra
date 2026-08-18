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
import { useToast } from "../../ui";
// Phase 7B (visual-only) — canonical shared design-system primitives.
// PageShell/PageHeader/PageSection from the barrel.
//
// Phase CASE-DETAIL-PROOVRA-V2 — the legacy `Button` barrel import and
// the deep `Card` / `EmptyState` imports are dropped from THIS file
// because the surface now renders the V2 primitives below. Both legacy
// components remain in the repository and are still used by other
// routes; nothing was deleted.
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
// Phase CASE-DETAIL-PROOVRA-V2 (visual-only) — the shared V2 internal UI
// foundation extracted from the Figma source. Presentation primitives
// only; no data fetching, no authorization, no mutations. See
// `components/proovra-v2/proovra-v2.css` for the token provenance.
import {
  ActionRail,
  AttentionPanel,
  Button as V2Button,
  CopyField,
  IconChevronRight,
  IconDocument,
  IconPlus,
  IconShare,
  IconShieldCheck,
  KeyValuePanel,
  LoadingSkeleton,
  MetricCard,
  MetricRow,
  SearchField,
  Split,
  StateBlock,
  Surface,
  Tabs as V2Tabs,
  useProovraV2Surface,
} from "../../proovra-v2";
import { caseStatusTone } from "./helpers";
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
  // Phase CASE-DETAIL-PROOVRA-V2 — opt this route (and ONLY this route)
  // into the redesigned shell chrome. Presentation only; unmount restores
  // the previous sidebar/topbar exactly, so no other internal page moves.
  useProovraV2Surface("case-detail");
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
        <Surface variant="panel">
          <p className="sr-only" style={{ margin: 0 }}>
            Loading case…
          </p>
          <LoadingSkeleton rows={4} label="Loading case" />
        </Surface>
      </CaseDetailPlane>
    );
  }
  if (state.status === "auth_error") {
    // RestrictedState — access is decided by the backend + PageRouteGate;
    // this only renders the outcome. No client-side authorization here.
    return (
      <CaseDetailPlane data-simple-case-detail-auth>
        <Surface variant="panel">
          <StateBlock
            tone="restricted"
            title="You don&apos;t have access to this case."
            description="Ask a workspace owner or administrator if you need access."
          />
        </Surface>
      </CaseDetailPlane>
    );
  }
  if (state.status === "not_found") {
    return (
      <CaseDetailPlane data-simple-case-detail-not-found>
        <Surface variant="panel">
          <StateBlock
            title="Case not found"
            description="The case may have been deleted or moved."
            actions={
              <Link href="/cases">
                <V2Button tone="outline">Back to cases</V2Button>
              </Link>
            }
          />
        </Surface>
      </CaseDetailPlane>
    );
  }
  if (state.status === "unavailable") {
    return (
      <CaseDetailPlane data-simple-case-detail-unavailable>
        <Surface variant="panel">
          <StateBlock
            tone="danger"
            title="Case unavailable"
            description={state.message}
            actions={
              <V2Button tone="outline" onClick={() => void reload()}>
                Retry
              </V2Button>
            }
          />
        </Surface>
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
      <SimpleCaseHeader
        caseDetail={caseDetail}
        evidenceCount={evidenceItems.length}
        isReloading={Boolean(isReloading)}
        canLinkEvidence={viewer.canLinkEvidence}
        linkEvidenceDisabledReason={viewer.disabledReasons.linkEvidence}
        onAddEvidence={() => setAttachOpen(true)}
      />

      {/* Phase CASE-DETAIL-PROOVRA-V2 §Tabs — Figma "Tabs/filled": white
          card, radius 8, 4px inset, 8px gap, active pill filled
          rgba(37,99,235,0.10). Tab identity + routing state are
          unchanged; `data-simple-case-tab` is still emitted per tab and
          `setActiveTab` is still the only state writer. */}
      <V2Tabs
        items={TAB_ORDER}
        active={activeTab}
        onSelect={setActiveTab}
        label="Case sections"
        tabAttr={(id) => ({ "data-simple-case-tab": id })}
        data-simple-case-tabs
      />

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
        <Split
          wideRail
          main={
            <EvidenceTab
              caseId={caseId}
              items={evidenceItems}
              viewer={viewer}
              onOpenEvidence={onOpenEvidence}
              onReload={reload}
              addToast={addToast}
              confirm={confirm}
            />
          }
          rail={
            // Presentation wrapper only — it carries the Figma rail styling
            // for the panel's existing class names. No props, no policy, no
            // disclosure copy is altered.
            <div className="pv2-copilot-rail">
              <CaseCopilotPanel
                caseId={caseId}
                linkedEvidence={evidenceItems.map((it) => ({
                  id: it.id,
                  title: getDisplayTitle(it),
                  type: (it as { type?: string }).type ?? "EVIDENCE",
                  version: (it as { verificationPackageVersion?: number | null }).verificationPackageVersion ?? 0,
                  status: (it as { status?: string }).status ?? "",
                }))}
              />
            </div>
          }
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
    </CaseDetailPlane>
  );
}

// ---------------------------------------------------------------------------
// Content plane
// ---------------------------------------------------------------------------

/**
 * Phase CASE-DETAIL-PROOVRA-V2 — the Figma content plane.
 *
 * Figma "Container" under the navbar: 24px top / 32px side / 32px bottom
 * padding and a 24px vertical rhythm, FLUID width (the frame's content
 * column simply fills whatever is left of the viewport beside the
 * sidebar). We therefore keep the shared `PageShell` — so this surface
 * still participates in the repository's page-plane contract — but opt
 * out of its 1360px clamp (`width="full"`) because clamping would shrink
 * the page below the reference composition on wide displays.
 */
function CaseDetailPlane({
  children,
  ...rest
}: { children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <PageShell
      width="full"
      className="cc-page pv2-page-plane"
      style={{
        paddingInline: "var(--pv2-gutter-x)",
        paddingBlock: "var(--pv2-gutter-y) var(--pv2-space-8)",
        gap: "var(--pv2-space-6)",
        fontFamily: "var(--pv2-font)",
        color: "var(--pv2-ink-primary)",
      }}
      {...rest}
    >
      {children}
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
  // Phase CASE-DETAIL-PROOVRA-V2 §PageHeader — the Figma "Page Heading"
  // frame, reproduced from decoded node properties:
  //
  //   Nav          12/18 Medium #565E74, current crumb #1D1A24
  //   Heading 2    24/32 Bold  #1D1A24  + right-aligned primary action
  //   Meta row     13/18 Regular #565E74, 4px dot separators, status pill
  //   Case ID      13/18 label + 305x32 bordered copy control
  //
  // The previous dark `.ops-banner-card` banner is replaced. EVERY
  // data-* attribute, testid, handler, capability gate, tooltip and
  // copy string below is preserved byte-for-byte from the previous
  // revision — this is a presentation change only.
  return (
    <header data-simple-case-header className="pv2-pagehead">
      {/* Breadcrumb — Cases links to /cases; the case name is the
          current, non-clickable segment. The workspace crumb keeps the
          existing label. */}
      <nav
        data-simple-case-breadcrumb
        aria-label="Breadcrumb"
        className="pv2-crumbs"
      >
        <span>Personal Space</span>
        <span aria-hidden className="pv2-crumb-sep">
          /
        </span>
        <Link href="/cases" className="cases-breadcrumb-link">
          Cases
        </Link>
        <span aria-hidden className="pv2-crumb-sep">
          /
        </span>
        <span aria-current="page" className="pv2-crumb-current">
          {caseDetail.name}
        </span>
      </nav>

      <div className="pv2-pagehead-top">
        <div className="pv2-pagehead-titlerow">
          <h1 data-simple-case-title className="pv2-pagehead-title">
            {caseDetail.name}
          </h1>
          {/* The single canonical Add-evidence entry point. The
              capability gate + disabled reason are unchanged. */}
          <button
            type="button"
            className="pv2-btn pv2-btn--outline"
            onClick={onAddEvidence}
            disabled={!canLinkEvidence}
            title={linkEvidenceDisabledReason ?? undefined}
            data-simple-case-action="add-evidence"
          >
            <span className="pv2-btn-icon" aria-hidden>
              <IconPlus size={20} />
            </span>
            Add evidence
            <span className="pv2-btn-icon" aria-hidden>
              <IconChevronRight size={20} />
            </span>
          </button>
        </div>

        {/* Compact metadata line — status pill, evidence count, created,
            last updated. Reference number is surfaced only when the
            envelope actually carries one (never fabricated). */}
        <div data-simple-case-subtitle className="pv2-pagehead-meta">
          <span
            className="pv2-status"
            data-tone={caseStatusTone(caseDetail.status)}
            data-status={caseDetail.status}
            data-simple-case-status
          >
            {caseStatusLabel(caseDetail.status)}
          </span>
          {caseDetail.referenceNumber ? (
            <span className="pv2-pagehead-meta-item">
              <span className="pv2-dot" aria-hidden />
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
          <span className="pv2-pagehead-meta-item">
            <span className="pv2-dot" aria-hidden />
            <span>Created {formatRelative(caseDetail.createdAt)}</span>
          </span>
          <span className="pv2-pagehead-meta-item">
            <span className="pv2-dot" aria-hidden />
            <span data-simple-case-updated>
              Last updated {formatRelative(caseDetail.updatedAt)}
            </span>
          </span>
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
        <CopyField
          label="CASE ID :"
          value={caseDetail.id}
          title="Copy case ID"
          data-simple-case-id
          onCopy={() => {
            void navigator.clipboard?.writeText(caseDetail.id);
            addToast("Case ID copied.", "success");
          }}
        />
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
      className="cc-section"
      role="tabpanel"
      aria-label="Overview"
      data-simple-case-overview
      style={{ display: "flex", flexDirection: "column", gap: "var(--pv2-space-6)" }}
    >
      {/* Figma "Frame 1109": [ KPI row + case summary ] | [ action rail ] */}
      <Split
        main={
          <>
            {/* Figma "KPI Summary Row" — four white cards, 16px padding,
                radius 16, 1px #F8FAFC border, 0 1px 2px shadow. */}
            <div data-simple-case-summary>
              <MetricRow>
                {kpis.map((kpi) => (
                  <MetricCard
                    key={kpi.label}
                    label={kpi.label}
                    value={kpi.value}
                    hint={kpi.hint}
                    data-simple-case-kpi={kpi.label}
                  />
                ))}
              </MetricRow>
            </div>

            {/* Figma "Case - Overview" — key/value panel, 24/16 padding. */}
            <KeyValuePanel rows={summaryRows} data-simple-case-summary-rows />
          </>
        }
        rail={
          // FIGMA DEVIATION (documented in the deliverable): the Figma
          // frame labels this rail "RISK SIGNALS" while its content is
          // four ordinary operational actions (Add evidence / Generate
          // report / Create verification package / Share). PROOVRA
          // reserves risk vocabulary for advisory integrity signals on
          // the Evidence Record surface, so relabelling these actions
          // as risk would be materially misleading on a custody
          // product. The Figma geometry is reproduced exactly; the
          // heading keeps the truthful product term.
          <ActionRail title="Quick actions" data-simple-case-actions>
            <V2Button
              tone="outline"
              block
              onClick={onAddEvidence}
              disabled={!viewer.canLinkEvidence}
              title={viewer.disabledReasons.linkEvidence ?? undefined}
            >
              <span className="pv2-btn-icon" aria-hidden>
                <IconPlus size={20} />
              </span>
              Add evidence
            </V2Button>
            {/* State-aware. With zero evidence, report + package
                generation have no valid input, so they are DISABLED
                with an explanatory tooltip. */}
            <V2Button
              tone="outline"
              block
              onClick={() => onGoToTab("reports")}
              disabled={evidenceCount === 0}
              title={
                evidenceCount === 0
                  ? "Add evidence before generating a report."
                  : undefined
              }
            >
              <span className="pv2-btn-icon" aria-hidden>
                <IconDocument size={20} />
              </span>
              Generate report
            </V2Button>
            <V2Button
              tone="outline"
              block
              onClick={() => onGoToTab("reports")}
              disabled={evidenceCount === 0}
              title={
                evidenceCount === 0
                  ? "A finalized evidence record is required."
                  : undefined
              }
            >
              <span className="pv2-btn-icon" aria-hidden>
                <IconShieldCheck size={20} />
              </span>
              Create verification package
            </V2Button>
            <V2Button tone="outline" block onClick={() => onGoToTab("settings")}>
              <span className="pv2-btn-icon" aria-hidden>
                <IconShare size={20} />
              </span>
              Share
            </V2Button>
          </ActionRail>
        }
      />

      {/* Figma "Section - AlertBanner" — full-width attention panel,
          1px #F59E0B border, radius 12. */}
      <AttentionPanel
        title="What needs attention"
        data-simple-case-needs-attention
        action={
          evidenceCount === 0 ? (
            <V2Button
              tone="outline"
              onClick={onAddEvidence}
              disabled={!viewer.canLinkEvidence}
              title={viewer.disabledReasons.linkEvidence ?? undefined}
            >
              <span className="pv2-btn-icon" aria-hidden>
                <IconPlus size={20} />
              </span>
              Add evidence
            </V2Button>
          ) : null
        }
      >
        {evidenceCount === 0 ? (
          <p className="pv2-attention-text" data-simple-case-attention-empty>
            No evidence linked yet. Add evidence to begin building this case
            workspace.
          </p>
        ) : needsAttention.length === 0 ? (
          <p
            className="pv2-attention-text"
            data-simple-case-attention-empty
          >
            No open issues. Reports and packages are up to date.
          </p>
        ) : (
          <ul className="pv2-attention-list" data-simple-case-attention-items>
            {needsAttention.map((item) => (
              <li
                key={item.key}
                data-simple-case-attention-key={item.key}
                className="pv2-attention-item"
              >
                <span aria-hidden className="pv2-attention-bullet" />
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        )}
      </AttentionPanel>
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
      className="cc-section"
      role="tabpanel"
      aria-label="Evidence"
      data-simple-case-evidence
      style={{ display: "flex", flexDirection: "column", gap: "var(--pv2-space-6)" }}
    >
      {/* Phase CASES-ATTACH-PICKER (Final) — the tab body no longer
          renders an Add-evidence button. The page header owns the
          single canonical entry point so the user can attach from
          any tab without duplicate affordances. */}
      {items.length === 0 ? (
        <Surface variant="panel" data-simple-case-evidence-empty>
          <StateBlock
            title="No evidence linked yet."
            description={
              <>
                Use <em>Add evidence</em> above to link files, photos,
                videos, or documents to this case.
              </>
            }
          />
        </Surface>
      ) : (
        <>
          {/* Figma "Input" — 56px tall, 16px padding, 1px #E2E8F0,
              radius 8. The search really filters the list client-side
              by name / type / status / record id; semantics unchanged. */}
          <SearchField
            value={search}
            onValueChange={setSearch}
            placeholder="Search linked evidence by name, type, or record ID"
            ariaLabel="Search linked evidence"
            data-simple-case-evidence-search
          />

          {/* Figma "Row Item (Default)" — one white card per record,
              24px padding, radius 16, 24px gap between rows. */}
          <ul className="pv2-rows" data-simple-case-evidence-items>
            {visibleItems.map((item) => (
              <Surface
                as="li"
                variant="flush"
                key={item.id}
                className="pv2-row"
                data-simple-case-evidence-item={item.id}
              >
                <div className="pv2-row-main">
                  <h3
                    className="pv2-row-title"
                    data-simple-case-evidence-title
                    title={getDisplayTitle(item)}
                  >
                    {getDisplayTitle(item)}
                  </h3>
                  <div className="cc-muted pv2-row-meta">
                    <span className="pv2-row-meta-id">{item.id.slice(0, 8)}</span>
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
                <div className="pv2-row-actions">
                  <V2Button
                    tone="outline"
                    onClick={() => onOpenEvidence(item.id)}
                    data-simple-case-evidence-open={item.id}
                  >
                    Open
                  </V2Button>
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
                    className="pv2-btn pv2-btn--danger cases-remove-action"
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
              </Surface>
            ))}
          </ul>
          {visibleItems.length === 0 ? (
            <Surface variant="panel">
              <p
                className="cc-muted pv2-attention-text"
                data-simple-case-evidence-no-match
                style={{ margin: 0 }}
              >
                No linked evidence matches your search.
              </p>
            </Surface>
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
