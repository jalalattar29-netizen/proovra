"use client";

/**
 * Phase C1 — Matter Workspace (canonical tabbed surface).
 *
 * Consumes the Phase 32.8D matter envelope
 * (`GET /v1/cases/:id/matter-workspace`) and renders the eleven
 * operational facets the spec calls for:
 *
 *   Overview · Evidence · Timeline · Graph · Holds · Decisions ·
 *   Risk · Communications · Assignments · Audit · Export
 *
 * Each tab is a focused, read-mostly view onto one slice of the
 * envelope. Mutations (rename, status change, link/unlink evidence,
 * comment, etc.) continue to live on the existing
 * `CaseWorkspace.tsx` scroll-spy surface — this component is the
 * canonical operator-facing navigation layer above it, with
 * deliberate empty-state discipline.
 *
 * Hard rules:
 *   * Every section MUST render either real data, an operationally
 *     meaningful empty state, or a degraded-section badge. No blank
 *     panels.
 *   * Vocabulary discipline: never overclaims authenticity,
 *     admissibility, or legal status. Operational labels only.
 *   * Read-mostly. Action affordances delegate to existing audited
 *     per-domain endpoints. The Evidence Discussion + Reviewer
 *     inline actions live on their own audited surfaces; the
 *     `onOpenEvidence` callback opens the Evidence detail page for
 *     evidence-scoped mutations.
 *   * Phase G4.2 — the legacy classic scroll-spy surface is retired.
 *     `/cases/[id]/classic` redirects here.
 *   * No CSS framework dependency — uses inline styles + minimal
 *     existing utility classes so the component is portable.
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
// Phase 7B (visual-only) — canonical shared design-system primitives.
// PageShell/PageHeader/PageSection come from the barrel; Card / Button /
// Badge / EmptyState are DEEP-imported (the barrel serves the LEGACY
// four). No data-fetching, permission, or routing behaviour changes.
import { PageShell, PageHeader } from "../ui";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { EmptyState as UiEmptyState } from "../ui/EmptyState";
// Phase 6 (SCOPE B) — canonical case-assignment picker. The modal was
// already built (POST /v1/cases/:id/assignments) but orphaned; wiring
// it into the Assignments tab is the only missing piece.
import {
  AssignmentPickerModal,
  type AssignmentRole,
} from "./matter-modals";
import { GovernanceSummary } from "../governance/GovernanceSummary";
import { PresenceIndicator } from "../presence/PresenceIndicator";
import { CaseRiskPanel } from "../hidden-feature-panels/HiddenFeaturePanels";
// Phase Final-Closure-Verification — mount SiuPanel inside the matter
// workspace as a dedicated "SIU" tab. The component is the canonical
// surface for SIU profile + indicators + checklist + exports; it
// already calls the right backend endpoints and renders
// `reviewIndicators`. Prior to this mount SiuPanel was orphaned —
// the file existed and was tested but no host page imported it.
import { SiuPanel } from "../../app/(app)/cases/components/SiuPanel";
import { SiuWorklistPanel } from "../../app/(app)/cases/components/SiuWorklistPanel";

// =============================================================================
// Envelope shape (mirror of services/api/src/services/cases/matter-workspace.service.ts)
// =============================================================================

type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

type MatterEnvelope = {
  generatedAt: string;
  case: {
    id: string;
    name: string;
    referenceNumber: string | null;
    description: string | null;
    status: string;
    priority: string;
    scope: "PERSONAL" | "TEAM";
    ownerUserId: string;
    teamId: string | null;
    closedAtUtc: string | null;
    closureReason: string | null;
    createdAt: string;
    updatedAt: string;
  };
  viewer: {
    userId: string;
    role: string;
    canManage?: boolean;
    // Phase 6 (SCOPE B) — capability flags emitted by the backend
    // envelope (matter-workspace.service.ts `viewer`). `canAssign`
    // mirrors the canonical `evaluateCaseMutationPermission("ASSIGN")`
    // guard, so the Assignments tab renders the assign/unassign
    // controls exactly when the backend would accept the mutation.
    canAssign?: boolean;
    disabledReasons?: Readonly<Record<string, string>>;
    activeAssignmentRoles?: ReadonlyArray<string>;
  };
  risk: {
    status: SectionStatus;
    data: {
      riskScore?: number;
      riskLevel?: string;
      reasonCodes?: ReadonlyArray<string>;
      recommendedAction?: string | null;
    } | null;
    sampledAtUtc: string;
  };
  sections: {
    commandSummary: {
      status: SectionStatus;
      data: {
        linkedEvidenceCount: number;
        recentlyLinkedCount: number;
        activeCaseHoldsCount: number;
        affectedEvidenceHoldsCount: number;
        pendingReviewCount: number;
        openEscalationsCount: number;
        activeAssignmentCount: number;
      } | null;
    };
    evidence: {
      status: SectionStatus;
      items: ReadonlyArray<{
        id: string;
        title: string;
        type: string;
        status: string;
        verificationStatus: string | null;
        lifecycleState: string | null;
        createdAt: string;
        reportReady: boolean;
        packageReady: boolean;
        linkRole: string | null;
      }>;
    };
    relationships: {
      status: SectionStatus;
      links: ReadonlyArray<{
        id: string;
        evidenceId: string;
        role: string;
        source: string;
        linkedAtUtc: string;
      }>;
      relationships: ReadonlyArray<{
        id: string;
        sourceEvidenceId: string;
        targetEvidenceId: string;
        relationshipType: string;
        createdAt: string;
      }>;
      counts: {
        primary: number;
        supporting: number;
        related: number;
        duplicate: number;
        derived: number;
        context: number;
      };
    };
    workflows: {
      status: SectionStatus;
      items: ReadonlyArray<{
        id: string;
        workflowType: string;
        status: string;
        title: string;
        priority: string;
        dueAtUtc: string | null;
      }>;
    };
    reviewerCoordination: {
      status: SectionStatus;
      data: {
        queuedCount: number;
        assignedCount: number;
        inReviewCount: number;
        needsInfoCount: number;
        overdueCount: number;
        openEscalationsCount: number;
        unresolvedReviewerCommentsCount: number;
        unresolvedAnnotationsCount: number;
      } | null;
      escalations: ReadonlyArray<{
        id: string;
        evidenceId: string;
        severity: string;
        status: string;
        createdAt: string;
      }>;
    };
    governance: {
      status: SectionStatus;
      caseHolds: ReadonlyArray<{
        id: string;
        title: string;
        status: string;
        placedAtUtc: string;
        releasedAtUtc: string | null;
      }>;
      evidenceHolds: ReadonlyArray<{
        id: string;
        evidenceId: string;
        status: string;
        createdAt: string;
      }>;
      auditReadinessScore: number | null;
      blockerCount: number;
    };
    custodyAndIntegrity: {
      status: SectionStatus;
      lifecycleStateCounts: ReadonlyArray<{ lifecycleState: string; count: number }>;
      verificationStatusCounts: ReadonlyArray<{
        verificationStatus: string;
        count: number;
      }>;
      integritySnapshots: ReadonlyArray<{
        evidenceId: string;
        overallStatus: string;
        reasonCodes: ReadonlyArray<string>;
      }>;
      custodyEventTotals: { eventsLast30d: number };
    };
    timeline: {
      status: SectionStatus;
      items: ReadonlyArray<{
        id: string;
        family: string;
        eventType: string;
        severity: string;
        occurredAtUtc: string;
        summary: string;
        evidenceId: string | null;
      }>;
    };
    notes: {
      status: SectionStatus;
      caseComments: ReadonlyArray<{
        id: string;
        authorUserId: string;
        body: string;
        visibility: string;
        createdAt: string;
        resolvedAtUtc: string | null;
      }>;
      unresolvedReviewerComments: ReadonlyArray<{
        id: string;
        evidenceId: string;
        createdAt: string;
      }>;
      unresolvedAnnotations: ReadonlyArray<{
        id: string;
        evidenceId: string;
        createdAt: string;
      }>;
    };
    deliverables: {
      status: SectionStatus;
      reports: ReadonlyArray<{
        id: string;
        evidenceId: string;
        version: number;
        generatedAtUtc: string | null;
      }>;
      packages: ReadonlyArray<{
        id: string;
        evidenceId: string;
        version: number;
        generatedAtUtc: string | null;
      }>;
      externalReviewLinks: ReadonlyArray<{
        id: string;
        evidenceId: string;
        viewerType: string;
        createdAt: string;
      }>;
      counts: {
        reportsReady: number;
        packagesReady: number;
        deliverablesPending: number;
      };
    };
  };
  assignments: ReadonlyArray<{
    id: string;
    assignedToUserId: string;
    assignedByUserId: string;
    role: string;
    status: string;
    assignedAtUtc: string;
    removedAtUtc: string | null;
    note: string | null;
  }>;
  statusHistory: ReadonlyArray<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    changedByUserId: string;
    reason: string | null;
    changedAtUtc: string;
  }>;
};

// =============================================================================
// Tab catalog (bounded vocabulary)
// =============================================================================

type TabId =
  | "overview"
  | "evidence"
  | "timeline"
  | "graph"
  | "holds"
  | "decisions"
  | "risk"
  | "communications"
  | "assignments"
  | "siu"
  | "audit"
  | "export";

const TABS: ReadonlyArray<{
  id: TabId;
  label: string;
  description: string;
}> = [
  { id: "overview", label: "Overview", description: "At-a-glance matter posture" },
  { id: "evidence", label: "Evidence", description: "Evidence operations" },
  { id: "timeline", label: "Timeline", description: "Operational chronology" },
  { id: "graph", label: "Graph", description: "Evidence relationships" },
  { id: "holds", label: "Holds", description: "Legal + retention holds" },
  {
    id: "decisions",
    label: "Decisions",
    description: "Review decision history",
  },
  { id: "risk", label: "Risk", description: "Operational risk surface" },
  {
    // Phase IA-cleanup — the tab id stays "communications" (pinned by
    // phase-c1 contract tests + URL hash routing). The visible label
    // is reframed to "Discussion & Activity" because the tab actually
    // surfaces aggregated discussion threads (from /v1/cases/:id/
    // discussion-threads), case-level comments, reviewer comments,
    // and unresolved evidence annotations — all of which read more
    // honestly as "discussion + activity" than as "communications".
    // This is the post-/collaboration case-discussion surface.
    id: "communications",
    label: "Discussion & Activity",
    description: "Discussion threads, comments, and activity",
  },
  {
    id: "assignments",
    label: "Assignments",
    description: "Ownership + escalation routing",
  },
  // Phase Final-Closure-Verification — SIU tab. Hosts the canonical
  // `SiuPanel` (profile, checklist, indicators, follow-ups, saved
  // views, export preflight). The component was orphaned prior to
  // this mount despite a fully-wired backend at /v1/cases/:id/siu-*.
  {
    // Phase IA-self-serve-completion — "SIU" (Special Investigation
    // Unit) was an opaque acronym for lawyers / journalists. Renamed
    // to plain-language "Investigation profile". The tab id stays
    // `siu` so the keyboard shortcut (`g i`) and the underlying
    // SiuPanel + /v1/cases/:id/siu-* endpoints are unchanged.
    id: "siu",
    label: "Investigation profile",
    description: "Profile · checklist · indicators · export",
  },
  { id: "audit", label: "Audit", description: "Operational traceability" },
  { id: "export", label: "Export", description: "Report + Package readiness" },
];

// =============================================================================
// Scoped visual styling (Phase 7B, visual-only)
// =============================================================================

// The `.matter-tab*` class hooks in this component had NO CSS anywhere in
// the codebase before Phase 7B — the surface rendered with browser
// defaults. This scoped block styles the list/table/heading affordances
// with the shared design tokens so the tab bodies match the rest of the
// migrated console. All colour comes from `lib/design-tokens/tokens.css`
// variables (with the same fallbacks the shared primitives use).
const MATTER_WORKSPACE_CSS = `
.matter-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  border-radius: var(--radius-card, 14px);
  border: 1px solid var(--border-default, rgba(15,23,42,0.09));
  background: var(--surface-card, #ffffff);
  box-shadow: var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04));
}
/* The SIU tab hosts its own self-contained panel; don't double-frame it. */
.matter-tab--siu { padding: 0; border: none; background: transparent; box-shadow: none; }
.matter-tab h3 {
  margin: 4px 0 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--ink-primary, #0f172a);
}
.matter-tab__hint {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-secondary, #475569);
}
.matter-tab__inline-empty {
  margin: 0;
  font-size: 13px;
  color: var(--ink-muted, #94a3b8);
}
.matter-tab ul, .matter-tab ol { margin: 0; padding: 0; list-style: none; }
.matter-tab ul li, .matter-tab__timeline li {
  padding: 10px 12px;
  border: 1px solid var(--border-subtle, rgba(15,23,42,0.06));
  border-radius: var(--radius-md, 10px);
  background: var(--surface-card, #ffffff);
  font-size: 13px;
  color: var(--ink-primary, #0f172a);
  margin-bottom: 6px;
}
.matter-tab ul li:last-child, .matter-tab__timeline li:last-child { margin-bottom: 0; }
.matter-tab ul li a, .matter-tab__timeline li a {
  color: var(--status-info-fg, #1e40af);
  text-decoration: none;
  font-weight: 600;
}
.matter-tab ul li a:hover { text-decoration: underline; }
.matter-tab ul li span, .matter-tab ul li small {
  color: var(--ink-secondary, #475569);
}
.matter-tab ul li code, .matter-tab__reasons code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--ink-primary, #0f172a);
}
.matter-tab__counts { display: flex; flex-wrap: wrap; gap: 8px; }
.matter-tab__counts li { margin-bottom: 0 !important; }
.matter-tab__reasons { display: flex; flex-wrap: wrap; gap: 6px; }
.matter-tab__reasons li {
  padding: 4px 10px !important;
  border-radius: var(--radius-pill, 999px) !important;
  background: var(--surface-muted, #f1f4f9) !important;
  margin-bottom: 0 !important;
}
.matter-tab__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
  color: var(--ink-primary, #0f172a);
  border: 1px solid var(--border-default, rgba(15,23,42,0.09));
  border-radius: var(--radius-card, 14px);
  overflow: hidden;
}
.matter-tab__table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted, #94a3b8);
  background: var(--surface-header, #f8fafc);
  border-bottom: 1px solid var(--border-default, rgba(15,23,42,0.09));
}
.matter-tab__table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle, rgba(15,23,42,0.06));
  vertical-align: middle;
}
.matter-tab__table tbody tr { cursor: pointer; transition: background-color 140ms ease; }
.matter-tab__table tbody tr:hover { background: var(--surface-muted, #f1f4f9); }
.matter-tab__timeline li time {
  display: block;
  font-size: 11px;
  color: var(--ink-muted, #94a3b8);
}
.matter-tab__timeline-family, .matter-tab__timeline-type {
  font-size: 11px;
  color: var(--ink-secondary, #475569);
  margin-right: 8px;
}
.matter-tab__empty { display: block; }
`;

// =============================================================================
// Component
// =============================================================================

export function MatterWorkspace({
  caseId,
  onOpenEvidence,
}: {
  caseId: string;
  /** Open an evidence detail page from a Matter Workspace row. */
  onOpenEvidence?: (evidenceId: string) => void;
}) {
  const [envelope, setEnvelope] = useState<MatterEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  // Phase G2 (C1.3) — per-tab filter input. One bounded string the
  // tab function components consume to filter their rows client-side.
  // Server-side filtering is unnecessary because each envelope
  // section already arrives bounded ≤25 rows from the Phase 32.8D
  // aggregator.
  const [filterText, setFilterText] = useState("");
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // Phase G2 (C1.5) — `g`-prefixed two-key sequence handling so
  // operators can jump tabs via `g + e`, `g + t`, etc. The buffer
  // resets after ~1 second of inactivity.
  const goPrefixRef = useRef<{ pending: boolean; timeout: number | null }>({
    pending: false,
    timeout: null,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = (await apiFetch(
        `/v1/cases/${encodeURIComponent(caseId)}/matter-workspace`,
        { method: "GET" },
      )) as MatterEnvelope;
      setEnvelope(result);
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      setError(toSafeUserError(e, { message: "Matter workspace unavailable." }).message);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Phase G2 (C1.5) — Matter Workspace keyboard shortcuts. Handler
  // mounts on the document but ignores events whose target is an
  // input/textarea/contenteditable element so we never steal text
  // composition (search input, discussion composer, etc.).
  useEffect(() => {
    function isEditableTarget(t: EventTarget | null): boolean {
      if (!t || !(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
      }
      if (t.isContentEditable) return true;
      return false;
    }

    function clearGoPrefix() {
      goPrefixRef.current.pending = false;
      if (goPrefixRef.current.timeout != null) {
        window.clearTimeout(goPrefixRef.current.timeout);
        goPrefixRef.current.timeout = null;
      }
    }

    function handler(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;

      // Escape clears the pending `g` prefix and the filter input.
      if (e.key === "Escape") {
        clearGoPrefix();
        if (filterText.length > 0) {
          e.preventDefault();
          setFilterText("");
        }
        return;
      }

      // `/` focuses the active tab's filter input. Browsers usually
      // surface their own find on the unmodified key, so this is
      // only honored when no modifier is held.
      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        filterInputRef.current?.focus();
        return;
      }

      // `g`-prefixed tab jumps. After pressing `g`, the next key
      // selects the tab (e for evidence, t for timeline, etc.).
      if (goPrefixRef.current.pending) {
        const map: Record<string, TabId> = {
          o: "overview",
          e: "evidence",
          t: "timeline",
          g: "graph",
          h: "holds",
          d: "decisions",
          r: "risk",
          c: "communications",
          n: "assignments",
          a: "audit",
          x: "export",
        };
        const next = map[e.key.toLowerCase()];
        clearGoPrefix();
        if (next) {
          e.preventDefault();
          setActiveTab(next);
        }
        return;
      }
      if (e.key === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        goPrefixRef.current.pending = true;
        goPrefixRef.current.timeout = window.setTimeout(clearGoPrefix, 1200);
        return;
      }
    }

    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      clearGoPrefix();
    };
  }, [filterText.length]);

  const sectionStatus = useMemo<Record<TabId, SectionStatus>>(() => {
    if (!envelope) {
      return {
        overview: "ok",
        evidence: "ok",
        timeline: "ok",
        graph: "ok",
        holds: "ok",
        decisions: "ok",
        risk: "ok",
        communications: "ok",
        assignments: "ok",
        // Final Closure Remediation Part J — SIU tab status defaults
        // to "ok"; the SiuPanel manages its own load/empty/error
        // states independently of the matter envelope.
        siu: "ok",
        audit: "ok",
        export: "ok",
      };
    }
    return {
      overview: envelope.sections.commandSummary.status,
      evidence: envelope.sections.evidence.status,
      timeline: envelope.sections.timeline.status,
      graph: envelope.sections.relationships.status,
      holds: envelope.sections.governance.status,
      decisions: envelope.sections.workflows.status,
      risk: envelope.risk.status,
      communications: envelope.sections.notes.status,
      assignments: envelope.assignments.length > 0 ? "ok" : "not_applicable",
      // Final Closure Remediation Part J — SIU section is not part of
      // the canonical matter envelope; the SiuPanel manages its own
      // state. Default to "ok" so it doesn't render a degradation chip
      // on the tab strip.
      siu: "ok",
      audit: envelope.sections.custodyAndIntegrity.status,
      export: envelope.sections.deliverables.status,
    };
  }, [envelope]);

  if (loading) {
    return (
      <PageShell className="matter-workspace matter-workspace--loading">
        <Card variant="summary">
          <p style={{ margin: 0, color: "var(--ink-secondary, #475569)" }}>
            Loading matter workspace…
          </p>
        </Card>
      </PageShell>
    );
  }

  if (error || !envelope) {
    return (
      <PageShell className="matter-workspace matter-workspace--error">
        <Card variant="status" tone="risk">
          <p role="alert" style={{ margin: 0 }}>
            {error ?? "Matter workspace unavailable."}
          </p>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell
      className="matter-workspace"
      data-active-tab={activeTab}
      header={
        <PageHeader
          eyebrow="Matter Workspace"
          title={envelope.case.name}
          subtitle={
            <>
              {envelope.case.referenceNumber ?? "no reference number"} ·{" "}
              {envelope.case.priority} · {envelope.case.status}
            </>
          }
          contextStrip={
            /* Phase G3.1 — polling-based presence chip. Workspace +
               resource-id scoped server-side. Bounded payload — only
               {userId, displayName, lastSeenAtUtc} per viewer. */
            <PresenceIndicator
              teamId={envelope.case.teamId ?? null}
              resourceKind="matter"
              resourceId={envelope.case.id}
            />
          }
        />
      }
    >
      {/* Phase 7B (visual-only) — scoped token-driven styling for the
          matter-workspace class hooks. These classes previously had NO
          CSS anywhere in the app (the surface rendered unstyled); this
          block gives them the shared design-system look without a
          framework dependency and without touching frozen globals.css.
          Every class hook + data-* attribute in the JSX is preserved. */}
      <style>{MATTER_WORKSPACE_CSS}</style>
      <nav
        className="matter-workspace__tabs"
        role="tablist"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        {TABS.map((tab) => {
          const status = sectionStatus[tab.id];
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`matter-workspace__tab ${isActive ? "is-active" : ""}`}
              data-section-status={status}
              data-tab-id={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 2,
                textAlign: "left",
                padding: "8px 14px",
                borderRadius: "var(--radius-md, 10px)",
                cursor: "pointer",
                background: isActive
                  ? "var(--surface-card, #ffffff)"
                  : "transparent",
                border: isActive
                  ? "1px solid var(--border-default, rgba(15,23,42,0.09))"
                  : "1px solid transparent",
                boxShadow: isActive
                  ? "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))"
                  : "none",
                color: isActive
                  ? "var(--ink-primary, #0f172a)"
                  : "var(--ink-secondary, #475569)",
              }}
            >
              <strong style={{ fontSize: 13.5, fontWeight: 650 }}>
                {tab.label}
              </strong>
              <span
                className="matter-workspace__tab-desc"
                style={{ fontSize: 11, color: "var(--ink-muted, #94a3b8)" }}
              >
                {tab.description}
              </span>
              {status === "degraded" ? (
                <span className="matter-workspace__tab-degraded">
                  <Badge tone="pending" subtle>
                    degraded
                  </Badge>
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* Phase G2 (C1.3 + C1.5) — per-tab filter input + keyboard
          shortcut help. The filter is suppressed on the Overview /
          Graph / Risk tabs where it does not apply. */}
      {activeTab !== "overview" &&
      activeTab !== "graph" &&
      activeTab !== "risk" ? (
        <div
          className="matter-workspace__filter-row"
          data-matter-filter-row
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderRadius: "var(--radius-md, 10px)",
            border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
            background: "var(--surface-muted, #f1f4f9)",
            fontSize: 13,
          }}
        >
          <label
            htmlFor="matter-workspace-filter"
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              color: "var(--ink-muted, #94a3b8)",
            }}
          >
            FILTER
          </label>
          <input
            id="matter-workspace-filter"
            ref={filterInputRef}
            data-matter-filter-input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={`Filter ${activeTab}… ( / to focus, Esc to clear)`}
            style={{
              flex: 1,
              padding: "6px 10px",
              borderRadius: "var(--radius-sm, 6px)",
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
              fontSize: 13,
              background: "var(--surface-card, #ffffff)",
              color: "var(--ink-primary, #0f172a)",
            }}
          />
          <span
            data-matter-keyboard-hint
            style={{ fontSize: 11, color: "var(--ink-muted, #94a3b8)" }}
            title="g + letter to jump tabs (g+e Evidence, g+t Timeline, g+a Audit, g+x Export). / to filter. Esc to clear."
          >
            g+key jumps · / filter · Esc clear
          </span>
        </div>
      ) : null}

      <div className="matter-workspace__body">
        {activeTab === "overview" ? (
          <OverviewTab envelope={envelope} />
        ) : null}
        {activeTab === "evidence" ? (
          <EvidenceTab
            envelope={envelope}
            onOpenEvidence={onOpenEvidence}
            filterText={filterText}
          />
        ) : null}
        {activeTab === "timeline" ? (
          <TimelineTab envelope={envelope} filterText={filterText} />
        ) : null}
        {activeTab === "graph" ? <GraphTab envelope={envelope} /> : null}
        {activeTab === "holds" ? (
          <HoldsTab envelope={envelope} filterText={filterText} />
        ) : null}
        {activeTab === "decisions" ? (
          <DecisionsTab envelope={envelope} filterText={filterText} />
        ) : null}
        {activeTab === "risk" ? <RiskTab envelope={envelope} /> : null}
        {activeTab === "communications" ? (
          <CommunicationsTab envelope={envelope} filterText={filterText} />
        ) : null}
        {activeTab === "assignments" ? (
          <AssignmentsTab
            envelope={envelope}
            filterText={filterText}
            caseId={caseId}
            onChanged={() => void load()}
          />
        ) : null}
        {activeTab === "siu" ? (
          <div className="matter-tab matter-tab--siu" data-cc-matter-siu-tab>
            <SiuPanel caseId={envelope.case.id} />
            {/* PHASE 12 — VERTICAL B. Saved views + intake templates +
                the worklist they drive. Mounted alongside the per-case
                profile so an investigator can pivot from this claim to
                every claim matching the same operational condition. */}
            <SiuWorklistPanel teamId={envelope.case.teamId ?? null} />
          </div>
        ) : null}
        {activeTab === "audit" ? (
          <AuditTab envelope={envelope} filterText={filterText} />
        ) : null}
        {activeTab === "export" ? (
          <ExportTab envelope={envelope} filterText={filterText} />
        ) : null}
      </div>
    </PageShell>
  );
}

// =============================================================================
// Tabs
// =============================================================================

function OverviewTab({ envelope }: { envelope: MatterEnvelope }) {
  const s = envelope.sections.commandSummary.data;
  if (!s) {
    // Phase IA-self-serve-completion — rewrote degraded-state copy to
    // drop the internal store names in favour of plain language.
    // Other tabs still render even when this summary is unavailable.
    return (
      <EmptyState
        title="Case summary unavailable"
        body="The case summary couldn't load. Other tabs may still work. Try reloading the page; if this section stays empty, the case summary data may be temporarily unavailable."
      />
    );
  }
  // Phase Final-Hidden-Feature-Surfacing — CaseRiskSnapshot panel.
  // Renders the most recent risk row from `/v1/cases/:id/risk` so
  // operators see the durable risk score + reason codes directly on
  // the matter overview tab, not just inside the command center.
  const _caseId = envelope.case.id;
  // Phase G2 (G1.1) — derive matter-level governance summary inputs
  // from the existing envelope sections. The summary is a deterministic
  // projection — no extra fetches.
  const gov = envelope.sections.governance;
  const totalHolds =
    (gov.caseHolds?.length ?? 0) + (gov.evidenceHolds?.length ?? 0);
  return (
    <div className="matter-tab matter-tab--overview">
      <Grid>
        <Tile label="Linked evidence" value={s.linkedEvidenceCount} />
        <Tile label="Recently linked" value={s.recentlyLinkedCount} />
        <Tile label="Active case holds" value={s.activeCaseHoldsCount} />
        <Tile
          label="Affected evidence holds"
          value={s.affectedEvidenceHoldsCount}
        />
        <Tile label="Pending review" value={s.pendingReviewCount} />
        <Tile
          label="Open escalations"
          value={s.openEscalationsCount}
          tone={s.openEscalationsCount > 0 ? "warning" : "neutral"}
        />
        <Tile label="Active assignments" value={s.activeAssignmentCount} />
      </Grid>

      {/* Phase G2 (G1.1) — matter-level governance summary. Aggregates
          hold counts + retention + lifecycle posture without fetching
          extra data. */}
      <div style={{ marginTop: 12 }}>
        <GovernanceSummary
          variant="matter"
          activeHoldCount={totalHolds}
          hasActiveDestructionReview={
            (gov.evidenceHolds?.length ?? 0) > 0 &&
            envelope.sections.custodyAndIntegrity.integritySnapshots.length > 0
          }
        />
      </div>

      <p className="matter-tab__hint">
        Sampled {formatRelative(envelope.generatedAt)}. Drill into individual
        tabs for the underlying records.
      </p>

      {/* Phase Final-Hidden-Feature-Surfacing — durable matter risk
          snapshot. Real backend; bounded; loading/empty/error states. */}
      <div style={{ marginTop: 12 }}>
        <CaseRiskPanel caseId={_caseId} />
      </div>
    </div>
  );
}

type MatterEvidenceRequestRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  requestType: string;
  dueAtUtc: string | null;
  sentAtUtc: string | null;
  completion: {
    requiredTotal: number;
    requiredFulfilled: number;
    optionalTotal: number;
    optionalFulfilled: number;
    completionPercent: number;
    reviewReady: boolean;
    needsMoreInfo: boolean;
  };
};

type MatterEvidenceRequestsEnvelope = {
  caseId: string;
  teamId: string | null;
  requests: ReadonlyArray<MatterEvidenceRequestRow>;
  counts: {
    total: number;
    open: number;
    sent: number;
    inProgress: number;
    needsMoreInfo: number;
    fulfilled: number;
    closed: number;
  };
};

// Phase G2 (C1.3) — case-insensitive substring filter helper. The
// caller passes a free-form `filterText` and a `text(item)` projection;
// rows whose projection contains the filter (case-insensitive) are
// retained. Empty filter is a no-op (all rows pass).
function matchesFilter<T>(
  items: ReadonlyArray<T>,
  filterText: string,
  text: (item: T) => string,
): ReadonlyArray<T> {
  const q = filterText.trim().toLowerCase();
  if (q.length === 0) return items;
  return items.filter((item) => text(item).toLowerCase().includes(q));
}

function EvidenceTab({
  envelope,
  onOpenEvidence,
  filterText = "",
}: {
  envelope: MatterEnvelope;
  onOpenEvidence?: (evidenceId: string) => void;
  filterText?: string;
}) {
  const ev = envelope.sections.evidence;

  // Phase C3 — surface the matter's evidence requests above the
  // linked-evidence table so reviewers can see intake readiness at
  // a glance and drill into the per-request inspector.
  const [requests, setRequests] = useState<
    MatterEvidenceRequestsEnvelope | { error: string } | null
  >(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await apiFetch(
          `/v1/cases/${encodeURIComponent(envelope.case.id)}/evidence-requests`,
        )) as MatterEvidenceRequestsEnvelope;
        if (alive) setRequests(data);
      } catch (err) {
        const e = err as { message?: string };
        if (alive)
          setRequests({ error: toSafeUserError(e, { message: "Could not load requests." }).message });
      }
    })();
    return () => {
      alive = false;
    };
  }, [envelope.case.id]);

  const requestRows =
    requests && !("error" in requests) ? requests.requests : [];
  const requestCounts =
    requests && !("error" in requests) ? requests.counts : null;

  if (ev.items.length === 0 && requestRows.length === 0) {
    return (
      <EmptyState
        title="No evidence linked yet"
        body="Link evidence from the Evidence Library or issue an Evidence Request via the intake operations surface. Evidence linked here forms the operational basis for review, hold, and export decisions."
      />
    );
  }
  return (
    <div className="matter-tab matter-tab--evidence">
      {/* Phase C3 — Evidence Requests sub-section. Bounded surfacing
          of operational intake readiness for this matter. */}
      <h3>
        Evidence requests ({requestRows.length}
        {requestCounts && requestCounts.needsMoreInfo > 0
          ? ` · ${requestCounts.needsMoreInfo} needs more info`
          : ""}
        )
      </h3>
      {requests && "error" in requests ? (
        <p className="matter-tab__inline-empty">{requests.error}</p>
      ) : !requests ? (
        <p className="matter-tab__inline-empty">Loading requests…</p>
      ) : requestRows.length === 0 ? (
        <p className="matter-tab__inline-empty">
          No evidence requests for this matter. Issue a request from the
          intake operations surface to drive structured evidence collection.
        </p>
      ) : (
        <ul data-matter-evidence-requests>
          {requestRows.slice(0, 25).map((r) => (
            <li
              key={r.id}
              data-matter-evidence-request={r.id}
              data-request-status={r.status}
              data-request-review-ready={r.completion.reviewReady ? "true" : "false"}
              data-request-needs-more-info={r.completion.needsMoreInfo ? "true" : "false"}
            >
              <a href={`/evidence-requests/${encodeURIComponent(r.id)}`}>
                <strong>{r.title}</strong>
              </a>
              <span>
                {" · "}
                {r.status}
                {" · "}
                {r.completion.requiredFulfilled}/{r.completion.requiredTotal}{" "}
                required
                {" · "}
                {r.completion.completionPercent}% complete
                {r.completion.needsMoreInfo ? " · needs more info" : ""}
                {r.completion.reviewReady ? " · review-ready" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Existing C1 linked-evidence table. */}
      <h3>Linked evidence ({ev.items.length})</h3>
      {ev.items.length === 0 ? (
        <p className="matter-tab__inline-empty">
          No evidence linked yet. Link evidence from the workspace library
          via the Evidence detail surface.
        </p>
      ) : (
        <table className="matter-tab__table" role="grid">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Status</th>
              <th>Verification</th>
              <th>Lifecycle</th>
              <th>Link role</th>
              <th>Artifacts</th>
            </tr>
          </thead>
          <tbody>
            {matchesFilter(
              ev.items,
              filterText,
              (it) =>
                `${it.title ?? ""} ${it.type ?? ""} ${it.status ?? ""} ${it.verificationStatus ?? ""} ${it.lifecycleState ?? ""} ${it.linkRole ?? ""}`,
            ).map((it) => (
              <tr key={it.id} onClick={() => onOpenEvidence?.(it.id)}>
                <td>{it.title || it.id}</td>
                <td>{it.type}</td>
                <td>{it.status}</td>
                <td>{it.verificationStatus ?? "—"}</td>
                <td>{it.lifecycleState ?? "—"}</td>
                <td>{it.linkRole ?? "—"}</td>
                <td>
                  {it.reportReady ? "Report PDF" : "—"}
                  {it.packageReady ? " · Verification Package ZIP" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TimelineTab({
  envelope,
  filterText = "",
}: {
  envelope: MatterEnvelope;
  filterText?: string;
}) {
  const tl = envelope.sections.timeline;
  if (tl.items.length === 0) {
    return (
      <EmptyState
        title="No events recorded yet"
        body="Operational events appear here as evidence is linked, reviews progress, holds are placed, and exports are generated. The timeline orders events deterministically by occurrence time."
      />
    );
  }
  return (
    <ol className="matter-tab__timeline">
      {matchesFilter(
        tl.items,
        filterText,
        (e) => `${e.family} ${e.eventType} ${e.severity} ${e.summary}`,
      ).map((ev) => (
        <li key={ev.id} data-severity={ev.severity}>
          <time>{formatRelative(ev.occurredAtUtc)}</time>
          <span className="matter-tab__timeline-family">{ev.family}</span>
          <span className="matter-tab__timeline-type">{ev.eventType}</span>
          <p>{ev.summary}</p>
        </li>
      ))}
    </ol>
  );
}

function GraphTab({ envelope }: { envelope: MatterEnvelope }) {
  const rel = envelope.sections.relationships;
  if (rel.relationships.length === 0 && rel.links.length === 0) {
    return (
      <EmptyState
        title="No relationships mapped yet"
        body="The relationship graph is populated when reviewers explicitly link evidence (e.g., 'primary', 'supporting', 'derived') or when the analyzer detects similarity. Empty here means no relationships have been recorded — not that the underlying evidence is unrelated."
      />
    );
  }
  return (
    <div className="matter-tab matter-tab--graph">
      <Grid>
        <Tile label="Primary" value={rel.counts.primary} />
        <Tile label="Supporting" value={rel.counts.supporting} />
        <Tile label="Related" value={rel.counts.related} />
        <Tile label="Duplicate" value={rel.counts.duplicate} />
        <Tile label="Derived" value={rel.counts.derived} />
        <Tile label="Context" value={rel.counts.context} />
      </Grid>
      <p className="matter-tab__hint">
        {rel.relationships.length} relationships across {rel.links.length}{" "}
        linked items. The interactive graph view lives in the Investigation
        Graph surface.
      </p>
    </div>
  );
}

function HoldsTab({
  envelope,
  filterText = "",
}: {
  envelope: MatterEnvelope;
  filterText?: string;
}) {
  const gov = envelope.sections.governance;
  if (gov.caseHolds.length === 0 && gov.evidenceHolds.length === 0) {
    // Phase IA-self-serve-completion — dropped the references to
    // "governance surface" and "parent organization's retention
    // template" (both ENTERPRISE_ONLY surfaces) and to "step-up
    // required" jargon. Sensitive holds may still require an extra
    // confirmation, but that's surfaced inline when the user
    // attempts the action, not advertised in an empty state.
    return (
      <div className="matter-tab matter-tab--holds">
        <EmptyState
          title="No holds active"
          body="No legal or retention holds apply to this case or its evidence. Place a hold when you need to stop records being deleted or destroyed."
        />
        {/* PHASE 12B CLUSTER 8 — ONE Legal-Hold surface. Placing and
            releasing holds happens in one place for every scope. */}
        <p className="matter-tab__hint">
          <a href="/evidence-lifecycle/legal-holds" data-legal-holds-link>
            Manage legal holds
          </a>
        </p>
      </div>
    );
  }
  // Phase G3.2 — per-tab filter wiring. Each row's projection composes
  // the strings the operator is likely to scan against.
  const filteredCaseHolds = matchesFilter(
    gov.caseHolds,
    filterText,
    (h) => `${h.title ?? ""} ${h.status ?? ""}`,
  );
  const filteredEvidenceHolds = matchesFilter(
    gov.evidenceHolds,
    filterText,
    (h) => `${h.evidenceId ?? ""} ${h.status ?? ""}`,
  );
  return (
    <div className="matter-tab matter-tab--holds">
      {/* PHASE 12B CLUSTER 8 — case-level holds now come from the ONE
          canonical Legal-Hold authority (canonical CASE-scoped rows plus any
          legacy row not yet converted), and placing/releasing happens on the
          single Legal Holds surface. */}
      <p className="matter-tab__hint">
        <a href="/evidence-lifecycle/legal-holds" data-legal-holds-link>
          Manage legal holds
        </a>
      </p>
      <h3>Case-level holds</h3>
      {filteredCaseHolds.length === 0 ? (
        <p className="matter-tab__inline-empty">No case-level holds.</p>
      ) : (
        <ul>
          {filteredCaseHolds.map((h) => (
            <li key={h.id}>
              <strong>{h.title}</strong>
              <span>
                {" · "}
                {h.status}
                {" · placed "}
                {formatRelative(h.placedAtUtc)}
                {h.releasedAtUtc
                  ? ` · released ${formatRelative(h.releasedAtUtc)}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3>Evidence-level holds ({filteredEvidenceHolds.length})</h3>
      {filteredEvidenceHolds.length === 0 ? (
        <p className="matter-tab__inline-empty">
          No evidence-level holds inherited or applied.
        </p>
      ) : (
        <ul>
          {filteredEvidenceHolds.slice(0, 25).map((h) => (
            <li key={h.id}>
              <code>{h.evidenceId}</code>
              <span>
                {" · "}
                {h.status}
                {" · "}
                {formatRelative(h.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {typeof gov.auditReadinessScore === "number" ? (
        <p className="matter-tab__hint">
          Audit readiness score: {gov.auditReadinessScore} (
          {gov.blockerCount} blockers).
        </p>
      ) : null}
    </div>
  );
}

function DecisionsTab({
  envelope,
  filterText = "",
}: {
  envelope: MatterEnvelope;
  filterText?: string;
}) {
  const wf = envelope.sections.workflows;
  const escalations = envelope.sections.reviewerCoordination.escalations;
  if (wf.items.length === 0 && escalations.length === 0) {
    // Phase IA-self-serve-completion — replaced identity-engineering
    // / feature-flag jargon with plain language. The underlying
    // behaviour (sensitive decisions may require an additional
    // confirmation step when configured) is unchanged; the copy just
    // describes it in words a lawyer / journalist can act on.
    return (
      <EmptyState
        title="No review decisions yet"
        body="Decisions and escalations appear here once people act on linked evidence. Sensitive decisions (approval, rejection) may require an additional confirmation step when configured by your team."
      />
    );
  }
  const filteredWorkflows = matchesFilter(
    wf.items,
    filterText,
    (w) =>
      `${w.title ?? ""} ${w.workflowType ?? ""} ${w.status ?? ""} ${w.priority ?? ""}`,
  );
  const filteredEscalations = matchesFilter(
    escalations,
    filterText,
    (e) => `${e.evidenceId ?? ""} ${e.severity ?? ""} ${e.status ?? ""}`,
  );
  return (
    <div className="matter-tab matter-tab--decisions">
      <h3>Active workflows ({filteredWorkflows.length})</h3>
      {filteredWorkflows.length === 0 ? (
        <p className="matter-tab__inline-empty">No active review workflows.</p>
      ) : (
        <ul>
          {filteredWorkflows.slice(0, 25).map((w) => (
            <li key={w.id}>
              <strong>{w.title}</strong>
              <span>
                {" · "}
                {w.workflowType}
                {" · "}
                {w.status}
                {" · priority "}
                {w.priority}
                {w.dueAtUtc ? ` · due ${formatRelative(w.dueAtUtc)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3>Open escalations ({filteredEscalations.length})</h3>
      {filteredEscalations.length === 0 ? (
        <p className="matter-tab__inline-empty">No open escalations.</p>
      ) : (
        <ul>
          {filteredEscalations.slice(0, 25).map((e) => (
            <li key={e.id} data-severity={e.severity}>
              <code>{e.evidenceId}</code>
              <span>
                {" · "}
                {e.severity}
                {" · "}
                {e.status}
                {" · "}
                {formatRelative(e.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RiskTab({ envelope }: { envelope: MatterEnvelope }) {
  const r = envelope.risk;
  if (!r.data) {
    return (
      <EmptyState
        title="Risk projection unavailable"
        body="The risk projection is a deterministic, explainable rollup of integrity, custody, review, escalation, SLA, governance, and export-readiness signals. It refreshes periodically; if it is unavailable here, retry shortly. The matter's evidence remains operational regardless of this projection."
      />
    );
  }
  return (
    <div className="matter-tab matter-tab--risk">
      <p>
        <strong>Risk level:</strong> {r.data.riskLevel ?? "—"}
        {typeof r.data.riskScore === "number"
          ? ` (score ${r.data.riskScore})`
          : ""}
      </p>
      {r.data.recommendedAction ? (
        <p className="matter-tab__hint">
          Recommended next operational action: {r.data.recommendedAction}
        </p>
      ) : null}
      {r.data.reasonCodes && r.data.reasonCodes.length > 0 ? (
        <ul className="matter-tab__reasons">
          {r.data.reasonCodes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="matter-tab__inline-empty">No reason codes recorded.</p>
      )}
      <p className="matter-tab__hint">
        Sampled {formatRelative(r.sampledAtUtc)}. This projection is operational
        decision support — it never asserts factual truth, authorship, or legal
        status.
      </p>
    </div>
  );
}

type MatterDiscussionThread = {
  id: string;
  evidenceId: string;
  kind: string;
  status: string;
  title: string;
  assignedToUserId: string | null;
  escalatedAtUtc: string | null;
  resolvedAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
};

type MatterDiscussionEnvelope = {
  caseId: string;
  teamId: string | null;
  threads: ReadonlyArray<MatterDiscussionThread>;
  counts: {
    total: number;
    open: number;
    inProgress: number;
    resolved: number;
    closed: number;
    escalated: number;
  };
};

function CommunicationsTab({
  envelope,
  filterText = "",
}: {
  envelope: MatterEnvelope;
  filterText?: string;
}) {
  const n = envelope.sections.notes;
  // Phase C2 — surface the Phase 16 discussion thread aggregator
  // alongside comments/annotations so reviewers see ALL matter-anchored
  // operational communication in one place.
  const [threads, setThreads] = useState<
    MatterDiscussionEnvelope | { error: string } | null
  >(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await apiFetch(
          `/v1/cases/${encodeURIComponent(envelope.case.id)}/discussion-threads`,
        )) as MatterDiscussionEnvelope;
        if (alive) setThreads(data);
      } catch (err) {
        const e = err as { message?: string };
        if (alive)
          setThreads({ error: toSafeUserError(e, { message: "Could not load threads." }).message });
      }
    })();
    return () => {
      alive = false;
    };
  }, [envelope.case.id]);

  const discussionThreads =
    threads && !("error" in threads) ? threads.threads : [];
  const discussionCounts =
    threads && !("error" in threads) ? threads.counts : null;

  // Phase G3.2 — per-row filter wiring across all four communication
  // sub-sections.
  const filteredThreads = matchesFilter(
    discussionThreads,
    filterText,
    (t) => `${t.title ?? ""} ${t.kind ?? ""} ${t.status ?? ""}`,
  );
  const filteredCaseComments = matchesFilter(
    n.caseComments,
    filterText,
    (c) => `${c.body ?? ""} ${c.visibility ?? ""}`,
  );
  const filteredReviewerComments = matchesFilter(
    n.unresolvedReviewerComments,
    filterText,
    (c) => `${c.evidenceId ?? ""}`,
  );

  if (
    n.caseComments.length === 0 &&
    n.unresolvedReviewerComments.length === 0 &&
    n.unresolvedAnnotations.length === 0 &&
    discussionThreads.length === 0
  ) {
    return (
      // Phase IA-cleanup — tab-level empty state. Discussion threads
      // are anchored to evidence (not directly to the case), so the
      // canonical way to start one is from any evidence's Discussion
      // tab. This copy is honest about that pattern instead of
      // implying case-level thread creation exists.
      <EmptyState
        title="No discussion activity yet"
        body="Start a discussion from an evidence record in this case. Discussion threads, case-level comments, reviewer comments, and evidence annotations all surface here once they exist. Activity is workspace-scoped and audit-safe — it never appears on public verify pages."
      />
    );
  }
  return (
    <div className="matter-tab matter-tab--communications">
      <h3>
        Discussion threads ({discussionThreads.length}
        {discussionCounts ? ` · ${discussionCounts.escalated} escalated` : ""})
      </h3>
      {threads && "error" in threads ? (
        <p className="matter-tab__inline-empty">{threads.error}</p>
      ) : !threads ? (
        <p className="matter-tab__inline-empty">Loading threads…</p>
      ) : discussionThreads.length === 0 ? (
        <p className="matter-tab__inline-empty">
          No discussion threads on linked evidence yet. Reviewers can open
          a thread from any evidence's Discussion tab to coordinate
          operationally without leaving the matter context.
        </p>
      ) : (
        <ul data-matter-discussion-threads>
          {filteredThreads.slice(0, 25).map((t) => (
            <li
              key={t.id}
              data-matter-discussion-thread={t.id}
              data-thread-status={t.status}
              data-thread-escalated={t.escalatedAtUtc ? "true" : "false"}
            >
              <a
                href={`/evidence/${encodeURIComponent(
                  t.evidenceId,
                )}?tab=discussion&thread=${encodeURIComponent(t.id)}`}
              >
                <strong>{t.title}</strong>
              </a>
              <span>
                {" · "}
                {t.kind}
                {" · "}
                {t.status}
                {t.escalatedAtUtc ? " · escalated" : ""}
                {" · updated "}
                {formatRelative(t.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Case-level comments ({filteredCaseComments.length})</h3>
      {filteredCaseComments.length === 0 ? (
        <p className="matter-tab__inline-empty">No case-level comments.</p>
      ) : (
        <ul>
          {filteredCaseComments.slice(0, 25).map((c) => (
            <li key={c.id}>
              <em>{c.visibility}</em>
              <span> · {formatRelative(c.createdAt)}</span>
              <p>{c.body}</p>
              {c.resolvedAtUtc ? (
                <small>resolved {formatRelative(c.resolvedAtUtc)}</small>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <h3>
        Unresolved reviewer comments ({filteredReviewerComments.length})
      </h3>
      {filteredReviewerComments.length === 0 ? (
        <p className="matter-tab__inline-empty">
          No unresolved reviewer comments.
        </p>
      ) : (
        <ul>
          {filteredReviewerComments.slice(0, 25).map((c) => (
            <li key={c.id}>
              <code>{c.evidenceId}</code>
              <span> · {formatRelative(c.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssignmentsTab({
  envelope,
  filterText = "",
  caseId,
  onChanged,
}: {
  envelope: MatterEnvelope;
  filterText?: string;
  // Phase 6 (SCOPE B) — the interactive assign/unassign controls need
  // the case id (for the write endpoints) and a refetch callback so the
  // list refreshes after a mutation without a full page reload.
  caseId: string;
  onChanged: () => void;
}) {
  const assignments = envelope.assignments;
  // Phase 6 (SCOPE B) — the backend already emits `viewer.canAssign`
  // from the SAME canonical guard the write routes enforce
  // (evaluateCaseMutationPermission("ASSIGN")). We render the manage
  // controls only when the mutation would actually be accepted, and
  // never on PERSONAL-scope cases (which reject assignment server-side).
  const canAssign =
    envelope.viewer.canAssign === true && envelope.case.scope === "TEAM";
  const assignDisabledReason =
    envelope.viewer.disabledReasons?.["ASSIGN"] ?? null;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Mirror the review-operations assign shape: a single audited POST to
  // the canonical /assignments endpoint. Returns `{ ok }` so the modal
  // stays open on failure for a retry. Errors are surfaced through the
  // sanctioned toSafeUserError path only.
  const submitAssignment = useCallback(
    async (input: {
      userId: string;
      role: AssignmentRole;
      note: string | null;
    }): Promise<{ ok: boolean }> => {
      setBanner(null);
      try {
        await apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/assignments`, {
          method: "POST",
          body: JSON.stringify({
            assignedToUserId: input.userId,
            role: input.role,
            note: input.note,
          }),
        });
        onChanged();
        return { ok: true };
      } catch (err) {
        const e = err as { message?: string };
        setBanner(
          toSafeUserError(e, {
            message: "Unable to add the assignment.",
          }).message,
        );
        return { ok: false };
      }
    },
    [caseId, onChanged],
  );

  // Unassign = canonical DELETE (soft REMOVE + audit) on the existing
  // assignment row. Never mutates case ownership, custody, or evidence.
  const unassign = useCallback(
    async (assignmentId: string) => {
      setBanner(null);
      setRemovingId(assignmentId);
      try {
        await apiFetch(
          `/v1/cases/${encodeURIComponent(caseId)}/assignments/${encodeURIComponent(assignmentId)}`,
          { method: "DELETE" },
        );
        onChanged();
      } catch (err) {
        const e = err as { message?: string };
        setBanner(
          toSafeUserError(e, {
            message: "Unable to remove the assignment.",
          }).message,
        );
      } finally {
        setRemovingId(null);
      }
    },
    [caseId, onChanged],
  );

  const active = matchesFilter(
    assignments.filter((a) => a.status === "ACTIVE"),
    filterText,
    (a) =>
      `${a.role ?? ""} ${a.assignedToUserId ?? ""} ${a.note ?? ""} ${a.status ?? ""}`,
  );
  const removed = matchesFilter(
    assignments.filter((a) => a.status !== "ACTIVE"),
    filterText,
    (a) => `${a.role ?? ""} ${a.assignedToUserId ?? ""} ${a.status ?? ""}`,
  );

  const assignButton = canAssign ? (
    <Button
      variant="primary"
      size="sm"
      data-matter-assignments-add
      onClick={() => setPickerOpen(true)}
    >
      Assign teammate
    </Button>
  ) : (
    <Button
      variant="secondary"
      size="sm"
      data-matter-assignments-add
      data-disabled="true"
      disabled
      title={
        assignDisabledReason ??
        (envelope.case.scope === "PERSONAL"
          ? "Personal cases do not support assignments. Switch to a team workspace."
          : "You need a manage-level role to change assignments.")
      }
    >
      Assign teammate
    </Button>
  );

  return (
    <div className="matter-tab matter-tab--assignments">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0 }}>Active assignments ({active.length})</h3>
        {assignButton}
      </div>

      {banner ? (
        <div
          className="cc-section-note"
          role="alert"
          data-matter-assignments-error
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            borderRadius: "var(--radius-md, 10px)",
            border: "1px solid var(--status-risk-border, #fecaca)",
            background: "var(--status-risk-bg, #fef2f2)",
            color: "var(--status-risk-fg, #991b1b)",
            fontSize: 13,
          }}
        >
          {banner}
        </div>
      ) : null}

      {active.length === 0 ? (
        <EmptyState
          title="No assignments yet"
          body={
            canAssign
              ? "Assign a teammate to this case using the button above. The assignment history shows here once someone is assigned."
              : "No one is assigned to this case yet. A workspace Owner or Admin (or the case OWNER) can assign teammates."
          }
        />
      ) : (
        <ul>
          {active.map((a) => (
            <li key={a.id} data-matter-assignment-row={a.id}>
              <strong>{a.role}</strong>
              <span> · {a.assignedToUserId}</span>
              <small> · assigned {formatRelative(a.assignedAtUtc)}</small>
              {a.note ? <p>{a.note}</p> : null}
              {canAssign ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-matter-assignment-unassign={a.id}
                  disabled={removingId === a.id}
                  onClick={() => void unassign(a.id)}
                  style={{ marginLeft: 8 }}
                >
                  {removingId === a.id ? "Removing…" : "Unassign"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {removed.length > 0 ? (
        <>
          <h3>History ({removed.length})</h3>
          <ul>
            {removed.slice(0, 25).map((a) => (
              <li key={a.id}>
                <span>{a.role}</span>
                <span> · {a.assignedToUserId}</span>
                {a.removedAtUtc ? (
                  <small> · removed {formatRelative(a.removedAtUtc)}</small>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <AssignmentPickerModal
        open={pickerOpen}
        caseId={caseId}
        onClose={() => setPickerOpen(false)}
        onSubmit={submitAssignment}
      />
    </div>
  );
}

function AuditTab({
  envelope,
  filterText = "",
}: {
  envelope: MatterEnvelope;
  filterText?: string;
}) {
  const ci = envelope.sections.custodyAndIntegrity;
  const filteredSnapshots = matchesFilter(
    ci.integritySnapshots,
    filterText,
    (s) =>
      `${s.evidenceId ?? ""} ${s.overallStatus ?? ""} ${(s.reasonCodes ?? []).join(" ")}`,
  );
  const filteredLifecycle = matchesFilter(
    ci.lifecycleStateCounts,
    filterText,
    (c) => `${c.lifecycleState ?? ""}`,
  );
  const filteredVerification = matchesFilter(
    ci.verificationStatusCounts,
    filterText,
    (c) => `${c.verificationStatus ?? ""}`,
  );
  if (
    ci.integritySnapshots.length === 0 &&
    ci.custodyEventTotals.eventsLast30d === 0
  ) {
    return (
      <EmptyState
        title="No audit activity in the last 30 days"
        body="Audit visibility consolidates custody events, integrity snapshots, and lifecycle counts. Quiet here means no recorded changes — not that the matter is inactive. Recent activity from the broader workspace appears in the Timeline tab."
      />
    );
  }
  return (
    <div className="matter-tab matter-tab--audit">
      <Grid>
        <Tile
          label="Custody events (30d)"
          value={ci.custodyEventTotals.eventsLast30d}
        />
      </Grid>
      <h3>Lifecycle states</h3>
      {filteredLifecycle.length === 0 ? (
        <p className="matter-tab__inline-empty">
          No lifecycle state breakdown available.
        </p>
      ) : (
        <ul className="matter-tab__counts">
          {filteredLifecycle.map((c) => (
            <li key={c.lifecycleState}>
              <code>{c.lifecycleState}</code>
              <span> · {c.count}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>Verification statuses</h3>
      {filteredVerification.length === 0 ? (
        <p className="matter-tab__inline-empty">
          No verification status breakdown available.
        </p>
      ) : (
        <ul className="matter-tab__counts">
          {filteredVerification.map((c) => (
            <li key={c.verificationStatus}>
              <code>{c.verificationStatus}</code>
              <span> · {c.count}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>Integrity snapshots ({filteredSnapshots.length})</h3>
      {filteredSnapshots.length === 0 ? (
        <p className="matter-tab__inline-empty">
          No integrity snapshots recorded.
        </p>
      ) : (
        <ul>
          {filteredSnapshots.slice(0, 25).map((s) => (
            <li key={s.evidenceId} data-status={s.overallStatus}>
              <code>{s.evidenceId}</code>
              <span> · {s.overallStatus}</span>
              {s.reasonCodes.length > 0 ? (
                <small> · {s.reasonCodes.join(", ")}</small>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExportTab({
  envelope,
  filterText = "",
}: {
  envelope: MatterEnvelope;
  filterText?: string;
}) {
  const d = envelope.sections.deliverables;
  const filteredReports = matchesFilter(
    d.reports,
    filterText,
    (r) => `${r.evidenceId ?? ""} ${r.version ?? ""}`,
  );
  const filteredPackages = matchesFilter(
    d.packages,
    filterText,
    (p) => `${p.evidenceId ?? ""} ${p.version ?? ""}`,
  );
  const filteredLinks = matchesFilter(
    d.externalReviewLinks,
    filterText,
    (l) => `${l.evidenceId ?? ""} ${l.viewerType ?? ""}`,
  );
  if (
    d.reports.length === 0 &&
    d.packages.length === 0 &&
    d.externalReviewLinks.length === 0
  ) {
    return (
      <EmptyState
        title="No deliverables ready"
        body="Report PDFs and Verification Package ZIPs are generated per-evidence after finalization. When ready, they appear here with their version + generation time. The Report PDF and the Verification Package ZIP are distinct artifacts (Phase A2 vocabulary) — neither is a substitute for the other."
      />
    );
  }
  return (
    <div className="matter-tab matter-tab--export">
      <Grid>
        <Tile label="Report PDFs ready" value={d.counts.reportsReady} />
        <Tile
          label="Verification Package ZIPs ready"
          value={d.counts.packagesReady}
        />
        <Tile label="Pending deliverables" value={d.counts.deliverablesPending} />
      </Grid>
      <h3>Report PDFs ({filteredReports.length})</h3>
      {filteredReports.length === 0 ? (
        <p className="matter-tab__inline-empty">No Report PDFs generated.</p>
      ) : (
        <ul>
          {filteredReports.slice(0, 25).map((r) => (
            <li key={r.id}>
              <code>{r.evidenceId}</code>
              <span>
                {" · v"}
                {r.version}
                {r.generatedAtUtc
                  ? ` · ${formatRelative(r.generatedAtUtc)}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3>Verification Package ZIPs ({filteredPackages.length})</h3>
      {filteredPackages.length === 0 ? (
        <p className="matter-tab__inline-empty">
          No Verification Package ZIPs generated.
        </p>
      ) : (
        <ul>
          {filteredPackages.slice(0, 25).map((p) => (
            <li key={p.id}>
              <code>{p.evidenceId}</code>
              <span>
                {" · v"}
                {p.version}
                {p.generatedAtUtc
                  ? ` · ${formatRelative(p.generatedAtUtc)}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3>External review links ({filteredLinks.length})</h3>
      {filteredLinks.length === 0 ? (
        <p className="matter-tab__inline-empty">No external review links.</p>
      ) : (
        <ul>
          {filteredLinks.slice(0, 25).map((l) => (
            <li key={l.id}>
              <code>{l.evidenceId}</code>
              <span> · {l.viewerType}</span>
              <small> · {formatRelative(l.createdAt)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "neutral" | "warning";
}) {
  const warn = tone === "warning";
  return (
    <div
      className="matter-tab__tile"
      data-tone={tone ?? "neutral"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "12px 14px",
        borderRadius: "var(--radius-md, 10px)",
        border: warn
          ? "1px solid var(--status-pending-border, #fde68a)"
          : "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
        background: warn
          ? "var(--status-pending-bg, #fef3c7)"
          : "var(--surface-muted, #f1f4f9)",
      }}
    >
      <span
        className="matter-tab__tile-label"
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: warn
            ? "var(--status-pending-fg, #78350f)"
            : "var(--ink-muted, #94a3b8)",
        }}
      >
        {label}
      </span>
      <strong
        className="matter-tab__tile-value"
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: warn
            ? "var(--status-pending-fg, #78350f)"
            : "var(--ink-primary, #0f172a)",
        }}
      >
        {value}
      </strong>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="matter-tab__grid"
      style={{
        display: "grid",
        gap: 10,
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  // Phase 7B — visual shell now delegates to the shared design-system
  // EmptyState (framed, token-driven). Copy + honesty discipline is
  // unchanged; `body` maps to the shared `purpose` slot.
  return (
    <div className="matter-tab__empty" role="status">
      <UiEmptyState title={title} purpose={body} framed compact />
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return iso;
  }
}
