"use client";

/**
 * Phase 26 — Access Reviews admin page.
 *
 * Lightweight wrapper around the existing Phase 17 access-review
 * service (`GET /v1/identity/access-reviews`). Displays the queue and
 * surfaces the certify / revoke decisions via the existing decision
 * route (`POST /v1/identity/access-reviews/:id/decision`).
 *
 * Phase 26 does NOT replace the underlying Phase 17 model; this page
 * gives operators a denser inspector.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import {
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  mutedStyle,
  pageStyle,
  selectStyle,
  statusBadgeStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
} from "../ui-tokens";

type AccessReview = {
  id: string;
  kind: string;
  status: string;
  subjectKind: string;
  subjectUserId: string | null;
  subjectApiCredentialId: string | null;
  initiatedAtUtc: string;
  dueAtUtc: string | null;
  completedAtUtc: string | null;
  decisionNote: string | null;
};

const STATUS_OPTIONS = [
  "",
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED_KEEP",
  "COMPLETED_REVOKED",
  "COMPLETED_SUSPENDED",
  "COMPLETED_NO_ACTION",
  "CANCELLED",
];

export default function AccessReviewsPage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<AccessReview[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("PENDING");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((r: { user?: { currentWorkspaceId?: string | null } }) => {
        if (!cancelled) setTeamId(r?.user?.currentWorkspaceId ?? null);
      })
      .catch(() => {
        if (!cancelled) setTeamId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(() => {
    if (!teamId) return;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    if (statusFilter) qs.set("status", statusFilter);
    apiFetch(`/v1/identity/access-reviews?${qs.toString()}`, { method: "GET" })
      .then(
        (r: { reviews?: AccessReview[]; items?: AccessReview[] }) => {
          setReviews(r.reviews ?? r.items ?? []);
          setError(null);
        },
      )
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Could not load access reviews."),
      );
  }, [teamId, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = useCallback(
    async (id: string, decision: string) => {
      if (!teamId) return;
      const note =
        decision === "COMPLETED_KEEP"
          ? window.prompt("Decision note (optional)") ?? ""
          : window.prompt("Decision note (required)") ?? "";
      if (decision !== "COMPLETED_KEEP" && !note) return;
      setBusy(id);
      try {
        await apiFetch(
          `/v1/identity/access-reviews/${encodeURIComponent(id)}/decision`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId,
              status: decision,
              decisionNote: note.slice(0, 2000),
            }),
          },
        );
        load();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ??
            "Could not record decision.",
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

  if (!teamId) {
    return (
      <main style={pageStyle}>
        <p style={mutedStyle}>Switch to a workspace.</p>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Access Reviews</h1>
          <p style={subtitleStyle}>
            Periodic and triggered access reviews from the Phase 17 access-
            review queue. Certify, revoke, or suspend; every decision is
            audited via the immutable platform audit log.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            style={selectStyle}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s || "All statuses"}
              </option>
            ))}
          </select>
          <button type="button" style={ghostButtonStyle} onClick={load}>
            Refresh
          </button>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <section style={{ ...cardStyle, marginTop: 16, padding: 0 }}>
        {reviews === null ? (
          <p style={{ ...mutedStyle, padding: 16 }}>Loading…</p>
        ) : reviews.length === 0 ? (
          <p style={{ ...mutedStyle, padding: 24 }}>
            No access reviews match this filter.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Kind</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Subject</th>
                <th style={thStyle}>Initiated</th>
                <th style={thStyle}>Due</th>
                <th style={thStyle}>Note</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id}>
                  <td style={tdStyle}>
                    <span style={{ ...mutedStyle, fontSize: 11 }}>{r.kind}</span>
                  </td>
                  <td style={tdStyle}>
                    <span style={statusBadgeStyle(r.status.split("_")[0])}>
                      {r.status.toLowerCase().replace(/_/g, " ")}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <code
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                        fontSize: 11,
                      }}
                    >
                      {r.subjectKind}{" "}
                      {(
                        r.subjectUserId ?? r.subjectApiCredentialId ?? ""
                      ).slice(0, 12)}
                      …
                    </code>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(r.initiatedAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>{formatDateTime(r.dueAtUtc)}</span>
                  </td>
                  <td style={tdStyle}>
                    <span
                      style={{
                        ...mutedStyle,
                        fontSize: 11,
                        maxWidth: 240,
                        display: "block",
                      }}
                    >
                      {r.decisionNote ?? "—"}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {r.status === "PENDING" || r.status === "IN_PROGRESS" ? (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          disabled={busy === r.id}
                          onClick={() => decide(r.id, "COMPLETED_KEEP")}
                        >
                          Certify
                        </button>
                        <button
                          type="button"
                          style={{
                            ...ghostButtonStyle,
                            color: "#991b1b",
                            borderColor: "#fecaca",
                            background: "#fef2f2",
                          }}
                          disabled={busy === r.id}
                          onClick={() => decide(r.id, "COMPLETED_REVOKED")}
                        >
                          Revoke
                        </button>
                        <button
                          type="button"
                          style={ghostButtonStyle}
                          disabled={busy === r.id}
                          onClick={() => decide(r.id, "COMPLETED_SUSPENDED")}
                        >
                          Suspend
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
