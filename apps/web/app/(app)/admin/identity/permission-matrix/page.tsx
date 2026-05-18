"use client";

/**
 * Phase 26 — Permission Matrix admin page.
 *
 * Operator-facing "what can this member do here?" inspector. For each
 * canonical permission, shows the outcome (ALLOW / DENY / STEP_UP /
 * NOT_APPLICABLE) and the SOURCE (role default, capability grant,
 * delegated scope, etc.). Backed by RBAC engine's
 * `buildPermissionSnapshot`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import {
  cardStyle,
  errorBoxStyle,
  ghostButtonStyle,
  headerRowStyle,
  inputStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  sectionTitleStyle,
  selectStyle,
  statusBadgeStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../ui-tokens";

type Outcome = "ALLOW" | "DENY" | "STEP_UP_REQUIRED" | "NOT_APPLICABLE";

type PermissionRow = {
  permission: string;
  outcome: Outcome;
  source: string;
  sourceLabel: string;
  reason: string;
};

type Snapshot = {
  teamId: string;
  userId: string;
  canonicalRole: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  permissions: PermissionRow[];
  capabilityGrantCount: number;
  delegatedScopeCount: number;
  temporaryElevationCount: number;
  computedAtUtc: string;
};

export default function PermissionMatrixPage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [subjectUserId, setSubjectUserId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [outcomeFilter, setOutcomeFilter] = useState<Outcome | "">("");

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

  const load = useCallback(async () => {
    if (!teamId || !subjectUserId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/v1/admin/identity/permission-matrix?teamId=${encodeURIComponent(
          teamId,
        )}&subjectUserId=${encodeURIComponent(subjectUserId)}`,
        { method: "GET" },
      );
      setSnapshot(res.snapshot as Snapshot);
    } catch (err) {
      setError(
        (err as { message?: string })?.message ?? "Could not load snapshot.",
      );
      setSnapshot(null);
    } finally {
      setBusy(false);
    }
  }, [teamId, subjectUserId]);

  const filtered = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.permissions.filter((p) => {
      if (outcomeFilter && p.outcome !== outcomeFilter) return false;
      if (filter && !p.permission.toLowerCase().includes(filter.toLowerCase()))
        return false;
      return true;
    });
  }, [snapshot, filter, outcomeFilter]);

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
          <h1 style={titleStyle}>Permission Matrix</h1>
          <p style={subtitleStyle}>
            For each canonical permission, shows the outcome plus the source
            (role default, capability grant, delegated scope, temporary
            elevation, or workspace policy).
          </p>
        </div>
      </header>

      <section style={{ ...cardStyle, marginTop: 16 }}>
        <h3 style={sectionTitleStyle}>Inspect a member</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            style={{ ...inputStyle, maxWidth: 360 }}
            placeholder="Member user id (UUID)"
            value={subjectUserId}
            onChange={(e) => setSubjectUserId(e.target.value.trim())}
          />
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={load}
            disabled={busy || !subjectUserId}
          >
            {busy ? "Loading…" : "Inspect"}
          </button>
        </div>
      </section>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {snapshot ? (
        <>
          <section style={{ ...cardStyle, marginTop: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <KV k="Member" v={snapshot.userId} mono />
              <KV k="Canonical role" v={snapshot.canonicalRole} />
              <KV k="Status" v={snapshot.status} />
              <KV
                k="Capability grants"
                v={String(snapshot.capabilityGrantCount)}
              />
              <KV
                k="Delegated scopes"
                v={String(snapshot.delegatedScopeCount)}
              />
              <KV
                k="Temp elevations"
                v={String(snapshot.temporaryElevationCount)}
              />
            </div>
          </section>

          <section style={{ ...cardStyle, marginTop: 16 }}>
            <div
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 8,
                flexWrap: "wrap",
              }}
            >
              <input
                style={{ ...inputStyle, maxWidth: 280 }}
                placeholder="Filter by permission name…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <select
                style={selectStyle}
                value={outcomeFilter}
                onChange={(e) =>
                  setOutcomeFilter(e.target.value as Outcome | "")
                }
              >
                <option value="">All outcomes</option>
                <option value="ALLOW">Allow</option>
                <option value="DENY">Deny</option>
                <option value="STEP_UP_REQUIRED">Step-up required</option>
                <option value="NOT_APPLICABLE">Not applicable</option>
              </select>
              <span style={mutedStyle}>
                {filtered.length} / {snapshot.permissions.length} permissions
              </span>
              <button
                type="button"
                style={ghostButtonStyle}
                onClick={() => {
                  setFilter("");
                  setOutcomeFilter("");
                }}
              >
                Clear
              </button>
            </div>
            <div
              style={{
                overflowY: "auto",
                maxHeight: "calc(100vh - 380px)",
              }}
            >
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Permission</th>
                    <th style={thStyle}>Outcome</th>
                    <th style={thStyle}>Source</th>
                    <th style={thStyle}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.permission}>
                      <td
                        style={{
                          ...tdStyle,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                          fontSize: 12,
                        }}
                      >
                        {r.permission}
                      </td>
                      <td style={tdStyle}>
                        <span style={statusBadgeStyle(r.outcome)}>
                          {r.outcome.toLowerCase().replace("_", " ")}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={mutedStyle}>{r.sourceLabel}</span>
                      </td>
                      <td style={tdStyle}>
                        <span style={mutedStyle}>{r.reason}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

function KV({
  k,
  v,
  mono,
}: {
  k: string;
  v: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: TOKENS.inkSubtle, textTransform: "uppercase" }}>
        {k}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          ...(mono
            ? {
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 12,
              }
            : {}),
        }}
      >
        {v}
      </span>
    </div>
  );
}
