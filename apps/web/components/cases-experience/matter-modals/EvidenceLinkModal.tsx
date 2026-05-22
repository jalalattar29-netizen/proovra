"use client";

/**
 * Phase 32.8D-frontend-closure — Evidence search/link modal.
 *
 * Replaces the legacy `window.prompt("Evidence UUID:")` flow. Lists
 * evidence in the case's workspace (team or personal) via
 * `GET /v1/cases/:id/linkable-evidence?search=…`, surfaces lifecycle
 * + verification + readiness flags + an "already linked" badge, and
 * submits a single canonical `POST /v1/cases/:id/evidence-links`
 * request.
 *
 * Hard rules:
 *   - No raw evidence content. No signed URLs. The picker reads
 *     only bounded summary fields.
 *   - "Already linked" badge prevents the user from creating a
 *     duplicate link — the backend would also 409 on conflict.
 *   - Backend remains authoritative; this modal is UI only.
 */

import React, { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { Modal } from "./Modal";

const EVIDENCE_LINK_ROLES = [
  "PRIMARY",
  "SUPPORTING",
  "RELATED",
  "DUPLICATE",
  "DERIVED",
  "CONTEXT",
] as const;
export type EvidenceLinkRole = (typeof EVIDENCE_LINK_ROLES)[number];

type LinkableEvidenceItem = {
  id: string;
  title: string;
  type: string;
  status: string;
  verificationStatus: string | null;
  lifecycleState: string | null;
  createdAt: string;
  reportReady: boolean;
  packageReady: boolean;
  alreadyLinked: boolean;
  existingLinkRole: string | null;
};

type LinkableEnvelope = {
  items: LinkableEvidenceItem[];
  nextCursor: string | null;
};

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      items: LinkableEvidenceItem[];
      nextCursor: string | null;
      loadingMore: boolean;
    }
  | { status: "error"; message: string };

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

export function EvidenceLinkModal({
  open,
  caseId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  caseId: string;
  onClose: () => void;
  onSubmit: (input: {
    evidenceId: string;
    role: EvidenceLinkRole;
    reason: string | null;
  }) => Promise<{ ok: boolean }>;
}) {
  const [search, setSearch] = useState("");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(
    null,
  );
  const [role, setRole] = useState<EvidenceLinkRole>("PRIMARY");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(
    async (q: string) => {
      setState({ status: "loading" });
      try {
        const qs = new URLSearchParams();
        if (q.trim()) qs.set("search", q.trim());
        qs.set("limit", "25");
        const envelope = (await apiFetch(
          `/v1/cases/${encodeURIComponent(caseId)}/linkable-evidence?${qs.toString()}`,
          { method: "GET" },
        )) as LinkableEnvelope;
        setState({
          status: "ready",
          items: envelope.items,
          nextCursor: envelope.nextCursor ?? null,
          loadingMore: false,
        });
      } catch (err) {
        const e = err as { message?: string };
        setState({
          status: "error",
          message: e?.message ?? "Unable to load evidence.",
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
        `/v1/cases/${encodeURIComponent(caseId)}/linkable-evidence?${qs.toString()}`,
        { method: "GET" },
      )) as LinkableEnvelope;
      setState((prev) =>
        prev.status === "ready"
          ? {
              ...prev,
              items: dedupeById(prev.items, envelope.items, (x) => x.id),
              nextCursor: envelope.nextCursor ?? null,
              loadingMore: false,
            }
          : prev,
      );
    } catch (err) {
      const e = err as { message?: string };
      setState({
        status: "error",
        message: e?.message ?? "Unable to load more evidence.",
      });
    }
  }, [state, search, caseId]);

  // Search resets cursor; debounced.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      void reload(search);
    }, search ? 200 : 0);
    return () => clearTimeout(t);
  }, [open, search, reload]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelectedEvidenceId(null);
      setRole("PRIMARY");
      setReason("");
      setSubmitting(false);
    }
  }, [open]);

  const items = state.status === "ready" ? state.items : [];
  const selected =
    items.find((e) => e.id === selectedEvidenceId) ?? null;
  const cannotLink = selected?.alreadyLinked ?? false;

  const handleSubmit = useCallback(async () => {
    if (!selectedEvidenceId) return;
    setSubmitting(true);
    const result = await onSubmit({
      evidenceId: selectedEvidenceId,
      role,
      reason: reason.trim() ? reason.trim() : null,
    });
    setSubmitting(false);
    if (result.ok) onClose();
  }, [selectedEvidenceId, role, reason, onSubmit, onClose]);

  return (
    <Modal
      open={open}
      title="Link evidence to this matter"
      onClose={onClose}
      testid="evidence-link-modal"
      dismissDisabled={submitting}
      footer={
        <>
          <button
            type="button"
            className="cases-filter-chip"
            data-matter-evidence-link-cancel
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cases-filter-chip is-active"
            data-matter-evidence-link-submit
            onClick={() => void handleSubmit()}
            disabled={!selectedEvidenceId || submitting || cannotLink}
            title={
              !selectedEvidenceId
                ? "Select an evidence item"
                : cannotLink
                  ? "This evidence is already linked to the matter"
                  : "Link evidence"
            }
          >
            {submitting ? "Linking…" : "Link evidence"}
          </button>
        </>
      }
    >
      <input
        type="search"
        placeholder="Search evidence by title"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-matter-evidence-link-search-input
        className="cases-filter-search"
        style={{ width: "100%", marginBottom: 10 }}
      />
      <div
        data-matter-evidence-link-list
        style={{
          maxHeight: 280,
          overflowY: "auto",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 10,
          marginBottom: 12,
        }}
      >
        {state.status === "loading" ? (
          <div className="cc-section-note">Loading evidence…</div>
        ) : state.status === "error" ? (
          <div
            className="cc-section-note"
            data-matter-evidence-link-error
          >
            {state.message}
          </div>
        ) : items.length === 0 ? (
          <div className="cc-section-note">
            No evidence matches the search.
          </div>
        ) : (
          <ul
            role="listbox"
            aria-label="Workspace evidence"
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {items.map((ev) => {
              const isSelected = ev.id === selectedEvidenceId;
              return (
                <li
                  key={ev.id}
                  data-matter-evidence-link-row={ev.id}
                  data-matter-evidence-link-row-selected={
                    isSelected ? "true" : "false"
                  }
                >
                  <button
                    type="button"
                    onClick={() => setSelectedEvidenceId(ev.id)}
                    aria-selected={isSelected}
                    role="option"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      width: "100%",
                      padding: "10px 12px",
                      background: isSelected
                        ? "rgba(183,157,132,0.18)"
                        : "transparent",
                      border: "none",
                      color: "inherit",
                      textAlign: "left",
                      cursor: "pointer",
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                        alignItems: "center",
                      }}
                    >
                      <span
                        data-matter-evidence-link-row-title
                        style={{ fontWeight: 600 }}
                      >
                        {ev.title}
                      </span>
                      {ev.alreadyLinked ? (
                        <span
                          className="cases-row-chip"
                          data-matter-evidence-link-row-already-linked
                          data-existing-role={ev.existingLinkRole ?? ""}
                        >
                          Already linked
                          {ev.existingLinkRole
                            ? ` (${ev.existingLinkRole})`
                            : ""}
                        </span>
                      ) : null}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        flexWrap: "wrap",
                        fontSize: 12,
                        opacity: 0.85,
                      }}
                    >
                      <span
                        className="cases-row-chip"
                        data-matter-evidence-link-row-type={ev.type}
                      >
                        {ev.type}
                      </span>
                      <span data-matter-evidence-link-row-status={ev.status}>
                        {ev.status}
                      </span>
                      {ev.lifecycleState ? (
                        <span
                          data-matter-evidence-link-row-lifecycle={
                            ev.lifecycleState
                          }
                        >
                          {ev.lifecycleState}
                        </span>
                      ) : null}
                      {ev.verificationStatus ? (
                        <span
                          data-matter-evidence-link-row-verification={
                            ev.verificationStatus
                          }
                        >
                          {ev.verificationStatus}
                        </span>
                      ) : null}
                      <span
                        data-matter-evidence-link-row-report-ready={
                          ev.reportReady ? "true" : "false"
                        }
                      >
                        {ev.reportReady ? "Report ready" : "No report"}
                      </span>
                      <span
                        data-matter-evidence-link-row-package-ready={
                          ev.packageReady ? "true" : "false"
                        }
                      >
                        {ev.packageReady ? "Package ready" : "No package"}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {state.status === "ready" && state.nextCursor ? (
        <div
          data-matter-evidence-link-load-more-row
          style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}
        >
          <button
            type="button"
            className="cases-filter-chip"
            data-matter-evidence-link-load-more
            disabled={state.loadingMore}
            onClick={() => void loadMore()}
          >
            {state.loadingMore ? "Loading…" : "Load more evidence"}
          </button>
        </div>
      ) : null}

      <div
        style={{ display: "grid", gap: 10 }}
        data-matter-evidence-link-form
      >
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: 12, opacity: 0.85 }}>Link role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as EvidenceLinkRole)}
            disabled={submitting}
            data-matter-evidence-link-role
            className="cases-filter-chip"
          >
            {EVIDENCE_LINK_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            Reason / note (optional, ≤ 400 characters)
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={400}
            rows={3}
            disabled={submitting}
            data-matter-evidence-link-reason
            placeholder="Why is this evidence linked to the matter?"
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
    </Modal>
  );
}
