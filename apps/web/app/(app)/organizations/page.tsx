"use client";

/**
 * Phase 2.7X Stage 3 — Organization runtime: list page.
 *
 * Consumes the new `GET /v1/me/orgs` endpoint and renders a minimal
 * card-per-org list. Operational clarity only.
 *
 * Hard rules (carried from the Stage 3 brief):
 *   - NO redesign, NO giant dashboard, NO analytics.
 *   - NO evidence data, NO case data, NO reviewer data — those
 *     remain Team-scoped surfaces (the existing /teams flow is
 *     untouched).
 *   - This page consumes the Phase 2.7X Organization domain
 *     EXCLUSIVELY; it does NOT use the legacy `useOrganizations()`
 *     envelope hook (that hook reads Team-shaped orgs and is used
 *     by the existing /teams page — leaving it alone preserves
 *     dual-read compatibility).
 *
 * Empty state:
 *   - Pre-Stage-4 there's no "Create organization" CTA here. New
 *     orgs are created today only by the Stage 2 backfill or by
 *     team creation (which triggers backfill on re-run). Stage 4
 *     will ship the explicit create UI.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";

type OrgRole =
  | "ORG_OWNER"
  | "ORG_ADMIN"
  | "ORG_SECURITY_ADMIN"
  | "ORG_BILLING_ADMIN"
  | "ORG_AUDITOR"
  | "ORG_MEMBER";

type MeOrgsResponse = {
  summary: { totalOrgs: number };
  orgs: Array<{
    organizationId: string;
    name: string;
    status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
    role: OrgRole;
    orgCreatedAt: string;
    memberSince: string;
  }>;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: MeOrgsResponse }
  | { kind: "error"; message: string; status: number };

const ROLE_LABELS: Record<OrgRole, string> = {
  ORG_OWNER: "Owner",
  ORG_ADMIN: "Admin",
  ORG_SECURITY_ADMIN: "Security admin",
  ORG_BILLING_ADMIN: "Billing admin",
  ORG_AUDITOR: "Auditor",
  ORG_MEMBER: "Member",
};

export default function OrganizationsListPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Phase 2.7X Stage 4 — create-org modal state.
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await apiFetch("/v1/me/orgs");
      const data = (await res.json()) as MeOrgsResponse;
      setState({ kind: "ready", data });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to load organizations.";
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      setState({ kind: "error", message, status });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = useCallback(async () => {
    const trimmed = createName.trim();
    if (!trimmed) {
      setCreateError("Name is required.");
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiFetch("/v1/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      setCreateOpen(false);
      setCreateName("");
      await load();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to create organization.";
      setCreateError(message);
    } finally {
      setCreateBusy(false);
    }
  }, [createName, load]);

  return (
    <main
      style={{ padding: "1.5rem", maxWidth: 880 }}
      data-phase-2-7x-organizations-list
    >
      <header
        style={{
          marginBottom: "1.5rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
        }}
      >
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Phase 2.7X Stage 3+4 — Organization runtime
          </div>
          <h1 style={{ margin: "0.25rem 0" }}>Organizations</h1>
          <p style={{ margin: 0, opacity: 0.85, fontSize: 14 }}>
            Organizations group your workspaces for governance, billing, and
            audit. Workspace operational behavior is unchanged — Teams continue
            to own evidence, cases, and reviewer queues.
          </p>
        </div>
        <button
          type="button"
          data-action="open-create-org"
          onClick={() => {
            setCreateError(null);
            setCreateOpen(true);
          }}
          style={{
            padding: "0.5rem 0.9rem",
            border: "1px solid currentColor",
            borderRadius: 4,
            fontSize: 13,
            whiteSpace: "nowrap",
          }}
        >
          + Create organization
        </button>
      </header>

      {createOpen && (
        <div
          role="dialog"
          aria-modal="true"
          data-modal="create-org"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !createBusy) setCreateOpen(false);
          }}
        >
          <form
            data-form="create-org"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreate();
            }}
            style={{
              background: "var(--bg, #fff)",
              color: "var(--fg, #000)",
              padding: "1.25rem",
              borderRadius: 6,
              minWidth: 360,
              maxWidth: 480,
              boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
            }}
          >
            <h2 style={{ margin: "0 0 0.5rem" }}>Create organization</h2>
            <p style={{ fontSize: 13, opacity: 0.85, marginTop: 0 }}>
              You become the ORG_OWNER. You can rename, invite members, and
              transfer ownership later.
            </p>
            <label
              style={{ display: "block", fontSize: 13, marginBottom: 4 }}
            >
              Name
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                maxLength={180}
                required
                disabled={createBusy}
                autoFocus
                data-input="create-org-name"
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  padding: "0.4rem 0.5rem",
                  border: "1px solid currentColor",
                  borderRadius: 4,
                  background: "transparent",
                  color: "inherit",
                }}
              />
            </label>
            {createError && (
              <div
                role="alert"
                data-state="error"
                style={{
                  marginTop: 8,
                  padding: "0.4rem 0.6rem",
                  border: "1px solid #d44",
                  borderRadius: 4,
                  fontSize: 13,
                }}
              >
                {createError}
              </div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 12,
              }}
            >
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                disabled={createBusy}
                data-action="cancel-create-org"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={createBusy || !createName.trim()}
                data-action="submit-create-org"
              >
                {createBusy ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}

      {state.kind === "loading" && (
        <div data-state="loading" style={{ opacity: 0.7 }}>
          Loading organizations…
        </div>
      )}

      {state.kind === "error" && (
        <div
          data-state="error"
          role="alert"
          style={{
            padding: "1rem",
            border: "1px solid #d44",
            borderRadius: 6,
            background: "rgba(220,68,68,0.06)",
          }}
        >
          <strong>Couldn’t load organizations.</strong>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {state.status ? `HTTP ${state.status}: ` : ""}
            {state.message}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            style={{ marginTop: 8 }}
          >
            Retry
          </button>
        </div>
      )}

      {state.kind === "ready" && state.data.summary.totalOrgs === 0 && (
        <div
          data-state="empty"
          style={{
            padding: "1rem",
            border: "1px dashed #888",
            borderRadius: 6,
            opacity: 0.85,
            fontSize: 14,
          }}
        >
          You aren’t a member of any organization yet. Organizations are
          governance + billing groupings — they’re created automatically
          for your existing workspaces during the platform’s safe
          local-only backfill. New-org self-service ships in a later phase.
        </div>
      )}

      {state.kind === "ready" && state.data.summary.totalOrgs > 0 && (
        <ul
          data-state="ready"
          data-total-orgs={state.data.summary.totalOrgs}
          style={{ listStyle: "none", padding: 0, margin: 0 }}
        >
          {state.data.orgs.map((org) => (
            <li
              key={org.organizationId}
              style={{
                padding: "1rem",
                border: "1px solid rgba(127,127,127,0.3)",
                borderRadius: 6,
                marginBottom: "0.75rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{org.name}</div>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                  Role: <strong>{ROLE_LABELS[org.role]}</strong> · Status:{" "}
                  {org.status} · Member since{" "}
                  {new Date(org.memberSince).toLocaleDateString()}
                </div>
              </div>
              <Link
                href={`/organizations/${org.organizationId}`}
                style={{
                  padding: "0.4rem 0.8rem",
                  border: "1px solid currentColor",
                  borderRadius: 4,
                  textDecoration: "none",
                }}
                data-action="open-org"
                data-org-id={org.organizationId}
              >
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
