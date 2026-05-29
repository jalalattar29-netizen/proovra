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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
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
    id: "communications",
    label: "Communications",
    description: "Notes + comments + annotations",
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
    id: "siu",
    label: "SIU",
    description: "SIU profile · checklist · indicators · export",
  },
  { id: "audit", label: "Audit", description: "Operational traceability" },
  { id: "export", label: "Export", description: "Report + Package readiness" },
];

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
      setError(e.message ?? "Matter workspace unavailable.");
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
      <section className="matter-workspace matter-workspace--loading">
        <p>Loading matter workspace…</p>
      </section>
    );
  }

  if (error || !envelope) {
    return (
      <section className="matter-workspace matter-workspace--error" role="alert">
        <p>{error ?? "Matter workspace unavailable."}</p>
      </section>
    );
  }

  return (
    <section className="matter-workspace" data-active-tab={activeTab}>
      <header className="matter-workspace__header">
        <div>
          <h1>{envelope.case.name}</h1>
          <p className="matter-workspace__sub">
            Matter Workspace ·{" "}
            {envelope.case.referenceNumber ?? "no reference number"} ·{" "}
            {envelope.case.priority} · {envelope.case.status}
          </p>
          {/* Phase G3.1 — polling-based presence chip. Workspace +
              resource-id scoped server-side. Bounded payload — only
              {userId, displayName, lastSeenAtUtc} per viewer. */}
          <div style={{ marginTop: 6 }}>
            <PresenceIndicator
              teamId={envelope.case.teamId ?? null}
              resourceKind="matter"
              resourceId={envelope.case.id}
            />
          </div>
        </div>
      </header>

      <nav className="matter-workspace__tabs" role="tablist">
        {TABS.map((tab) => {
          const status = sectionStatus[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`matter-workspace__tab ${
                activeTab === tab.id ? "is-active" : ""
              }`}
              data-section-status={status}
              data-tab-id={tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              <strong>{tab.label}</strong>
              <span className="matter-workspace__tab-desc">
                {tab.description}
              </span>
              {status === "degraded" ? (
                <span className="matter-workspace__tab-degraded">degraded</span>
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
            padding: "8px 12px",
            borderTop: "1px solid rgba(127,127,127,0.15)",
            borderBottom: "1px solid rgba(127,127,127,0.15)",
            fontSize: 13,
          }}
        >
          <label
            htmlFor="matter-workspace-filter"
            style={{ fontSize: 11, color: "#475569", letterSpacing: 0.4 }}
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
              borderRadius: 6,
              border: "1px solid rgba(127,127,127,0.4)",
              fontSize: 13,
              background: "transparent",
              color: "inherit",
            }}
          />
          <span
            data-matter-keyboard-hint
            style={{ fontSize: 11, color: "#64748b" }}
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
          <AssignmentsTab envelope={envelope} filterText={filterText} />
        ) : null}
        {activeTab === "siu" ? (
          <div className="matter-tab matter-tab--siu" data-cc-matter-siu-tab>
            <SiuPanel caseId={envelope.case.id} />
          </div>
        ) : null}
        {activeTab === "audit" ? (
          <AuditTab envelope={envelope} filterText={filterText} />
        ) : null}
        {activeTab === "export" ? (
          <ExportTab envelope={envelope} filterText={filterText} />
        ) : null}
      </div>
    </section>
  );
}

// =============================================================================
// Tabs
// =============================================================================

function OverviewTab({ envelope }: { envelope: MatterEnvelope }) {
  const s = envelope.sections.commandSummary.data;
  if (!s) {
    return (
      <EmptyState
        title="Matter posture unavailable"
        body="The command-summary projection could not be computed. Other tabs may still render. Try reloading; if the section remains degraded, the workspace's reviewer-ops projection may be temporarily unavailable."
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
          setRequests({ error: e.message ?? "Could not load requests." });
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
    return (
      <EmptyState
        title="No holds active"
        body="No legal or retention holds apply to this matter or its evidence. Place a hold from the matter's governance surface (audited, step-up-required for sensitive holds). Holds inherit from the parent organization's retention template when one is published."
      />
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
    return (
      <EmptyState
        title="No review decisions yet"
        body="Reviewer decisions and escalations appear here once reviewers act on linked evidence. Sensitive decisions (approval, rejection) require a step-up token when the workspace's governance flag is set."
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
          setThreads({ error: e.message ?? "Could not load threads." });
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
      <EmptyState
        title="No matter communications yet"
        body="Discussion threads, case-level comments, reviewer comments, and evidence annotations appear here. Communications are workspace-scoped and audit-safe — they never surface on public verify pages."
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
}: {
  envelope: MatterEnvelope;
  filterText?: string;
}) {
  const assignments = envelope.assignments;
  if (assignments.length === 0) {
    return (
      <EmptyState
        title="No assignments yet"
        body="Assign investigators, reviewers, or governance owners to this matter from the per-domain assignment surfaces (reviewer-ops, governance). Assignment audits become first-class once one or more roles are assigned."
      />
    );
  }
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
  return (
    <div className="matter-tab matter-tab--assignments">
      <h3>Active assignments ({active.length})</h3>
      <ul>
        {active.map((a) => (
          <li key={a.id}>
            <strong>{a.role}</strong>
            <span> · {a.assignedToUserId}</span>
            <small> · assigned {formatRelative(a.assignedAtUtc)}</small>
            {a.note ? <p>{a.note}</p> : null}
          </li>
        ))}
      </ul>
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
  return (
    <div className="matter-tab__tile" data-tone={tone ?? "neutral"}>
      <span className="matter-tab__tile-label">{label}</span>
      <strong className="matter-tab__tile-value">{value}</strong>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="matter-tab__grid">{children}</div>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="matter-tab__empty" role="status">
      <strong>{title}</strong>
      <p>{body}</p>
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
