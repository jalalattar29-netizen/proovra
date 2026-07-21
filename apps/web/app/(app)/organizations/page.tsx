"use client";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

/**
 * Phase A.1B — Organizations & Workspace operational surface.
 *
 * This page is the canonical Org governance entry point.
 *
 * It consumes the Phase 2.7X Stage 3 endpoint `GET /v1/me/orgs` and
 * gives every authenticated user an operational grip on the
 * organizations they belong to:
 *
 *   - Compact enterprise card per org with role / status / member-
 *     since metadata.
 *   - Quick actions per card: Open (detail), Manage (detail), and the
 *     workspace-admin deep link for workspace-level operations.
 *   - Operational toolbar: create org (real, audited), accept invite
 *     by token (paste), cross-link to /teams (workspace administration)
 *     so the dual-surface relationship is explicit.
 *   - Honest empty state that explains the org vs workspace mental
 *     model and offers BOTH a create CTA and an accept-invite CTA.
 *
 * Hard rules (preserved from the original surface):
 *   - NO evidence / case / reviewer data exposure.
 *   - NO fake billing breakdown / fake governance scores. We surface
 *     what the canonical endpoints already own.
 *   - All CTAs are wired to real endpoints; no dead buttons.
 *
 * Discoverability:
 *   - The Phase A.1B navigation-registry change adds an "Organizations"
 *     entry to the topbar account menu (surface: ACCOUNT_MENU). The
 *     sidebar remains intentionally bounded per the CR0 sidebar
 *     contract.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { apiFetch } from "../../../lib/api";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { usePlatformContext } from "../../../lib/platform-context";
import { formatUserDate } from "../../../lib/date";

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
    // Phase A.1B Wave 2 — operational counts on the list endpoint.
    memberCount: number;
    workspaceCount: number;
    pendingInviteCount: number;
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

const ROLE_TONE: Record<OrgRole, string> = {
  ORG_OWNER: "rgba(99, 102, 241, 0.22)",
  ORG_ADMIN: "rgba(99, 102, 241, 0.16)",
  ORG_SECURITY_ADMIN: "rgba(239, 68, 68, 0.16)",
  ORG_BILLING_ADMIN: "rgba(245, 158, 11, 0.16)",
  ORG_AUDITOR: "rgba(34, 197, 94, 0.14)",
  ORG_MEMBER: "rgba(148, 163, 184, 0.18)",
};

const STATUS_TONE: Record<MeOrgsResponse["orgs"][number]["status"], string> = {
  ACTIVE: "rgba(34, 197, 94, 0.18)",
  SUSPENDED: "rgba(245, 158, 11, 0.22)",
  ARCHIVED: "rgba(148, 163, 184, 0.22)",
};

export default function OrganizationsListPage() {
  return (
    <PageRouteGate routeId="account.organizations">
      <OrganizationsListPageInner />
    </PageRouteGate>
  );
}

function OrganizationsListPageInner() {
  const router = useRouter();
  const { refresh } = usePlatformContext();

  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // Create-organization modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Accept-invite-by-token modal
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinToken, setJoinToken] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const data = (await apiFetch("/v1/me/orgs")) as MeOrgsResponse;
      setState({ kind: "ready", data });
    } catch (err: unknown) {
      const message =
        toSafeUserError(err, { message: "Failed to load organizations." }).message;
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
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const created = (await apiFetch("/v1/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      })) as { organizationId: string };
      setCreateOpen(false);
      setCreateName("");
      await load();
      if (created.organizationId) {
        router.push(`/organizations/${created.organizationId}`);
      }
    } catch (err: unknown) {
      const message =
        toSafeUserError(err, { message: "Failed to create organization." }).message;
      setCreateError(message);
    } finally {
      setCreateBusy(false);
    }
  }, [createName, load, router]);

  const submitJoin = useCallback(async () => {
    const token = joinToken.trim();
    if (!token) {
      setJoinError("Invite token is required.");
      return;
    }
    setJoinBusy(true);
    setJoinError(null);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const data = (await apiFetch(
        `/v1/org-invites/${encodeURIComponent(token)}/accept`,
        { method: "POST" },
      )) as { organizationId: string };
      setJoinOpen(false);
      setJoinToken("");
      await load();
      // Phase 5 (account-menu refactor, 2026-07-21) — refresh the canonical
      // platform-context envelope so the newly-joined organization appears in
      // the account-menu Workspace Switcher immediately. Personal Space
      // remains; the account is never merged or converted.
      void refresh();
      if (data.organizationId) {
        router.push(`/organizations/${data.organizationId}`);
      }
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const baseMsg =
        toSafeUserError(err, { message: "Failed to accept invite." }).message;
      const friendly =
        status === 410
          ? "This invite is expired, revoked, or already accepted."
          : status === 404
            ? "Invite not found — check the token."
            : baseMsg;
      setJoinError(friendly);
    } finally {
      setJoinBusy(false);
    }
  }, [joinToken, load, router, refresh]);

  const totalOrgs = state.kind === "ready" ? state.data.summary.totalOrgs : 0;

  return (
    <main
      className="org-list-surface"
      style={{ padding: "1.5rem", maxWidth: 980, margin: "0 auto" }}
      data-phase-a-1b-organizations-list
      data-total-orgs={totalOrgs}
    >
      {/* ---------- header / toolbar ---------- */}
      <header
        style={{
          marginBottom: "1.25rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 0.5, textTransform: "uppercase" }}>
            Account · Organizations
          </div>
          <h1 style={{ margin: "0.25rem 0 0.35rem" }}>Organizations</h1>
          <p style={{ margin: 0, opacity: 0.85, fontSize: 13.5, maxWidth: 640 }}>
            Organizations are the governance + billing tenant. Members,
            invites, and audit live here. Operational work — evidence,
            cases, reviewer queues — continues to live inside each{" "}
            <Link href="/workspaces" data-action="cross-link-workspace-admin">
              workspace
            </Link>
            .
          </p>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <button
            type="button"
            data-action="open-join-invite"
            onClick={() => {
              setJoinError(null);
              setJoinToken("");
              setJoinOpen(true);
            }}
            style={toolbarBtn(false)}
          >
            Accept invite token
          </button>
          <button
            type="button"
            data-action="open-create-org"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
            style={toolbarBtn(true)}
          >
            + Create organization
          </button>
        </div>
      </header>

      {/* ---------- create-org modal ---------- */}
      {createOpen && (
        <ModalShell
          onClose={() => !createBusy && setCreateOpen(false)}
          dataAttr="create-org"
        >
          <form
            data-form="create-org"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCreate();
            }}
            style={modalForm}
          >
            <h2 style={{ margin: "0 0 0.5rem" }}>Create organization</h2>
            <p style={{ fontSize: 13, opacity: 0.85, marginTop: 0 }}>
              You become the <strong>ORG_OWNER</strong>. You can rename,
              invite members, and add workspaces afterwards. This action
              is audited.
            </p>
            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
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
                style={modalInput}
              />
            </label>
            {createError && (
              <div
                role="alert"
                data-state="error"
                style={modalErrorBox}
              >
                {createError}
              </div>
            )}
            <div style={modalActions}>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                disabled={createBusy}
                data-action="cancel-create-org"
                style={toolbarBtn(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={createBusy || !createName.trim()}
                data-action="submit-create-org"
                style={toolbarBtn(true)}
              >
                {createBusy ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {/* ---------- accept-invite-token modal ---------- */}
      {joinOpen && (
        <ModalShell
          onClose={() => !joinBusy && setJoinOpen(false)}
          dataAttr="join-org"
        >
          <form
            data-form="join-org"
            onSubmit={(e) => {
              e.preventDefault();
              void submitJoin();
            }}
            style={modalForm}
          >
            <h2 style={{ margin: "0 0 0.5rem" }}>Accept invite token</h2>
            <p style={{ fontSize: 13, opacity: 0.85, marginTop: 0 }}>
              Paste the invite token an organization administrator
              shared with you. Accepting binds your account to the
              organization at the role chosen by the inviter. This does
              NOT grant you access to workspace evidence, cases, or
              reviewer queues — those remain workspace-scoped.
            </p>
            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              Invite token
              <input
                type="text"
                value={joinToken}
                onChange={(e) => setJoinToken(e.target.value)}
                required
                disabled={joinBusy}
                autoFocus
                data-input="join-org-token"
                style={modalInput}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            {joinError && (
              <div
                role="alert"
                data-state="error"
                style={modalErrorBox}
              >
                {joinError}
              </div>
            )}
            <div style={modalActions}>
              <button
                type="button"
                onClick={() => setJoinOpen(false)}
                disabled={joinBusy}
                data-action="cancel-join-org"
                style={toolbarBtn(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={joinBusy || !joinToken.trim()}
                data-action="submit-join-org"
                style={toolbarBtn(true)}
              >
                {joinBusy ? "Accepting…" : "Accept invite"}
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {/* ---------- list states ---------- */}
      {state.kind === "loading" && (
        <div data-state="loading" style={listLoadingStyle}>
          Loading organizations…
        </div>
      )}

      {state.kind === "error" && (
        <div data-state="error" role="alert" style={listErrorStyle}>
          <strong>Couldn’t load organizations.</strong>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {state.status ? `HTTP ${state.status}: ` : ""}
            {state.message}
          </div>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={() => void load()}
              data-action="retry-load-orgs"
              style={toolbarBtn(false)}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {state.kind === "ready" && state.data.summary.totalOrgs === 0 && (
        <div
          data-state="empty"
          style={listEmptyStyle}
        >
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            You’re not a member of any organization yet.
          </div>
          <ul style={{ margin: "0.6rem 0 0", paddingLeft: "1.1rem", fontSize: 13, opacity: 0.85 }}>
            <li>
              <strong>Create an organization</strong> to become its
              ORG_OWNER. You can then invite members and bind workspaces.
            </li>
            <li>
              <strong>Accept an invite token</strong> if an organization
              administrator shared one with you.
            </li>
            <li>
              For workspace-level operations (evidence, cases, reviewers),
              open <Link href="/workspaces" data-action="cross-link-workspace-admin">Workspace administration</Link>.
            </li>
          </ul>
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
              data-action="empty-create-org"
              style={toolbarBtn(true)}
            >
              + Create organization
            </button>
            <button
              type="button"
              onClick={() => {
                setJoinError(null);
                setJoinToken("");
                setJoinOpen(true);
              }}
              data-action="empty-join-org"
              style={toolbarBtn(false)}
            >
              Accept invite token
            </button>
          </div>
        </div>
      )}

      {state.kind === "ready" && state.data.summary.totalOrgs > 0 && (
        <ul
          data-state="ready"
          data-total-orgs={state.data.summary.totalOrgs}
          style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}
        >
          {state.data.orgs.map((org) => (
            <li
              key={org.organizationId}
              data-organization-id={org.organizationId}
              data-organization-role={org.role}
              data-organization-status={org.status}
              data-member-count={org.memberCount}
              data-workspace-count={org.workspaceCount}
              data-pending-invite-count={org.pendingInviteCount}
              style={cardStyle}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  minWidth: 0,
                  flex: "1 1 auto",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 15 }}>
                    {org.name}
                  </span>
                  <Pill tone={ROLE_TONE[org.role]} data-pill="role">
                    {ROLE_LABELS[org.role]}
                  </Pill>
                  <Pill tone={STATUS_TONE[org.status]} data-pill="status">
                    {org.status}
                  </Pill>
                  {org.pendingInviteCount > 0 && (
                    <Pill
                      tone="rgba(245, 158, 11, 0.22)"
                      data-pill="pending-invites"
                    >
                      {org.pendingInviteCount} pending
                    </Pill>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    flexWrap: "wrap",
                    fontSize: 12,
                    opacity: 0.85,
                  }}
                >
                  <span data-meta="members">
                    <strong>{org.memberCount}</strong>{" "}
                    {org.memberCount === 1 ? "member" : "members"}
                  </span>
                  <span data-meta="workspaces">
                    <strong>{org.workspaceCount}</strong>{" "}
                    {org.workspaceCount === 1 ? "workspace" : "workspaces"}
                  </span>
                  <span data-meta="member-since" style={{ opacity: 0.75 }}>
                    you joined{" "}
                    {formatUserDate(org.memberSince)}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Link
                  href={`/organizations/${org.organizationId}`}
                  style={cardLinkBtn(true)}
                  data-action="open-org"
                  data-org-id={org.organizationId}
                >
                  Open
                </Link>
                <Link
                  href={`/teams?org=${org.organizationId}`}
                  style={cardLinkBtn(false)}
                  data-action="open-workspace-admin"
                  data-org-id={org.organizationId}
                >
                  Workspace admin
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ---------- helper footer ---------- */}
      <footer
        style={{
          marginTop: 24,
          paddingTop: 12,
          borderTop: "1px solid rgba(127,127,127,0.18)",
          fontSize: 12,
          opacity: 0.75,
        }}
      >
        Looking for evidence, cases, reviewer queues, or per-workspace
        billing? Those are workspace-scoped. Open the relevant workspace
        from{" "}
        <Link href="/workspaces" data-action="footer-workspace-admin">
          Workspace administration
        </Link>
        .
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Small presentation helpers (inline; intentionally not pulled into a
// shared file because Phase A.1B is a surface pass, not a design-
// system extraction).
// ---------------------------------------------------------------------------

function ModalShell({
  onClose,
  children,
  dataAttr,
}: {
  onClose: () => void;
  children: React.ReactNode;
  dataAttr: string;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-modal={dataAttr}
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
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

function Pill({
  tone,
  children,
  ...rest
}: {
  tone: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
        padding: "1px 8px",
        borderRadius: 999,
        background: tone,
        border: "1px solid rgba(127,127,127,0.25)",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

function toolbarBtn(primary: boolean): React.CSSProperties {
  return {
    padding: "0.45rem 0.85rem",
    border: "1px solid currentColor",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: primary ? 600 : 500,
    background: primary ? "rgba(99,102,241,0.12)" : "transparent",
    color: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

function cardLinkBtn(primary: boolean): React.CSSProperties {
  return {
    padding: "0.35rem 0.7rem",
    border: "1px solid currentColor",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: primary ? 600 : 500,
    background: primary ? "rgba(99,102,241,0.12)" : "transparent",
    color: "inherit",
    textDecoration: "none",
    whiteSpace: "nowrap",
  };
}

const cardStyle: React.CSSProperties = {
  padding: "0.9rem 1rem",
  border: "1px solid rgba(127,127,127,0.3)",
  borderRadius: 8,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};

const listLoadingStyle: React.CSSProperties = {
  padding: "1rem",
  border: "1px dashed rgba(127,127,127,0.3)",
  borderRadius: 8,
  opacity: 0.75,
  fontSize: 13,
};

const listErrorStyle: React.CSSProperties = {
  padding: "1rem",
  border: "1px solid #d44",
  borderRadius: 8,
  background: "rgba(220,68,68,0.06)",
};

const listEmptyStyle: React.CSSProperties = {
  padding: "1.1rem",
  border: "1px dashed rgba(127,127,127,0.4)",
  borderRadius: 8,
  fontSize: 14,
};

const modalForm: React.CSSProperties = {
  background: "var(--bg, #fff)",
  color: "var(--fg, #000)",
  padding: "1.25rem",
  borderRadius: 8,
  minWidth: 380,
  maxWidth: 520,
  boxShadow: "0 10px 32px rgba(0,0,0,0.42)",
};

const modalInput: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "0.45rem 0.55rem",
  border: "1px solid currentColor",
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  fontSize: 13,
};

const modalErrorBox: React.CSSProperties = {
  marginTop: 8,
  padding: "0.45rem 0.6rem",
  border: "1px solid #d44",
  borderRadius: 4,
  fontSize: 13,
  background: "rgba(220,68,68,0.06)",
};

const modalActions: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 12,
};
