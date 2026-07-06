"use client";

/**
 * Phase 32.8D-frontend-closure — Assignment picker modal.
 *
 * Replaces the legacy `window.prompt("Assignee UUID:")` flow. Lists
 * eligible workspace members from
 * `GET /v1/cases/:id/assignment-candidates`, surfaces their existing
 * assignment state, and submits a single canonical
 * `POST /v1/cases/:id/assignments` request.
 *
 * Hard rules:
 *   - No raw UUID input. Members are picked from the bounded list.
 *   - Personal cases return `workspaceScope: "PERSONAL"` from the
 *     backend; the modal renders a structured reason instead of a
 *     broken fallback prompt.
 *   - Backend remains authoritative; this modal is UI only.
 */

import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { Modal } from "./Modal";

function dedupeById<T>(
  prev: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  id: (t: T) => string,
): T[] {
  const seen = new Set<string>(prev.map(id));
  const out = [...prev];
  for (const item of next) {
    const key = id(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const ASSIGNMENT_ROLES = [
  "OWNER",
  "INVESTIGATOR",
  "REVIEWER",
  "GOVERNANCE",
  "OBSERVER",
] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

type Candidate = {
  userId: string;
  displayName: string | null;
  email: string | null;
  workspaceRole: string;
  existingAssignmentRoles: string[];
};

type CandidatesEnvelope = {
  workspaceScope: "PERSONAL" | "TEAM";
  items: Candidate[];
  nextCursor: string | null;
  reason?: string;
};

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      items: Candidate[];
      nextCursor: string | null;
      workspaceScope: "PERSONAL" | "TEAM";
      reason?: string;
      loadingMore: boolean;
    }
  | { status: "error"; message: string };

export function AssignmentPickerModal({
  open,
  caseId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
  /**
   * Caller wires this to the audited mutation. Returns `{ ok }` from
   * the parent's `runMutation` so the modal can stay open on error
   * for a retry without losing user input.
   */
  onSubmit: (input: {
    userId: string;
    role: AssignmentRole;
    note: string | null;
  }) => Promise<{ ok: boolean }>;
}) {
  const [search, setSearch] = useState("");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [role, setRole] = useState<AssignmentRole>("INVESTIGATOR");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(
    async (q: string) => {
      setState({ status: "loading" });
      try {
        const qs = new URLSearchParams();
        if (q.trim()) qs.set("search", q.trim());
        qs.set("limit", "25");
        const envelope = (await apiFetch(
          `/v1/cases/${encodeURIComponent(caseId)}/assignment-candidates?${qs.toString()}`,
          { method: "GET" },
        )) as CandidatesEnvelope;
        setState({
          status: "ready",
          items: envelope.items,
          nextCursor: envelope.nextCursor ?? null,
          workspaceScope: envelope.workspaceScope,
          reason: envelope.reason,
          loadingMore: false,
        });
      } catch (err) {
        const e = err as { message?: string };
        setState({
          status: "error",
          message: toSafeUserError(e, { message: "Unable to load assignment candidates." }).message,
        });
      }
    },
    [caseId],
  );

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || !state.nextCursor || state.loadingMore)
      return;
    setState({ ...state, loadingMore: true });
    try {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set("search", search.trim());
      qs.set("limit", "25");
      qs.set("cursor", state.nextCursor);
      const envelope = (await apiFetch(
        `/v1/cases/${encodeURIComponent(caseId)}/assignment-candidates?${qs.toString()}`,
        { method: "GET" },
      )) as CandidatesEnvelope;
      setState((prev) =>
        prev.status === "ready"
          ? {
              ...prev,
              // Dedupe by userId so a redrawn row never appears twice.
              items: dedupeById(
                prev.items,
                envelope.items,
                (x) => x.userId,
              ),
              nextCursor: envelope.nextCursor ?? null,
              loadingMore: false,
            }
          : prev,
      );
    } catch (err) {
      const e = err as { message?: string };
      setState({
        status: "error",
        message: toSafeUserError(e, { message: "Unable to load more candidates." }).message,
      });
    }
  }, [state, search, caseId]);

  // Initial load + debounced search. Search resets pagination.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      void reload(search);
    }, search ? 200 : 0);
    return () => clearTimeout(t);
  }, [open, search, reload]);

  // Reset transient state whenever the modal closes/opens.
  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedUserId(null);
      setRole("INVESTIGATOR");
      setNote("");
      setSubmitting(false);
    }
  }, [open]);

  const candidates = state.status === "ready" ? state.items : [];
  const selected = useMemo(
    () => candidates.find((c) => c.userId === selectedUserId) ?? null,
    [candidates, selectedUserId],
  );
  const alreadyHasThisRole =
    selected?.existingAssignmentRoles.includes(role) ?? false;
  const isPersonalScope =
    state.status === "ready" && state.workspaceScope === "PERSONAL";

  const handleSubmit = useCallback(async () => {
    if (!selectedUserId) return;
    setSubmitting(true);
    const result = await onSubmit({
      userId: selectedUserId,
      role,
      note: note.trim() ? note.trim() : null,
    });
    setSubmitting(false);
    if (result.ok) onClose();
  }, [selectedUserId, role, note, onSubmit, onClose]);

  return (
    <Modal
      open={open}
      title="Add assignment"
      onClose={onClose}
      testid="assignment-picker"
      dismissDisabled={submitting}
      footer={
        <>
          <button
            type="button"
            className="cases-filter-chip"
            data-matter-assignment-picker-cancel
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cases-filter-chip is-active"
            data-matter-assignment-picker-submit
            onClick={() => void handleSubmit()}
            disabled={!selectedUserId || submitting || alreadyHasThisRole}
            title={
              !selectedUserId
                ? "Select a workspace member"
                : alreadyHasThisRole
                  ? "This member already holds that case role"
                  : "Add assignment"
            }
          >
            {submitting ? "Adding…" : "Add assignment"}
          </button>
        </>
      }
    >
      {isPersonalScope ? (
        <div
          className="cc-section-note"
          data-matter-assignment-picker-personal-mode
        >
          {state.status === "ready" && state.reason
            ? state.reason
            : "Personal cases do not support assignments. Switch to a team workspace."}
        </div>
      ) : (
        <>
          <input
            type="search"
            placeholder="Search by name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-matter-assignment-picker-search-input
            className="cases-filter-search"
            style={{ width: "100%", marginBottom: 10 }}
          />
          <div
            data-matter-assignment-picker-list
            style={{
              maxHeight: 280,
              overflowY: "auto",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 10,
              marginBottom: 12,
            }}
          >
            {state.status === "loading" ? (
              <div className="cc-section-note">Loading workspace members…</div>
            ) : state.status === "error" ? (
              <div
                className="cc-section-note"
                data-matter-assignment-picker-error
              >
                {state.message}
              </div>
            ) : candidates.length === 0 ? (
              <div className="cc-section-note">
                No workspace members match the search.
              </div>
            ) : (
              <ul
                role="listbox"
                aria-label="Workspace members"
                style={{ listStyle: "none", padding: 0, margin: 0 }}
              >
                {candidates.map((c) => {
                  const isSelected = c.userId === selectedUserId;
                  return (
                    <li
                      key={c.userId}
                      data-matter-assignment-picker-row={c.userId}
                      data-matter-assignment-picker-row-selected={
                        isSelected ? "true" : "false"
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedUserId(c.userId)}
                        aria-selected={isSelected}
                        role="option"
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          width: "100%",
                          padding: "10px 12px",
                          background: isSelected
                            ? "rgba(183,157,132,0.18)"
                            : "transparent",
                          border: "none",
                          color: "inherit",
                          textAlign: "left",
                          cursor: "pointer",
                          gap: 12,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            data-matter-assignment-picker-row-name
                            style={{
                              fontWeight: 600,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {c.displayName ?? "(no name on record)"}
                          </div>
                          {c.email ? (
                            <small
                              data-matter-assignment-picker-row-email
                              style={{ opacity: 0.7 }}
                            >
                              {c.email}
                            </small>
                          ) : null}
                        </div>
                        <span
                          className="cases-row-chip"
                          data-matter-assignment-picker-row-workspace-role={
                            c.workspaceRole
                          }
                        >
                          {c.workspaceRole}
                        </span>
                        {c.existingAssignmentRoles.length > 0 ? (
                          <span
                            className="cases-row-chip"
                            data-matter-assignment-picker-row-existing
                            data-existing-roles={c.existingAssignmentRoles.join(
                              ",",
                            )}
                            title={`Already assigned as ${c.existingAssignmentRoles.join(", ")}`}
                          >
                            {c.existingAssignmentRoles.join(" / ")}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {state.status === "ready" && state.nextCursor ? (
            <div
              data-matter-assignment-picker-load-more-row
              style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}
            >
              <button
                type="button"
                className="cases-filter-chip"
                data-matter-assignment-picker-load-more
                disabled={state.loadingMore}
                onClick={() => void loadMore()}
              >
                {state.loadingMore ? "Loading…" : "Load more candidates"}
              </button>
            </div>
          ) : null}

          <div
            style={{ display: "grid", gap: 10 }}
            data-matter-assignment-picker-form
          >
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.85 }}>Role</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as AssignmentRole)}
                disabled={submitting}
                data-matter-assignment-picker-role
                className="cases-filter-chip"
              >
                {ASSIGNMENT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            {alreadyHasThisRole ? (
              <div
                className="cc-section-note"
                data-matter-assignment-picker-conflict
              >
                This user already holds the {role} role on this case.
              </div>
            ) : null}
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.85 }}>
                Note (optional, ≤ 400 characters)
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={400}
                rows={3}
                disabled={submitting}
                data-matter-assignment-picker-note
                placeholder="Why this assignment? Any handoff notes?"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 10,
                  padding: 8,
                  color: "inherit",
                  resize: "vertical",
                }}
              />
            </label>
          </div>
        </>
      )}
    </Modal>
  );
}
