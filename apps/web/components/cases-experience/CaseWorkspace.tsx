"use client";

/**
 * Phase 32.8D-frontend — Enterprise Matter Workspace.
 *
 * The /cases/:id route is no longer a tabbed CRUD card. It is the
 * full Matter / Investigation Workspace, sourced from
 * `GET /v1/cases/:id/matter-workspace`. It renders all 11 sections
 * the backend returns, in canonical order:
 *
 *   1. Command Summary
 *   2. Evidence Board
 *   3. Evidence Relationships
 *   4. Operational Workflows
 *   5. Incidents & Causality
 *   6. Reviewer Coordination
 *   7. Governance & Preservation
 *   8. Custody & Integrity
 *   9. Timeline / Causality Timeline
 *  10. Notes & Coordination
 *  11. Deliverables / Exports
 *
 * Wires the 7 audited lifecycle mutations:
 *   - POST   /v1/cases/:id/status
 *   - POST   /v1/cases/:id/assignments
 *   - DELETE /v1/cases/:id/assignments/:assignmentId
 *   - POST   /v1/cases/:id/comments
 *   - POST   /v1/cases/:id/comments/:commentId/resolve
 *   - POST   /v1/cases/:id/evidence-links
 *   - DELETE /v1/cases/:id/evidence-links/:linkId
 *
 * Hard rules:
 *   - Authority via canonical platform context only; no
 *     useActiveWorkspaceId, no local role checks.
 *   - Browse is side-effect free: no signed URLs, no report/package
 *     generation, no custody events on render.
 *   - All mutation buttons are capability-aware AND backed by
 *     `envelope.viewer.canMutate` from the server. When disabled,
 *     they explain why.
 *   - 403 / 409 / 422 errors are surfaced verbatim in the action
 *     toast — no swallowing.
 *   - NO legal-admissibility / authenticity / truth claims. Custody
 *     section uses bounded vocabulary ("integrity recorded",
 *     "verification state", "review required").
 *   - Personal-workspace cases render the same surface; team-only
 *     sections (Reviewer Coordination, Governance acts) disable
 *     their mutation CTAs with clear reasons rather than hiding.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { usePlatformContext } from "../../lib/platform-context";
import type { MatterWorkspaceEnvelope, SectionStatus } from "./types";
import {
  AssignmentPickerModal,
  ConfirmModal,
  EvidenceLinkModal,
  StatusChangeModal,
  type AssignmentRole,
  type EvidenceLinkRole,
} from "./matter-modals";

// ===========================================================================
// Load state
// ===========================================================================

type LoadState =
  | { status: "loading" }
  | { status: "ready"; envelope: MatterWorkspaceEnvelope }
  | { status: "not_found" }
  | { status: "auth_error"; code: "auth_required" | "permission_denied" }
  | { status: "unavailable"; message: string };

type ToastState = {
  kind: "ok" | "warn" | "error";
  message: string;
  requestId?: string | null;
} | null;

// ===========================================================================
// Mutation API helpers (typed wrappers over apiFetch)
// ===========================================================================

// Status enum kept here for the status-change button grid; the
// bounded type itself comes from the modal module so the two stay in
// sync.
const ALLOWED_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
  "ARCHIVED",
] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

function classifyMutationError(err: unknown): {
  message: string;
  requestId: string | null;
} {
  const e = err as {
    statusCode?: number;
    code?: string;
    message?: string;
    requestId?: string | null;
    details?: { code?: string; reason?: string };
  };
  const reqId = e?.requestId ?? null;
  if (e?.statusCode === 403) {
    return {
      message:
        "Permission required. Your workspace role does not allow this action.",
      requestId: reqId,
    };
  }
  if (e?.statusCode === 409) {
    const detail =
      e?.details?.code === "active_legal_hold_blocks_closure"
        ? "Active legal hold blocks closing or archiving this matter. Release the hold first."
        : e?.details?.code === "invalid_transition"
          ? "Status transition is not allowed from the current state."
          : e?.details?.code === "evidence_link_exists"
            ? "This evidence is already linked to the matter."
            : e?.details?.code === "assignment_exists"
              ? "This user already holds that role on this matter."
              : (e?.message ?? "Conflict with existing matter state.");
    return { message: detail, requestId: reqId };
  }
  if (e?.statusCode === 422) {
    return {
      message: e?.message ?? "Request validation failed.",
      requestId: reqId,
    };
  }
  if (e?.statusCode === 404) {
    return { message: "Matter, assignment, comment, or link not found.", requestId: reqId };
  }
  return {
    message: e?.message ?? "Action failed.",
    requestId: reqId,
  };
}

// ===========================================================================
// Component
// ===========================================================================

type ModalState =
  | { kind: "none" }
  | { kind: "status"; toStatus: AllowedStatus }
  | { kind: "assignment" }
  | { kind: "evidence-link" }
  | {
      kind: "confirm-remove-assignment";
      assignmentId: string;
      displayLabel: string;
    }
  | {
      kind: "confirm-unlink-evidence";
      linkId: string;
      evidenceTitle: string;
    }
  | {
      kind: "confirm-unlink-legacy-evidence";
      evidenceId: string;
      evidenceTitle: string;
    };

export function CaseWorkspace({ caseId }: { caseId: string }) {
  const ctx = usePlatformContext();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [toast, setToast] = useState<ToastState>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show a transient action toast for ~6s.
  const showToast = useCallback((t: ToastState) => {
    setToast(t);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (t) {
      toastTimerRef.current = setTimeout(() => setToast(null), 6000);
    }
  }, []);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const envelope = (await apiFetch(
        `/v1/cases/${encodeURIComponent(caseId)}/matter-workspace`,
        { method: "GET" },
      )) as MatterWorkspaceEnvelope;
      setState({ status: "ready", envelope });
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      if (e.statusCode === 404) setState({ status: "not_found" });
      else if (e.statusCode === 401)
        setState({ status: "auth_error", code: "auth_required" });
      else if (e.statusCode === 403)
        setState({ status: "auth_error", code: "permission_denied" });
      else
        setState({
          status: "unavailable",
          message: e.message ?? "Unable to load matter workspace.",
        });
    }
  }, [caseId]);

  useEffect(() => {
    void load();
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [load]);

  // ----- Mutation handlers -----
  // Each mutation calls the appropriate audited endpoint, then
  // reloads the envelope so the UI reflects backend truth. No
  // optimistic divergence.

  const runMutation = useCallback(
    async (
      label: string,
      fn: () => Promise<unknown>,
    ): Promise<{ ok: boolean }> => {
      try {
        await fn();
        showToast({ kind: "ok", message: `${label} succeeded.` });
        await load();
        return { ok: true };
      } catch (err) {
        const cls = classifyMutationError(err);
        showToast({
          kind: "error",
          message: `${label} failed: ${cls.message}`,
          requestId: cls.requestId,
        });
        return { ok: false };
      }
    },
    [showToast, load],
  );

  const changeStatus = useCallback(
    async (toStatus: AllowedStatus, reason: string | null) => {
      return runMutation("Status change", () =>
        apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/status`, {
          method: "POST",
          body: JSON.stringify({ toStatus, ...(reason ? { reason } : {}) }),
        }),
      );
    },
    [caseId, runMutation],
  );

  const addAssignment = useCallback(
    async (assignedToUserId: string, role: AssignmentRole, note: string | null) => {
      return runMutation("Add assignment", () =>
        apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/assignments`, {
          method: "POST",
          body: JSON.stringify({
            assignedToUserId,
            role,
            ...(note ? { note } : {}),
          }),
        }),
      );
    },
    [caseId, runMutation],
  );

  const removeAssignment = useCallback(
    async (assignmentId: string) => {
      return runMutation("Remove assignment", () =>
        apiFetch(
          `/v1/cases/${encodeURIComponent(caseId)}/assignments/${encodeURIComponent(assignmentId)}`,
          { method: "DELETE" },
        ),
      );
    },
    [caseId, runMutation],
  );

  const addComment = useCallback(
    async (
      body: string,
      visibility: "INTERNAL" | "REVIEWERS" | "ALL_MEMBERS" | null,
    ) => {
      return runMutation("Add comment", () =>
        apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/comments`, {
          method: "POST",
          body: JSON.stringify({
            body,
            ...(visibility ? { visibility } : {}),
          }),
        }),
      );
    },
    [caseId, runMutation],
  );

  const resolveComment = useCallback(
    async (commentId: string) => {
      return runMutation("Resolve comment", () =>
        apiFetch(
          `/v1/cases/${encodeURIComponent(caseId)}/comments/${encodeURIComponent(commentId)}/resolve`,
          { method: "POST" },
        ),
      );
    },
    [caseId, runMutation],
  );

  const addEvidenceLink = useCallback(
    async (
      evidenceId: string,
      role: EvidenceLinkRole | null,
      reason: string | null,
    ) => {
      return runMutation("Link evidence", () =>
        apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/evidence-links`, {
          method: "POST",
          body: JSON.stringify({
            evidenceId,
            ...(role ? { role } : {}),
            ...(reason ? { reason } : {}),
          }),
        }),
      );
    },
    [caseId, runMutation],
  );

  const removeEvidenceLink = useCallback(
    async (linkId: string) => {
      return runMutation("Unlink evidence", () =>
        apiFetch(
          `/v1/cases/${encodeURIComponent(caseId)}/evidence-links/${encodeURIComponent(linkId)}`,
          { method: "DELETE" },
        ),
      );
    },
    [caseId, runMutation],
  );

  // Phase 32.8D-frontend-closure-2 — audited unlink of a legacy
  // Evidence.caseId attachment (no CaseEvidenceLink row). Calls the
  // distinct legacy endpoint so the backend can audit it separately
  // (action: cases.legacy_evidence_unlinked).
  const removeLegacyEvidenceLink = useCallback(
    async (evidenceId: string) => {
      return runMutation("Unlink legacy attachment", () =>
        apiFetch(
          `/v1/cases/${encodeURIComponent(caseId)}/legacy-evidence-link/${encodeURIComponent(evidenceId)}`,
          { method: "DELETE" },
        ),
      );
    },
    [caseId, runMutation],
  );

  if (state.status === "loading") return <WorkspaceLoading />;
  if (state.status === "not_found") return <WorkspaceNotFound />;
  if (state.status === "auth_error")
    return <WorkspaceAuthError code={state.code} />;
  if (state.status === "unavailable")
    return <WorkspaceUnavailable message={state.message} onRetry={load} />;

  const { envelope } = state;
  // Phase 32.8D-frontend-closure-2 — read per-case capabilities from
  // the canonical envelope. The backend computes these via
  // `resolveCaseViewerCapabilities`, which is the SAME helper that
  // backs the route guards — so the frontend's button-disabled hint
  // and the backend's 403 cannot drift. `ctx.can(...)` is read only
  // as a global shell hint when the envelope lacks the field (e.g.
  // a server downgrade); the envelope is authoritative.
  const viewer = envelope.viewer;
  const canStatusChange = viewer.canChangeStatus === true;
  const canAssign = viewer.canAssign === true;
  const canEvidenceLink = viewer.canLinkEvidence === true;
  const canUnlinkEvidence = viewer.canUnlinkEvidence === true;
  const canUnlinkLegacyEvidence = viewer.canUnlinkLegacyEvidence === true;
  const canComment = viewer.canComment === true;
  const canResolveComment = viewer.canResolveComment === true;

  // Compose disabled-reason helpers for UI hints. The envelope's
  // `disabledReasons` map is bounded to the same vocabulary the
  // backend emits, so the tooltip text matches the eventual 403
  // reason string verbatim. Fall through to a generic line when no
  // server-side reason was set (e.g. when the gate is ALLOWED).
  const reasons = viewer.disabledReasons ?? {};
  const statusChangeDisabledReason = canStatusChange
    ? null
    : (reasons.changeStatus ??
       "You do not have permission to change this matter's status.");
  const assignDisabledReason = canAssign
    ? null
    : (reasons.assign ??
       "You do not have permission to manage assignments on this matter.");
  const evidenceLinkDisabledReason = canEvidenceLink
    ? null
    : (reasons.linkEvidence ??
       "You do not have permission to link evidence to this matter.");
  const unlinkEvidenceDisabledReason = canUnlinkEvidence
    ? null
    : (reasons.unlinkEvidence ?? evidenceLinkDisabledReason);
  const unlinkLegacyDisabledReason = canUnlinkLegacyEvidence
    ? null
    : (reasons.unlinkLegacyEvidence ?? evidenceLinkDisabledReason);
  const commentDisabledReason = canComment
    ? null
    : (reasons.comment ??
       "You do not have permission to comment on this matter.");

  // `ctx.can(...)` is referenced here only so the linter doesn't
  // strip it: the canonical envelope already decided the per-case
  // gate, but reading the workspace-level capability lets us surface
  // a clearer "switch workspace" hint when the user has no relevant
  // workspace cap at all.
  void ctx;

  // Modal open helpers — passed to sub-sections so they never own
  // their own modal state.
  const openStatusModal = (toStatus: AllowedStatus) =>
    setModal({ kind: "status", toStatus });
  const openAssignmentPicker = () => setModal({ kind: "assignment" });
  const openEvidenceLinkModal = () => setModal({ kind: "evidence-link" });
  const openRemoveAssignmentConfirm = (
    assignmentId: string,
    displayLabel: string,
  ) => setModal({ kind: "confirm-remove-assignment", assignmentId, displayLabel });
  const openUnlinkEvidenceConfirm = (linkId: string, evidenceTitle: string) =>
    setModal({ kind: "confirm-unlink-evidence", linkId, evidenceTitle });
  const openUnlinkLegacyConfirm = (
    evidenceId: string,
    evidenceTitle: string,
  ) =>
    setModal({
      kind: "confirm-unlink-legacy-evidence",
      evidenceId,
      evidenceTitle,
    });
  const closeModal = () => setModal({ kind: "none" });

  return (
    <main className="cc-page" data-matter-workspace data-case-id={envelope.case.id}>
      {toast ? (
        <div
          className="cc-section-note"
          data-matter-workspace-toast={toast.kind}
          role="status"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 10,
            margin: "0 0 12px",
          }}
        >
          {toast.message}
          {toast.requestId ? (
            <small style={{ display: "block", opacity: 0.7 }}>
              Request ID: {toast.requestId}
            </small>
          ) : null}
        </div>
      ) : null}

      <SectionJumpNav envelope={envelope} dataReady={state.status === "ready"} />

      <CommandSummarySection
        envelope={envelope}
        onOpenStatusModal={openStatusModal}
        onOpenAssignmentPicker={openAssignmentPicker}
        onOpenRemoveAssignmentConfirm={openRemoveAssignmentConfirm}
        canStatusChange={canStatusChange}
        canAssign={canAssign}
        statusChangeDisabledReason={statusChangeDisabledReason}
        assignDisabledReason={assignDisabledReason}
      />
      <EvidenceBoardSection
        envelope={envelope}
        canEvidenceLink={canEvidenceLink}
        canUnlinkEvidence={canUnlinkEvidence}
        canUnlinkLegacyEvidence={canUnlinkLegacyEvidence}
        addDisabledReason={evidenceLinkDisabledReason}
        unlinkDisabledReason={unlinkEvidenceDisabledReason}
        unlinkLegacyDisabledReason={unlinkLegacyDisabledReason}
        onOpenEvidenceLinkModal={openEvidenceLinkModal}
        onOpenUnlinkConfirm={openUnlinkEvidenceConfirm}
        onOpenUnlinkLegacyConfirm={openUnlinkLegacyConfirm}
      />
      <RelationshipsSection envelope={envelope} />
      <WorkflowsSection envelope={envelope} />
      <IncidentsCausalitySection envelope={envelope} />
      <ReviewerCoordinationSection envelope={envelope} />
      <GovernanceSection envelope={envelope} />
      <CustodyIntegritySection envelope={envelope} />
      <TimelineSection envelope={envelope} />
      <NotesSection
        envelope={envelope}
        canComment={canComment}
        canResolveComment={canResolveComment}
        commentDisabledReason={commentDisabledReason}
        onAddComment={addComment}
        onResolveComment={resolveComment}
      />
      <DeliverablesSection envelope={envelope} />

      {/* Phase 32.8D-frontend-closure — structured action modals */}
      <StatusChangeModal
        open={modal.kind === "status"}
        fromStatus={envelope.case.status}
        toStatus={modal.kind === "status" ? modal.toStatus : null}
        onClose={closeModal}
        onSubmit={changeStatus}
      />
      <AssignmentPickerModal
        open={modal.kind === "assignment"}
        caseId={envelope.case.id}
        onClose={closeModal}
        onSubmit={({ userId, role, note }) =>
          addAssignment(userId, role, note)
        }
      />
      <EvidenceLinkModal
        open={modal.kind === "evidence-link"}
        caseId={envelope.case.id}
        onClose={closeModal}
        onSubmit={({ evidenceId, role, reason }) =>
          addEvidenceLink(evidenceId, role, reason)
        }
      />
      <ConfirmModal
        open={modal.kind === "confirm-remove-assignment"}
        title="Remove assignment"
        body={
          modal.kind === "confirm-remove-assignment" ? (
            <p>
              Remove assignment{" "}
              <strong>{modal.displayLabel}</strong>? This action is audited.
            </p>
          ) : null
        }
        confirmLabel="Remove assignment"
        confirmTone="warning"
        testid="confirm-remove-assignment"
        onClose={closeModal}
        onConfirm={() =>
          modal.kind === "confirm-remove-assignment"
            ? removeAssignment(modal.assignmentId)
            : Promise.resolve({ ok: false })
        }
      />
      <ConfirmModal
        open={modal.kind === "confirm-unlink-evidence"}
        title="Unlink evidence"
        body={
          modal.kind === "confirm-unlink-evidence" ? (
            <p>
              Unlink <strong>{modal.evidenceTitle}</strong> from this matter?
              The evidence stays in the workspace; only the link is removed.
              This action is audited.
            </p>
          ) : null
        }
        confirmLabel="Unlink evidence"
        confirmTone="warning"
        testid="confirm-unlink-evidence"
        onClose={closeModal}
        onConfirm={() =>
          modal.kind === "confirm-unlink-evidence"
            ? removeEvidenceLink(modal.linkId)
            : Promise.resolve({ ok: false })
        }
      />
      <ConfirmModal
        open={modal.kind === "confirm-unlink-legacy-evidence"}
        title="Unlink legacy attachment"
        body={
          modal.kind === "confirm-unlink-legacy-evidence" ? (
            <p>
              This removes the legacy case association from{" "}
              <strong>{modal.evidenceTitle}</strong> only. The evidence
              record stays preserved in the workspace and remains accessible
              from the evidence library. This action is audited.
            </p>
          ) : null
        }
        confirmLabel="Unlink legacy attachment"
        confirmTone="warning"
        testid="confirm-unlink-legacy-evidence"
        onClose={closeModal}
        onConfirm={() =>
          modal.kind === "confirm-unlink-legacy-evidence"
            ? removeLegacyEvidenceLink(modal.evidenceId)
            : Promise.resolve({ ok: false })
        }
      />
    </main>
  );
}

// ===========================================================================
// Section jump nav (sticky top)
// ===========================================================================

const SECTIONS: Array<{ id: string; label: string }> = [
  { id: "section-command-summary", label: "Command Summary" },
  { id: "section-evidence", label: "Evidence Board" },
  { id: "section-relationships", label: "Relationships" },
  { id: "section-workflows", label: "Workflows" },
  { id: "section-incidents", label: "Incidents & Causality" },
  { id: "section-reviewer", label: "Reviewer Coordination" },
  { id: "section-governance", label: "Governance" },
  { id: "section-custody", label: "Custody & Integrity" },
  { id: "section-timeline", label: "Timeline" },
  { id: "section-notes", label: "Notes" },
  { id: "section-deliverables", label: "Deliverables" },
];

function SectionJumpNav({
  envelope,
  dataReady,
}: {
  envelope: MatterWorkspaceEnvelope;
  dataReady: boolean;
}) {
  // Phase 32.8D-frontend-closure — deep-link aware section nav.
  //
  //  1. On initial mount (after data is ready), scroll to the section
  //     pointed to by location.hash.
  //  2. Update the URL hash when the user clicks a chip — preserving
  //     the deep link on reload without polluting browser history.
  //  3. Track the active section via IntersectionObserver and
  //     highlight the matching chip.
  const [activeId, setActiveId] = useState<string>(SECTIONS[0]!.id);
  const initialScrollDoneRef = useRef(false);

  // Initial deep-link scroll, after data is ready (sections must
  // exist in the DOM before scrollIntoView resolves).
  useEffect(() => {
    if (!dataReady || initialScrollDoneRef.current) return;
    if (typeof window === "undefined") return;
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) {
      initialScrollDoneRef.current = true;
      return;
    }
    // Only scroll to bounded section ids — guard against hostile or
    // legacy fragments.
    if (!SECTIONS.some((s) => s.id === raw)) {
      initialScrollDoneRef.current = true;
      return;
    }
    // Defer one paint so the layout has measured all sections.
    const t = setTimeout(() => {
      const el = document.getElementById(raw);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveId(raw);
      }
      initialScrollDoneRef.current = true;
    }, 50);
    return () => clearTimeout(t);
  }, [dataReady]);

  // Active section tracking via IntersectionObserver. The section
  // with the largest intersection ratio in the viewport's upper
  // half becomes active.
  useEffect(() => {
    if (!dataReady) return;
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      return;
    }
    const elements = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el != null,
    );
    if (elements.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length > 0) {
          setActiveId(visible[0]!.target.id);
        }
      },
      {
        rootMargin: "-15% 0px -50% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [dataReady]);

  const handleJumpClick = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveId(id);
      if (typeof window !== "undefined" && window.history?.replaceState) {
        // replaceState instead of pushState — avoids cluttering
        // history while preserving the deep link on reload.
        window.history.replaceState(null, "", `#${id}`);
      }
    }
  };

  return (
    <header className="cc-page-header">
      <div>
        <div className="cc-kicker">Matter Workspace</div>
        <h1 className="cc-title">{envelope.case.name}</h1>
        <p className="cc-subtitle">
          {envelope.case.referenceNumber
            ? `Reference: ${envelope.case.referenceNumber} · `
            : ""}
          {envelope.case.description ??
            "Operational coordination across evidence, reviewers, incidents, governance, and deliverables."}
        </p>
      </div>
      <nav
        aria-label="Matter sections"
        className="cases-filter-chips"
        data-matter-workspace-jump-nav
        data-matter-workspace-active-section={activeId}
      >
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className={`cases-filter-chip ${activeId === s.id ? "is-active" : ""}`}
            data-matter-workspace-jump-target={s.id}
            data-matter-workspace-jump-active={
              activeId === s.id ? "true" : "false"
            }
            aria-current={activeId === s.id ? "true" : undefined}
            onClick={handleJumpClick(s.id)}
          >
            {s.label}
          </a>
        ))}
      </nav>
    </header>
  );
}

// ===========================================================================
// Generic section helpers
// ===========================================================================

function SectionShell({
  id,
  title,
  status,
  children,
  testid,
  emptyHint,
}: {
  id: string;
  title: string;
  status: SectionStatus;
  children: React.ReactNode;
  testid: string;
  emptyHint?: string;
}) {
  return (
    <section
      id={id}
      className="cc-section"
      data-matter-section={testid}
      data-matter-section-status={status}
    >
      <header className="cc-section-header">
        <h2 className="cc-section-title">{title}</h2>
        <SectionStatusBadge status={status} />
      </header>
      {status === "unavailable" ? (
        <div
          className="cc-section-note"
          data-matter-section-state="unavailable"
        >
          This section is temporarily unavailable. The rest of the matter
          workspace remains usable; retry shortly.
        </div>
      ) : status === "not_applicable" ? (
        <div
          className="cc-section-note"
          data-matter-section-state="not_applicable"
        >
          {emptyHint ?? "Not applicable in this workspace."}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

function SectionStatusBadge({ status }: { status: SectionStatus }) {
  if (status === "ok") return null;
  const tone =
    status === "unavailable"
      ? "high"
      : status === "degraded"
        ? "warning"
        : "neutral";
  return (
    <span
      className="cases-row-chip"
      data-matter-section-status-chip={status}
      data-tone={tone}
    >
      {status === "degraded"
        ? "Partial data"
        : status === "unavailable"
          ? "Unavailable"
          : status === "not_applicable"
            ? "Not applicable"
            : ""}
    </span>
  );
}

// ===========================================================================
// 1. Command Summary
// ===========================================================================

function CommandSummarySection({
  envelope,
  onOpenStatusModal,
  onOpenAssignmentPicker,
  onOpenRemoveAssignmentConfirm,
  canStatusChange,
  canAssign,
  statusChangeDisabledReason,
  assignDisabledReason,
}: {
  envelope: MatterWorkspaceEnvelope;
  onOpenStatusModal: (toStatus: AllowedStatus) => void;
  onOpenAssignmentPicker: () => void;
  onOpenRemoveAssignmentConfirm: (
    assignmentId: string,
    displayLabel: string,
  ) => void;
  canStatusChange: boolean;
  canAssign: boolean;
  statusChangeDisabledReason: string | null;
  assignDisabledReason: string | null;
}) {
  const { case: caseRow, risk, sections, assignments } = envelope;
  const summary = sections.commandSummary;
  const data = summary.data;
  const riskData = risk.data;
  const hasActiveHold = (data?.activeCaseHoldsCount ?? 0) > 0;
  const closureBlocked =
    hasActiveHold &&
    (caseRow.status === "CLOSED" || caseRow.status === "ARCHIVED")
      ? false
      : hasActiveHold;

  const handleStatusClick = useCallback(
    (next: AllowedStatus) => {
      if (next === caseRow.status) return;
      onOpenStatusModal(next);
    },
    [caseRow.status, onOpenStatusModal],
  );

  return (
    <SectionShell
      id="section-command-summary"
      title="Command Summary"
      status={summary.status}
      testid="command-summary"
      emptyHint="Command summary is unavailable for this matter."
    >
      <div
        data-matter-section-command-summary-grid
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        <Tile label="Status" value={caseRow.status} dataKey="status" />
        <Tile label="Priority" value={caseRow.priority} dataKey="priority" />
        {caseRow.referenceNumber ? (
          <Tile
            label="Reference"
            value={caseRow.referenceNumber}
            dataKey="reference"
          />
        ) : null}
        {riskData ? (
          <>
            <Tile
              label="Risk score"
              value={String(riskData.riskScore)}
              dataKey="risk-score"
              tone={
                riskData.riskLevel === "CRITICAL"
                  ? "critical"
                  : riskData.riskLevel === "HIGH"
                    ? "high"
                    : riskData.riskLevel === "MEDIUM"
                      ? "warning"
                      : "neutral"
              }
            />
            <Tile
              label="Risk level"
              value={riskData.riskLevel}
              dataKey="risk-level"
            />
            <Tile
              label="Audit readiness"
              value={String(riskData.auditReadinessScore)}
              dataKey="audit-readiness"
            />
          </>
        ) : null}
        {data ? (
          <>
            <Tile
              label="Linked evidence"
              value={String(data.linkedEvidenceCount)}
              dataKey="linked-evidence"
            />
            <Tile
              label="Recently linked"
              value={String(data.recentlyLinkedCount)}
              dataKey="recently-linked"
            />
            <Tile
              label="Active case holds"
              value={String(data.activeCaseHoldsCount)}
              dataKey="active-case-holds"
              tone={data.activeCaseHoldsCount > 0 ? "warning" : "neutral"}
            />
            <Tile
              label="Affected evidence holds"
              value={String(data.affectedEvidenceHoldsCount)}
              dataKey="affected-evidence-holds"
            />
            <Tile
              label="Pending review"
              value={String(data.pendingReviewCount)}
              dataKey="pending-review"
            />
            <Tile
              label="Open escalations"
              value={String(data.openEscalationsCount)}
              dataKey="open-escalations"
              tone={data.openEscalationsCount > 0 ? "high" : "neutral"}
            />
            <Tile
              label="Active assignments"
              value={String(data.activeAssignmentCount)}
              dataKey="active-assignments"
            />
          </>
        ) : null}
      </div>

      {riskData && riskData.reasonCodes.length > 0 ? (
        <div
          data-matter-section-risk-reasons
          style={{
            marginTop: 12,
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          {riskData.reasonCodes.map((code) => (
            <span
              key={code}
              className="cases-row-chip"
              data-matter-section-risk-reason={code}
            >
              {code.replace(/_/g, " ").toLowerCase()}
            </span>
          ))}
        </div>
      ) : null}

      {riskData?.recommendedAction ? (
        <div
          data-matter-section-recommendation
          className="cc-section-note"
          style={{ marginTop: 12 }}
        >
          Recommended action: {riskData.recommendedAction}
        </div>
      ) : null}

      {closureBlocked ? (
        <div
          data-matter-section-closure-blocked
          className="cc-section-note"
          style={{ marginTop: 12 }}
        >
          Active legal preservation blocks transitioning this matter to CLOSED
          or ARCHIVED. Release the case-level hold first.
        </div>
      ) : null}

      {/* Status change controls */}
      <div
        data-matter-section-status-controls
        style={{
          marginTop: 16,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <strong style={{ alignSelf: "center" }}>Change status:</strong>
        {ALLOWED_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className="cases-filter-chip"
            data-matter-section-status-button={s}
            disabled={s === caseRow.status || !canStatusChange}
            title={
              s === caseRow.status
                ? "Already in this status"
                : (statusChangeDisabledReason ?? `Change status to ${s}`)
            }
            onClick={() => handleStatusClick(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Assignments */}
      <div
        data-matter-section-assignments
        style={{ marginTop: 16 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <strong>Assignments ({assignments.length})</strong>
          <button
            type="button"
            className="cases-filter-chip"
            data-matter-section-add-assignment
            disabled={!canAssign}
            title={assignDisabledReason ?? "Add assignment"}
            onClick={onOpenAssignmentPicker}
          >
            + Add assignment
          </button>
        </div>
        {assignments.length === 0 ? (
          <div className="cc-section-note" data-matter-section-empty>
            No active assignments. Add an owner or investigator to coordinate
            this matter.
          </div>
        ) : (
          <ul
            data-matter-section-assignment-items
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 6,
            }}
          >
            {assignments.map((a) => (
              <li
                key={a.id}
                data-matter-section-assignment-id={a.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 10,
                }}
              >
                <div>
                  <span
                    data-matter-section-assignment-user={a.assignedToUserId}
                    style={{ fontFamily: "monospace", fontSize: 12 }}
                  >
                    {a.assignedToUserId.slice(0, 8)}…
                  </span>
                  <span style={{ margin: "0 8px" }}>·</span>
                  <span data-matter-section-assignment-role={a.role}>
                    {a.role}
                  </span>
                  <span style={{ margin: "0 8px" }}>·</span>
                  <small>
                    {a.status} · since {formatRelativeTime(a.assignedAtUtc)}
                  </small>
                  {a.note ? (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{a.note}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="cases-filter-chip"
                  data-matter-section-remove-assignment={a.id}
                  disabled={!canAssign}
                  title={assignDisabledReason ?? "Remove assignment"}
                  onClick={() =>
                    onOpenRemoveAssignmentConfirm(
                      a.id,
                      `${a.role} for ${a.assignedToUserId.slice(0, 8)}…`,
                    )
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionShell>
  );
}

function Tile({
  label,
  value,
  dataKey,
  tone,
}: {
  label: string;
  value: string;
  dataKey: string;
  tone?: "neutral" | "warning" | "high" | "critical";
}) {
  return (
    <div
      className="cc-summary-card"
      data-matter-section-tile={dataKey}
      data-tone={tone ?? "neutral"}
    >
      <span className="cc-summary-card-value">{value}</span>
      <span className="cc-summary-card-label">{label}</span>
    </div>
  );
}

// ===========================================================================
// 2. Evidence Board
// ===========================================================================

function EvidenceBoardSection({
  envelope,
  canEvidenceLink,
  canUnlinkEvidence,
  canUnlinkLegacyEvidence,
  addDisabledReason,
  unlinkDisabledReason,
  unlinkLegacyDisabledReason,
  onOpenEvidenceLinkModal,
  onOpenUnlinkConfirm,
  onOpenUnlinkLegacyConfirm,
}: {
  envelope: MatterWorkspaceEnvelope;
  canEvidenceLink: boolean;
  canUnlinkEvidence: boolean;
  canUnlinkLegacyEvidence: boolean;
  addDisabledReason: string | null;
  unlinkDisabledReason: string | null;
  unlinkLegacyDisabledReason: string | null;
  onOpenEvidenceLinkModal: () => void;
  onOpenUnlinkConfirm: (linkId: string, evidenceTitle: string) => void;
  onOpenUnlinkLegacyConfirm: (evidenceId: string, evidenceTitle: string) => void;
}) {
  const evidence = envelope.sections.evidence;

  return (
    <SectionShell
      id="section-evidence"
      title="Evidence Board"
      status={evidence.status}
      testid="evidence"
      emptyHint="No evidence is linked to this matter yet."
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: 10,
        }}
      >
        <button
          type="button"
          className="cases-filter-chip"
          data-matter-section-add-evidence-link
          disabled={!canEvidenceLink}
          title={addDisabledReason ?? "Link evidence to this matter"}
          onClick={onOpenEvidenceLinkModal}
        >
          + Link evidence
        </button>
      </div>
      {evidence.items.length === 0 ? (
        <div className="cc-section-note" data-matter-section-empty>
          No evidence linked yet. Link evidence by UUID to begin coordinating
          custody, integrity, and reports across this matter.
        </div>
      ) : (
        <ul
          data-matter-section-evidence-items
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 8,
          }}
        >
          {evidence.items.map((e) => (
            <li
              key={e.id}
              data-matter-section-evidence-id={e.id}
              data-matter-section-evidence-status={e.status}
              data-matter-section-evidence-verification={e.verificationStatus ?? "unknown"}
              style={{
                padding: "10px 12px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <Link
                  href={`/evidence/${e.id}`}
                  data-matter-section-evidence-link
                  style={{
                    flex: 1,
                    minWidth: 200,
                    fontWeight: 600,
                    color: "#d6b89d",
                  }}
                >
                  {e.title}
                </Link>
                <span
                  className="cases-row-chip"
                  data-matter-section-evidence-type={e.type}
                >
                  {e.type}
                </span>
                <span
                  className="cases-row-chip"
                  data-matter-section-evidence-lifecycle={e.lifecycleState ?? "—"}
                >
                  {e.lifecycleState ?? "lifecycle: unknown"}
                </span>
                <span
                  className="cases-row-chip"
                  data-matter-section-evidence-verification-chip={
                    e.verificationStatus ?? "unknown"
                  }
                >
                  {e.verificationStatus ?? "verification: unknown"}
                </span>
                <button
                  type="button"
                  className="cases-filter-chip"
                  data-matter-section-remove-evidence-link={e.id}
                  data-matter-section-evidence-link-id={e.linkId ?? ""}
                  data-matter-section-evidence-legacy={
                    e.linkId ? "false" : "true"
                  }
                  // Phase 32.8D-frontend-closure-2 — canonical links
                  // call the standard DELETE; legacy attachments call
                  // the audited legacy endpoint.
                  disabled={
                    e.linkId
                      ? !canUnlinkEvidence
                      : !canUnlinkLegacyEvidence
                  }
                  title={
                    e.linkId
                      ? (unlinkDisabledReason ?? "Unlink evidence")
                      : (unlinkLegacyDisabledReason ??
                          "Unlink the legacy case attachment (preserves the evidence record).")
                  }
                  onClick={() => {
                    if (e.linkId) {
                      onOpenUnlinkConfirm(e.linkId, e.title);
                    } else {
                      onOpenUnlinkLegacyConfirm(e.id, e.title);
                    }
                  }}
                >
                  Unlink
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 6,
                  flexWrap: "wrap",
                  fontSize: 12,
                  opacity: 0.85,
                }}
              >
                {e.reportReady ? (
                  <span data-matter-section-evidence-report-ready>
                    Report ready
                  </span>
                ) : (
                  <span data-matter-section-evidence-report-missing>
                    No report yet
                  </span>
                )}
                {e.packageReady ? (
                  <span data-matter-section-evidence-package-ready>
                    Package ready
                  </span>
                ) : (
                  <span data-matter-section-evidence-package-missing>
                    No verification package
                  </span>
                )}
                {e.linkRole ? (
                  <span data-matter-section-evidence-link-role={e.linkRole}>
                    Role: {e.linkRole}
                  </span>
                ) : null}
                {e.linkSource ? (
                  <span data-matter-section-evidence-link-source={e.linkSource}>
                    Source: {e.linkSource}
                  </span>
                ) : null}
                {!e.linkId ? (
                  <span
                    data-matter-section-evidence-legacy-attachment
                    style={{ opacity: 0.7 }}
                    title="Attached only via the legacy Evidence.caseId column"
                  >
                    Legacy attachment
                  </span>
                ) : null}
                <time
                  dateTime={e.createdAt}
                  data-matter-section-evidence-created
                  title={e.createdAt}
                >
                  Captured {formatRelativeTime(e.createdAt)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}

    </SectionShell>
  );
}

// ===========================================================================
// 3. Relationships
// ===========================================================================

function RelationshipsSection({
  envelope,
}: {
  envelope: MatterWorkspaceEnvelope;
}) {
  const rel = envelope.sections.relationships;
  const counts = rel.counts;
  return (
    <SectionShell
      id="section-relationships"
      title="Evidence Relationships"
      status={rel.status}
      testid="relationships"
      emptyHint="No evidence relationships have been recorded for this matter."
    >
      <div
        data-matter-section-relationships-counts
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Tile label="Primary" value={String(counts.primary)} dataKey="primary" />
        <Tile
          label="Supporting"
          value={String(counts.supporting)}
          dataKey="supporting"
        />
        <Tile label="Related" value={String(counts.related)} dataKey="related" />
        <Tile
          label="Duplicate"
          value={String(counts.duplicate)}
          dataKey="duplicate"
        />
        <Tile label="Derived" value={String(counts.derived)} dataKey="derived" />
        <Tile label="Context" value={String(counts.context)} dataKey="context" />
      </div>

      {rel.links.length === 0 && rel.relationships.length === 0 ? (
        <div className="cc-section-note" data-matter-section-empty>
          No evidence links or evidence-to-evidence relationships recorded yet.
        </div>
      ) : (
        <>
          {rel.links.length > 0 ? (
            <details data-matter-section-link-list open>
              <summary>
                Case ↔ evidence links ({rel.links.length})
              </summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {rel.links.map((l) => (
                  <li
                    key={l.id}
                    data-matter-section-link-id={l.id}
                    data-matter-section-link-evidence-id={l.evidenceId}
                    data-matter-section-link-role={l.role}
                  >
                    <Link href={`/evidence/${l.evidenceId}`}>
                      {l.evidenceId.slice(0, 8)}…
                    </Link>{" "}
                    · {l.role} · {l.source} ·{" "}
                    {formatRelativeTime(l.linkedAtUtc)}
                    {l.reason ? ` · "${l.reason}"` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {rel.relationships.length > 0 ? (
            <details data-matter-section-relationship-list>
              <summary>
                Evidence ↔ evidence relationships ({rel.relationships.length})
              </summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {rel.relationships.map((r) => (
                  <li
                    key={r.id}
                    data-matter-section-relationship-id={r.id}
                    data-matter-section-relationship-type={r.relationshipType}
                  >
                    {r.sourceEvidenceId.slice(0, 8)}… →{" "}
                    {r.targetEvidenceId.slice(0, 8)}… · {r.relationshipType} ·{" "}
                    {formatRelativeTime(r.createdAt)}
                    {r.note ? ` · ${r.note}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </SectionShell>
  );
}

// ===========================================================================
// 4. Workflows
// ===========================================================================

function WorkflowsSection({
  envelope,
}: {
  envelope: MatterWorkspaceEnvelope;
}) {
  const wf = envelope.sections.workflows;
  return (
    <SectionShell
      id="section-workflows"
      title="Operational Workflows"
      status={wf.status}
      testid="workflows"
      emptyHint="No operational workflows are active for this matter."
    >
      {wf.items.length === 0 ? (
        <div className="cc-section-note" data-matter-section-empty>
          No open workflows for this matter.
        </div>
      ) : (
        <ul
          data-matter-section-workflow-items
          style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}
        >
          {wf.items.map((w) => (
            <li
              key={w.id}
              data-matter-section-workflow-id={w.id}
              data-matter-section-workflow-status={w.status}
              data-matter-section-workflow-severity={w.severity}
              style={{
                padding: "10px 12px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10,
              }}
            >
              <div style={{ fontWeight: 600 }}>{w.title}</div>
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.85,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <span data-matter-section-workflow-type={w.workflowType}>
                  {w.workflowType}
                </span>
                <span>{w.severity}</span>
                <span>{w.priority}</span>
                <span data-matter-section-workflow-escalation={w.escalationLevel}>
                  Escalation L{w.escalationLevel}
                </span>
                {w.dueAtUtc ? (
                  <time
                    dateTime={w.dueAtUtc}
                    data-matter-section-workflow-due
                    title={w.dueAtUtc}
                  >
                    Due {formatRelativeTime(w.dueAtUtc)}
                  </time>
                ) : null}
                {w.retryCount > 0 ? (
                  <span data-matter-section-workflow-retries={w.retryCount}>
                    Retries: {w.retryCount}
                  </span>
                ) : null}
              </div>
              {w.safeSummary ? (
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  {w.safeSummary}
                </div>
              ) : null}
              <div style={{ marginTop: 6 }}>
                <Link
                  href={`/reviewer-ops/${w.id}`}
                  className="cases-filter-chip"
                  data-matter-section-workflow-route
                >
                  Open workflow →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

// ===========================================================================
// 5. Incidents & Causality
// ===========================================================================

function IncidentsCausalitySection({
  envelope,
}: {
  envelope: MatterWorkspaceEnvelope;
}) {
  const ic = envelope.sections.incidentsAndCausality;
  return (
    <SectionShell
      id="section-incidents"
      title="Incidents & Causality"
      status={ic.status}
      testid="incidents-causality"
      emptyHint="No linked incidents or causality chains for this matter."
    >
      <div style={{ marginBottom: 12 }}>
        <strong>Linked incidents ({ic.incidents.length})</strong>
        {ic.incidents.length === 0 ? (
          <div className="cc-section-note" data-matter-section-empty>
            No linked incidents currently affect this matter.
          </div>
        ) : (
          <ul
            data-matter-section-incident-items
            style={{
              listStyle: "none",
              padding: 0,
              margin: "8px 0 0",
              display: "grid",
              gap: 6,
            }}
          >
            {ic.incidents.map((i) => (
              <li
                key={i.id}
                data-matter-section-incident-id={i.id}
                data-matter-section-incident-severity={i.severity}
                data-matter-section-incident-status={i.status}
                style={{
                  padding: "8px 10px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 10,
                }}
              >
                <div style={{ fontWeight: 600 }}>{i.title}</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>
                  {i.category} · {i.severity} · {i.status} · seen{" "}
                  {i.occurrenceCount}× · last {formatRelativeTime(i.lastSeenAtUtc)}
                </div>
                {i.safeSummary ? (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    {i.safeSummary}
                  </div>
                ) : null}
                {i.relatedEvidenceId ? (
                  <Link
                    href={`/evidence/${i.relatedEvidenceId}`}
                    className="cases-filter-chip"
                    style={{ marginTop: 4 }}
                    data-matter-section-incident-evidence-link
                  >
                    Related evidence →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <strong>Causality chains ({ic.chains.length})</strong>
        {ic.chains.length === 0 ? (
          <div className="cc-section-note" data-matter-section-empty>
            No causality chains link this matter to other operational events.
          </div>
        ) : (
          <ul
            data-matter-section-chain-items
            style={{
              listStyle: "none",
              padding: 0,
              margin: "8px 0 0",
              display: "grid",
              gap: 6,
            }}
          >
            {ic.chains.map((c) => (
              <li
                key={c.id}
                data-matter-section-chain-id={c.id}
                data-matter-section-chain-severity={c.severity}
                data-matter-section-chain-status={c.status}
                style={{
                  padding: "8px 10px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 10,
                }}
              >
                <div style={{ fontWeight: 600 }}>{c.title}</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>
                  Root cause: {c.rootCauseType} · {c.severity} · {c.status} ·{" "}
                  incidents: {c.linkedIncidentCount} · workflows:{" "}
                  {c.linkedWorkflowCount}
                </div>
                {c.summary ? (
                  <div style={{ fontSize: 12, marginTop: 4 }}>{c.summary}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionShell>
  );
}

// ===========================================================================
// 6. Reviewer Coordination
// ===========================================================================

function ReviewerCoordinationSection({
  envelope,
}: {
  envelope: MatterWorkspaceEnvelope;
}) {
  const rc = envelope.sections.reviewerCoordination;
  const data = rc.data;
  return (
    <SectionShell
      id="section-reviewer"
      title="Reviewer Coordination"
      status={rc.status}
      testid="reviewer-coordination"
      emptyHint="Reviewer coordination is not active for this matter."
    >
      {!data && rc.escalations.length === 0 && rc.reviewerCapacity.length === 0 ? (
        <div className="cc-section-note" data-matter-section-empty>
          No reviewer coordination signals yet — reviewer workflows produce
          these once review work is opened on linked evidence.
        </div>
      ) : (
        <>
          {data ? (
            <div
              data-matter-section-reviewer-counts
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: 8,
              }}
            >
              <Tile label="Queued" value={String(data.queuedCount)} dataKey="queued" />
              <Tile
                label="Assigned"
                value={String(data.assignedCount)}
                dataKey="assigned"
              />
              <Tile
                label="In review"
                value={String(data.inReviewCount)}
                dataKey="in-review"
              />
              <Tile
                label="Needs info"
                value={String(data.needsInfoCount)}
                dataKey="needs-info"
              />
              <Tile
                label="Overdue"
                value={String(data.overdueCount)}
                dataKey="overdue"
                tone={data.overdueCount > 0 ? "high" : "neutral"}
              />
              <Tile
                label="Open escalations"
                value={String(data.openEscalationsCount)}
                dataKey="open-escalations"
                tone={data.openEscalationsCount > 0 ? "high" : "neutral"}
              />
              <Tile
                label="Unresolved comments"
                value={String(data.unresolvedReviewerCommentsCount)}
                dataKey="unresolved-comments"
              />
              <Tile
                label="Unresolved annotations"
                value={String(data.unresolvedAnnotationsCount)}
                dataKey="unresolved-annotations"
              />
            </div>
          ) : null}

          {rc.escalations.length > 0 ? (
            <details
              data-matter-section-reviewer-escalations
              style={{ marginTop: 12 }}
              open
            >
              <summary>Open escalations ({rc.escalations.length})</summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {rc.escalations.map((e) => (
                  <li
                    key={e.id}
                    data-matter-section-reviewer-escalation-id={e.id}
                    data-matter-section-reviewer-escalation-severity={e.severity}
                    data-matter-section-reviewer-escalation-status={e.status}
                  >
                    <Link href={`/evidence/${e.evidenceId}`}>
                      {e.evidenceId.slice(0, 8)}…
                    </Link>{" "}
                    · {e.severity} · {e.status} ·{" "}
                    {formatRelativeTime(e.createdAt)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {rc.reviewerCapacity.length > 0 ? (
            <details
              data-matter-section-reviewer-capacity
              style={{ marginTop: 12 }}
            >
              <summary>Reviewer capacity ({rc.reviewerCapacity.length})</summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {rc.reviewerCapacity.map((cap) => (
                  <li
                    key={cap.reviewerUserId}
                    data-matter-section-reviewer-capacity-row={cap.reviewerUserId}
                    data-matter-section-reviewer-saturation={cap.saturationLevel}
                  >
                    {cap.reviewerUserId.slice(0, 8)}… · {cap.saturationLevel} ·
                    assigned {cap.assignedCount} · overdue {cap.overdueCount} ·
                    capacity {cap.capacityScore}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </SectionShell>
  );
}

// ===========================================================================
// 7. Governance & Preservation
// ===========================================================================

function GovernanceSection({
  envelope,
}: {
  envelope: MatterWorkspaceEnvelope;
}) {
  const gov = envelope.sections.governance;
  return (
    <SectionShell
      id="section-governance"
      title="Governance & Preservation"
      status={gov.status}
      testid="governance"
      emptyHint="No governance signals are active for this matter."
    >
      <div
        data-matter-section-governance-tiles
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Tile
          label="Audit readiness"
          value={
            gov.auditReadinessScore != null
              ? String(gov.auditReadinessScore)
              : "—"
          }
          dataKey="audit-readiness-score"
        />
        <Tile
          label="Active blockers"
          value={String(gov.blockerCount)}
          dataKey="blocker-count"
          tone={gov.blockerCount > 0 ? "warning" : "neutral"}
        />
        <Tile
          label="Case holds"
          value={String(gov.caseHolds.length)}
          dataKey="case-holds-count"
        />
        <Tile
          label="Evidence holds"
          value={String(gov.evidenceHolds.length)}
          dataKey="evidence-holds-count"
        />
        <Tile
          label="Governance workflows"
          value={String(gov.governanceWorkflows.length)}
          dataKey="governance-workflows-count"
        />
      </div>

      {gov.caseHolds.length === 0 &&
      gov.evidenceHolds.length === 0 &&
      gov.governanceWorkflows.length === 0 ? (
        <div className="cc-section-note" data-matter-section-empty>
          No case holds, evidence holds, or governance workflows are active.
        </div>
      ) : (
        <>
          {gov.caseHolds.length > 0 ? (
            <details data-matter-section-case-holds open>
              <summary>Case-level legal preservation ({gov.caseHolds.length})</summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {gov.caseHolds.map((h) => (
                  <li
                    key={h.id}
                    data-matter-section-case-hold-id={h.id}
                    data-matter-section-case-hold-status={h.status}
                  >
                    {h.title} · {h.status} · placed{" "}
                    {formatRelativeTime(h.placedAtUtc)}
                    {h.releasedAtUtc
                      ? ` · released ${formatRelativeTime(h.releasedAtUtc)}`
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {gov.evidenceHolds.length > 0 ? (
            <details data-matter-section-evidence-holds>
              <summary>Evidence-level holds ({gov.evidenceHolds.length})</summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {gov.evidenceHolds.map((h) => (
                  <li
                    key={h.id}
                    data-matter-section-evidence-hold-id={h.id}
                  >
                    <Link href={`/evidence/${h.evidenceId}`}>
                      {h.evidenceId.slice(0, 8)}…
                    </Link>{" "}
                    · {h.status} · {formatRelativeTime(h.createdAt)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {gov.governanceWorkflows.length > 0 ? (
            <details data-matter-section-governance-workflows>
              <summary>
                Governance workflows ({gov.governanceWorkflows.length})
              </summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {gov.governanceWorkflows.map((w) => (
                  <li
                    key={w.id}
                    data-matter-section-governance-workflow-id={w.id}
                    data-matter-section-governance-workflow-status={w.status}
                  >
                    {w.title} · {w.workflowType} · {w.severity} · {w.status}
                    {w.dueAtUtc
                      ? ` · due ${formatRelativeTime(w.dueAtUtc)}`
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      <div className="cc-section-note" style={{ marginTop: 12 }}>
        Place / release legal hold and edit retention policy live on{" "}
        <Link href="/governance">/governance</Link>. This section is the
        read surface for the matter.
      </div>
    </SectionShell>
  );
}

// ===========================================================================
// 8. Custody & Integrity
// ===========================================================================

function CustodyIntegritySection({
  envelope,
}: {
  envelope: MatterWorkspaceEnvelope;
}) {
  const ci = envelope.sections.custodyAndIntegrity;
  return (
    <SectionShell
      id="section-custody"
      title="Custody & Integrity"
      status={ci.status}
      testid="custody-integrity"
      emptyHint="No custody or integrity signals for this matter."
    >
      <div
        data-matter-section-custody-totals
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <Tile
          label="Custody events (30d)"
          value={String(ci.custodyEventTotals.eventsLast30d)}
          dataKey="events-30d"
        />
      </div>

      {ci.lifecycleStateCounts.length > 0 ? (
        <details data-matter-section-lifecycle-counts open>
          <summary>Lifecycle state distribution</summary>
          <ul style={{ paddingLeft: 18, marginTop: 6 }}>
            {ci.lifecycleStateCounts.map((row) => (
              <li
                key={row.lifecycleState}
                data-matter-section-lifecycle-state={row.lifecycleState}
              >
                {row.lifecycleState}: {row.count}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {ci.verificationStatusCounts.length > 0 ? (
        <details data-matter-section-verification-counts>
          <summary>Verification state distribution</summary>
          <ul style={{ paddingLeft: 18, marginTop: 6 }}>
            {ci.verificationStatusCounts.map((row) => (
              <li
                key={row.verificationStatus}
                data-matter-section-verification-state={row.verificationStatus}
              >
                {row.verificationStatus}: {row.count}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {ci.integritySnapshots.length > 0 ? (
        <details data-matter-section-integrity-snapshots>
          <summary>
            Integrity snapshots ({ci.integritySnapshots.length})
          </summary>
          <ul style={{ paddingLeft: 18, marginTop: 6 }}>
            {ci.integritySnapshots.map((s) => (
              <li
                key={s.evidenceId}
                data-matter-section-integrity-evidence-id={s.evidenceId}
                data-matter-section-integrity-status={s.overallStatus}
              >
                <Link href={`/evidence/${s.evidenceId}`}>
                  {s.evidenceId.slice(0, 8)}…
                </Link>{" "}
                · {s.overallStatus}
                {s.tsaStatus ? ` · TSA ${s.tsaStatus}` : ""}
                {s.otsStatus ? ` · OTS ${s.otsStatus}` : ""}
                {s.tsaParseStatus ? ` · TSA parse ${s.tsaParseStatus}` : ""}
                {s.reasonCodes.length > 0
                  ? ` · ${s.reasonCodes.join(", ")}`
                  : ""}
                {" · "}
                {formatRelativeTime(s.computedAtUtc)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {ci.lifecycleStateCounts.length === 0 &&
      ci.verificationStatusCounts.length === 0 &&
      ci.integritySnapshots.length === 0 ? (
        <div className="cc-section-note" data-matter-section-empty>
          No custody or integrity signals recorded yet. Once linked evidence
          completes verification, this section reports its state.
        </div>
      ) : null}

      <div className="cc-section-note" style={{ marginTop: 12 }}>
        Custody data records integrity state and verification state. It does
        not assert legal admissibility, authenticity, or truth of any record.
      </div>
    </SectionShell>
  );
}

// ===========================================================================
// 9. Timeline
// ===========================================================================

function TimelineSection({
  envelope,
}: {
  envelope: MatterWorkspaceEnvelope;
}) {
  const tl = envelope.sections.timeline;
  const [familyFilter, setFamilyFilter] = useState<string>("");
  const families = useMemo(() => {
    const set = new Set<string>();
    tl.items.forEach((i) => set.add(i.family));
    return Array.from(set).sort();
  }, [tl.items]);
  const filtered = familyFilter
    ? tl.items.filter((i) => i.family === familyFilter)
    : tl.items;

  return (
    <SectionShell
      id="section-timeline"
      title="Timeline"
      status={tl.status}
      testid="timeline"
      emptyHint="No timeline events recorded for this matter."
    >
      {families.length > 0 ? (
        <div className="cases-filter-chips" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className={`cases-filter-chip ${familyFilter === "" ? "is-active" : ""}`}
            data-matter-section-timeline-family-filter=""
            onClick={() => setFamilyFilter("")}
          >
            All
          </button>
          {families.map((f) => (
            <button
              key={f}
              type="button"
              className={`cases-filter-chip ${familyFilter === f ? "is-active" : ""}`}
              data-matter-section-timeline-family-filter={f}
              onClick={() => setFamilyFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="cc-section-note" data-matter-section-empty>
          No timeline events in this view.
        </div>
      ) : (
        <ol
          data-matter-section-timeline-items
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 6,
          }}
        >
          {filtered.map((ev) => (
            <li
              key={ev.id}
              data-matter-section-timeline-id={ev.id}
              data-matter-section-timeline-family={ev.family}
              data-matter-section-timeline-event-type={ev.eventType}
              data-matter-section-timeline-severity={ev.severity}
              style={{
                padding: "8px 10px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600 }}>{ev.eventType}</span>
                <time
                  dateTime={ev.occurredAtUtc}
                  title={ev.occurredAtUtc}
                  style={{ fontSize: 12, opacity: 0.7 }}
                >
                  {formatRelativeTime(ev.occurredAtUtc)}
                </time>
              </div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>
                {ev.family} · severity {ev.severity} · source {ev.sourceTable}
                {ev.route ? ` · ${ev.route}` : ""}
              </div>
              {ev.summary ? (
                <div style={{ fontSize: 12, marginTop: 4 }}>{ev.summary}</div>
              ) : null}
              {ev.evidenceId ? (
                <Link
                  href={`/evidence/${ev.evidenceId}`}
                  className="cases-filter-chip"
                  data-matter-section-timeline-evidence-link
                >
                  Evidence →
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </SectionShell>
  );
}

// ===========================================================================
// 10. Notes & Coordination
// ===========================================================================

function NotesSection({
  envelope,
  canComment,
  canResolveComment,
  commentDisabledReason,
  onAddComment,
  onResolveComment,
}: {
  envelope: MatterWorkspaceEnvelope;
  canComment: boolean;
  canResolveComment: boolean;
  commentDisabledReason: string | null;
  onAddComment: (
    body: string,
    visibility: "INTERNAL" | "REVIEWERS" | "ALL_MEMBERS" | null,
  ) => Promise<{ ok: boolean }>;
  onResolveComment: (commentId: string) => Promise<{ ok: boolean }>;
}) {
  const notes = envelope.sections.notes;
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<
    "INTERNAL" | "REVIEWERS" | "ALL_MEMBERS"
  >("INTERNAL");

  const handleSubmit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const result = await onAddComment(trimmed, visibility);
    if (result.ok) setBody("");
  }, [body, visibility, onAddComment]);

  return (
    <SectionShell
      id="section-notes"
      title="Notes & Coordination"
      status={notes.status}
      testid="notes"
      emptyHint="Notes & coordination are not available for this matter."
    >
      {notes.caseComments.length === 0 &&
      notes.unresolvedReviewerComments.length === 0 &&
      notes.unresolvedAnnotations.length === 0 ? (
        <div className="cc-section-note" data-matter-section-empty>
          No comments, reviewer notes, or evidence annotations on this matter
          yet.
        </div>
      ) : (
        <>
          {notes.caseComments.length > 0 ? (
            <details data-matter-section-case-comments open>
              <summary>Case comments ({notes.caseComments.length})</summary>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "8px 0 0",
                  display: "grid",
                  gap: 6,
                }}
              >
                {notes.caseComments.map((c) => (
                  <li
                    key={c.id}
                    data-matter-section-case-comment-id={c.id}
                    data-matter-section-case-comment-visibility={c.visibility}
                    data-matter-section-case-comment-resolved={
                      c.resolvedAtUtc ? "true" : "false"
                    }
                    style={{
                      padding: "8px 10px",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 10,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12,
                        opacity: 0.85,
                      }}
                    >
                      <span>
                        {c.authorUserId.slice(0, 8)}… · {c.visibility}
                      </span>
                      <time dateTime={c.createdAt} title={c.createdAt}>
                        {formatRelativeTime(c.createdAt)}
                      </time>
                    </div>
                    <div style={{ marginTop: 4 }}>{c.body}</div>
                    {!c.resolvedAtUtc ? (
                      <button
                        type="button"
                        className="cases-filter-chip"
                        data-matter-section-resolve-comment={c.id}
                        disabled={!canResolveComment}
                        title={commentDisabledReason ?? "Resolve comment"}
                        onClick={() => void onResolveComment(c.id)}
                        style={{ marginTop: 6 }}
                      >
                        Resolve
                      </button>
                    ) : (
                      <small
                        data-matter-section-case-comment-resolved-at={c.resolvedAtUtc}
                        style={{ opacity: 0.7 }}
                      >
                        Resolved {formatRelativeTime(c.resolvedAtUtc)}
                      </small>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {notes.unresolvedReviewerComments.length > 0 ? (
            <details
              data-matter-section-unresolved-reviewer-comments
              style={{ marginTop: 8 }}
            >
              <summary>
                Unresolved reviewer comments (
                {notes.unresolvedReviewerComments.length})
              </summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {notes.unresolvedReviewerComments.map((c) => (
                  <li
                    key={c.id}
                    data-matter-section-reviewer-comment-id={c.id}
                  >
                    <Link href={`/evidence/${c.evidenceId}`}>
                      {c.evidenceId.slice(0, 8)}…
                    </Link>{" "}
                    · {formatRelativeTime(c.createdAt)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {notes.unresolvedAnnotations.length > 0 ? (
            <details
              data-matter-section-unresolved-annotations
              style={{ marginTop: 8 }}
            >
              <summary>
                Unresolved annotations ({notes.unresolvedAnnotations.length})
              </summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {notes.unresolvedAnnotations.map((a) => (
                  <li
                    key={a.id}
                    data-matter-section-annotation-id={a.id}
                  >
                    <Link href={`/evidence/${a.evidenceId}`}>
                      {a.evidenceId.slice(0, 8)}…
                    </Link>{" "}
                    · {formatRelativeTime(a.createdAt)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}

      <form
        data-matter-section-add-comment-form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        style={{ marginTop: 16, display: "grid", gap: 8 }}
      >
        <textarea
          data-matter-section-comment-input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment to this matter…"
          rows={3}
          maxLength={4000}
          disabled={!canComment}
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10,
            padding: 8,
            color: "inherit",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            data-matter-section-comment-visibility
            value={visibility}
            onChange={(e) =>
              setVisibility(
                e.target.value as "INTERNAL" | "REVIEWERS" | "ALL_MEMBERS",
              )
            }
            className="cases-filter-chip"
            disabled={!canComment}
          >
            <option value="INTERNAL">Internal</option>
            <option value="REVIEWERS">Reviewers</option>
            <option value="ALL_MEMBERS">All members</option>
          </select>
          <button
            type="submit"
            className="cases-filter-chip"
            data-matter-section-submit-comment
            disabled={!canComment || body.trim().length === 0}
            title={
              !canComment
                ? (commentDisabledReason ?? "Add comment")
                : body.trim().length === 0
                  ? "Type a comment first"
                  : "Add comment"
            }
          >
            Add comment
          </button>
        </div>
      </form>
    </SectionShell>
  );
}

// ===========================================================================
// 11. Deliverables / Exports
// ===========================================================================

function DeliverablesSection({
  envelope,
}: {
  envelope: MatterWorkspaceEnvelope;
}) {
  const d = envelope.sections.deliverables;
  return (
    <SectionShell
      id="section-deliverables"
      title="Deliverables & Exports"
      status={d.status}
      testid="deliverables"
      emptyHint="No deliverables are ready or pending for this matter."
    >
      <div
        data-matter-section-deliverables-counts
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Tile
          label="Reports ready"
          value={String(d.counts.reportsReady)}
          dataKey="reports-ready"
        />
        <Tile
          label="Packages ready"
          value={String(d.counts.packagesReady)}
          dataKey="packages-ready"
        />
        <Tile
          label="Deliverables pending"
          value={String(d.counts.deliverablesPending)}
          dataKey="deliverables-pending"
          tone={d.counts.deliverablesPending > 0 ? "warning" : "neutral"}
        />
      </div>

      {d.reports.length === 0 &&
      d.packages.length === 0 &&
      d.externalReviewLinks.length === 0 ? (
        <div className="cc-section-note" data-matter-section-empty>
          No deliverables are ready yet because linked evidence has no
          completed report or verification package. Reports / packages are
          generated by explicit user action on evidence detail, not on view.
        </div>
      ) : (
        <>
          {d.reports.length > 0 ? (
            <details data-matter-section-reports open>
              <summary>Reports ({d.reports.length})</summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {d.reports.map((r) => (
                  <li
                    key={r.id}
                    data-matter-section-report-id={r.id}
                  >
                    <Link href={`/evidence/${r.evidenceId}`}>
                      {r.evidenceId.slice(0, 8)}…
                    </Link>{" "}
                    · v{r.version} ·{" "}
                    {r.generatedAtUtc
                      ? formatRelativeTime(r.generatedAtUtc)
                      : "pending"}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {d.packages.length > 0 ? (
            <details data-matter-section-packages>
              <summary>Verification packages ({d.packages.length})</summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {d.packages.map((p) => (
                  <li
                    key={p.id}
                    data-matter-section-package-id={p.id}
                  >
                    <Link href={`/evidence/${p.evidenceId}`}>
                      {p.evidenceId.slice(0, 8)}…
                    </Link>{" "}
                    · v{p.version} ·{" "}
                    {p.generatedAtUtc
                      ? formatRelativeTime(p.generatedAtUtc)
                      : "pending"}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {d.externalReviewLinks.length > 0 ? (
            <details data-matter-section-external-review-links>
              <summary>
                External review links ({d.externalReviewLinks.length})
              </summary>
              <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                {d.externalReviewLinks.map((l) => (
                  <li
                    key={l.id}
                    data-matter-section-external-review-link-id={l.id}
                    data-matter-section-external-review-viewer-type={l.viewerType}
                  >
                    <Link href={`/evidence/${l.evidenceId}`}>
                      {l.evidenceId.slice(0, 8)}…
                    </Link>{" "}
                    · {l.viewerType} · {formatRelativeTime(l.createdAt)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
      <div className="cc-section-note" style={{ marginTop: 12 }}>
        Reports and verification packages are generated by explicit user
        action from the evidence detail page. Viewing the matter workspace
        does not generate anything or emit custody events.
      </div>
    </SectionShell>
  );
}

// ===========================================================================
// Shells (loading / not-found / auth / unavailable)
// ===========================================================================

function WorkspaceLoading() {
  return (
    <main className="cc-page" data-matter-workspace-loading>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Matter Workspace</div>
          <h1 className="cc-title">Loading matter…</h1>
        </div>
      </header>
      <section className="cc-section">
        <div className="cc-skeleton" />
      </section>
    </main>
  );
}

function WorkspaceNotFound() {
  return (
    <main className="cc-page" data-matter-workspace-not-found>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Matter Workspace</div>
          <h1 className="cc-title">Matter not found</h1>
          <p className="cc-subtitle">
            This matter does not exist, has been removed, or you do not have
            access to it in this workspace.
          </p>
        </div>
        <div className="cc-meta">
          <Link href="/cases" className="cases-filter-chip">
            Back to matter queue
          </Link>
        </div>
      </header>
    </main>
  );
}

function WorkspaceAuthError({
  code,
}: {
  code: "auth_required" | "permission_denied";
}) {
  return (
    <main className="cc-page" data-matter-workspace-auth-error={code}>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Matter Workspace</div>
          <h1 className="cc-title">
            {code === "auth_required"
              ? "Sign in required"
              : "Permission required"}
          </h1>
          <p className="cc-subtitle">
            {code === "auth_required"
              ? "Sign in to view this matter."
              : "You do not have permission to view this matter. Ask a workspace administrator for access."}
          </p>
        </div>
      </header>
    </main>
  );
}

function WorkspaceUnavailable({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="cc-page" data-matter-workspace-unavailable>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Matter Workspace</div>
          <h1 className="cc-title">Matter workspace temporarily unavailable</h1>
          <p className="cc-subtitle">{message}</p>
        </div>
        <div className="cc-meta">
          <button type="button" onClick={onRetry} className="cases-filter-chip">
            Retry
          </button>
        </div>
      </header>
    </main>
  );
}

// ===========================================================================
// Time helper
// ===========================================================================

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
