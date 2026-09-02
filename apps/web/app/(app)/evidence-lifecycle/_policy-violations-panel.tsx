"use client";

/**
 * PHASE 12B (Evidence Operations) — policy-violation observability panel.
 *
 * Consumes the two dedicated lifecycle observability reads:
 *
 *   GET /v1/lifecycle/violations/counts?since=  → summary + badge authority
 *   GET /v1/lifecycle/violations?kind=&since=   → bounded event drill-down
 *
 * Before this panel the landing page rendered the counts that come
 * embedded in the lifecycle dashboard envelope — a decorative number with
 * no drill-down and no time window. The dedicated counts endpoint is now
 * the authority for the summary, and the list endpoint backs a real
 * per-code drill-down.
 *
 * Hard rules honoured:
 *   - Lifecycle authority is SERVER-side: both routes resolve the
 *     workspace from `user.currentWorkspaceId` (never a client-supplied
 *     teamId), so this panel sends no tenant parameter at all.
 *   - Stale-context rejection comes from `useLifecycleFetch`, which drops
 *     the previous tenant's payload and re-loads on a workspace switch.
 *   - Denial / degraded / empty / failure are distinct rendered states.
 *     A denial NEVER renders as "0 violations".
 *   - The bounded `reason` chip on each event is deliberately NOT
 *     rendered: POLICY_VIOLATION_LEGAL_HOLD reasons must not surface in
 *     an operator list. Only bounded codes, target kinds, ids and
 *     timestamps are shown.
 */

import { useCallback, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import {
  DenialBanner,
  EmptyState,
  SectionLoadingSkeleton,
  useLifecycleFetch,
} from "./_shared";

// ---------------------------------------------------------------------------
// Bounded vocabulary — mirrors POLICY_VIOLATION_CODES on the API side
// (services/api/src/services/lifecycle/policy-violation.service.ts).
// ---------------------------------------------------------------------------

const VIOLATION_CODES = [
  "POLICY_VIOLATION_ENTITLEMENT",
  "POLICY_VIOLATION_LEGAL_HOLD",
  "POLICY_VIOLATION_RETENTION",
  "POLICY_VIOLATION_QUOTA",
] as const;

type ViolationCode = (typeof VIOLATION_CODES)[number];

const CODE_LABEL: Record<ViolationCode, string> = {
  POLICY_VIOLATION_ENTITLEMENT: "Entitlement",
  POLICY_VIOLATION_LEGAL_HOLD: "Legal hold",
  POLICY_VIOLATION_RETENTION: "Retention",
  POLICY_VIOLATION_QUOTA: "Quota",
};

const WINDOWS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
] as const;

/** Route caps `limit` at 200. */
const LIST_LIMIT = 100;

type CountsPayload = {
  counts?: { total?: number; byKind?: Partial<Record<string, number>> };
};

type ViolationEvent = {
  id: string;
  code: string;
  evidenceId: string | null;
  caseId: string | null;
  targetType: string | null;
  targetId: string | null;
  actorUserId: string | null;
  occurredAtUtc: string;
};

type ListPayload = { violations?: ReadonlyArray<ViolationEvent> };

/**
 * `fallbackByCode` carries the counts that the lifecycle dashboard
 * envelope already returned. They are used ONLY when the dedicated counts
 * endpoint is denied, and the UI says so explicitly.
 */
export function PolicyViolationsPanel({
  fallbackByCode,
}: {
  fallbackByCode?: Partial<Record<ViolationCode, number>>;
}) {
  const [windowDays, setWindowDays] = useState<number>(30);
  const [selectedCode, setSelectedCode] = useState<ViolationCode | null>(null);

  const sinceIso = useMemo(
    () => new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString(),
    [windowDays],
  );

  const countsLoader = useCallback(async () => {
    const params = new URLSearchParams({ since: sinceIso });
    return (await apiFetch(`/v1/lifecycle/violations/counts?${params.toString()}`, {
      method: "GET",
    })) as CountsPayload | null;
  }, [sinceIso]);

  const listLoader = useCallback(async () => {
    const params = new URLSearchParams({
      since: sinceIso,
      limit: String(LIST_LIMIT),
    });
    if (selectedCode) params.set("kind", selectedCode);
    return (await apiFetch(`/v1/lifecycle/violations?${params.toString()}`, {
      method: "GET",
    })) as ListPayload | null;
  }, [sinceIso, selectedCode]);

  const counts = useLifecycleFetch<CountsPayload | null>(countsLoader, [sinceIso]);
  const list = useLifecycleFetch<ListPayload | null>(listLoader, [
    sinceIso,
    selectedCode,
  ]);

  const countsDenied = counts.denial !== null && counts.data === null;
  const byKind = counts.data?.counts?.byKind ?? null;
  const total = counts.data?.counts?.total ?? null;

  const resolvedByCode: Record<ViolationCode, number | null> = useMemo(() => {
    const out = {} as Record<ViolationCode, number | null>;
    for (const code of VIOLATION_CODES) {
      if (byKind) out[code] = Number(byKind[code] ?? 0);
      else if (countsDenied) out[code] = fallbackByCode?.[code] ?? null;
      else out[code] = null;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byKind, countsDenied, fallbackByCode]);

  const resolvedTotal =
    total !== null
      ? total
      : countsDenied
        ? VIOLATION_CODES.reduce(
            (sum, code) => sum + (fallbackByCode?.[code] ?? 0),
            0,
          )
        : null;

  const events = list.data?.violations ?? [];

  return (
    <section
      data-lifecycle-violations-panel
      data-lifecycle-violations-window={windowDays}
      style={{
        background: "var(--surface-card, #ffffff)",
        border: "1px solid rgba(15,23,42,0.08)",
        borderRadius: 12,
        padding: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: 10,
        }}
      >
        <div>
          <strong style={{ fontSize: 14, display: "block" }}>
            Policy violations
          </strong>
          <small style={{ color: "var(--ink-muted, #64748b)", fontSize: 11.5 }}>
            Bounded POLICY_VIOLATION_* events recorded by the lifecycle
            engine. Counts come from the dedicated violations summary, not
            from the dashboard tile.
          </small>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          {resolvedTotal !== null ? (
            <span
              data-lifecycle-violations-total={resolvedTotal}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 700,
                background: resolvedTotal > 0 ? "var(--status-risk-bg, #fef2f2)" : "var(--status-verified-bg, #f0fdf4)",
                border: `1px solid ${resolvedTotal > 0 ? "var(--status-risk-border, #fecaca)" : "var(--status-verified-border, #bbf7d0)"}`,
                color: resolvedTotal > 0 ? "var(--status-risk-fg, #991b1b)" : "var(--status-verified-fg, #15803d)",
              }}
            >
              {resolvedTotal} in window
            </span>
          ) : null}
          <label style={labelStyle}>
            Window
            <select
              data-lifecycle-violations-window-select
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              style={selectStyle}
            >
              {WINDOWS.map((w) => (
                <option key={w.days} value={w.days}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {counts.denial && counts.data === null ? (
        <DenialBanner denial={counts.denial} />
      ) : null}

      {counts.loading ? (
        <SectionLoadingSkeleton rows={1} />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
          }}
        >
          {VIOLATION_CODES.map((code) => {
            const value = resolvedByCode[code];
            const active = selectedCode === code;
            const hot = (value ?? 0) > 0;
            return (
              <button
                key={code}
                type="button"
                data-violation-code={code}
                data-violation-count={value === null ? "unknown" : value}
                data-violation-selected={active ? "true" : "false"}
                onClick={() => setSelectedCode(active ? null : code)}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  background: hot ? "var(--status-risk-bg, #fef2f2)" : "var(--surface-card, #ffffff)",
                  border: `${active ? 2 : 1}px solid ${
                    active
                      ? "var(--ink-primary, #0f172a)"
                      : hot
                        ? "var(--status-risk-border, #fecaca)"
                        : "rgba(15,23,42,0.08)"
                  }`,
                  borderRadius: 10,
                  padding: 10,
                }}
              >
                <small
                  style={{
                    fontSize: 11,
                    color: hot ? "var(--status-risk-fg, #991b1b)" : "var(--ink-secondary, #475569)",
                    fontWeight: 600,
                  }}
                >
                  {CODE_LABEL[code]}
                </small>
                <strong style={{ fontSize: 22, display: "block", marginTop: 4 }}>
                  {value === null ? "—" : value}
                </strong>
                <small style={{ fontSize: 10.5, color: "var(--ink-muted, #64748b)" }}>
                  {active ? "Filtering events" : "Show events"}
                </small>
              </button>
            );
          })}
        </div>
      )}

      {countsDenied ? (
        <p
          data-lifecycle-violations-fallback
          style={{ fontSize: 11.5, color: "var(--status-pending-fg, #EA580C)", marginTop: 8 }}
        >
          The violations summary is not available for your role, so the
          counts above fall back to the lifecycle dashboard totals and may
          not reflect the selected window.
        </p>
      ) : null}

      <div style={{ marginTop: 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginBottom: 6,
          }}
        >
          <strong style={{ fontSize: 13 }}>
            {selectedCode
              ? `${CODE_LABEL[selectedCode]} events`
              : "Most recent events"}
          </strong>
          {selectedCode ? (
            <button
              type="button"
              data-lifecycle-violations-clear-filter
              onClick={() => setSelectedCode(null)}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                fontSize: 11.5,
                fontWeight: 600,
                color: "var(--accent-link, #4338ca)",
                cursor: "pointer",
              }}
            >
              Clear filter
            </button>
          ) : null}
        </div>

        {list.denial && list.data === null ? (
          <DenialBanner denial={list.denial} />
        ) : null}

        {list.loading ? (
          <SectionLoadingSkeleton rows={3} />
        ) : events.length === 0 ? (
          <EmptyState
            title="No policy violations recorded in this window"
            hint="Violation events appear here when the lifecycle engine blocks an entitlement, legal-hold, retention or quota action."
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              data-lifecycle-violations-table
              style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "var(--ink-secondary, #475569)" }}>
                  <th style={th}>Code</th>
                  <th style={th}>Target</th>
                  <th style={th}>Evidence</th>
                  <th style={th}>Actor</th>
                  <th style={th}>Occurred</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} data-lifecycle-violation-row={event.id}>
                    <td style={td}>
                      <strong>
                        {CODE_LABEL[event.code as ViolationCode] ?? event.code}
                      </strong>
                    </td>
                    <td style={td}>
                      {event.targetType ?? "—"}
                      {event.targetId ? (
                        <code style={{ marginLeft: 6, fontSize: 11 }}>
                          {event.targetId.slice(0, 8)}…
                        </code>
                      ) : null}
                    </td>
                    <td style={td}>
                      {event.evidenceId ? (
                        <a
                          href={`/evidence/${event.evidenceId}`}
                          data-lifecycle-violation-evidence={event.evidenceId}
                          style={{
                            color: "var(--accent-link, #4338ca)",
                            fontWeight: 600,
                            textDecoration: "none",
                          }}
                        >
                          {event.evidenceId.slice(0, 8)}…
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={td}>
                      {event.actorUserId
                        ? `${event.actorUserId.slice(0, 8)}…`
                        : "System"}
                    </td>
                    <td style={td}>{formatUserDateTime(event.occurredAtUtc)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {events.length >= LIST_LIMIT ? (
              <p style={{ fontSize: 11, color: "var(--ink-muted, #64748b)", marginTop: 6 }}>
                Showing the {LIST_LIMIT} most recent events. Narrow the window
                or pick a single code to see older activity.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const labelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 2,
  fontSize: 11,
  fontWeight: 600,
  color: "var(--ink-secondary, #475569)",
};
const selectStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "var(--surface-card, #ffffff)",
  minWidth: 140,
} as const;
