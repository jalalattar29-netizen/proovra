"use client";

/**
 * PROOVRA Phase 2B — Portal dashboard.
 *
 * Renders the external reviewer's dashboard with:
 *   - reviewer identity + role + capabilities
 *   - scope + expiry
 *   - assigned reviews (pending / completed) with deep links
 *   - bounded limitations footer
 *
 * The raw token is taken from the route param and stored in memory
 * as the bearer for subsequent requests. If the bearer is missing
 * (e.g. user refreshed), we re-authenticate with the route token.
 */

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import type { ExternalPortalProjection } from "@proovra/shared";

import {
  authenticate,
  fetchPortalDashboard,
  getSessionId,
  logout as portalLogout,
  setBearer,
} from "../../../lib/external-portal/portal-client";
import { formatUserDate, formatUserDateTime } from "../../../lib/date";

export default function PortalDashboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [projection, setProjection] = useState<ExternalPortalProjection | null>(
    null,
  );
  const [denial, setDenial] = useState<string | null>(null);

  const reauth = useCallback(async () => {
    setBearer(decodeURIComponent(token));
    try {
      await authenticate({
        token: decodeURIComponent(token),
        existingSessionId: getSessionId() ?? undefined,
      });
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setDenial(((err as any)?.denial ?? "TOKEN_INVALID") as string);
      return false;
    }
    return true;
  }, [token]);

  const load = useCallback(async () => {
    const ok = await reauth();
    if (!ok) return;
    try {
      const proj = await fetchPortalDashboard();
      setProjection(proj);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setDenial(((err as any)?.denial ?? "TOKEN_INVALID") as string);
    }
  }, [reauth]);

  useEffect(() => {
    void load();
  }, [load]);

  if (denial) {
    return (
      <main
        data-portal-denied
        style={{
          maxWidth: 480,
          margin: "0 auto",
          padding: 40,
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 20 }}>Portal access denied</h1>
        <code
          data-portal-denial-code
          style={{
            display: "inline-block",
            marginTop: 8,
            padding: "4px 10px",
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            borderRadius: 6,
            color: "#7f1d1d",
          }}
        >
          {denial}
        </code>
        <p style={{ marginTop: 12, fontSize: 12, color: "#475569" }}>
          Ask the workspace operator who invited you to issue a new
          invitation.
        </p>
      </main>
    );
  }

  if (!projection) {
    return (
      <main style={{ padding: 40, textAlign: "center" }}>
        Loading portal…
      </main>
    );
  }

  return (
    <main
      data-portal-dashboard
      data-portal-role={projection.reviewer.role}
      style={{
        maxWidth: 980,
        margin: "0 auto",
        padding: "24px 18px",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <PortalRibbon projection={projection} onLogout={async () => {
        await portalLogout();
        window.location.href = "/portal";
      }} />
      <AssignedList
        projection={projection}
        token={token}
      />
      <LimitationsFooter limitations={projection.limitations} />
    </main>
  );
}

function PortalRibbon({
  projection,
  onLogout,
}: {
  projection: ExternalPortalProjection;
  onLogout: () => void;
}) {
  return (
    <header
      data-portal-ribbon
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "10px 14px",
        background: "#0f172a",
        color: "#fafafa",
        borderRadius: 10,
        fontSize: 12,
      }}
    >
      <strong style={{ fontSize: 13 }}>External Reviewer Portal</strong>
      <Pill label={`Role: ${projection.reviewer.role}`} />
      {projection.reviewer.organization ? (
        <Pill label={projection.reviewer.organization} />
      ) : null}
      <Pill label={`Pending ${projection.pendingCount}`} />
      <Pill label={`Completed ${projection.completedCount}`} />
      <Pill label={`Scope: ${projection.scope.kind}`} />
      {/* Phase 2B Closure — federation + adaptive auth chips. */}
      <Pill
        data-portal-auth-method-chip={projection.session.authMethod}
        label={`Auth: ${projection.session.authMethod}`}
      />
      {projection.session.mfaRequired ? (
        <Pill
          data-portal-mfa-chip={
            projection.session.mfaSatisfied ? "SATISFIED" : "REQUIRED"
          }
          label={
            projection.session.mfaSatisfied ? "MFA satisfied" : "MFA required"
          }
        />
      ) : null}
      {projection.session.ssoConnectionId ? (
        <Pill
          data-portal-sso-chip
          label={`SSO bound: ${projection.session.ssoConnectionId.slice(0, 8)}…`}
        />
      ) : null}
      <span style={{ flex: 1 }} />
      <Pill
        label={`Expires ${formatUserDateTime(projection.scope.expiresAtUtc)}`}
      />
      <button
        type="button"
        data-portal-logout
        onClick={onLogout}
        style={{
          marginLeft: 8,
          background: "transparent",
          border: "1px solid rgba(255,255,255,0.24)",
          color: "#fafafa",
          fontSize: 11,
          padding: "3px 10px",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        Log out
      </button>
    </header>
  );
}

function Pill({ label }: { label: string }) {
  return (
    <span
      data-portal-ribbon-pill
      style={{
        padding: "3px 8px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.1)",
        border: "1px solid rgba(255,255,255,0.18)",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function AssignedList({
  projection,
  token,
}: {
  projection: ExternalPortalProjection;
  token: string;
}) {
  return (
    <section
      data-portal-assigned
      style={{
        marginTop: 18,
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: 12,
      }}
    >
      <h2 style={{ fontSize: 14, marginTop: 0 }}>Assigned reviews</h2>
      {projection.assigned.length === 0 ? (
        <p style={{ color: "#475569", fontSize: 12 }}>
          No reviews are currently assigned to your grant.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Workflow</th>
              <th style={th}>Status</th>
              <th style={th}>Due</th>
              <th style={th}>Open</th>
            </tr>
          </thead>
          <tbody>
            {projection.assigned.map((a) => (
              <tr key={a.workflowId} data-portal-assigned-row={a.workflowId}>
                <td style={td}>
                  <code>{a.workflowId.slice(0, 8)}…</code>
                </td>
                <td style={td}>
                  {a.submittedDecisionAtUtc ? (
                    <code
                      data-portal-row-status="DECIDED"
                      style={statusChip("#16a34a")}
                    >
                      DECIDED
                    </code>
                  ) : (
                    <code
                      data-portal-row-status="PENDING"
                      style={statusChip("#f59e0b")}
                    >
                      PENDING
                    </code>
                  )}
                </td>
                <td style={td}>
                  {a.dueAt ? formatUserDate(a.dueAt) : "—"}
                </td>
                <td style={td}>
                  <Link
                    href={`/portal/${encodeURIComponent(token)}/work/${a.workflowId}`}
                    data-portal-open-review={a.workflowId}
                    style={{ color: "#0f172a", textDecoration: "underline" }}
                  >
                    Open review →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LimitationsFooter({ limitations }: { limitations: ReadonlyArray<string> }) {
  return (
    <footer
      data-portal-limitations
      style={{
        marginTop: 18,
        padding: 10,
        background: "rgba(15, 23, 42, 0.04)",
        border: "1px dashed rgba(15, 23, 42, 0.18)",
        borderRadius: 8,
        fontSize: 11,
        color: "#475569",
      }}
    >
      <strong style={{ color: "#0f172a" }}>Portal limitations</strong>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {limitations.map((l) => (
          <li key={l}>
            <code>{l}</code>
          </li>
        ))}
      </ul>
    </footer>
  );
}

const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;

function statusChip(color: string) {
  return {
    padding: "1px 6px",
    borderRadius: 4,
    background: `${color}1f`,
    color,
    fontSize: 10,
    fontWeight: 700,
  } as const;
}
