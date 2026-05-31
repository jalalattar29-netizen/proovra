"use client";

/**
 * PROOVRA Phase 2A Closure — Reviewer queues + bulk operations.
 *
 * Workspace-anchored queue surface with multi-select + bulk actions
 * (assign, decide). Selection model:
 *   - shift-click → range select
 *   - cmd/ctrl-click → toggle
 *   - "Select all" header checkbox toggles every visible row
 *
 * Bulk confirmation modal shows the affected count + the action
 * before issuing the request. Server applies bounded batch limit
 * (≤ 100) and emits per-item outcomes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { REVIEWER_VERDICTS } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import {
  bulkAssign,
  bulkDecide,
  type BulkOutcome,
} from "../../../../lib/reviewer-workspace/reviewer-api";

type QueueRow = {
  id: string;
  evidenceId: string;
  status: string;
  priority: string;
  assignedToUserId: string | null;
  dueAt: string | null;
  createdAt: string;
};

export default function QueuesPage() {
  return (
    <PageRouteGate routeId="workspace.review_queues">
      <QueuesShell />
    </PageRouteGate>
  );
}

function QueuesShell() {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [filter, setFilter] = useState<string>("assigned");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<
    | null
    | {
        kind: "DECIDE";
        verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO";
      }
    | { kind: "ASSIGN"; assigneeUserId: string }
  >(null);

  const refresh = useCallback(async () => {
    // Workspace-anchored queue read via the existing reviewer-ops
    // listing route. The Phase 2A workspace aggregator surfaces the
    // counts; per-state listing reuses the existing surface.
    try {
      const res = await apiFetch(
        `/v1/reviewer-ops/queue?state=${encodeURIComponent(filter)}&limit=200`,
        { method: "GET" },
      );
      setRows((res?.workflows ?? res?.rows ?? []) as QueueRow[]);
    } catch {
      setRows([]);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allVisibleIds = useMemo(
    () => (rows ?? []).map((r) => r.id),
    [rows],
  );
  const allSelected =
    allVisibleIds.length > 0 &&
    allVisibleIds.every((id) => selected.has(id));

  const toggleOne = useCallback(
    (idx: number, ev: React.MouseEvent) => {
      if (!rows) return;
      const id = rows[idx]!.id;
      setSelected((prev) => {
        const next = new Set(prev);
        if (ev.shiftKey && lastIndex !== null) {
          const lo = Math.min(idx, lastIndex);
          const hi = Math.max(idx, lastIndex);
          for (let i = lo; i <= hi; i += 1) next.add(rows[i]!.id);
        } else {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
        return next;
      });
      setLastIndex(idx);
    },
    [rows, lastIndex],
  );

  function toggleAll() {
    if (!rows) return;
    setSelected((prev) => {
      if (allSelected) return new Set();
      const next = new Set(prev);
      for (const id of allVisibleIds) next.add(id);
      return next;
    });
  }

  async function runDecide(
    verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO",
  ) {
    const ids = Array.from(selected).slice(0, 100);
    const res = await bulkDecide({ verdict, workflowIds: ids });
    setBanner(summariseOutcome(`Decide=${verdict}`, ids.length, res));
    setSelected(new Set());
    setPendingConfirmation(null);
    await refresh();
  }

  async function runAssign(assigneeUserId: string) {
    const ids = Array.from(selected).slice(0, 100);
    const res = await bulkAssign({ assigneeUserId, workflowIds: ids });
    setBanner(summariseOutcome(`Assign`, ids.length, res));
    setSelected(new Set());
    setPendingConfirmation(null);
    await refresh();
  }

  return (
    <div
      data-reviewer-queues-page
      style={{
        padding: 18,
        maxWidth: 1200,
        margin: "0 auto",
        color: "#0f172a",
      }}
    >
      <header
        style={{
          display: "flex",
          gap: 12,
          alignItems: "baseline",
          marginBottom: 10,
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>Reviewer queues</h1>
        <select
          data-reviewer-queue-filter
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setSelected(new Set());
          }}
          style={{ padding: "4px 8px", fontSize: 12 }}
        >
          <option value="assigned">Assigned (mine)</option>
          <option value="unassigned">Unassigned</option>
          <option value="in_progress">In progress</option>
          <option value="escalated">Escalated</option>
          <option value="completed">Completed</option>
        </select>
      </header>

      <BulkBar
        selectedCount={selected.size}
        onDecide={(verdict) =>
          setPendingConfirmation({ kind: "DECIDE", verdict })
        }
        onAssign={() => {
          const id = window.prompt("Assignee user id:");
          if (id) setPendingConfirmation({ kind: "ASSIGN", assigneeUserId: id });
        }}
        onClear={() => setSelected(new Set())}
      />

      {banner ? (
        <div
          data-bulk-banner
          style={{
            margin: "8px 0",
            padding: "8px 12px",
            background: "rgba(15, 23, 42, 0.05)",
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          {banner}
        </div>
      ) : null}

      {rows === null ? (
        <div>Loading…</div>
      ) : (
        <table
          data-reviewer-queue-table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>
                <input
                  type="checkbox"
                  data-reviewer-queue-select-all
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
              <th style={th}>Workflow</th>
              <th style={th}>Evidence</th>
              <th style={th}>Status</th>
              <th style={th}>Priority</th>
              <th style={th}>Assignee</th>
              <th style={th}>Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr
                key={r.id}
                data-reviewer-queue-row={r.id}
                data-reviewer-queue-selected={selected.has(r.id) ? "true" : "false"}
                style={{
                  background: selected.has(r.id) ? "rgba(15, 23, 42, 0.05)" : "transparent",
                  cursor: "pointer",
                }}
                onClick={(e) => toggleOne(idx, e)}
              >
                <td style={td}>
                  <input
                    type="checkbox"
                    data-reviewer-queue-checkbox={r.id}
                    checked={selected.has(r.id)}
                    onChange={() => null}
                  />
                </td>
                <td style={td}>
                  <code>{r.id.slice(0, 8)}…</code>
                </td>
                <td style={td}>
                  <code>{r.evidenceId.slice(0, 8)}…</code>
                </td>
                <td style={td}>{r.status}</td>
                <td style={td}>{r.priority}</td>
                <td style={td}>
                  {r.assignedToUserId ? r.assignedToUserId.slice(0, 8) + "…" : "—"}
                </td>
                <td style={td}>
                  {r.dueAt ? new Date(r.dueAt).toLocaleDateString() : "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ ...td, color: "#475569" }}>
                  No workflows in this view.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}

      {pendingConfirmation ? (
        <ConfirmModal
          confirmation={pendingConfirmation}
          count={selected.size}
          onCancel={() => setPendingConfirmation(null)}
          onConfirm={async () => {
            if (pendingConfirmation.kind === "DECIDE") {
              await runDecide(pendingConfirmation.verdict);
            } else {
              await runAssign(pendingConfirmation.assigneeUserId);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function BulkBar({
  selectedCount,
  onDecide,
  onAssign,
  onClear,
}: {
  selectedCount: number;
  onDecide: (
    verdict: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO",
  ) => void;
  onAssign: () => void;
  onClear: () => void;
}) {
  if (selectedCount === 0) {
    return (
      <div
        data-bulk-bar
        data-bulk-bar-state="empty"
        style={{
          padding: "8px 12px",
          background: "rgba(15, 23, 42, 0.02)",
          borderRadius: 8,
          fontSize: 12,
          color: "#475569",
        }}
      >
        Select rows with the checkboxes or shift-click. Bulk actions
        appear when at least one row is selected (≤ 100 per call).
      </div>
    );
  }
  return (
    <div
      data-bulk-bar
      data-bulk-bar-state="active"
      data-bulk-bar-selected={selectedCount}
      style={{
        padding: "8px 12px",
        background: "#0f172a",
        color: "#fafafa",
        borderRadius: 8,
        fontSize: 12,
        display: "flex",
        gap: 8,
        alignItems: "center",
      }}
    >
      <strong>{selectedCount} selected</strong>
      <button
        type="button"
        data-bulk-action="ASSIGN"
        onClick={onAssign}
        style={bulkBtn}
      >
        Bulk assign
      </button>
      {REVIEWER_VERDICTS.filter((v) => v !== "PENDING").map((v) => (
        <button
          key={v}
          type="button"
          data-bulk-action={v}
          onClick={() =>
            onDecide(v as "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO")
          }
          style={bulkBtn}
        >
          Bulk {v.toLowerCase()}
        </button>
      ))}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        data-bulk-clear
        onClick={onClear}
        style={{ ...bulkBtn, background: "transparent" }}
      >
        Clear
      </button>
    </div>
  );
}

function ConfirmModal({
  confirmation,
  count,
  onConfirm,
  onCancel,
}: {
  confirmation:
    | { kind: "DECIDE"; verdict: string }
    | { kind: "ASSIGN"; assigneeUserId: string };
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-bulk-confirm
      data-bulk-confirm-kind={confirmation.kind}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 18,
          maxWidth: 440,
          width: "92vw",
        }}
      >
        <h3 style={{ marginTop: 0, fontSize: 16 }}>
          Confirm bulk{" "}
          {confirmation.kind === "DECIDE"
            ? confirmation.verdict.toLowerCase()
            : "assign"}
        </h3>
        <p style={{ color: "#475569", fontSize: 13 }}>
          This will apply the action to <strong>{Math.min(count, 100)}</strong>{" "}
          workflows. The audit trail records each per-item outcome.
        </p>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 12,
          }}
        >
          <button
            type="button"
            data-bulk-confirm-cancel
            onClick={onCancel}
            style={ghostBtn}
          >
            Cancel
          </button>
          <button
            type="button"
            data-bulk-confirm-go
            onClick={onConfirm}
            style={primaryBtn}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function summariseOutcome(
  action: string,
  requested: number,
  res:
    | {
        total: number;
        succeeded: number;
        outcomes: BulkOutcome[];
      }
    | { denial: string }
    | unknown,
): string {
  if (res && typeof res === "object" && "denial" in (res as object)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return `${action} refused: ${(res as any).denial}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any;
  return `${action}: ${r?.succeeded ?? 0} of ${r?.total ?? requested} succeeded.`;
}

const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const bulkBtn = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#fafafa",
  fontSize: 11,
  padding: "3px 9px",
  borderRadius: 6,
  cursor: "pointer",
} as const;
const ghostBtn = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#0f172a",
  fontSize: 12,
  padding: "5px 12px",
  borderRadius: 6,
  cursor: "pointer",
} as const;
const primaryBtn = {
  background: "#0f172a",
  color: "#fafafa",
  border: "none",
  fontSize: 12,
  padding: "5px 14px",
  borderRadius: 6,
  cursor: "pointer",
} as const;
