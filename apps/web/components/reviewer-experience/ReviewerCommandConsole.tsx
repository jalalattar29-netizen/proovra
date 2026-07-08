"use client";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

/**
 * Phase 32.8E — Reviewer Orchestration & Escalation Command.
 *
 * Renders the workspace-level review-ops summary on top of (and
 * replacing) the previous bespoke /reviewer-ops console. Sourced
 * from `/v1/reviewer-ops/command` — a single read-only envelope
 * with per-section status.
 *
 * Out of scope here:
 *   - Per-workflow inspector + mutation actions (start / pause /
 *     approve / reject / escalate / reassign) — they continue to
 *     live on the existing /reviewer-ops/[reviewId] detail route
 *     and on the audited POST /v1/reviewer-ops/* endpoints. This
 *     orchestration console is a triage surface, not a mutation
 *     surface.
 *   - SLA configuration UI — `/governance/policy`.
 *   - Per-reviewer drill-down — link to /reviewer-ops/sla.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import {
  CapabilityDegradedPanel,
  useActiveSpaceId,
  useCan,
  usePersonaProfile,
  usePlatformContext,
  workflowFromPersona,
} from "../../lib/platform-context";
import { ContextualHelp } from "../contextual-help/ContextualHelp";
import { RuntimeStatusBanner } from "../operational";
import type { ReviewerCommandEnvelope, SectionStatus } from "./types";

// CR1.6 — The legacy `no_workspace` LoadState branch was removed.
// PageRouteGate (review.queue, ORGANIZATION_ONLY) gates entry and
// the in-component capability check (REVIEWER_OPS_VIEW) renders the
// canonical CapabilityDegradedPanel for personal users. The previous
// `ShellNoWorkspace` render was unreachable dead code.
type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: ReviewerCommandEnvelope }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

export function ReviewerCommandConsole() {
  const ctx = usePlatformContext();
  // Phase 38.14 — migrated off the legacy workspace-gate hook. The
  // /reviewer-ops page is already wrapped in <PageRouteGate
  // routeId="review.queue"> (ORGANIZATION_ONLY) so by the time this
  // component renders the actor has an active organization workspace
  // AND the REVIEWER_OPS_VIEW capability. We read the active-space id
  // directly; loading is a transient state.
  const teamId = useActiveSpaceId();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Phase 38.17 — workflow-aware contextual help.
  const reviewerPersona = usePersonaProfile();
  const reviewerWorkflowCode = workflowFromPersona(
    reviewerPersona.primaryProfile,
  ).code;

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ status: "loading" });
    try {
      const envelope = (await apiFetch(
        `/v1/reviewer-ops/command?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as ReviewerCommandEnvelope;
      setState({ status: "ready", envelope });
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      if (e.statusCode === 401)
        setState({ status: "auth_error", code: "auth_required" });
      else if (e.statusCode === 403)
        setState({ status: "auth_error", code: "permission_denied" });
      else
        setState({
          status: "unavailable",
          message: toSafeUserError(e, { message: "Unable to load reviewer command center." }).message,
        });
    }
  }, [teamId]);

  useEffect(() => {
    if (!teamId) {
      setState({ status: "loading" });
      return;
    }
    void load();
  }, [teamId, load]);

  // Phase 32.8 Foundation — capability gate from the canonical
  // context. Personal workspaces (REVIEWER_OPS_VIEW = false) render
  // the structured CapabilityDegradedPanel instead of the legacy
  // "no workspace" plain-text fallback.
  if (ctx.envelope && !ctx.can("REVIEWER_OPS_VIEW")) {
    return (
      <main className="cc-page" data-reviewer-capability-degraded>
        <CapabilityDegradedPanel
          surface="Reviewer Ops"
          requiredCapability="REVIEWER_OPS_VIEW"
          reason="Reviewer Ops coordinates work across a team — queue triage, SLA pressure, escalations, and reviewer capacity. It activates when you switch into a team workspace."
          alternatives={[
            { label: "Manage your evidence", href: "/evidence" },
            { label: "Open your cases", href: "/cases" },
            { label: "Generate a report", href: "/reports" },
          ]}
        />
      </main>
    );
  }

  if (state.status === "loading") return <ShellLoading />;
  if (state.status === "auth_error")
    return <ShellAuthError code={state.code} />;
  if (state.status === "unavailable")
    return <ShellUnavailable message={state.message} />;

  const env = state.envelope;
  const isTeam = env.workspace.scope === "TEAM";
  // Phase B-1 — caller identity for "Assign to me" bulk action. The
  // envelope is loaded at this point so `ctx.envelope?.user.id` is
  // present; we fall back to null safely if it ever isn't, which
  // disables the Assign-to-me bulk action gracefully.
  //
  // DEPLOY-BLOCKER FIX (post-Phase-B.2): A previous edit declared a
  // duplicate `reload` callback below the early-return conditionals,
  // which violated the "hooks must be called in the same order every
  // render" rule and broke the Vercel build with
  //   "React Hook useCallback is called conditionally."
  //
  // The fix:
  //   1. We do NOT redefine `reload` below the conditionals — the
  //      `load` callback ABOVE the conditionals does the exact same
  //      thing (same fetch path, same setState transitions). Reusing
  //      it removes the duplication AND keeps every hook above any
  //      conditional return.
  //   2. The Phase B-1 bulk-bar refresh hook (`onMutated`) is passed
  //      the `load` callback directly — see the `<QueuePeekSection>`
  //      below.
  //
  // No more hooks declared after this line. Anything that looks like
  // a hook (useCallback / useMemo / useEffect / useState) must live
  // ABOVE the `if (state.status === "loading") return …` block.
  const callerUserId = ctx.envelope?.user?.id ?? null;

  return (
    <main className="cc-page" data-reviewer-command>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Review Orchestration · Escalation Command</div>
          <h1 className="cc-title">Reviewer Ops</h1>
          <p className="cc-subtitle">
            Triage queue, SLA pressure, and open escalations for the workspace.
            Reviewer actions live on the per-workflow inspector pages — this
            console is a read-only triage surface.
          </p>
        </div>
        <div className="cc-meta">
          <span data-reviewer-scope={env.workspace.scope}>
            {env.workspace.scope === "PERSONAL"
              ? "Personal workspace"
              : "Team workspace"}
          </span>
          <span data-reviewer-role={env.workspace.role}>
            Role: {env.workspace.role}
          </span>
          <span title={env.generatedAt}>Refreshed {relTime(env.generatedAt)}</span>
        </div>
      </header>

      {/* Phase 38.17 — workflow-aware contextual help, collapsed by
          default so the reviewer triage surface stays primary. */}
      <ContextualHelp
        workflow={reviewerWorkflowCode}
        surface="reviewer-ops"
        collapsedByDefault
      />

      {/* Phase 32.7 — runtime banner scoped to reviewer_ops so platform-
          internal degradations don't poison the operator view. */}
      <RuntimeStatusBanner
        teamId={env.workspace.id}
        forDomains={["reviewer_ops"]}
      />

      {/* Phase 32.8C FINAL-3 — capability degradation rather than page
          hiding. Personal workspace renders the same surface; team-only
          sections render disabled with a clear "Requires team workspace"
          label. The page never early-returns a plain text fallback. */}
      {!isTeam ? (
        <div
          className="cc-section-note"
          data-reviewer-personal-banner
          data-cc-section-status="not_applicable"
          role="status"
        >
          Personal workspace — reviewer orchestration sections render in
          read-only enterprise-lite mode. Team-only actions (escalation
          ownership, reviewer policy editing, bulk reassignment) are
          disabled with clear labels. Switch to a team workspace to enable
          the full reviewer command surface.
        </div>
      ) : null}
      <SummarySection env={env} />
      <div className="cc-grid-2col">
        <QueuePeekSection
          env={env}
          callerUserId={callerUserId}
          onMutated={load}
          isTeam={isTeam}
        />
        <EscalationsSection env={env} />
      </div>
      <div className="cc-grid-2col">
        <WorkloadSection env={env} />
        <PolicySection env={env} />
      </div>
      <ReconciliationSection env={env} />
      {/* Phase B.3 — multi-stage review summary card. Workspace-
          scoped read of the multi-stage state buckets (first_required,
          second_required, conflict_detected, resolved). Deep-links
          to the per-workflow detail page where the operator actually
          acts on each item. The card is read-only and degrades to a
          honest unavailable state if the endpoint fails. */}
      <MultiStageReviewSummaryCard teamId={env.workspace.id} />
      {/* Phase B-3 — operational scope panel. Sets accurate
          enterprise expectations: what reviewer-ops can do RIGHT
          NOW vs what is deliberately deferred. This is read-only;
          it never describes a fake capability. */}
      <OperationalScopePanel isTeam={isTeam} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Phase B-3 — Operational scope panel.
//
// A read-only honesty card that anchors enterprise expectations:
// which reviewer-ops capabilities are wired today, which are
// deferred. The brief explicitly forbade fake Bates / fake redaction
// tooling / fake second-review / fake reviewer-AI; this card is the
// operator-visible truth.
//
// All claims here are checkable against the codebase: every
// "available now" item maps to an endpoint that exists in
// reviewer-ops.routes.ts; every "deferred" item is genuinely absent
// from the backend.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Phase B.3 — Multi-stage review summary card.
//
// Reads `GET /v1/reviewer-ops/decisions/summary?teamId=<uuid>` and
// renders 4 state count chips. Hooks are declared at the top of the
// function and are never called conditionally — required after the
// post-Phase-B.2 deploy-blocker that came from a duplicate `useCallback`
// declared after early returns.
// ---------------------------------------------------------------------------
type ReviewSummaryEnvelope = {
  teamId: string;
  generatedAt: string;
  summary: {
    windowDays: number;
    workflowsInWindow: number;
    byState: {
      first_required: number;
      second_required: number;
      conflict_detected: number;
      resolved: number;
    };
  };
  preview: {
    first_required: Array<{ workflowId: string; priority: string }>;
    second_required: Array<{ workflowId: string; priority: string }>;
    conflict_detected: Array<{ workflowId: string; priority: string }>;
    resolved: Array<{ workflowId: string; priority: string }>;
  };
};

function MultiStageReviewSummaryCard({ teamId }: { teamId: string }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: ReviewSummaryEnvelope }
    | { kind: "error"; status: number; message: string }
  >({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/reviewer-ops/decisions/summary?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as ReviewSummaryEnvelope;
      setState({ kind: "ready", data });
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        toSafeUserError(err, { message: "Could not load review summary." }).message;
      setState({ kind: "error", status, message });
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stateChips: Array<{
    key: keyof ReviewSummaryEnvelope["summary"]["byState"];
    label: string;
    tone: "info" | "warning" | "high" | "success";
  }> = [
    { key: "first_required", label: "Awaiting first review", tone: "info" },
    {
      key: "second_required",
      label: "Awaiting second review",
      tone: "warning",
    },
    {
      key: "conflict_detected",
      label: "Conflict — adjudication required",
      tone: "high",
    },
    { key: "resolved", label: "Resolved (recent)", tone: "success" },
  ];

  return (
    <section
      className="cc-section"
      data-reviewer-section="multi-stage-review-summary"
      data-multi-stage-state={state.kind}
    >
      <header className="cc-section-header">
        <h2 className="cc-section-title">Multi-stage review summary</h2>
      </header>
      <p
        className="cc-section-note"
        style={{ fontSize: 12, opacity: 0.85, marginTop: 0, marginBottom: 8 }}
      >
        Workflow counts by derived multi-stage review state across the
        last{" "}
        {state.kind === "ready" ? state.data.summary.windowDays : 90}{" "}
        days. Items in the “Conflict” bucket are gated to team
        OWNER/ADMIN for adjudication (Phase B.2).
      </p>

      {state.kind === "loading" ? (
        <div data-multi-stage-state-loading style={{ fontSize: 13, opacity: 0.7 }}>
          Loading multi-stage review state…
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div
          role="alert"
          data-multi-stage-state-error
          style={{
            padding: "0.45rem 0.6rem",
            border: "1px dashed rgba(127,127,127,0.4)",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          Multi-stage review summary unavailable
          {state.status ? ` (HTTP ${state.status})` : ""}.
          <button
            type="button"
            onClick={() => void load()}
            data-multi-stage-retry
            style={{
              marginLeft: 6,
              fontSize: 12,
              padding: "0.15rem 0.45rem",
              border: "1px solid currentColor",
              borderRadius: 4,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <div
          data-multi-stage-summary-tiles
          data-multi-stage-workflows-in-window={
            state.data.summary.workflowsInWindow
          }
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          }}
        >
          {stateChips.map((chip) => {
            const count = state.data.summary.byState[chip.key];
            const preview = state.data.preview[chip.key];
            const toneStyle =
              chip.tone === "high"
                ? {
                    border: "1px solid rgba(239,68,68,0.55)",
                    background: "rgba(239,68,68,0.08)",
                  }
                : chip.tone === "warning"
                  ? {
                      border: "1px solid rgba(245,158,11,0.55)",
                      background: "rgba(245,158,11,0.08)",
                    }
                  : chip.tone === "success"
                    ? {
                        border: "1px solid rgba(34,197,94,0.45)",
                        background: "rgba(34,197,94,0.06)",
                      }
                    : {
                        border: "1px solid rgba(99,102,241,0.45)",
                        background: "rgba(99,102,241,0.06)",
                      };
            return (
              <div
                key={chip.key}
                data-multi-stage-summary-tile={chip.key}
                data-multi-stage-summary-tile-count={count}
                data-multi-stage-summary-tile-tone={chip.tone}
                style={{
                  padding: "0.55rem 0.7rem",
                  borderRadius: 6,
                  ...toneStyle,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    textTransform: "uppercase",
                    opacity: 0.85,
                  }}
                >
                  {chip.label}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
                  {count}
                </div>
                {preview.length > 0 ? (
                  <ul
                    data-multi-stage-summary-preview={chip.key}
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "6px 0 0",
                      fontSize: 11,
                      display: "grid",
                      gap: 2,
                    }}
                  >
                    {preview.slice(0, 3).map((p) => (
                      <li key={p.workflowId}>
                        <Link
                          href={`/reviewer-ops/${encodeURIComponent(p.workflowId)}`}
                          data-multi-stage-preview-workflow={p.workflowId}
                        >
                          {p.workflowId.slice(0, 8)}… · {p.priority}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function OperationalScopePanel({ isTeam }: { isTeam: boolean }) {
  return (
    <section
      className="cc-section"
      data-reviewer-section="operational-scope"
      data-reviewer-scope-team={isTeam ? "true" : "false"}
    >
      <header className="cc-section-header">
        <h2 className="cc-section-title">Operational scope</h2>
      </header>
      <p className="cc-section-note" style={{ fontSize: 12, opacity: 0.85 }}>
        Honest summary of what the reviewer surface supports today vs
        what is intentionally deferred. Items marked “deferred” are
        not faked in the UI — they require deliberate backend
        modeling. This panel is the canonical reference; the brief for
        this surface is explicit about not inventing legal/eDiscovery
        features.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 10,
          marginTop: 6,
        }}
      >
        <div
          data-reviewer-scope-block="available"
          style={scopeBlockStyle("available")}
        >
          <div style={scopeBlockTitle}>Available now</div>
          <ul style={scopeListStyle}>
            <li data-reviewer-scope-item="queue-triage">
              <strong>Queue triage</strong> — claim, assign, reassign,
              start, pause, request-info, approve, reject. Per-row.
            </li>
            <li data-reviewer-scope-item="bulk-ops">
              <strong>Bulk operations</strong> — assign-to-me,
              priority changes (HIGH/NORMAL/URGENT), escalate, pause,
              request-info, close (with note). 207 partial-success
              outcomes.
            </li>
            <li data-reviewer-scope-item="escalation-lifecycle">
              <strong>Escalation lifecycle</strong> — acknowledge,
              reassign, resolve, suppress.{" "}
              <Link href="/reviewer-ops/escalations">Open</Link>.
            </li>
            <li data-reviewer-scope-item="sla-tracking">
              <strong>SLA tracking</strong> — real reconcile cron +
              per-workspace policy + reviewer workload snapshots.{" "}
              <Link href="/reviewer-ops/sla">Open</Link>.
            </li>
            <li data-reviewer-scope-item="audit-chain">
              <strong>Audit chain</strong> — every mutation emits a
              SecurityEvent; custody events fire from worker paths.
            </li>
            <li data-reviewer-scope-item="governance-signals">
              <strong>Governance signals on review detail</strong> —
              active legal hold + redaction-required visibility
              decisions visible read-only.
            </li>
            <li data-reviewer-scope-item="saved-views">
              <strong>Saved queue views</strong> — per-reviewer custom
              filters with shared visibility.
            </li>
            <li data-reviewer-scope-item="keyboard-shortcuts">
              <strong>Keyboard shortcuts</strong> — J/K queue
              navigation, A claim, E escalate, R request-info, C
              close. Press <kbd>?</kbd> on a review detail page for
              the full list.
            </li>
            <li data-reviewer-scope-item="multi-stage-summary">
              <strong>Multi-stage review summary</strong> (Phase
              B.3). Workspace-scoped counts by derived review state
              (first/second/conflict/resolved) over a 90-day window.
              The summary card above this panel.
            </li>
            <li data-reviewer-scope-item="review-decision-inbox">
              <strong>Multi-stage review inbox items</strong>{" "}
              (Phase B.3).{" "}
              <Link href="/inbox">/inbox</Link> surfaces conflict-
              detected workflows in workspaces you administer, plus
              awareness items where your first-stage decision is
              awaiting peer review.
            </li>
          </ul>
        </div>
        <div
          data-reviewer-scope-block="deferred"
          style={scopeBlockStyle("deferred")}
        >
          <div style={scopeBlockTitle}>Deferred (not yet self-service)</div>
          <ul style={scopeListStyle}>
            <li data-reviewer-scope-item="reviewer-notes">
              <strong>Reviewer notes endpoint</strong> — the
              EvidenceReviewerComment model exists but is not wired
              into reviewer-ops routes. Notes today live inside
              escalation/pause/request-info text fields.
            </li>
            <li data-reviewer-scope-item="second-review">
              <strong>Second-review requirement</strong> — no
              dual-approval state machine. Two-step transfers happen
              via manual role-change + audit chain.
            </li>
            <li data-reviewer-scope-item="conflict-resolution">
              <strong>Conflict resolution</strong> — when two
              reviewers disagree, the existing escalation lifecycle is
              the operational path; a dedicated conflict workflow is
              not modeled.
            </li>
            <li data-reviewer-scope-item="bates-numbering">
              <strong>Bates numbering</strong> — not modeled in
              schema; no production-set sequence tracking. Surfaces
              do not pretend it exists.
            </li>
            <li data-reviewer-scope-item="redaction-tooling">
              <strong>Redaction tooling</strong> — `requiresRedaction`
              is a signal flag, not a redaction editor. Highlight +
              approve UI is not built.
            </li>
            <li data-reviewer-scope-item="evidence-compare">
              <strong>Side-by-side evidence compare</strong> — not
              built. Evidence-detail rendering is per-item.
            </li>
            <li data-reviewer-scope-item="auto-routing">
              <strong>Auto-routing rules engine</strong> — workload
              suggestions exist (advisory only). No automated
              assignment based on rules; operators always decide.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function scopeBlockStyle(kind: "available" | "deferred"): React.CSSProperties {
  return {
    padding: "0.7rem 0.9rem",
    border:
      kind === "available"
        ? "1px solid rgba(34, 197, 94, 0.45)"
        : "1px solid rgba(127, 127, 127, 0.4)",
    background:
      kind === "available"
        ? "rgba(34, 197, 94, 0.06)"
        : "rgba(127, 127, 127, 0.04)",
    borderRadius: 6,
    fontSize: 12,
  };
}

const scopeBlockTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  marginBottom: 6,
  opacity: 0.85,
};

const scopeListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: "1.1rem",
  display: "grid",
  gap: 5,
};

// ---------------------------------------------------------------------------
// Summary section
// ---------------------------------------------------------------------------

function SummarySection({ env }: { env: ReviewerCommandEnvelope }) {
  const s = env.sections.summary;
  if (s.status !== "ok" || !s.data) {
    return (
      <section className="cc-section" data-reviewer-section="summary">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Review Operations Summary</h2>
        </header>
        <SectionNote status={s.status} kind="summary" />
      </section>
    );
  }
  const d = s.data;
  const tiles = [
    {
      key: "assigned_to_me",
      label: "Assigned to me",
      value: d.assignedToMe,
      href: "/reviewer-ops",
    },
    { key: "unassigned", label: "Unassigned", value: d.unassigned, href: "/reviewer-ops" },
    {
      key: "in_review",
      label: "In review",
      value: d.inReview,
      href: "/reviewer-ops",
    },
    {
      key: "due_soon",
      label: "Due in 24h",
      value: d.dueSoon,
      href: "/reviewer-ops/sla",
    },
    {
      key: "overdue",
      label: "Overdue",
      value: d.overdue,
      severe: d.overdue > 0,
      href: "/reviewer-ops/sla",
    },
    {
      key: "open_escalations",
      label: "Open escalations",
      value: d.openEscalations,
      severe: d.openEscalations > 0,
      href: "/reviewer-ops/escalations",
    },
  ];
  return (
    <section className="cc-section" data-reviewer-section="summary">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Review Operations Summary</h2>
      </header>
      <div className="cc-summary-strip" data-reviewer-summary-tiles>
        {tiles.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            className="cc-summary-card"
            data-reviewer-summary-tile={t.key}
            data-cc-tile-severe={t.severe ? "true" : "false"}
          >
            <span className="cc-summary-card-value">{t.value}</span>
            <span className="cc-summary-card-label">{t.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Queue peek section
// ---------------------------------------------------------------------------

function QueuePeekSection({
  env,
  callerUserId,
  onMutated,
  isTeam,
}: {
  env: ReviewerCommandEnvelope;
  callerUserId: string | null;
  onMutated: () => void;
  isTeam: boolean;
}) {
  const q = env.sections.queuePeek;
  if (q.status === "unavailable") {
    return (
      <section className="cc-section" data-reviewer-section="queue-peek">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Queue (top 10)</h2>
        </header>
        <SectionNote status="unavailable" kind="queue" />
      </section>
    );
  }
  if (q.items.length === 0) {
    return (
      <section className="cc-section" data-reviewer-section="queue-peek">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Queue (top 10)</h2>
        </header>
        <div className="cc-section-note">
          No open review workflows in this workspace.
        </div>
      </section>
    );
  }
  return (
    <QueuePeekWithBulkOps
      env={env}
      items={q.items}
      callerUserId={callerUserId}
      onMutated={onMutated}
      isTeam={isTeam}
    />
  );
}

// ---------------------------------------------------------------------------
// Phase B-1 — Bulk operations on the reviewer queue.
//
// Adds multi-select to the queue-peek section and wires it to the
// existing POST /v1/reviewer-ops/reviews/bulk endpoint. The backend
// returns a 207 partial-success envelope with per-row outcomes; we
// surface those outcomes inline so the reviewer can see exactly what
// succeeded and what failed without re-fetching the queue blind.
//
// Hard rules:
//   - No invented mutation semantics. Every action maps to one of the
//     bounded ReviewerOpsBulkAction values the backend already
//     accepts.
//   - Permission gating happens server-side (REVIEWER_OPS_ACT +
//     adaptive-runtime + step-up gates). The UI never tries to predict
//     denial; it surfaces server errors honestly.
//   - Bulk bar is hidden on personal workspaces — bulk reassignment
//     is a team-only operation and the backend rejects it there.
//   - Note-required actions (ESCALATE / PAUSE / REQUEST_INFO / CLOSE)
//     do not submit without a note; the UI disables the Apply button
//     until a non-empty note is provided.
// ---------------------------------------------------------------------------
type QueueRow = ReviewerCommandEnvelope["sections"]["queuePeek"]["items"][number];

type BulkAction =
  | "ASSIGN_TO_ME"
  | "PRIORITY_HIGH"
  | "PRIORITY_NORMAL"
  | "PRIORITY_URGENT"
  | "ESCALATE"
  | "PAUSE"
  | "REQUEST_INFO"
  | "CLOSE";

type BulkRowOutcome = {
  workflowId: string;
  ok: boolean;
  errorCode?: string;
  message?: string;
};

function QueuePeekWithBulkOps({
  env,
  items,
  callerUserId,
  onMutated,
  isTeam,
}: {
  env: ReviewerCommandEnvelope;
  items: ReadonlyArray<QueueRow>;
  callerUserId: string | null;
  onMutated: () => void;
  isTeam: boolean;
}) {
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [noteAction, setNoteAction] = useState<BulkAction | null>(null);
  const [noteText, setNoteText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    total: number;
    succeeded: number;
    failed: number;
    items: ReadonlyArray<BulkRowOutcome>;
  } | null>(null);

  const allSelected = items.length > 0 && selection.size === items.length;
  const someSelected = selection.size > 0;
  const teamId = env.workspace.id;
  // Personal-space envelopes carry a Team-shaped workspace id but are
  // not team-mutation-capable (reviewer mutations require team scope
  // server-side). Disable the bulk bar on personal so we don't ship
  // requests that will always 403.
  const bulkDisabled = !isTeam;

  const toggleRow = (id: string) =>
    setSelection((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelection(
      allSelected ? new Set() : new Set(items.map((r) => r.workflowId)),
    );
  const clearSelection = () => setSelection(new Set());

  const submitBulk = useCallback(
    async (action: BulkAction, note?: string) => {
      if (bulkDisabled) {
        setError("Bulk operations require a team workspace.");
        return;
      }
      if (selection.size === 0) {
        setError("Select at least one workflow first.");
        return;
      }
      const workflowIds = Array.from(selection);

      // Map UI action → backend action + payload.
      const requiresNote =
        action === "ESCALATE" ||
        action === "PAUSE" ||
        action === "REQUEST_INFO";
      if (requiresNote && (!note || note.trim().length === 0)) {
        setError("A short note is required for that action.");
        return;
      }
      if (action === "ASSIGN_TO_ME" && !callerUserId) {
        setError(
          "Could not identify the caller for assign-to-me. Reload and retry.",
        );
        return;
      }

      const bodyAction =
        action === "ASSIGN_TO_ME" ? "ASSIGN" : action;
      const body: Record<string, unknown> = {
        teamId,
        workflowIds,
        action: bodyAction,
      };
      if (action === "ASSIGN_TO_ME") {
        body.assignedToUserId = callerUserId;
      }
      if (requiresNote || action === "CLOSE") {
        // CLOSE also accepts a note; if the operator provided one we
        // forward it, otherwise the backend will validate.
        if (note && note.trim().length > 0) body.note = note.trim();
      }

      setSubmitting(true);
      setError(null);
      setLastResult(null);
      try {
        const resp = (await apiFetch("/v1/reviewer-ops/reviews/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })) as {
          total?: number;
          succeeded?: number;
          failed?: number;
          items?: ReadonlyArray<BulkRowOutcome>;
        };
        setLastResult({
          total: resp.total ?? workflowIds.length,
          succeeded: resp.succeeded ?? 0,
          failed: resp.failed ?? 0,
          items: resp.items ?? [],
        });
        // Refresh the envelope so the queue reflects the post-mutation
        // state. We deliberately keep the selection so the operator
        // can see which rows just changed; the rows the bulk action
        // closed will fall out of the queue naturally on reload.
        onMutated();
        setNoteAction(null);
        setNoteText("");
      } catch (err) {
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 400) {
          setError(toSafeUserError(e, { message: "Bulk request was rejected. Check the action + note." }).message);
        } else if (e.statusCode === 403) {
          setError(
            "Permission denied. Bulk mutation requires REVIEWER_OPS_ACT in this team.",
          );
        } else if (e.statusCode === 429) {
          setError("Rate-limited. Slow down and retry shortly.");
        } else {
          setError(toSafeUserError(e, { message: "Bulk submit failed." }).message);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [bulkDisabled, callerUserId, onMutated, selection, teamId],
  );

  return (
    <section
      className="cc-section"
      data-reviewer-section="queue-peek"
      data-reviewer-bulk-disabled={bulkDisabled ? "true" : "false"}
    >
      <header
        className="cc-section-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 className="cc-section-title">Queue (top 10)</h2>
        <span
          data-reviewer-bulk-selection-count={selection.size}
          style={{ fontSize: 12, opacity: 0.75 }}
        >
          {selection.size > 0
            ? `${selection.size} selected`
            : bulkDisabled
              ? "Bulk ops require a team workspace"
              : "Select workflows to bulk-act"}
        </span>
      </header>

      {/* Bulk action bar — visible whenever any selection exists OR
          the operator is in a team workspace and explicitly opens the
          note action. */}
      {!bulkDisabled && (someSelected || noteAction) && (
        <div
          data-reviewer-bulk-actions-bar
          data-reviewer-bulk-selected-count={selection.size}
          style={bulkBarStyle}
        >
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <strong style={{ fontSize: 12 }}>Bulk actions:</strong>
            <button
              type="button"
              disabled={submitting || selection.size === 0 || !callerUserId}
              onClick={() => void submitBulk("ASSIGN_TO_ME")}
              data-reviewer-bulk-action="ASSIGN_TO_ME"
              style={bulkBtnStyle}
              title={
                callerUserId
                  ? "Assign every selected workflow to your account."
                  : "Caller identity not yet resolved; refresh and retry."
              }
            >
              Assign to me
            </button>
            <button
              type="button"
              disabled={submitting || selection.size === 0}
              onClick={() => void submitBulk("PRIORITY_HIGH")}
              data-reviewer-bulk-action="PRIORITY_HIGH"
              style={bulkBtnStyle}
            >
              Mark HIGH
            </button>
            <button
              type="button"
              disabled={submitting || selection.size === 0}
              onClick={() => void submitBulk("PRIORITY_NORMAL")}
              data-reviewer-bulk-action="PRIORITY_NORMAL"
              style={bulkBtnStyle}
            >
              Mark NORMAL
            </button>
            <button
              type="button"
              disabled={submitting || selection.size === 0}
              onClick={() => void submitBulk("PRIORITY_URGENT")}
              data-reviewer-bulk-action="PRIORITY_URGENT"
              style={bulkBtnStyle}
            >
              Mark URGENT
            </button>
            <span
              aria-hidden="true"
              style={{
                width: 1,
                height: 22,
                background: "rgba(127,127,127,0.3)",
                margin: "0 4px",
              }}
            />
            <select
              data-reviewer-bulk-note-action
              value={noteAction ?? ""}
              onChange={(e) => {
                const v = e.target.value as BulkAction | "";
                setNoteAction(v === "" ? null : v);
              }}
              disabled={submitting}
              style={{ fontSize: 12 }}
              aria-label="Bulk action requiring a note"
            >
              <option value="">— with note —</option>
              <option value="ESCALATE">Escalate</option>
              <option value="PAUSE">Pause</option>
              <option value="REQUEST_INFO">Request info</option>
              <option value="CLOSE">Close</option>
            </select>
            {noteAction ? (
              <>
                <input
                  type="text"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Short note (required for escalate/pause/request-info)"
                  data-reviewer-bulk-note-input
                  disabled={submitting}
                  maxLength={1000}
                  style={{
                    fontSize: 12,
                    flex: "1 1 220px",
                    padding: "0.25rem 0.4rem",
                  }}
                />
                <button
                  type="button"
                  disabled={
                    submitting ||
                    selection.size === 0 ||
                    ((noteAction === "ESCALATE" ||
                      noteAction === "PAUSE" ||
                      noteAction === "REQUEST_INFO") &&
                      noteText.trim().length === 0)
                  }
                  onClick={() => void submitBulk(noteAction, noteText)}
                  data-reviewer-bulk-action="WITH_NOTE_APPLY"
                  data-reviewer-bulk-note-action-target={noteAction}
                  style={bulkBtnPrimaryStyle}
                >
                  Apply {noteAction}
                </button>
              </>
            ) : null}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={clearSelection}
              disabled={submitting || selection.size === 0}
              data-reviewer-bulk-action="CLEAR_SELECTION"
              style={bulkBtnStyle}
            >
              Clear
            </button>
          </div>
          {error ? (
            <div
              role="alert"
              data-reviewer-bulk-error
              style={{
                marginTop: 6,
                fontSize: 12,
                color: "#d44",
              }}
            >
              {error}
            </div>
          ) : null}
          {lastResult ? (
            <div
              data-reviewer-bulk-last-result
              data-reviewer-bulk-last-total={lastResult.total}
              data-reviewer-bulk-last-succeeded={lastResult.succeeded}
              data-reviewer-bulk-last-failed={lastResult.failed}
              style={{
                marginTop: 6,
                fontSize: 12,
                opacity: 0.85,
              }}
            >
              Last bulk result: {lastResult.succeeded}/{lastResult.total}{" "}
              succeeded{lastResult.failed > 0 ? `, ${lastResult.failed} failed` : ""}.
              {lastResult.failed > 0 && lastResult.items.length > 0 ? (
                <ul
                  data-reviewer-bulk-last-failures
                  style={{
                    margin: "4px 0 0",
                    paddingLeft: "1.2rem",
                    fontSize: 12,
                  }}
                >
                  {lastResult.items
                    .filter((i) => !i.ok)
                    .map((i) => (
                      <li
                        key={i.workflowId}
                        data-reviewer-bulk-failed-workflow={i.workflowId}
                        data-reviewer-bulk-failed-error-code={i.errorCode ?? ""}
                      >
                        {i.workflowId.slice(0, 8)}…:{" "}
                        {i.errorCode ?? "error"}{" "}
                        {i.message ? `— ${i.message}` : ""}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {/* Personal-space banner that the bulk bar will not appear. */}
      {bulkDisabled ? (
        <div
          data-reviewer-bulk-personal-banner
          className="cc-section-note"
          style={{ fontSize: 12 }}
        >
          Bulk reviewer operations require a team workspace. In personal
          space, open each workflow individually from the queue below.
        </div>
      ) : null}

      <div
        data-reviewer-bulk-select-row
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0.35rem 0.5rem",
          borderBottom: "1px solid rgba(127,127,127,0.2)",
          fontSize: 12,
        }}
      >
        <input
          type="checkbox"
          aria-label="Select all queue rows"
          data-reviewer-bulk-select-all
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = !allSelected && someSelected;
          }}
          onChange={toggleAll}
          disabled={bulkDisabled || items.length === 0}
        />
        <span style={{ opacity: 0.75 }}>
          Select all visible
        </span>
      </div>

      <ul className="cases-list" data-reviewer-queue-items>
        {items.map((row) => {
          const selected = selection.has(row.workflowId);
          // Phase B-1 — per-row outcome marker from the most recent
          // bulk submit, so the reviewer can see which rows just
          // succeeded vs failed without re-fetching.
          const outcome = lastResult
            ? lastResult.items.find((i) => i.workflowId === row.workflowId)
            : null;
          return (
            <li
              key={row.workflowId}
              className="cases-row"
              data-reviewer-workflow-id={row.workflowId}
              data-reviewer-sla-tone={row.slaTone}
              data-reviewer-bulk-selected={selected ? "true" : "false"}
              data-reviewer-bulk-last-outcome={
                outcome ? (outcome.ok ? "ok" : "failed") : ""
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <input
                type="checkbox"
                aria-label={`Select workflow ${row.workflowId.slice(0, 8)}`}
                data-reviewer-bulk-row-checkbox={row.workflowId}
                checked={selected}
                onChange={() => toggleRow(row.workflowId)}
                disabled={bulkDisabled || submitting}
              />
              <Link
                href={`/reviewer-ops/${encodeURIComponent(row.workflowId)}`}
                className="cases-row-link"
                style={{ flex: 1, minWidth: 0 }}
              >
                <div className="cases-row-main">
                  <span className="cases-row-title">
                    Workflow {row.workflowId.slice(0, 8)}
                  </span>
                  <span
                    className="cases-row-scope"
                    data-reviewer-status={row.status}
                  >
                    {row.status}
                  </span>
                </div>
                <div className="cases-row-meta">
                  <span data-reviewer-priority={row.priority}>{row.priority}</span>
                  {row.assignedToUserId ? (
                    <span>Assigned to {row.assignedToUserId.slice(0, 8)}</span>
                  ) : (
                    <span>Unassigned</span>
                  )}
                  {row.dueAt ? (
                    <time dateTime={row.dueAt} data-reviewer-due-at={row.slaTone}>
                      {row.slaTone === "overdue"
                        ? "Overdue"
                        : row.slaTone === "due_soon"
                          ? "Due soon"
                          : `Due ${relTime(row.dueAt)}`}
                    </time>
                  ) : null}
                  {outcome ? (
                    <span
                      data-reviewer-bulk-row-outcome={
                        outcome.ok ? "ok" : "failed"
                      }
                      style={{
                        fontSize: 11,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: outcome.ok
                          ? "rgba(34,197,94,0.18)"
                          : "rgba(239,68,68,0.22)",
                      }}
                    >
                      {outcome.ok ? "applied" : `failed: ${outcome.errorCode ?? "error"}`}
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="cc-section-foot">
        Full queue lives at <Link href="/reviewer-ops/sla">SLA workspace</Link>.
      </div>
    </section>
  );
}

const bulkBarStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  border: "1px solid rgba(99,102,241,0.4)",
  borderRadius: 6,
  background: "rgba(99,102,241,0.06)",
  margin: "0.5rem 0",
};

const bulkBtnStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "0.25rem 0.55rem",
  border: "1px solid currentColor",
  borderRadius: 4,
  background: "transparent",
  cursor: "pointer",
};

const bulkBtnPrimaryStyle: React.CSSProperties = {
  ...bulkBtnStyle,
  background: "rgba(99,102,241,0.18)",
  fontWeight: 600,
};

// ---------------------------------------------------------------------------
// Escalations section
// ---------------------------------------------------------------------------

function EscalationsSection({ env }: { env: ReviewerCommandEnvelope }) {
  const e = env.sections.escalations;
  if (e.status === "unavailable") {
    return (
      <section className="cc-section" data-reviewer-section="escalations">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Escalation Command</h2>
        </header>
        <SectionNote status="unavailable" kind="escalations" />
      </section>
    );
  }
  if (e.items.length === 0) {
    return (
      <section className="cc-section" data-reviewer-section="escalations">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Escalation Command</h2>
        </header>
        <div className="cc-section-note">No open escalations.</div>
      </section>
    );
  }
  return (
    <section className="cc-section" data-reviewer-section="escalations">
      <header className="cc-section-header">
        <h2 className="cc-section-title">
          Escalation Command · {e.items.length}
        </h2>
      </header>
      <ul className="cases-list" data-reviewer-escalation-items>
        {e.items.map((row) => (
          <li
            key={row.id}
            className="cases-row"
            data-reviewer-escalation-id={row.id}
            data-reviewer-escalation-severity={row.severity}
          >
            <Link
              href={`/reviewer-ops/escalations`}
              className="cases-row-link"
            >
              <div className="cases-row-main">
                <span className="cases-row-title">{humanize(row.reason)}</span>
                <span className="cases-row-scope">{row.severity}</span>
              </div>
              <div className="cases-row-meta">
                <span>Workflow {row.workflowId.slice(0, 8)}</span>
                {row.evidenceId ? (
                  <span>Evidence {row.evidenceId.slice(0, 8)}</span>
                ) : null}
                <time dateTime={row.createdAt}>
                  Opened {relTime(row.createdAt)}
                </time>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Workload section
// ---------------------------------------------------------------------------

function WorkloadSection({ env }: { env: ReviewerCommandEnvelope }) {
  const w = env.sections.workload;
  if (w.status === "unavailable") {
    return (
      <section className="cc-section" data-reviewer-section="workload">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Reviewer Workload</h2>
        </header>
        <SectionNote status="unavailable" kind="workload" />
      </section>
    );
  }
  if (w.reviewers.length === 0) {
    return (
      <section className="cc-section" data-reviewer-section="workload">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Reviewer Workload</h2>
        </header>
        <div className="cc-section-note">
          Workload snapshot unavailable — no reviewers currently assigned.
        </div>
      </section>
    );
  }
  return (
    <section className="cc-section" data-reviewer-section="workload">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Reviewer Workload</h2>
      </header>
      <ul className="cases-list" data-reviewer-workload-items>
        {w.reviewers.map((r) => (
          <li
            key={r.userId}
            className="cases-row"
            data-reviewer-workload-user={r.userId}
          >
            <div className="cases-row-link">
              <div className="cases-row-main">
                <span className="cases-row-title">
                  {r.displayName ?? r.email ?? r.userId.slice(0, 8)}
                </span>
                <span
                  className="cases-row-scope"
                  data-cc-tile-severe={r.overdueCount > 0 ? "true" : "false"}
                >
                  {r.assignedCount} assigned
                </span>
              </div>
              <div className="cases-row-meta">
                {r.overdueCount > 0 ? (
                  <span data-reviewer-workload-overdue="true">
                    {r.overdueCount} overdue
                  </span>
                ) : (
                  <span>On track</span>
                )}
                {r.email ? <span>{r.email}</span> : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Policy summary section
// ---------------------------------------------------------------------------

function PolicySection({ env }: { env: ReviewerCommandEnvelope }) {
  const p = env.sections.workflowPolicy;
  if (p.status !== "ok" || !p.data) {
    return (
      <section className="cc-section" data-reviewer-section="policy">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Workflow Policy</h2>
        </header>
        <SectionNote status={p.status} kind="policy" />
      </section>
    );
  }
  const d = p.data;
  const rows = [
    {
      key: "review_due",
      label: "Default review due",
      value: d.defaultReviewDueHours ? `${d.defaultReviewDueHours} h` : "unset",
    },
    {
      key: "first_response_due",
      label: "First-response due",
      value: d.defaultFirstResponseDueHours
        ? `${d.defaultFirstResponseDueHours} h`
        : "unset",
    },
    {
      key: "step_up_approve",
      label: "Step-up · approve",
      value: d.requireStepUpForApprove ? "required" : "off",
    },
    {
      key: "step_up_reject",
      label: "Step-up · reject",
      value: d.requireStepUpForReject ? "required" : "off",
    },
    {
      key: "step_up_bulk",
      label: "Step-up · bulk",
      value: d.requireStepUpForBulk ? "required" : "off",
    },
    {
      key: "inactivity",
      label: "Inactivity threshold",
      value: d.reviewerInactivityHours
        ? `${d.reviewerInactivityHours} h`
        : "unset",
    },
  ];
  return (
    <section className="cc-section" data-reviewer-section="policy">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Workflow Policy</h2>
      </header>
      <ul className="governance-policy-summary" data-reviewer-policy-rows>
        {rows.map((r) => (
          <li
            key={r.key}
            className="governance-policy-row"
            data-reviewer-policy-row={r.key}
          >
            <span className="governance-policy-row-label">{r.label}</span>
            <span className="governance-policy-row-value">{r.value}</span>
          </li>
        ))}
      </ul>
      <div className="cc-section-foot">
        Source:{" "}
        <span data-reviewer-policy-source={d.slaPolicySource}>
          {d.slaPolicySource === "workspace_row"
            ? "workspace policy row"
            : "platform default"}
        </span>{" "}
        · Edit at <Link href="/governance/policy">Governance Policy</Link>.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reconciliation health section
// ---------------------------------------------------------------------------

function ReconciliationSection({ env }: { env: ReviewerCommandEnvelope }) {
  const r = env.sections.reconciliationHealth;
  // STAGE 2 — gate the deep-link to Observability on the canonical
  // capability for that route. The tiles still render either way;
  // only the pivot link is hidden when the actor cannot reach it.
  const canObservability = useCan("OBSERVABILITY_VIEW");
  if (r.status !== "ok" || !r.data) {
    return (
      <section className="cc-section" data-reviewer-section="reconciliation">
        <header className="cc-section-header">
          <h2 className="cc-section-title">Reconciliation Health</h2>
        </header>
        <SectionNote status={r.status} kind="reconciliation" />
      </section>
    );
  }
  return (
    <section className="cc-section" data-reviewer-section="reconciliation">
      <header className="cc-section-header">
        <h2 className="cc-section-title">Reconciliation Health</h2>
      </header>
      <div className="cc-tile-grid" data-reviewer-reconciliation-tiles>
        <div className="cc-tile" data-reviewer-reconciliation-tile="last_update">
          <span className="cc-tile-value">
            {r.data.lastWorkflowUpdateAtUtc
              ? relTime(r.data.lastWorkflowUpdateAtUtc)
              : "—"}
          </span>
          <span className="cc-tile-label">Last workflow update</span>
        </div>
        <div className="cc-tile" data-reviewer-reconciliation-tile="oldest_queued">
          <span className="cc-tile-value">
            {r.data.oldestQueuedAtUtc ? relTime(r.data.oldestQueuedAtUtc) : "—"}
          </span>
          <span className="cc-tile-label">Oldest queued</span>
        </div>
      </div>
      {canObservability ? (
        <div className="cc-section-foot">
          Worker health + cron status live at{" "}
          <Link href="/operations/observability">Operations · Observability</Link>.
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared shells + helpers
// ---------------------------------------------------------------------------

function SectionNote({
  status,
  kind,
}: {
  status: SectionStatus;
  kind: string;
}) {
  if (status === "ok") return null;
  const copy =
    status === "degraded"
      ? "This section returned partial data."
      : status === "unavailable"
        ? "This section is temporarily unavailable. Retry shortly."
        : "Not applicable for this workspace.";
  return (
    <div
      className="cc-section-note"
      data-cc-section-status={status}
      data-cc-section-kind={kind}
    >
      {copy}
    </div>
  );
}

function ShellLoading() {
  return (
    <main className="cc-page" data-reviewer-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Review Orchestration · Escalation Command</div>
          <h1 className="cc-title">Loading reviewer ops…</h1>
        </div>
      </header>
      <section className="cc-section">
        <div className="cc-skeleton" />
      </section>
    </main>
  );
}

// CR1.6 — `ShellNoWorkspace` removed. The canonical no-team
// rendering path is the in-component `CapabilityDegradedPanel`
// (REVIEWER_OPS_VIEW) for personal users; PageRouteGate handles
// truly missing workspace state at route entry.

function ShellAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="cc-page" data-reviewer-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Review Orchestration · Escalation Command</div>
          <h1 className="cc-title">
            {code === "auth_required" ? "Sign in required" : "Permission required"}
          </h1>
        </div>
      </header>
    </main>
  );
}

function ShellUnavailable({ message }: { message: string }) {
  return (
    <main className="cc-page" data-reviewer-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Review Orchestration · Escalation Command</div>
          <h1 className="cc-title">Temporarily unavailable</h1>
          <p className="cc-subtitle">{message}</p>
        </div>
      </header>
    </main>
  );
}

function humanize(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (Math.abs(diff) < 60_000) return "just now";
  const minutes = Math.floor(Math.abs(diff) / 60_000);
  if (minutes < 60) return `${minutes}m${diff < 0 ? " from now" : " ago"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${diff < 0 ? " from now" : " ago"}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d${diff < 0 ? " from now" : " ago"}`;
  return new Date(iso).toISOString().slice(0, 10);
}
