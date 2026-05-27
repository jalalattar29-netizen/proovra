"use client";

/**
 * Phase 25 — Review Workspace (single review).
 *
 * Full-page reviewer workspace surface. Loads `/workspace/:workflowId`,
 * shows lifecycle / SLA / escalation panels and the same reviewer action
 * surface as the queue inspector but in a wider layout (left =
 * lifecycle + SLA + escalation; right = actions + evidence pointer).
 *
 * Wording: operator-safe only. Never composes legal / forensic
 * overclaim phrases.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
// Phase G3.2 — Presence + collision wiring for the reviewer
// inspector. Mirrors the evidence detail page's presence surfacing
// so reviewers see when a peer is acting on the same workflow + when
// the workflow has moved under them.
import { PresenceIndicator } from "../../../../components/presence/PresenceIndicator";
import { CollisionWarning } from "../../../../components/presence/CollisionWarning";
import {
  ReviewerReasonModal,
  type ReviewerReasonKind,
} from "../components/ReviewerReasonModal";
import {
  ReviewerShortcutsHelp,
  isShortcutTarget,
  useReviewerHelpHotkey,
} from "../components/ReviewerShortcutsHelp";
import {
  cardStyle,
  emptyStateStyle,
  errorBoxStyle,
  formatDateTime,
  formatRelative,
  ghostButtonStyle,
  headerRowStyle,
  lifecycleBadgeStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  sectionTitleStyle,
  severityBadgeStyle,
  slaBadgeStyle,
  subtitleStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

type LifecycleState =
  | "DRAFT"
  | "SUBMITTED"
  | "QUEUED"
  | "ASSIGNED"
  | "IN_REVIEW"
  | "NEEDS_INFORMATION"
  | "ESCALATED"
  | "APPROVED"
  | "REJECTED"
  | "ARCHIVED";

type SlaState =
  | "HEALTHY"
  | "DUE_SOON"
  | "BREACHED"
  | "ESCALATED"
  | "BLOCKED"
  | "PAUSED"
  | "COMPLETED";

type WorkspaceResponse = {
  projection: {
    workflowId: string;
    evidenceId: string;
    lifecycleState: LifecycleState;
    assignedToUserId: string | null;
    assignedAtUtc: string | null;
    priority: string;
    slaRollupState: SlaState;
    slaDimensions: Array<{
      dimension: string;
      dueAtUtc: string | null;
      state: SlaState;
    }>;
  };
  openEscalation: null | {
    id: string;
    reason: string;
    severity: string;
    status: string;
    safeSummary: string;
    createdAt: string;
    assignedToUserId: string | null;
  };
  allowedLifecycleTransitions: LifecycleState[];
  // Phase B-2 — additive governance signals from the workspace
  // endpoint. Optional so older API versions degrade gracefully.
  governance?: {
    legalHold: {
      activeCount: number;
      mostRecent: null | {
        id: string;
        title: string;
        placedAtUtc: string;
      };
    };
    requiresRedaction: boolean;
    requiresRedactionFieldCount: number;
  };
};

// Phase 38.12 — wrap in canonical PageRouteGate.
export default function ReviewWorkspacePage() {
  return (
    <PageRouteGate routeId="review.queue_detail">
      <ReviewWorkspacePageInner />
    </PageRouteGate>
  );
}

function deriveSignature(r: WorkspaceResponse | null): string | null {
  if (!r) return null;
  const p = r.projection;
  return [
    p.lifecycleState,
    p.assignedToUserId ?? "",
    p.slaRollupState,
    p.assignedAtUtc ?? "",
    r.openEscalation?.id ?? "",
    r.openEscalation?.status ?? "",
  ].join("|");
}

function ReviewWorkspacePageInner() {
  const params = useParams<{ reviewId: string }>();
  const workflowId = params?.reviewId ?? "";
  // PageRouteGate guarantees an active ORGANIZATION space here.
  const teamId = useActiveSpaceId();
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Phase G3.2 — collision detection. The reviewer workspace
  // projection doesn't surface `updatedAt` directly, so we derive a
  // stable signature from the fields that mutating actions move
  // (lifecycle, assignment, SLA, escalation). String equality on the
  // signature is the same check CollisionWarning performs against an
  // ISO timestamp — both modes are honest, neither claims false
  // precision.
  const [initialSignature, setInitialSignature] = useState<string | null>(null);
  // Phase 2.4 — replace 3 `window.prompt` calls with a structured modal.
  // `reasonModal` holds the kind currently open, or null when closed.
  const [reasonModal, setReasonModal] = useState<ReviewerReasonKind | null>(
    null,
  );
  // Phase 2.5 — keyboard shortcuts + help overlay.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useReviewerHelpHotkey({
    open: shortcutsOpen,
    onOpen: () => setShortcutsOpen(true),
    onClose: () => setShortcutsOpen(false),
  });

  const load = useCallback(() => {
    if (!teamId || !workflowId) return;
    apiFetch(
      `/v1/reviewer-ops/workspace/${encodeURIComponent(
        workflowId,
      )}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: WorkspaceResponse) => {
        setData(r);
        setError(null);
        // Capture the first signature; subsequent reloads update
        // `data` (the current side) but never overwrite this snapshot.
        setInitialSignature((prev) => prev ?? deriveSignature(r));
      })
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Could not load workspace."),
      );
  }, [teamId, workflowId]);

  useEffect(() => {
    load();
  }, [load]);

  const post = useCallback(
    async (label: string, path: string, body: Record<string, unknown>) => {
      if (!teamId) return;
      setBusy(label);
      try {
        await apiFetch(
          `/v1/reviewer-ops/reviews/${encodeURIComponent(
            workflowId,
          )}/${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, ...body }),
          },
        );
        load();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ??
            `Action "${label}" failed.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, workflowId, load],
  );

  // Phase 2.5 — action shortcuts. Fire ONLY when no input/textarea is
  // focused (isShortcutTarget) and when the review is in a state that
  // accepts the action (mirrors the per-button `disabled` gates so the
  // shortcut never bypasses backend transition rules). Destructive
  // text-input actions open the structured ReviewerReasonModal rather
  // than triggering a bare network call — preserving the Phase 2.4
  // "no raw prompts" contract.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutTarget(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Ignore while the shortcuts overlay is itself open — the
      // overlay manages its own Esc handler.
      if (shortcutsOpen) return;
      // Ignore while a reason modal is open — we don't want
      // double-triggers while the user is typing a reason.
      if (reasonModal !== null) return;
      // Need a loaded projection to check lifecycle state.
      if (!data) return;
      const lifecycleState = data.projection.lifecycleState;
      const requestableStates = ["IN_REVIEW", "NEEDS_INFORMATION", "ESCALATED"];

      const k = e.key.toLowerCase();
      if (k === "r") {
        if (busy !== null) return;
        if (!requestableStates.includes(lifecycleState)) return;
        e.preventDefault();
        setReasonModal("REQUEST_INFO");
      } else if (k === "e") {
        // E opens the escalations console (review-detail page has no
        // direct "escalate" mutation; the link is the canonical
        // operator path).
        e.preventDefault();
        window.location.href = "/reviewer-ops/escalations";
      } else if (k === "c") {
        // C = approve (the "close-positive" terminal for a review).
        if (busy !== null) return;
        if (!requestableStates.includes(lifecycleState)) return;
        e.preventDefault();
        void post("approve", "approve", {});
      } else if (k === "a") {
        // A = start review (claim it for the current reviewer).
        if (busy !== null) return;
        if (lifecycleState !== "ASSIGNED") return;
        e.preventDefault();
        void post("start", "start", {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, busy, shortcutsOpen, reasonModal, post]);

  // PageRouteGate already guaranteed ALLOWED. If the envelope is
  // still hydrating, render the bounded loading shell.
  if (!teamId) {
    return (
      <main style={pageStyle} data-review-workspace-loading>
        <header style={headerRowStyle}>
          <div>
            <h1 style={titleStyle}>Review workspace</h1>
            <p style={subtitleStyle}>Loading organization workspace…</p>
          </div>
        </header>
      </main>
    );
  }

  if (!data) {
    return (
      <main style={pageStyle}>
        {error ? <div style={errorBoxStyle}>{error}</div> : null}
        <div style={emptyStateStyle}>Loading workspace…</div>
      </main>
    );
  }

  const p = data.projection;

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={lifecycleBadgeStyle(p.lifecycleState)}>
              {p.lifecycleState.toLowerCase().replace("_", " ")}
            </span>
            <span style={slaBadgeStyle(p.slaRollupState)}>
              {p.slaRollupState.toLowerCase().replace("_", " ")}
            </span>
          </div>
          <h1 style={{ ...titleStyle, marginTop: 8 }}>Review workspace</h1>
          <p style={subtitleStyle}>
            Workflow {p.workflowId.slice(0, 12)}… · Evidence{" "}
            <a
              href={`/evidence/${p.evidenceId}`}
              style={{ color: TOKENS.link, textDecoration: "none" }}
            >
              {p.evidenceId}
            </a>
          </p>
        </div>
        <div>
          <a
            href="/reviewer-ops"
            style={{ ...ghostButtonStyle, textDecoration: "none" }}
          >
            Back to queue
          </a>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {/* Phase G3.2 — Presence + collision wiring for the inspector. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <PresenceIndicator
          teamId={teamId}
          resourceKind="reviewer_workflow"
          resourceId={workflowId}
        />
      </div>
      <CollisionWarning
        entityLabel="Review workflow"
        initialUpdatedAtUtc={initialSignature}
        currentUpdatedAtUtc={deriveSignature(data)}
        onReload={() => load()}
      />

      {/* Phase B-2 — governance signals strip. Surfaces ACTIVE legal
          hold count + redaction-required visibility decisions for the
          underlying evidence. Read-only; the operator's path to act
          on these lives on /governance/* surfaces (Phase 9). Hidden
          when there is no signal — we never show an empty "no hold"
          state because the absence of a hold is the default. */}
      {data.governance &&
        (data.governance.legalHold.activeCount > 0 ||
          data.governance.requiresRedaction) && (
          <section
            data-section="reviewer-governance-signals"
            data-reviewer-legal-hold-active={
              data.governance.legalHold.activeCount > 0 ? "true" : "false"
            }
            data-reviewer-legal-hold-count={
              data.governance.legalHold.activeCount
            }
            data-reviewer-requires-redaction={
              data.governance.requiresRedaction ? "true" : "false"
            }
            data-reviewer-redaction-field-count={
              data.governance.requiresRedactionFieldCount
            }
            style={{
              ...cardStyle,
              marginBottom: 12,
              borderColor: "rgba(245, 158, 11, 0.55)",
              background: "rgba(245, 158, 11, 0.06)",
            }}
          >
            <h3 style={sectionTitleStyle}>Governance signals</h3>
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                fontSize: 13,
              }}
            >
              {data.governance.legalHold.activeCount > 0 && (
                <span
                  data-reviewer-governance-chip="legal-hold"
                  style={{
                    padding: "0.25rem 0.6rem",
                    border: "1px solid rgba(239, 68, 68, 0.55)",
                    background: "rgba(239, 68, 68, 0.1)",
                    borderRadius: 4,
                    fontWeight: 600,
                  }}
                >
                  Legal hold ACTIVE ({data.governance.legalHold.activeCount})
                  {data.governance.legalHold.mostRecent
                    ? ` — “${data.governance.legalHold.mostRecent.title}”`
                    : ""}
                </span>
              )}
              {data.governance.requiresRedaction && (
                <span
                  data-reviewer-governance-chip="requires-redaction"
                  style={{
                    padding: "0.25rem 0.6rem",
                    border: "1px solid rgba(245, 158, 11, 0.55)",
                    background: "rgba(245, 158, 11, 0.1)",
                    borderRadius: 4,
                    fontWeight: 600,
                  }}
                >
                  Redaction required (
                  {data.governance.requiresRedactionFieldCount} field
                  {data.governance.requiresRedactionFieldCount === 1
                    ? ""
                    : "s"}
                  )
                </span>
              )}
            </div>
            <p
              style={{
                ...mutedStyle,
                marginTop: 6,
                fontSize: 12,
              }}
            >
              {data.governance.legalHold.activeCount > 0
                ? "Evidence under legal hold cannot be deleted or purged. Export gating applies; package downloads remain subject to workspace policy. Open /governance/lifecycle for full hold lifecycle. "
                : ""}
              {data.governance.requiresRedaction
                ? "One or more visibility decisions for this evidence flag fields requiring redaction before report/package export. The export gate enforces this server-side; this strip is the operator-visible signal."
                : ""}
            </p>
          </section>
        )}

      {/* Phase A.1D — review workflow continuity. Surface the related
          artifacts + cross-surface links the reviewer needs without
          leaving the review workspace. Every link routes to a real,
          registered surface; downloads use the same audited endpoints
          ReportsIndex uses. */}
      <section
        style={{
          ...cardStyle,
          marginBottom: 12,
        }}
        data-section="reviewer-workflow-continuity"
      >
        <h3 style={sectionTitleStyle}>Linked artifacts &amp; context</h3>
        <ReviewerCrossSurfaceLinks evidenceId={p.evidenceId} />
      </section>

      {/* Phase B.2 — multi-stage review governance panel.
          Server-enforced state machine. Caller's next allowed action
          is computed by the API based on existing decision rows +
          policy triggers (escalated / legal hold / redaction
          required) + caller's team role (OWNER/ADMIN required for
          adjudication). */}
      {teamId ? (
        <ReviewerDecisionLineagePanel
          workflowId={workflowId}
          teamId={teamId}
        />
      ) : null}

      {/* Phase B.1-1 — structured reviewer notes. Wired to
          /v1/reviewer-ops/workspace/:workflowId/notes. Notes carry
          one of seven structured types and are audited via
          TeamActivity (REVIEWER_NOTE_CREATED). */}
      {teamId ? (
        <ReviewerNotesPanel
          workflowId={workflowId}
          teamId={teamId}
        />
      ) : null}

      {/* Phase B.1-3 — Honest deferred-features panel. The brief
          explicitly told us to "show honest unavailable state" rather
          than fake second-review, conflict-resolution, or evidence-
          compare. This panel documents the precise truth so an
          enterprise reviewer is never misled. */}
      <ReviewerDeferredFeaturesPanel />


      <div style={twoColStyle}>
        <section style={cardStyle}>
          <h3 style={sectionTitleStyle}>SLA dimensions</h3>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr>
                <th style={thLight}>Dimension</th>
                <th style={thLight}>State</th>
                <th style={thLight}>Due</th>
              </tr>
            </thead>
            <tbody>
              {p.slaDimensions.map((d) => (
                <tr key={d.dimension}>
                  <td style={tdLight}>
                    {d.dimension.toLowerCase().replace("_", " ")}
                  </td>
                  <td style={tdLight}>
                    <span style={slaBadgeStyle(d.state)}>
                      {d.state.toLowerCase().replace("_", " ")}
                    </span>
                  </td>
                  <td style={tdLight}>
                    <span style={mutedStyle}>
                      {formatRelative(d.dueAtUtc)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={sectionTitleStyle}>Assignment</h3>
          <div style={{ fontSize: 13 }}>
            <KV
              k="Assigned to"
              v={
                p.assignedToUserId
                  ? p.assignedToUserId.slice(0, 12) + "…"
                  : "Unassigned"
              }
            />
            <KV k="Assigned at" v={formatDateTime(p.assignedAtUtc)} />
            <KV k="Priority" v={p.priority} />
          </div>

          {data.openEscalation ? (
            <>
              <h3 style={sectionTitleStyle}>Open escalation</h3>
              <div
                style={{
                  border: "1px solid #fecaca",
                  background: "#fef2f2",
                  borderRadius: 6,
                  padding: 10,
                  fontSize: 13,
                  color: "#7f1d1d",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <span style={severityBadgeStyle(data.openEscalation.severity)}>
                    {data.openEscalation.severity}
                  </span>
                  <span style={mutedStyle}>
                    {data.openEscalation.reason}
                  </span>
                  <span style={{ marginLeft: "auto", ...mutedStyle }}>
                    {formatDateTime(data.openEscalation.createdAt)}
                  </span>
                </div>
                <div>{data.openEscalation.safeSummary}</div>
              </div>
            </>
          ) : null}
        </section>

        <section style={cardStyle}>
          <h3 style={sectionTitleStyle}>Allowed lifecycle transitions</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.allowedLifecycleTransitions.map((s) => (
              <span key={s} style={lifecycleBadgeStyle(s)}>
                {s.toLowerCase().replace("_", " ")}
              </span>
            ))}
            {data.allowedLifecycleTransitions.length === 0 ? (
              <span style={mutedStyle}>Terminal state</span>
            ) : null}
          </div>

          <h3 style={sectionTitleStyle}>Reviewer actions</h3>
          <div style={actionGridStyle}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy !== null || p.lifecycleState !== "ASSIGNED"}
              onClick={() => post("start", "start", {})}
            >
              Start review
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              disabled={
                busy !== null ||
                !["IN_REVIEW", "NEEDS_INFORMATION", "ESCALATED"].includes(
                  p.lifecycleState,
                )
              }
              onClick={() => setReasonModal("REQUEST_INFO")}
              data-reviewer-action-request-info
            >
              Request info
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={
                busy !== null ||
                !["IN_REVIEW", "NEEDS_INFORMATION", "ESCALATED"].includes(
                  p.lifecycleState,
                )
              }
              onClick={() => post("approve", "approve", {})}
            >
              Approve
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              disabled={
                busy !== null ||
                !["IN_REVIEW", "NEEDS_INFORMATION", "ESCALATED"].includes(
                  p.lifecycleState,
                )
              }
              onClick={() => setReasonModal("REJECT")}
              data-reviewer-action-reject
            >
              Reject
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              disabled={busy !== null}
              onClick={() => setReasonModal("PAUSE")}
              data-reviewer-action-pause
            >
              Pause
            </button>
            <a
              href="/reviewer-ops/escalations"
              style={{
                ...ghostButtonStyle,
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              Escalation log
            </a>
          </div>
        </section>
      </div>

      {/* Phase 2.5 — Keyboard shortcuts help overlay. Triggered by `?`
          (input-safe; ignored while typing). Mounted last so its
          z-index renders above other modals if both ever stack. */}
      <ReviewerShortcutsHelp
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      {/* Phase 2.4 — Structured reason modal. Replaces the three
          window.prompt calls that previously gathered request-info /
          reject / pause reasons. The modal validates + truncates and
          delegates the POST to the existing `post()` helper. */}
      <ReviewerReasonModal
        kind={reasonModal}
        open={reasonModal !== null}
        onCancel={() => setReasonModal(null)}
        onSubmit={async (reason) => {
          if (!reasonModal) return;
          if (reasonModal === "REQUEST_INFO") {
            await post("request-info", "request-info", { note: reason });
          } else if (reasonModal === "REJECT") {
            await post("reject", "reject", { note: reason });
          } else if (reasonModal === "PAUSE") {
            await post("pause", "pause", { pausedReason: reason });
          }
          // Close on success. The `post()` helper handles failures by
          // setting `error` on the page; the modal stays open in that
          // case so the operator can retry without retyping the reason.
          // The early returns above mean: only close when we actually
          // dispatched.
          setReasonModal(null);
        }}
      />
    </main>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "2px 0",
      }}
    >
      <span style={mutedStyle}>{k}</span>
      <span>{v}</span>
    </div>
  );
}

const twoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
  marginTop: 16,
  alignItems: "flex-start",
};

const thLight: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  color: TOKENS.inkMuted,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  padding: "6px 0",
  borderBottom: `1px solid ${TOKENS.border}`,
};

const tdLight: React.CSSProperties = {
  padding: "6px 0",
  borderBottom: `1px solid ${TOKENS.divider}`,
  fontSize: 12,
};

const actionGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 6,
  marginTop: 8,
};

// ---------------------------------------------------------------------------
// Phase A.1D — Reviewer cross-surface continuity.
//
// Renders a compact strip of links + on-demand downloads inside the
// review workspace so a reviewer can open the evidence, fetch the
// latest report, fetch the verification package, and jump back to the
// reviewer queue without leaving the review.
//
// Every action routes to an EXISTING endpoint or registered route;
// nothing is invented. Downloads use the same gated path the
// evidence-detail page uses (signed URLs, gated on policy, audited
// server-side). Failure messaging is honest: 202 → "still generating",
// 403 → "permission required", etc.
// ---------------------------------------------------------------------------
function ReviewerCrossSurfaceLinks({ evidenceId }: { evidenceId: string }) {
  const [busy, setBusy] = useState<null | "report" | "package">(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (kind: "report" | "package") => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const path =
        kind === "report"
          ? `/v1/evidence/${evidenceId}/report/latest`
          : `/v1/evidence/${evidenceId}/verification-package`;
      const resp = (await apiFetch(path, { method: "GET" })) as {
        url?: string;
        code?: string;
        message?: string;
      };
      if (resp.url) {
        window.open(resp.url, "_blank", "noopener,noreferrer");
      } else if (resp.code === "verification_package_pending") {
        setError(resp.message ?? "Package is still generating.");
      } else {
        setError(
          kind === "report"
            ? "Report URL unavailable."
            : "Package URL unavailable.",
        );
      }
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 202) {
        setError(
          kind === "report"
            ? "Report is still generating. Refresh shortly."
            : "Package is still generating. Refresh shortly.",
        );
      } else if (e.statusCode === 403) {
        setError("Permission required to download this artifact.");
      } else if (e.statusCode === 404) {
        setError("Artifact not found for this evidence.");
      } else if (e.statusCode === 409) {
        setError(e.message ?? "Download blocked by workspace policy.");
      } else {
        setError(e.message ?? "Could not start download.");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-reviewer-cross-surface-links
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        alignItems: "center",
        fontSize: 13,
      }}
    >
      <a
        href={`/evidence/${evidenceId}`}
        data-reviewer-link="open-evidence"
        style={{
          ...ghostButtonStyle,
          textDecoration: "none",
          display: "inline-block",
        }}
      >
        Open evidence detail
      </a>
      <button
        type="button"
        onClick={() => void open("report")}
        disabled={busy !== null}
        data-reviewer-link="download-report"
        style={ghostButtonStyle}
      >
        {busy === "report" ? "Opening…" : "Download latest report"}
      </button>
      <button
        type="button"
        onClick={() => void open("package")}
        disabled={busy !== null}
        data-reviewer-link="download-package"
        style={ghostButtonStyle}
      >
        {busy === "package" ? "Opening…" : "Download verification package"}
      </button>
      <a
        href="/reports"
        data-reviewer-link="open-reports"
        style={{
          ...ghostButtonStyle,
          textDecoration: "none",
          display: "inline-block",
        }}
      >
        Reports queue
      </a>
      <a
        href="/reviewer-ops/escalations"
        data-reviewer-link="open-escalations"
        style={{
          ...ghostButtonStyle,
          textDecoration: "none",
          display: "inline-block",
        }}
      >
        Escalations
      </a>
      {error ? (
        <span
          role="alert"
          data-reviewer-cross-surface-error
          style={{
            color: "#f6c8c8",
            fontSize: 12,
            width: "100%",
            marginTop: 4,
          }}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase B.1-1 + B.1-2 — Structured Reviewer Notes panel + Timeline.
//
// Wired to:
//   GET  /v1/reviewer-ops/workspace/:workflowId/notes?teamId=<uuid>
//   POST /v1/reviewer-ops/workspace/:workflowId/notes  body: { teamId, type, body }
//
// Backend stores notes as a v1 JSON envelope inside
// EvidenceReviewerComment.body so we don't need a schema migration.
// Audit emission is workspace-scoped via TeamActivity. RBAC mirrors
// the rest of reviewer-ops (requireReviewerActor on the workflow's
// team).
//
// Note types (operator-readable categories the brief specified):
//   observation, concern, request_info, escalation_context,
//   decision_rationale, legal_hold_context, redaction_context.
//
// Legacy plain-text comments created BEFORE Phase B.1 surface with
// type "general" — the parser tolerates them so we don't blow up on
// pre-existing rows.
// ---------------------------------------------------------------------------

type ReviewerNoteType =
  | "observation"
  | "concern"
  | "request_info"
  | "escalation_context"
  | "decision_rationale"
  | "legal_hold_context"
  | "redaction_context";

const NOTE_TYPE_OPTIONS: ReadonlyArray<{ value: ReviewerNoteType; label: string }> = [
  { value: "observation", label: "Observation" },
  { value: "concern", label: "Concern" },
  { value: "request_info", label: "Request info" },
  { value: "escalation_context", label: "Escalation context" },
  { value: "decision_rationale", label: "Decision rationale" },
  { value: "legal_hold_context", label: "Legal hold context" },
  { value: "redaction_context", label: "Redaction context" },
];

const NOTE_TYPE_LABELS: Record<string, string> = {
  observation: "Observation",
  concern: "Concern",
  request_info: "Request info",
  escalation_context: "Escalation context",
  decision_rationale: "Decision rationale",
  legal_hold_context: "Legal hold context",
  redaction_context: "Redaction context",
  general: "Note",
};

const NOTE_TYPE_TONE: Record<string, { bg: string; border: string }> = {
  observation: { bg: "rgba(99,102,241,0.06)", border: "rgba(99,102,241,0.45)" },
  concern: { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.55)" },
  request_info: { bg: "rgba(99,102,241,0.06)", border: "rgba(99,102,241,0.45)" },
  escalation_context: {
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.55)",
  },
  decision_rationale: {
    bg: "rgba(34,197,94,0.06)",
    border: "rgba(34,197,94,0.45)",
  },
  legal_hold_context: {
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.55)",
  },
  redaction_context: {
    bg: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.55)",
  },
  general: { bg: "rgba(127,127,127,0.06)", border: "rgba(127,127,127,0.4)" },
};

type ReviewerNote = {
  id: string;
  type: string;
  body: string;
  isLegacyPlainText: boolean;
  visibility: string;
  author: {
    userId: string;
    email: string | null;
    displayName: string | null;
  };
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
};

type NotesEnvelope = {
  workflowId: string;
  evidenceId: string;
  summary: { total: number };
  items: ReviewerNote[];
};

function ReviewerNotesPanel({
  workflowId,
  teamId,
}: {
  workflowId: string;
  teamId: string;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: NotesEnvelope }
    | { kind: "error"; status: number; message: string }
  >({ kind: "loading" });
  const [filterType, setFilterType] = useState<"all" | ReviewerNoteType | "general">(
    "all",
  );
  const [composeType, setComposeType] = useState<ReviewerNoteType>("observation");
  const [composeBody, setComposeBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/notes?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as NotesEnvelope;
      setState({ kind: "ready", data });
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        err instanceof Error ? err.message : "Could not load notes.";
      setState({ kind: "error", status, message });
    }
  }, [workflowId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitNote = useCallback(async () => {
    const trimmed = composeBody.trim();
    if (!trimmed) {
      setComposeError("Body is required.");
      return;
    }
    setSubmitting(true);
    setComposeError(null);
    try {
      await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/notes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, type: composeType, body: trimmed }),
        },
      );
      setComposeBody("");
      // Reload so the new note appears with its real audit-emitted state.
      await load();
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      if (status === 403) {
        setComposeError(
          "Permission denied. Reviewer note creation requires workspace membership.",
        );
      } else if (status === 404) {
        setComposeError("Workflow not found in this workspace.");
      } else if (status === 400) {
        setComposeError(
          "Request rejected — note body must be 1–4000 characters.",
        );
      } else {
        const message =
          err instanceof Error ? err.message : "Could not create note.";
        setComposeError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }, [composeBody, composeType, workflowId, teamId, load]);

  const visibleNotes =
    state.kind === "ready"
      ? filterType === "all"
        ? state.data.items
        : state.data.items.filter((n) => n.type === filterType)
      : [];

  return (
    <section
      style={{ ...cardStyle, marginBottom: 12 }}
      data-section="reviewer-notes"
      data-reviewer-notes-total={
        state.kind === "ready" ? state.data.summary.total : 0
      }
    >
      <h3 style={sectionTitleStyle}>
        Reviewer notes{" "}
        {state.kind === "ready" ? (
          <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 6 }}>
            · {state.data.summary.total} total
          </span>
        ) : null}
      </h3>
      <p
        style={{
          ...mutedStyle,
          fontSize: 12,
          marginTop: 0,
          marginBottom: 8,
        }}
      >
        Structured notes attached to the evidence under this review.
        Every note is audited via the workspace activity feed
        (REVIEWER_NOTE_CREATED). Notes persist across reviewers and
        survive workflow transitions.
      </p>

      {/* ---- compose ---- */}
      <form
        data-reviewer-notes-form
        onSubmit={(e) => {
          e.preventDefault();
          void submitNote();
        }}
        style={{
          display: "grid",
          gap: 6,
          padding: "0.5rem 0.6rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 6,
          marginBottom: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <label style={{ fontSize: 12, fontWeight: 600 }}>
            Type
            <select
              value={composeType}
              onChange={(e) =>
                setComposeType(e.target.value as ReviewerNoteType)
              }
              disabled={submitting}
              data-reviewer-notes-compose-type
              style={{ marginLeft: 6, fontSize: 12 }}
            >
              {NOTE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          value={composeBody}
          onChange={(e) => setComposeBody(e.target.value)}
          disabled={submitting}
          maxLength={4000}
          rows={3}
          placeholder="Write a structured reviewer note (1–4000 chars). Every note is audited."
          data-reviewer-notes-compose-body
          style={{
            width: "100%",
            fontSize: 13,
            padding: "0.4rem 0.5rem",
            border: "1px solid currentColor",
            borderRadius: 4,
            background: "transparent",
            color: "inherit",
            resize: "vertical",
            minHeight: 60,
          }}
        />
        {composeError ? (
          <div role="alert" data-reviewer-notes-compose-error style={{ fontSize: 12, color: "#d44" }}>
            {composeError}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            {composeBody.length}/4000
          </span>
          <button
            type="submit"
            disabled={submitting || composeBody.trim().length === 0}
            data-reviewer-notes-compose-submit
            style={primaryButtonStyle}
          >
            {submitting ? "Adding…" : "Add note"}
          </button>
        </div>
      </form>

      {/* ---- filter chips ---- */}
      {state.kind === "ready" && state.data.summary.total > 0 ? (
        <div
          data-reviewer-notes-filter
          style={{
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
            marginBottom: 8,
            fontSize: 12,
          }}
        >
          <FilterChip
            label="All"
            active={filterType === "all"}
            onClick={() => setFilterType("all")}
            count={state.data.summary.total}
            dataValue="all"
          />
          {(["observation", "concern", "request_info", "escalation_context", "decision_rationale", "legal_hold_context", "redaction_context"] as ReviewerNoteType[]).map((t) => {
            const c = state.data.items.filter((n) => n.type === t).length;
            if (c === 0) return null;
            return (
              <FilterChip
                key={t}
                label={NOTE_TYPE_LABELS[t]}
                active={filterType === t}
                onClick={() => setFilterType(t)}
                count={c}
                dataValue={t}
              />
            );
          })}
          {state.data.items.some((n) => n.type === "general") ? (
            <FilterChip
              label="Legacy"
              active={filterType === "general"}
              onClick={() => setFilterType("general")}
              count={state.data.items.filter((n) => n.type === "general").length}
              dataValue="general"
            />
          ) : null}
        </div>
      ) : null}

      {/* ---- list ---- */}
      {state.kind === "loading" ? (
        <div data-reviewer-notes-state="loading" style={mutedStyle}>
          Loading notes…
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div
          role="alert"
          data-reviewer-notes-state="error"
          style={{ fontSize: 13, opacity: 0.85 }}
        >
          {state.status === 403
            ? "You don't have permission to view notes for this workflow."
            : state.status === 404
              ? "Workflow not found in this workspace."
              : `Could not load notes${state.status ? ` (HTTP ${state.status})` : ""}.`}
          <button
            type="button"
            onClick={() => void load()}
            data-reviewer-notes-retry
            style={{
              marginLeft: 6,
              fontSize: 12,
              padding: "0.2rem 0.5rem",
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
      {state.kind === "ready" && state.data.summary.total === 0 ? (
        <div
          data-reviewer-notes-state="empty"
          style={{ ...mutedStyle, fontSize: 13 }}
        >
          No notes yet. Add the first structured note above to anchor
          this review's context for future reviewers.
        </div>
      ) : null}
      {state.kind === "ready" && visibleNotes.length === 0 && state.data.summary.total > 0 ? (
        <div data-reviewer-notes-state="filter-empty" style={{ fontSize: 13, opacity: 0.8 }}>
          No notes of type{" "}
          <strong>{NOTE_TYPE_LABELS[filterType] ?? filterType}</strong>. {" "}
          <button
            type="button"
            onClick={() => setFilterType("all")}
            style={{
              fontSize: 12,
              padding: "0.15rem 0.45rem",
              border: "1px solid currentColor",
              borderRadius: 4,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Show all
          </button>
        </div>
      ) : null}
      {state.kind === "ready" && visibleNotes.length > 0 ? (
        <ul
          data-reviewer-notes-items
          data-reviewer-notes-visible-count={visibleNotes.length}
          style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}
        >
          {visibleNotes.map((n) => {
            const tone = NOTE_TYPE_TONE[n.type] ?? NOTE_TYPE_TONE.general;
            return (
              <li
                key={n.id}
                data-reviewer-note-id={n.id}
                data-reviewer-note-type={n.type}
                data-reviewer-note-legacy={n.isLegacyPlainText ? "true" : "false"}
                style={{
                  padding: "0.55rem 0.7rem",
                  border: `1px solid ${tone.border}`,
                  background: tone.bg,
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span
                      data-reviewer-note-type-chip={n.type}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        textTransform: "uppercase",
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: "rgba(127,127,127,0.18)",
                      }}
                    >
                      {NOTE_TYPE_LABELS[n.type] ?? n.type}
                    </span>
                    <span style={{ fontWeight: 600 }}>
                      {n.author.displayName ||
                        n.author.email ||
                        n.author.userId.slice(0, 8)}
                    </span>
                  </div>
                  <time dateTime={n.createdAt} style={{ opacity: 0.75 }}>
                    {new Date(n.createdAt).toLocaleString()}
                  </time>
                </div>
                <div
                  data-reviewer-note-body
                  style={{
                    fontSize: 13,
                    marginTop: 4,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {n.body}
                </div>
                {n.isLegacyPlainText ? (
                  <div
                    data-reviewer-note-legacy-banner
                    style={{
                      marginTop: 4,
                      fontSize: 11,
                      opacity: 0.65,
                    }}
                  >
                    Legacy plain-text note (pre-Phase-B.1; no structured type).
                  </div>
                ) : null}
                {n.resolvedAt ? (
                  <div
                    data-reviewer-note-resolved
                    style={{
                      marginTop: 4,
                      fontSize: 11,
                      opacity: 0.7,
                    }}
                  >
                    Resolved {new Date(n.resolvedAt).toLocaleString()}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  count,
  dataValue,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count: number;
  dataValue: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-reviewer-notes-filter-chip={dataValue}
      data-reviewer-notes-filter-active={active ? "true" : "false"}
      style={{
        padding: "0.2rem 0.55rem",
        border: "1px solid currentColor",
        borderRadius: 999,
        fontSize: 12,
        background: active ? "rgba(99,102,241,0.18)" : "transparent",
        cursor: "pointer",
        color: "inherit",
      }}
    >
      {label} <span style={{ opacity: 0.65 }}>· {count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Phase B.2 — Multi-stage review governance panel.
//
// Wired to:
//   GET  /v1/reviewer-ops/workspace/:workflowId/decisions?teamId=<uuid>
//   POST /v1/reviewer-ops/workspace/:workflowId/decisions
//        body: { teamId, decision, reasonCode?, rationale }
//
// The API enforces every state-machine transition (first → second →
// adjudication), the same-reviewer guard, and the adjudicator role
// check. The UI mirrors the server's `callerContext.nextAction` to
// disable / enable the submit controls. Disabled states always
// explain WHY ("blocked: you submitted the FIRST decision",
// "blocked: only team OWNER/ADMIN can adjudicate", "no action: the
// review is already resolved").
//
// Decision lineage is rendered as a sequence card so reviewers see
// every prior decision (stage + reviewer + decision + reason +
// rationale + timestamp). Decisions cannot be edited or deleted —
// the audit chain is the truth.
// ---------------------------------------------------------------------------

type DecisionKind =
  | "APPROVE"
  | "REJECT"
  | "REQUEST_INFO"
  | "UPHOLD_FIRST"
  | "UPHOLD_SECOND"
  | "NEEDS_MORE_INFO"
  | "UNRESOLVED";

type ReasonCode =
  | "EVIDENCE_INCOMPLETE"
  | "REPORT_FAILED"
  | "INTEGRITY_CONCERN"
  | "CUSTODY_CONCERN"
  | "MISSING_CONTEXT"
  | "LEGAL_HOLD_ISSUE"
  | "REDACTION_REQUIRED"
  | "REVIEWER_DISAGREEMENT"
  | "OTHER";

type ReviewState =
  | "first_required"
  | "second_required"
  | "conflict_detected"
  | "adjudication_required"
  | "resolved";

type NextAction =
  | "submit_first"
  | "submit_second"
  | "submit_adjudication"
  | "blocked_same_reviewer"
  | "blocked_not_adjudicator"
  | "no_action_resolved";

type DecisionRow = {
  id: string;
  stage: "FIRST" | "SECOND" | "ADJUDICATION";
  decision: DecisionKind;
  reasonCode: ReasonCode | null;
  rationale: string;
  decidedAt: string;
  reviewer: {
    userId: string;
    email: string | null;
    displayName: string | null;
  };
};

type DecisionsEnvelope = {
  workflowId: string;
  evidenceId: string;
  state: ReviewState;
  secondReviewRequirement: {
    required: boolean;
    reason: string | null;
  };
  callerContext: {
    userId: string;
    teamRole: string | null;
    isAdjudicator: boolean;
    callerIsFirstReviewer: boolean;
    nextAction: NextAction;
  };
  decisions: DecisionRow[];
};

const STATE_LABELS: Record<ReviewState, string> = {
  first_required: "First review required",
  second_required: "Second review required",
  conflict_detected: "Conflict detected — adjudication required",
  adjudication_required: "Adjudication required",
  resolved: "Review resolved",
};

const STATE_TONE: Record<
  ReviewState,
  { bg: string; border: string; chipBg: string; chipFg: string }
> = {
  first_required: {
    bg: "rgba(99,102,241,0.06)",
    border: "rgba(99,102,241,0.45)",
    chipBg: "rgba(99,102,241,0.22)",
    chipFg: "#312e81",
  },
  second_required: {
    bg: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.55)",
    chipBg: "rgba(245,158,11,0.22)",
    chipFg: "#78350f",
  },
  conflict_detected: {
    bg: "rgba(239,68,68,0.1)",
    border: "rgba(239,68,68,0.65)",
    chipBg: "rgba(239,68,68,0.3)",
    chipFg: "#7f1d1d",
  },
  adjudication_required: {
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.55)",
    chipBg: "rgba(239,68,68,0.22)",
    chipFg: "#7f1d1d",
  },
  resolved: {
    bg: "rgba(34,197,94,0.06)",
    border: "rgba(34,197,94,0.45)",
    chipBg: "rgba(34,197,94,0.22)",
    chipFg: "#14532d",
  },
};

const DECISION_KIND_OPTIONS_FIRST_SECOND: DecisionKind[] = [
  "APPROVE",
  "REJECT",
  "REQUEST_INFO",
  "NEEDS_MORE_INFO",
];
const DECISION_KIND_OPTIONS_ADJUDICATION: DecisionKind[] = [
  "UPHOLD_FIRST",
  "UPHOLD_SECOND",
  "NEEDS_MORE_INFO",
  "UNRESOLVED",
];
const REASON_CODE_OPTIONS: ReasonCode[] = [
  "EVIDENCE_INCOMPLETE",
  "REPORT_FAILED",
  "INTEGRITY_CONCERN",
  "CUSTODY_CONCERN",
  "MISSING_CONTEXT",
  "LEGAL_HOLD_ISSUE",
  "REDACTION_REQUIRED",
  "REVIEWER_DISAGREEMENT",
  "OTHER",
];

function ReviewerDecisionLineagePanel({
  workflowId,
  teamId,
}: {
  workflowId: string;
  teamId: string;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: DecisionsEnvelope }
    | { kind: "error"; status: number; message: string }
  >({ kind: "loading" });

  // Compose form (only visible when submit is allowed)
  const [composeDecision, setComposeDecision] = useState<DecisionKind | "">("");
  const [composeReason, setComposeReason] = useState<ReasonCode | "">("");
  const [composeRationale, setComposeRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/decisions?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as DecisionsEnvelope;
      setState({ kind: "ready", data });
      // Reset compose state on reload.
      setComposeDecision("");
      setComposeReason("");
      setComposeRationale("");
      setSubmitError(null);
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        err instanceof Error ? err.message : "Could not load decisions.";
      setState({ kind: "error", status, message });
    }
  }, [workflowId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    if (!composeDecision) {
      setSubmitError("Pick a decision.");
      return;
    }
    if (composeRationale.trim().length === 0) {
      setSubmitError("Rationale is required.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/decisions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            teamId,
            decision: composeDecision,
            reasonCode: composeReason || undefined,
            rationale: composeRationale.trim(),
          }),
        },
      );
      await load();
    } catch (err: unknown) {
      const e = err as {
        statusCode?: number;
        message?: string;
        body?: { error?: { code?: string; reason?: string } };
      };
      const status = e.statusCode ?? 0;
      const code = e.body?.error?.code;
      const reason = e.body?.error?.reason;
      if (status === 409 && code === "same_reviewer_blocked") {
        setSubmitError(
          "Same-reviewer guard fired — you submitted the FIRST decision; a different reviewer must submit the SECOND.",
        );
      } else if (status === 403 && code === "adjudicator_role_required") {
        setSubmitError(
          "Adjudication requires team OWNER or ADMIN role on this workspace.",
        );
      } else if (status === 409 && code === "decision_not_allowed") {
        setSubmitError(
          "This review is already resolved; no further decisions are accepted.",
        );
      } else if (status === 400) {
        setSubmitError(reason ?? e.message ?? "Request rejected.");
      } else {
        setSubmitError(e.message ?? "Submit failed.");
      }
    } finally {
      setSubmitting(false);
    }
  }, [composeDecision, composeReason, composeRationale, workflowId, teamId, load]);

  if (state.kind === "loading") {
    return (
      <section
        style={{ ...cardStyle, marginBottom: 12 }}
        data-section="reviewer-decision-lineage"
        data-decision-state="loading"
      >
        <h3 style={sectionTitleStyle}>Multi-stage review governance</h3>
        <div style={mutedStyle}>Loading review state…</div>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section
        style={{ ...cardStyle, marginBottom: 12 }}
        data-section="reviewer-decision-lineage"
        data-decision-state="error"
      >
        <h3 style={sectionTitleStyle}>Multi-stage review governance</h3>
        <div role="alert" style={{ fontSize: 13, opacity: 0.85 }}>
          {state.status === 404
            ? "Workflow not found in this workspace."
            : state.status === 403
              ? "You don't have permission to view review decisions."
              : `Could not load decisions${state.status ? ` (HTTP ${state.status})` : ""}.`}
        </div>
      </section>
    );
  }

  const data = state.data;
  const tone = STATE_TONE[data.state];
  const stageOptions =
    data.callerContext.nextAction === "submit_adjudication"
      ? DECISION_KIND_OPTIONS_ADJUDICATION
      : DECISION_KIND_OPTIONS_FIRST_SECOND;
  const canSubmit =
    data.callerContext.nextAction === "submit_first" ||
    data.callerContext.nextAction === "submit_second" ||
    data.callerContext.nextAction === "submit_adjudication";

  return (
    <section
      style={{
        ...cardStyle,
        marginBottom: 12,
        background: tone.bg,
        borderColor: tone.border,
      }}
      data-section="reviewer-decision-lineage"
      data-decision-state={data.state}
      data-decision-next-action={data.callerContext.nextAction}
      data-decision-requires-second={
        data.secondReviewRequirement.required ? "true" : "false"
      }
      data-decision-caller-is-first-reviewer={
        data.callerContext.callerIsFirstReviewer ? "true" : "false"
      }
      data-decision-is-adjudicator={
        data.callerContext.isAdjudicator ? "true" : "false"
      }
    >
      <h3 style={sectionTitleStyle}>
        Multi-stage review governance{" "}
        <span
          data-decision-state-chip={data.state}
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.4,
            padding: "2px 8px",
            borderRadius: 999,
            background: tone.chipBg,
            color: tone.chipFg,
            marginLeft: 6,
          }}
        >
          {STATE_LABELS[data.state]}
        </span>
      </h3>

      {data.secondReviewRequirement.required ? (
        <div
          data-decision-second-review-reason={data.secondReviewRequirement.reason}
          style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}
        >
          Second review required —{" "}
          <strong>
            {data.secondReviewRequirement.reason?.replace(/_/g, " ") ??
              "policy-required"}
          </strong>
          .
        </div>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
          Single-stage review (no policy trigger for second review).
        </div>
      )}

      {/* ---- next-action / submit form ---- */}
      {canSubmit ? (
        <form
          data-decision-form
          data-decision-form-stage={
            data.callerContext.nextAction === "submit_first"
              ? "FIRST"
              : data.callerContext.nextAction === "submit_second"
                ? "SECOND"
                : "ADJUDICATION"
          }
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{
            display: "grid",
            gap: 6,
            marginTop: 10,
            padding: "0.6rem 0.75rem",
            border: "1px solid currentColor",
            borderRadius: 6,
            background: "rgba(255,255,255,0.04)",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700 }}>
            Submit{" "}
            {data.callerContext.nextAction === "submit_first"
              ? "FIRST"
              : data.callerContext.nextAction === "submit_second"
                ? "SECOND"
                : "ADJUDICATION"}{" "}
            decision
          </div>
          <label style={{ fontSize: 12 }}>
            Decision
            <select
              value={composeDecision}
              onChange={(e) =>
                setComposeDecision(e.target.value as DecisionKind | "")
              }
              disabled={submitting}
              required
              data-decision-form-decision
              style={{ marginLeft: 6, fontSize: 12 }}
            >
              <option value="">— pick —</option>
              {stageOptions.map((d) => (
                <option key={d} value={d}>
                  {d.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>
            Reason code (optional but recommended)
            <select
              value={composeReason}
              onChange={(e) => setComposeReason(e.target.value as ReasonCode | "")}
              disabled={submitting}
              data-decision-form-reason
              style={{ marginLeft: 6, fontSize: 12 }}
            >
              <option value="">— none —</option>
              {REASON_CODE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <textarea
            value={composeRationale}
            onChange={(e) => setComposeRationale(e.target.value)}
            disabled={submitting}
            maxLength={4000}
            rows={3}
            placeholder="Rationale (required; 1–4000 chars). Captured in the audit chain and visible to subsequent reviewers."
            data-decision-form-rationale
            style={{
              fontSize: 13,
              padding: "0.4rem 0.5rem",
              border: "1px solid currentColor",
              borderRadius: 4,
              background: "transparent",
              color: "inherit",
              resize: "vertical",
              minHeight: 60,
            }}
          />
          {submitError ? (
            <div
              role="alert"
              data-decision-form-error
              style={{ fontSize: 12, color: "#d44" }}
            >
              {submitError}
            </div>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>
              {composeRationale.length}/4000
            </span>
            <button
              type="submit"
              disabled={
                submitting ||
                !composeDecision ||
                composeRationale.trim().length === 0
              }
              data-decision-form-submit
              style={primaryButtonStyle}
            >
              {submitting ? "Submitting…" : "Submit decision"}
            </button>
          </div>
        </form>
      ) : (
        <div
          data-decision-blocked-banner={data.callerContext.nextAction}
          style={{
            marginTop: 10,
            padding: "0.5rem 0.7rem",
            border: "1px dashed currentColor",
            borderRadius: 6,
            fontSize: 12.5,
          }}
        >
          {data.callerContext.nextAction === "blocked_same_reviewer" && (
            <>
              <strong>Same-reviewer guard:</strong> you submitted the FIRST
              decision. A different reviewer must submit the SECOND review
              for independence.
            </>
          )}
          {data.callerContext.nextAction === "blocked_not_adjudicator" && (
            <>
              <strong>Adjudicator role required:</strong> a conflict was
              detected between the FIRST and SECOND decisions. Only team
              OWNER or ADMIN can adjudicate (your role:{" "}
              <code>{data.callerContext.teamRole ?? "—"}</code>).
            </>
          )}
          {data.callerContext.nextAction === "no_action_resolved" && (
            <>
              <strong>Review resolved:</strong> the audit chain is closed
              for this workflow. No further decisions are accepted.
            </>
          )}
        </div>
      )}

      {/* ---- decision lineage ---- */}
      {data.decisions.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              opacity: 0.8,
              marginBottom: 6,
            }}
          >
            Decision lineage ({data.decisions.length})
          </div>
          <ol
            data-decision-lineage
            data-decision-lineage-count={data.decisions.length}
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 6,
            }}
          >
            {data.decisions.map((d, idx) => (
              <li
                key={d.id}
                data-decision-row
                data-decision-stage={d.stage}
                data-decision-kind={d.decision}
                data-decision-reason-code={d.reasonCode ?? ""}
                data-decision-reviewer-id={d.reviewer.userId}
                style={{
                  padding: "0.5rem 0.7rem",
                  border: "1px solid rgba(127,127,127,0.3)",
                  background: "rgba(255,255,255,0.04)",
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
                  >
                    <span
                      data-decision-stage-chip={d.stage}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: "rgba(127,127,127,0.18)",
                      }}
                    >
                      #{idx + 1} · {d.stage}
                    </span>
                    <span
                      data-decision-kind-chip={d.decision}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background:
                          d.decision === "APPROVE" ||
                          d.decision === "UPHOLD_FIRST" ||
                          d.decision === "UPHOLD_SECOND"
                            ? "rgba(34,197,94,0.22)"
                            : d.decision === "REJECT"
                              ? "rgba(239,68,68,0.22)"
                              : "rgba(245,158,11,0.22)",
                      }}
                    >
                      {d.decision.replace(/_/g, " ")}
                    </span>
                    {d.reasonCode ? (
                      <span
                        data-decision-reason-chip={d.reasonCode}
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: "rgba(127,127,127,0.12)",
                        }}
                      >
                        {d.reasonCode.replace(/_/g, " ")}
                      </span>
                    ) : null}
                    <span style={{ fontWeight: 600 }}>
                      {d.reviewer.displayName ||
                        d.reviewer.email ||
                        d.reviewer.userId.slice(0, 8)}
                    </span>
                  </div>
                  <time dateTime={d.decidedAt} style={{ opacity: 0.75 }}>
                    {new Date(d.decidedAt).toLocaleString()}
                  </time>
                </div>
                <div
                  data-decision-rationale
                  style={{
                    fontSize: 13,
                    marginTop: 4,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {d.rationale}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div
          data-decision-lineage-empty
          style={{ marginTop: 10, ...mutedStyle, fontSize: 13 }}
        >
          No decisions recorded yet for this workflow.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phase B.1-3 — Honest deferred-features panel.
//
// The brief explicitly told us to "show honest unavailable state"
// for features whose backend doesn't yet exist. Faking second-review,
// conflict resolution, or evidence-compare would have violated the
// brief's non-negotiable rules.
//
// This panel is the operator-visible truth: what Phase B.1 added,
// and what specifically remains backend-modeling work.
// ---------------------------------------------------------------------------
function ReviewerDeferredFeaturesPanel() {
  return (
    <section
      data-section="reviewer-deferred-features"
      style={{
        ...cardStyle,
        marginBottom: 12,
        background: "rgba(127,127,127,0.04)",
      }}
    >
      <h3 style={sectionTitleStyle}>Reviewer collaboration scope</h3>
      <p style={{ ...mutedStyle, fontSize: 12, marginTop: 0 }}>
        Honest summary of what reviewer collaboration supports today
        vs what is deliberately deferred to future backend work. Items
        marked “deferred” are not faked anywhere in this UI — the
        underlying state machine genuinely does not exist yet.
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
          data-reviewer-deferred-block="available"
          style={{
            padding: "0.6rem 0.75rem",
            border: "1px solid rgba(34,197,94,0.45)",
            background: "rgba(34,197,94,0.06)",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <div style={deferredBlockTitleStyle}>Available now</div>
          <ul style={deferredListStyle}>
            <li data-reviewer-deferred-item="structured-notes">
              <strong>Structured reviewer notes</strong> with 7 types
              (observation, concern, request_info, escalation_context,
              decision_rationale, legal_hold_context,
              redaction_context). Audited via TeamActivity.
            </li>
            <li data-reviewer-deferred-item="decision-audit-chain">
              <strong>Decision audit chain.</strong> Every approve /
              reject / request-info / pause / escalate emits a
              SecurityEvent + workflow event. Decision history is
              traceable via /v1/reviewer-ops/workspace/:workflowId.
            </li>
            <li data-reviewer-deferred-item="rationale-required">
              <strong>Rationale enforcement.</strong> ESCALATE / PAUSE /
              REQUEST_INFO require a note server-side (bulk + per-row).
            </li>
            <li data-reviewer-deferred-item="governance-signals">
              <strong>Governance signals on the review.</strong> Legal
              hold count + redaction-required field count surface
              read-only (Phase B-2).
            </li>
            <li data-reviewer-deferred-item="multi-stage-review">
              <strong>Multi-stage review governance</strong> (Phase
              B.2). FIRST → SECOND → ADJUDICATION state machine
              enforced server-side. Same-reviewer guard fires 409.
              Conflict detection auto-derives from mismatched
              decisions. Adjudication requires team OWNER/ADMIN.
              Audited via TeamActivity (REVIEWER_DECISION_FIRST /
              _SECOND / _ADJUDICATION).
            </li>
            <li data-reviewer-deferred-item="decision-lineage">
              <strong>Decision lineage</strong> (Phase B.2). Every
              decision row carries stage + decision kind + reason code
              + rationale + reviewer + timestamp. Visible inline on
              this review surface; never overwritten.
            </li>
          </ul>
        </div>
        <div
          data-reviewer-deferred-block="deferred"
          style={{
            padding: "0.6rem 0.75rem",
            border: "1px solid rgba(127,127,127,0.4)",
            background: "rgba(127,127,127,0.04)",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <div style={deferredBlockTitleStyle}>Deferred</div>
          <ul style={deferredListStyle}>
            {/* Phase B.2 PROMOTED — second-review + conflict
                 resolution are NOW DELIVERED via the multi-stage
                 review governance panel above. The items below have
                 moved out of "deferred" to "available" in the panel
                 header. */}
            <li data-reviewer-deferred-item="manual-second-review-override">
              <strong>Manual “require second review” override.</strong>{" "}
              Phase B.2 derives the second-review requirement from
              policy triggers (escalated, legal hold, redaction). A
              per-workflow manual override flag is a future migration.
            </li>
            <li data-reviewer-deferred-item="senior-reviewer-role">
              <strong>Dedicated senior-reviewer role.</strong>{" "}
              Adjudication uses the existing team OWNER / ADMIN role.
              A separate REVIEW_LEAD role would require workspace-
              capability model changes.
            </li>
            <li data-reviewer-deferred-item="evidence-compare">
              <strong>Evidence side-by-side compare.</strong> Manual
              evidence relationships exist on /evidence; a dedicated
              compare UI inside the review workspace is not built.
            </li>
            <li data-reviewer-deferred-item="search-notes">
              <strong>Full-text note search.</strong> Notes filter
              locally by type today; backend full-text search is not
              wired.
            </li>
            <li data-reviewer-deferred-item="auto-routing">
              <strong>Auto-routing rules engine.</strong> Reviewer
              workload snapshots ARE wired at /reviewer-ops/sla — the
              suggestions are advisory only. No rule-based automatic
              assignment.
            </li>
            <li data-reviewer-deferred-item="note-edit-delete">
              <strong>Note edit / delete.</strong> The underlying
              EvidenceReviewerComment supports soft-delete +
              resolution; the reviewer-ops UI surface for those is
              not exposed in this phase.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

const deferredBlockTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  marginBottom: 6,
  opacity: 0.85,
};

const deferredListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: "1.1rem",
  display: "grid",
  gap: 5,
};
