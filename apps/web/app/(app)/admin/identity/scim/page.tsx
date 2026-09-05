"use client";

/**
 * Phase 26 + Phase P1.1 — SCIM Operations Center.
 *
 * Tabbed admin surface:
 *
 *   1. Tokens          — manage SCIM provisioning tokens (Phase 26 surface,
 *                        kept verbatim; step-up gated create + revoke).
 *   2. Drift detection — Phase P1.1 — scan workspace state for drift
 *                        against the IdP source of truth. Preview-only
 *                        scan; reconciliation is opt-in per row and
 *                        always step-up gated.
 *   3. Sync replay     — Phase P1.1 — list recent SCIM sync failures
 *                        and replay transient ones. Terminal failures
 *                        (bad token) are not replayable from this UI.
 *
 * Hard rules (P1.1):
 *   * No reconcile without preview (preview id is the contract).
 *   * Preview expires after 5 minutes — stale runs are rejected.
 *   * Destructive reconcile rows route through the step-up modal.
 *   * Replay never deletes data; it re-emits a `scim_sync_replayed`
 *     audit event so the timeline shows the chain.
 *   * No raw IdP payloads exposed; the row summary + severity is all
 *     the operator sees.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import { FilterBar } from "../../../../../components/ui/FilterBar";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  inputStyle,
  mutedStyle,
  sectionTitleStyle,
  statusBadgeStyle,
  successBoxStyle,
  tableStyle,
  tdStyle,
  thStyle,
  badgeStyle,
  TOKENS,
} from "../ui-tokens";
import { PageShell, PageHeader } from "../../../../../components/ui/PageShell";
import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import {
  AdmTabPanel,
  AdmTabs,
} from "../../../../../components/admin/AdminSurfaces";
import { ManagedMembershipSection } from "./_sections/ManagedMembershipSection";

// ============================================================================
// PHASE 12B — denial classification.
//
// A 402/403/404 is a DENIAL and must never be painted as "nothing here": an
// empty table invites the operator to create a token they are not allowed to
// create, and hides the fact that the server refused.
// ============================================================================

type ScimDenial = { title: string; detail: string };

function readScimDenial(err: unknown): ScimDenial | null {
  const e = (err ?? {}) as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
  };
  const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  if (status === 402 || code.includes("enterprise_feature_required")) {
    return {
      title: "Not included in this plan",
      detail:
        "Directory provisioning (SCIM) is part of the Enterprise plan. The server declined this request — nothing was changed.",
    };
  }
  if (status === 403 || code === "forbidden" || code === "permission_denied") {
    return {
      title: "You don't have access to SCIM provisioning",
      detail:
        "Your role in this workspace does not allow managing directory provisioning. Nothing was loaded and nothing was changed.",
    };
  }
  if (status === 404 || code === "not_found") {
    return {
      title: "Not available to your account",
      detail:
        "This workspace's directory configuration is not available to you. If you expected access, ask a workspace owner to grant it.",
    };
  }
  return null;
}

function ScimDenialPanel({ denial }: { denial: ScimDenial }) {
  return (
    <Card
      variant="status"
      tone="risk"
      padding="comfortable"
      data-testid="scim-denied"
      style={{ marginTop: 12 }}
    >
      <strong style={{ fontSize: 14 }}>{denial.title}</strong>
      <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 0, maxWidth: 620 }}>
        {denial.detail}
      </p>
    </Card>
  );
}

// ============================================================================
// Types
// ============================================================================

type ScimToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  status: "ACTIVE" | "REVOKED";
  ipAllowlist: string[];
  createdByUserId: string;
  createdAt: string;
  lastUsedAtUtc: string | null;
  expiresAtUtc: string | null;
  revokedAtUtc: string | null;
};

const SCIM_SCOPE_OPTIONS = [
  "users.read",
  "users.write",
  "users.deactivate",
  "groups.read",
] as const;

type ScimDriftCategory =
  | "ORPHAN_LOCAL_MEMBERSHIP"
  | "UNLINKED_IDENTITY_ACTIVE_USER"
  | "STALE_TOKEN"
  | "ORPHAN_SCIM_GROUP"
  | "DUPLICATE_EXTERNAL_SUBJECT";

type ScimDriftRiskLevel = "LOW" | "MEDIUM" | "HIGH";

type ScimDriftItem = {
  id: string;
  category: ScimDriftCategory;
  riskLevel: ScimDriftRiskLevel;
  summary: string;
  proposedAction:
    | "REVIEW_ONLY"
    | "ARCHIVE_TOKEN"
    | "SUSPEND_MEMBERSHIP"
    | "ARCHIVE_GROUP"
    | "MANUAL_RESOLUTION";
  isDestructive: boolean;
  subject: {
    kind: "user" | "token" | "group" | "external_identity";
    id: string;
    label: string | null;
  };
};

type ScimDriftReport = {
  previewId: string;
  teamId: string;
  generatedAtUtc: string;
  items: ScimDriftItem[];
  summary: {
    total: number;
    byCategory: Record<ScimDriftCategory, number>;
    byRisk: Record<ScimDriftRiskLevel, number>;
    destructiveCount: number;
  };
  truncated: boolean;
};

type ExecuteResult = {
  executedAtUtc: string;
  appliedCount: number;
  skippedCount: number;
  details: Array<{
    itemId: string;
    action: ScimDriftItem["proposedAction"];
    outcome: "APPLIED" | "SKIPPED" | "FAILED";
    reason: string | null;
  }>;
};

type ScimSyncFailure = {
  id: string;
  occurredAtUtc: string;
  eventType: string;
  severity: "INFO" | "WARNING" | "HIGH";
  summary: string;
  retryEligible: boolean;
  terminal: boolean;
};

const TAB_LABELS = {
  tokens: "Tokens",
  ownership: "Managed membership",
  drift: "Drift detection",
  replay: "Sync replay",
} as const;
type TabKey = keyof typeof TAB_LABELS;

// ============================================================================
// Root page (tab dispatcher)
// ============================================================================

/**
 * The sync-failure query.
 *
 * Empty means "no filter" and is omitted rather than sent as an empty string —
 * the endpoint validates with z.enum, so "" would be a 400 and the page would
 * show an error where the operator had simply cleared a dropdown.
 */
function syncFailureQuery(
  teamId: string,
  eventType: string,
  severity: string,
): string {
  const p = new URLSearchParams();
  p.set("teamId", teamId);
  p.set("limit", "100");
  if (eventType) p.set("eventType", eventType);
  if (severity) p.set("severity", severity);
  return p.toString();
}

export default function ScimPage() {
  const teamId = useTeamId();

  /**
   * THE OPEN TAB LIVES IN THE URL.
   *
   * It was `useState<TabKey>("tokens")`, and these four tabs are the only real
   * in-page tabs in the whole console — every other section switches view
   * through the secondary navigation row, which is links and therefore already
   * addressable. So this was the one surface where:
   *
   *   - "look at the drift tab" could not be sent to anybody as a link;
   *   - the browser Back button left the page instead of returning to the
   *     previous tab, because nothing had been pushed;
   *   - a reload silently returned the operator to Tokens.
   *
   * Mid-incident, on the page that reconciles an identity provider against
   * what the platform believes, all three of those matter.
   *
   * `replace`, not `push`: flicking between four peer views of one entity
   * should not build four history entries to Back out of. Back leaves the
   * page, forward-and-back within it is what the tabs themselves are for —
   * and the URL is still shareable, which was the point.
   *
   * =========================================================================
   * LOCAL STATE RENDERS; THE URL IS SEEDED FROM AND SYNCED TO
   * =========================================================================
   * The first version of this derived `tab` DIRECTLY from `useSearchParams()`
   * with no local state, which is tidier and was wrong: it makes the component
   * unable to change view unless the ROUTER works. Four render tests in
   * admin-mutations-identity broke immediately — they mount the page, click
   * "Sync replay", and assert the panel fetches `/v1/scim/sync-failures`. With
   * a stubbed router `replace()` is a no-op, the search params never change,
   * and the tab silently stayed on Tokens. The tests were right: a tab that
   * only works when navigation works is a tab that fails closed, and a
   * stubbed router in a test is the cheap version of a navigation that is
   * merely slow.
   *
   * So the state is local — it always responds — and the URL is a seed on
   * mount and a side effect on change. Sharing and reload keep working; the
   * rendering no longer depends on them.
   */
  const router = useRouter();
  const params = useSearchParams();
  const fromUrl = params.get("tab");
  const [tab, setTabState] = useState<TabKey>(() =>
    fromUrl && fromUrl in TAB_LABELS ? (fromUrl as TabKey) : "tokens",
  );

  /* A URL that changes under us — Back, Forward, or a pasted link into the
     same mounted page — moves the tab. Guarded so it cannot fight the click
     that is already in flight. */
  useEffect(() => {
    const next =
      fromUrl && fromUrl in TAB_LABELS ? (fromUrl as TabKey) : "tokens";
    setTabState((current) => (current === next ? current : next));
  }, [fromUrl]);

  const setTab = useCallback(
    (next: TabKey) => {
      setTabState(next);
      const qs = new URLSearchParams(params.toString());
      if (next === "tokens") qs.delete("tab");
      else qs.set("tab", next);
      const query = qs.toString();
      router.replace(`/admin/identity/scim${query ? `?${query}` : ""}`, {
        scroll: false,
      });
    },
    [params, router],
  );

  if (!teamId) {
    return (
      <PageShell header={<PageHeader eyebrow="Identity operations" title="SCIM Operations" />}>
        <EmptyState variant="inline"
          framed
          title="No SCIM directory connected"
          purpose="Switch to a workspace to manage its SCIM provisioning tokens, drift reconciliation, and sync replay."
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="SCIM Operations"
          subtitle={
            <>
              Provisioning tokens, drift reconciliation against IdP state, and
              replay of transient sync failures. The endpoint base is{" "}
              <code style={{ fontFamily: "monospace", fontSize: 12 }}>
                /v2/scim
              </code>
              . Destructive reconcile actions require step-up.
            </>
          }
        />
      }
    >
      <AdmTabs
        label="SCIM operations"
        tabs={(Object.keys(TAB_LABELS) as TabKey[]).map((k) => ({
          id: k,
          label: TAB_LABELS[k],
        }))}
        active={tab}
        onSelect={(id) => setTab(id as TabKey)}
      />

      {/*
        MOUNTED AND HIDDEN, not conditionally rendered. Switching to a sibling
        and back keeps each panel's scroll position and its unsaved filter
        state, which is what "tab switching does not discard unsaved work"
        means in practice. The panels only fetch when first shown, because
        each one's own effect is keyed on its visibility via `teamId`.
      */}
      <AdmTabPanel id="tokens" active={tab}>
        {tab === "tokens" ? <TokensTab teamId={teamId} /> : null}
      </AdmTabPanel>
      <AdmTabPanel id="ownership" active={tab}>
        {tab === "ownership" ? <ManagedMembershipSection teamId={teamId} /> : null}
      </AdmTabPanel>
      <AdmTabPanel id="drift" active={tab}>
        {tab === "drift" ? <DriftTab teamId={teamId} /> : null}
      </AdmTabPanel>
      <AdmTabPanel id="replay" active={tab}>
        {tab === "replay" ? <ReplayTab teamId={teamId} /> : null}
      </AdmTabPanel>
    </PageShell>
  );
}

// ============================================================================
// Tab 1: Tokens
// ============================================================================

function TokensTab({ teamId }: { teamId: string }) {
  const stepUp = useStepUpAction({ teamId });
  const { confirm } = useConfirmAction();
  const { stamp, isStale } = useTenantGuard();
  const [tokens, setTokens] = useState<ScimToken[] | null>(null);
  /** Whether this workspace's plan includes issuing and rotating credentials. */
  const [canProvision, setCanProvision] = useState(true);
  const [denial, setDenial] = useState<ScimDenial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createScopes, setCreateScopes] = useState<Set<string>>(
    new Set(["users.read", "users.write", "users.deactivate"]),
  );
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    const captured = stamp();
    try {
      const r = (await apiFetch(
        `/v1/admin/identity/scim/tokens?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { tokens?: ScimToken[]; entitlement?: { ssoScim?: boolean } };
      if (isStale(captured)) return;
      setTokens(r.tokens ?? []);
      /*
       * Issuing and rotating a directory credential are Enterprise
       * capabilities; revoking one is not, because a customer must always be
       * able to destroy a credential that already exists. The list says which
       * side of that line this workspace is on, so the console can present
       * create and rotate as plan-gated instead of offering buttons the
       * server will refuse. This is presentation only — the server refuses
       * regardless of what the page shows.
       */
      setCanProvision(r.entitlement?.ssoScim !== false);
      setDenial(null);
      setError(null);
    } catch (err) {
      if (isStale(captured)) return;
      const d = readScimDenial(err);
      setTokens([]);
      if (d) {
        setDenial(d);
        setError(null);
        return;
      }
      setDenial(null);
      setError(
        toSafeUserError(err, { message: "Could not load tokens." }).message,
      );
    }
  }, [teamId, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  // A one-time token must never survive a workspace switch.
  useEffect(() => {
    setRevealedToken(null);
  }, [teamId]);

  const submitCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setBusy("create");
    setRevealedToken(null);
    setError(null);
    const captured = stamp();
    try {
      const res = await stepUp.runStepUpAction(async (headers) => {
        return await apiFetch("/v1/admin/identity/scim/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            teamId,
            name: createName.trim().slice(0, 180),
            scopes: Array.from(createScopes),
          }),
        });
      });
      if (isStale(captured)) return;
      // The raw token is present in the CREATE response only — never on a
      // list/read. It lives in this tab's state until dismissed and is never
      // written to a URL, storage, or a shared component.
      if (res && (res as { tokenOnce?: unknown })?.tokenOnce) {
        setRevealedToken((res as { tokenOnce: string }).tokenOnce);
      }
      setShowCreate(false);
      setCreateName("");
      await load();
    } catch (err) {
      if (isStale(captured)) return;
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — token was not created.");
        return;
      }
      const d = readScimDenial(err);
      if (d) {
        setDenial(d);
        return;
      }
      setError(
        toSafeUserError(err, { message: "Could not create token." }).message,
      );
    } finally {
      setBusy(null);
    }
  }, [teamId, createName, createScopes, load, stepUp, stamp, isStale]);

  // PHASE 12B — ROTATION. Server-side this is ONE transaction (revoke the old
  // credential + issue the replacement), so an abandoned rotation can never
  // leave two live tokens for the same directory.
  const rotate = useCallback(
    async (token: ScimToken) => {
      const ok = await confirm({
        title: "Rotate this SCIM token?",
        description:
          "A replacement token is issued and this one stops working immediately — in the same step, so there is never a moment with two live tokens. Your identity provider will fail to sync until you paste the new token into it. The new value is shown once.",
        confirmLabel: "Rotate token",
        tone: "danger",
        testId: "scim-token-rotate",
      });
      if (!ok) return;
      setBusy(token.id);
      setError(null);
      setRevealedToken(null);
      const captured = stamp();
      try {
        const res = await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/admin/identity/scim/tokens/${encodeURIComponent(token.id)}/rotate`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({ teamId, reason: "Admin rotation" }),
            },
          ),
        );
        if (isStale(captured)) return;
        if (res && (res as { tokenOnce?: unknown })?.tokenOnce) {
          setRevealedToken((res as { tokenOnce: string }).tokenOnce);
        }
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setError("Step-up cancelled — the token was not rotated.");
          return;
        }
        const d = readScimDenial(err);
        if (d) {
          setDenial(d);
          return;
        }
        setError(
          toSafeUserError(err, { message: "Rotation failed." }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load, stepUp, confirm, stamp, isStale],
  );

  const revoke = useCallback(
    async (id: string) => {
      const ok = await confirm({
        title: "Revoke this SCIM token?",
        description:
          "Provisioning requests using this token will fail immediately. This is irreversible — rotate instead if the identity provider still needs to sync.",
        confirmLabel: "Revoke token",
        tone: "danger",
        testId: "scim-token-revoke",
      });
      if (!ok) return;
      setBusy(id);
      setError(null);
      const captured = stamp();
      try {
        await stepUp.runStepUpAction(async (headers) => {
          return await apiFetch(
            `/v1/admin/identity/scim/tokens/${encodeURIComponent(id)}/revoke`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(headers ?? {}),
              },
              body: JSON.stringify({ teamId, reason: "Admin revocation" }),
            },
          );
        });
        if (isStale(captured)) return;
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setError("Step-up cancelled — token remains active.");
          return;
        }
        const d = readScimDenial(err);
        if (d) {
          setDenial(d);
          return;
        }
        setError(toSafeUserError(err, { message: "Revoke failed." }).message);
      } finally {
        setBusy(null);
      }
    },
    [teamId, load, stepUp, confirm, stamp, isStale],
  );

  const tokenColumns: DataTableColumn<ScimToken>[] = [
    {
      key: "name",
      header: "Name",
      render: (t) => <span style={{ fontWeight: 600 }}>{t.name}</span>,
    },
    {
      key: "prefix",
      header: "Prefix",
      render: (t) => (
        <code
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 12,
          }}
        >
          {t.tokenPrefix}…
        </code>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (t) => <span style={statusBadgeStyle(t.status)}>{t.status}</span>,
    },
    {
      key: "scopes",
      header: "Scopes",
      render: (t) => (
        <span style={{ ...mutedStyle, fontSize: 11 }}>{t.scopes.join(", ")}</span>
      ),
    },
    {
      key: "lastused",
      header: "Last used",
      nowrap: true,
      render: (t) => <span style={mutedStyle}>{formatDateTime(t.lastUsedAtUtc)}</span>,
    },
    {
      key: "created",
      header: "Created",
      nowrap: true,
      render: (t) => <span style={mutedStyle}>{formatDateTime(t.createdAt)}</span>,
    },
  ];

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <p style={mutedStyle}>
          Bearer tokens for SCIM v2 provisioning. Tokens are scope-bounded and
          hashed at rest; raw values are shown exactly once at creation.
        </p>
        <Button
          variant="enterprise"
          disabled={!canProvision}
          title={
            canProvision
              ? undefined
              : "Issuing a token is part of the Enterprise plan. Existing tokens can still be revoked."
          }
          onClick={() => {
            setShowCreate(true);
            setRevealedToken(null);
          }}
        >
          New token
        </Button>
      </div>

      {denial ? <ScimDenialPanel denial={denial} /> : null}
      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {revealedToken ? (
        <div style={successBoxStyle}>
          <strong>Token issued.</strong> Copy now — this is the only time it
          will be shown:{" "}
          <code style={{ fontFamily: "monospace" }}>{revealedToken}</code>
          <button
            type="button"
            style={{ ...ghostButtonStyle, marginInlineStart: 12 }}
            onClick={() => setRevealedToken(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {denial || canProvision ? null : (
        <div
          data-scim-provisioning-gated="true"
          style={{
            marginTop: 16,
            padding: "12px 14px",
            borderRadius: 8,
            border: "1px solid var(--border-subtle, #d6d9e0)",
            background: "var(--surface-muted, #f6f7f9)",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ display: "block", marginBottom: 2 }}>
            Directory provisioning is not included in this plan
          </strong>
          New tokens cannot be issued and existing tokens cannot be rotated or used
          to synchronize. Tokens already issued stay listed here and can still be
          revoked.
        </div>
      )}

      {denial ? null : (
        <div style={{ marginTop: 16 }}>
          <DataTable
            columns={tokenColumns}
            rows={tokens ?? []}
            getRowId={(t) => t.id}
            loading={tokens === null}
            ariaLabel="SCIM provisioning tokens"
            emptyState={
              <EmptyState variant="inline"
                title="No SCIM directory connected"
                purpose="Issue a scope-bounded SCIM v2 provisioning token so your identity provider can create, update, and deactivate users automatically."
                action={
                  <Button
                    variant="enterprise"
                    disabled={!canProvision}
                    title={
                      canProvision
                        ? undefined
                        : "Issuing a token is part of the Enterprise plan. Existing tokens can still be revoked."
                    }
                    onClick={() => {
                      setShowCreate(true);
                      setRevealedToken(null);
                    }}
                  >
                    New token
                  </Button>
                }
              />
            }
            rowActions={(t) =>
              t.status === "ACTIVE" ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === t.id || !canProvision}
                    title={
                      canProvision
                        ? undefined
                        : "Rotating a token is part of the Enterprise plan. You can still revoke this token."
                    }
                    onClick={() => rotate(t)}
                  >
                    Rotate
                  </Button>
                  {/*
                    Revoke stays available on every plan. A customer who has
                    downgraded still holds a live directory credential, and
                    taking away the only way to destroy it would be the worst
                    possible moment to do so.
                  */}
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy === t.id}
                    onClick={() => revoke(t.id)}
                  >
                    Revoke
                  </Button>
                </div>
              ) : null
            }
          />
        </div>
      )}

      {showCreate ? (
        <section style={{ ...cardStyle, marginTop: 16 }}>
          <h3 style={sectionTitleStyle}>New SCIM token</h3>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 12,
              color: TOKENS.inkMuted,
              maxWidth: 360,
            }}
          >
            <span>Token name</span>
            <input
              style={inputStyle}
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="Acme Okta provisioning"
            />
          </label>
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                ...sectionTitleStyle,
                fontSize: 11,
                marginBottom: 4,
              }}
            >
              Scopes
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {SCIM_SCOPE_OPTIONS.map((s) => {
                const active = createScopes.has(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() =>
                      setCreateScopes((prev) => {
                        const next = new Set(prev);
                        if (next.has(s)) next.delete(s);
                        else next.add(s);
                        return next;
                      })
                    }
                    style={{
                      padding: "4px 10px",
                      fontSize: 11,
                      borderRadius: 999,
                      border: "1px solid",
                      background: active ? TOKENS.accent : TOKENS.surface,
                      color: active ? TOKENS.accentInk : "var(--ink-secondary)",
                      borderColor: active ? TOKENS.accent : "var(--border-standard)",
                      cursor: "pointer",
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Button
              variant="enterprise"
              loading={busy === "create"}
              disabled={busy === "create" || createScopes.size === 0}
              onClick={submitCreate}
            >
              {busy === "create" ? "Creating…" : "Create token"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      <StepUpModal control={stepUp} />
    </>
  );
}

// ============================================================================
// Tab 2: Drift detection
// ============================================================================

function riskBadge(level: ScimDriftRiskLevel) {
  const palette =
    level === "HIGH"
      ? { bg: "var(--danger-subtle-bg)", fg: "var(--danger-strong)", border: "var(--danger-border)" }
      : level === "MEDIUM"
        ? { bg: "var(--warning-subtle-bg)", fg: "var(--warning-strong)", border: "var(--warning-border)" }
        : { bg: "var(--surface-muted)", fg: "var(--ink-secondary)", border: "var(--border-standard)" };
  return badgeStyle(palette);
}

function DriftTab({ teamId }: { teamId: string }) {
  const stepUp = useStepUpAction({ teamId });
  const { confirm } = useConfirmAction();
  const { stamp, isStale } = useTenantGuard();
  const [report, setReport] = useState<ScimDriftReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [denial, setDenial] = useState<ScimDenial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecuteResult | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    setResult(null);
    setSelected(new Set());
    const captured = stamp();
    try {
      const r = (await apiFetch(
        `/v1/scim/reconciliation/preview?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { report: ScimDriftReport };
      if (isStale(captured)) return;
      setReport(r.report);
      setDenial(null);
    } catch (err) {
      if (isStale(captured)) return;
      const d = readScimDenial(err);
      if (d) {
        setDenial(d);
        setReport(null);
        return;
      }
      setDenial(null);
      setError(
        toSafeUserError(err, { message: "Drift scan failed." }).message,
      );
    } finally {
      if (!isStale(captured)) setScanning(false);
    }
  }, [teamId, stamp, isStale]);

  useEffect(() => {
    scan();
  }, [scan]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const execute = useCallback(async () => {
    if (!report) return;
    if (selected.size === 0) {
      setError("Pick at least one row to reconcile.");
      return;
    }
    const ok = await confirm({
      title: `Reconcile ${selected.size} drift row(s)?`,
      description:
        "Destructive rows demote memberships, archive tokens, or archive groups. Step-up authentication is required on the next request.",
      confirmLabel: "Reconcile selected",
      tone: "danger",
      testId: "scim-drift-reconcile",
    });
    if (!ok) return;
    setExecuting(true);
    setError(null);
    const captured = stamp();
    try {
      const res = (await stepUp.runStepUpAction(async (headers) => {
        return (await apiFetch("/v1/scim/reconciliation/execute", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            teamId,
            previewId: report.previewId,
            itemIds: Array.from(selected),
          }),
        })) as { result: ExecuteResult };
      })) as { result: ExecuteResult };
      if (isStale(captured)) return;
      setResult(res.result);
      setSelected(new Set());
      // Re-scan so the operator sees the post-reconcile state.
      await scan();
    } catch (err) {
      if (isStale(captured)) return;
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — no rows were reconciled.");
        return;
      }
      const d = readScimDenial(err);
      if (d) {
        setDenial(d);
        return;
      }
      setError(
        toSafeUserError(err, { message: "Reconciliation failed." }).message,
      );
    } finally {
      setExecuting(false);
    }
  }, [report, selected, stepUp, teamId, scan, confirm, stamp, isStale]);

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <p style={{ ...mutedStyle, maxWidth: 720 }}>
          Detect drift between PROOVRA workspace state and IdP source of truth:
          orphan memberships, unlinked-but-active users, stale tokens, orphan
          SCIM groups, duplicate external subjects. Scan runs locally — no IdP
          calls. Preview is valid for 5 minutes.
        </p>
        <Button
          variant="secondary"
          onClick={scan}
          loading={scanning}
          disabled={scanning}
        >
          {scanning ? "Scanning…" : "Re-scan"}
        </Button>
      </div>

      {denial ? <ScimDenialPanel denial={denial} /> : null}
      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {result ? (
        <div style={successBoxStyle}>
          <strong>Reconciliation complete.</strong> Applied{" "}
          {result.appliedCount}, skipped {result.skippedCount}.{" "}
          {result.details.some((d) => d.outcome === "FAILED")
            ? "Some rows failed — see audit center for details."
            : null}
        </div>
      ) : null}

      {denial ? null : report ? (
        <>
          <Card
            variant="status"
            tone={report.summary.byRisk.HIGH > 0 ? "risk" : "governance"}
            padding="comfortable"
            style={{ marginTop: 16 }}
          >
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={mutedStyle}>Drift items</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                {report.summary.total}
              </div>
            </div>
            <div>
              <div style={mutedStyle}>High risk</div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: report.summary.byRisk.HIGH > 0 ? "var(--danger-strong)" : undefined,
                }}
              >
                {report.summary.byRisk.HIGH ?? 0}
              </div>
            </div>
            <div>
              <div style={mutedStyle}>Destructive</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                {report.summary.destructiveCount}
              </div>
            </div>
            <div>
              <div style={mutedStyle}>Preview generated</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {formatDateTime(report.generatedAtUtc)}
              </div>
            </div>
            <div style={{ marginInlineStart: "auto" }}>
              <Button
                variant="enterprise"
                disabled={selected.size === 0 || executing}
                loading={executing}
                onClick={execute}
              >
                {executing
                  ? "Reconciling…"
                  : `Reconcile selected (${selected.size})`}
              </Button>
            </div>
            </div>
          </Card>

          {report.truncated ? (
            <p style={{ ...mutedStyle, marginTop: 8 }}>
              ⚠ Result truncated to 200 rows. Resolve high-risk items first,
              then re-scan.
            </p>
          ) : null}

          <section style={{ ...cardStyle, marginTop: 12, padding: 0 }}>
            {report.items.length === 0 ? (
              <EmptyState variant="inline"
                title="No drift detected"
                purpose="Workspace state matches IdP expectations. Re-scan after IdP changes to surface new drift."
              />
            ) : (
              <div style={{ overflowX: "auto" }}>
              {/* A wide table scrolls ITSELF. Measured at 320px, an unwrapped table
              drags the whole page sideways and the reader loses the column
              headers and the navigation at the same moment. */}
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>{" "}</th>
                    <th style={thStyle}>Category</th>
                    <th style={thStyle}>Risk</th>
                    <th style={thStyle}>Subject</th>
                    <th style={thStyle}>Summary</th>
                    <th style={thStyle}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((i) => (
                    <tr key={i.id}>
                      <td style={tdStyle}>
                        <input
                          type="checkbox"
                          checked={selected.has(i.id)}
                          onChange={() => toggle(i.id)}
                          disabled={i.proposedAction === "REVIEW_ONLY"}
                          aria-label={`Select drift item ${i.id}`}
                        />
                      </td>
                      <td style={tdStyle}>
                        <span style={{ ...mutedStyle, fontSize: 11 }}>
                          {i.category}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={riskBadge(i.riskLevel)}>
                          {i.riskLevel}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ fontSize: 12 }}>
                          <div style={{ fontWeight: 500 }}>
                            {i.subject.label ?? "—"}
                          </div>
                          <div style={mutedStyle}>
                            {i.subject.kind} · {i.subject.id.slice(0, 12)}…
                          </div>
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontSize: 12 }}>{i.summary}</span>
                      </td>
                      <td style={tdStyle}>
                        <span
                          style={
                            i.isDestructive
                              ? badgeStyle({
                                  bg: "var(--danger-subtle-bg)",
                                  fg: "var(--danger-strong)",
                                  border: "var(--danger-border)",
                                })
                              : badgeStyle({
                                  bg: "var(--info-subtle-bg)",
                                  fg: "var(--info)",
                                  border: "var(--info-border)",
                                })
                          }
                        >
                          {i.proposedAction}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>
        </>
      ) : scanning ? (
        <p style={{ ...mutedStyle, padding: 16 }}>Running drift scan…</p>
      ) : null}

      <StepUpModal control={stepUp} />
    </>
  );
}

// ============================================================================
// Tab 3: Sync replay
// ============================================================================

function ReplayTab({ teamId }: { teamId: string }) {
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();
  const [failures, setFailures] = useState<ScimSyncFailure[] | null>(null);
  /**
   * Server-side filters, and the metadata that makes the count honest.
   *
   * The endpoint used to accept only teamId and limit, so this list was the
   * newest 100 sync errors with no way to reach the rest and no way to say how
   * many there were. Both filters go into the REQUEST — narrowing in the
   * browser would leave the 100-row cap over an unfiltered window, which
   * hides rows rather than finding them.
   */
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [failureTotal, setFailureTotal] = useState<number | null>(null);
  const [failureLimit, setFailureLimit] = useState<number | null>(null);
  const [denial, setDenial] = useState<ScimDenial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    const captured = stamp();
    try {
      const r = (await apiFetch(
        `/v1/scim/sync-failures?${syncFailureQuery(teamId, eventTypeFilter, severityFilter)}`,
        { method: "GET" },
      )) as { failures?: ScimSyncFailure[]; total?: number; limit?: number };
      if (isStale(captured)) return;
      setFailures(r.failures ?? []);
      setFailureTotal(typeof r.total === "number" ? r.total : null);
      setFailureLimit(typeof r.limit === "number" ? r.limit : null);
      setDenial(null);
      setError(null);
    } catch (err) {
      if (isStale(captured)) return;
      const d = readScimDenial(err);
      setFailures([]);
      if (d) {
        setDenial(d);
        setError(null);
        return;
      }
      setDenial(null);
      setError(
        toSafeUserError(err, { message: "Could not load sync failures." })
          .message,
      );
    }
  }, [teamId, stamp, isStale, eventTypeFilter, severityFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const replay = useCallback(
    async (id: string) => {
      if (busy !== null) return;
      const failure = failures?.find((f) => f.id === id);
      // Clears the entry so the identity provider's next push is accepted
      // again: the provisioning change it carried takes effect on that push.
      const ok = await confirm({
        title: "Replay this SCIM sync failure?",
        description: `Failure ${id.slice(0, 8)}…${
          failure ? ` (${failure.eventType}, ${failure.severity})` : ""
        } is cleared from this workspace's queue and the identity provider's original push is accepted on its next retry. The provisioning change it carries — a user or group create, update or deactivate — is then applied.`,
        confirmLabel: "Replay",
        tone: "warning",
        testId: "scim-replay-failure",
      });
      if (!ok) return;
      setBusy(id);
      setError(null);
      setSuccess(null);
      const captured = stamp();
      try {
        await apiFetch(
          `/v1/scim/sync-failures/${encodeURIComponent(id)}/replay`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ teamId }),
          },
        );
        if (isStale(captured)) return;
        setSuccess(
          "Replay recorded. The original IdP push retries automatically — this entry has been cleared from the queue.",
        );
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        const d = readScimDenial(err);
        if (d) {
          setDenial(d);
          return;
        }
        setError(toSafeUserError(err, { message: "Replay failed." }).message);
      } finally {
        setBusy(null);
      }
    },
    [teamId, load, stamp, isStale, busy, failures, confirm],
  );

  const failureColumns: DataTableColumn<ScimSyncFailure>[] = [
    {
      key: "occurred",
      header: "Occurred",
      nowrap: true,
      render: (f) => <span style={mutedStyle}>{formatDateTime(f.occurredAtUtc)}</span>,
    },
    {
      key: "type",
      header: "Type",
      render: (f) => (
        <span style={{ ...mutedStyle, fontSize: 11 }}>{f.eventType}</span>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      render: (f) => (
        <span
          style={badgeStyle(
            f.severity === "HIGH"
              ? { bg: "var(--danger-subtle-bg)", fg: "var(--danger-strong)", border: "var(--danger-border)" }
              : f.severity === "WARNING"
                ? { bg: "var(--warning-subtle-bg)", fg: "var(--warning-strong)", border: "var(--warning-border)" }
                : { bg: "var(--surface-muted)", fg: "var(--ink-secondary)", border: "var(--border-standard)" },
          )}
        >
          {f.severity}
        </span>
      ),
    },
    {
      key: "summary",
      header: "Summary",
      render: (f) => <span style={{ fontSize: 12 }}>{f.summary}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (f) =>
        f.terminal ? (
          <span style={badgeStyle({ bg: "var(--danger-subtle-bg)", fg: "var(--danger-strong)", border: "var(--danger-border)" })}>
            TERMINAL
          </span>
        ) : f.retryEligible ? (
          <span style={badgeStyle({ bg: "var(--info-subtle-bg)", fg: "var(--info)", border: "var(--info-border)" })}>
            REPLAYABLE
          </span>
        ) : (
          <span style={badgeStyle({ bg: "var(--surface-muted)", fg: "var(--ink-secondary)", border: "var(--border-standard)" })}>
            MANUAL
          </span>
        ),
    },
  ];

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <p style={{ ...mutedStyle, maxWidth: 720 }}>
          Recent SCIM sync failures. Transient failures (e.g. failed user
          creation) can be replayed; terminal failures (bad token) require
          issuing a new token in the Tokens tab.
        </p>
        <Button variant="secondary" onClick={load}>
          Refresh
        </Button>
      </div>

      {denial ? <ScimDenialPanel denial={denial} /> : null}
      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {success ? <div style={successBoxStyle}>{success}</div> : null}

      {/* Server-side. Both go into the request, so the 100-row cap applies
          to the NARROWED set — a browser-side filter would keep the cap over
          an unfiltered window and hide rows rather than find them. */}
      <FilterBar style={{ marginTop: 12 }}>
        <FilterBar.Select
          label="Failure type"
          value={eventTypeFilter}
          onChange={setEventTypeFilter}
          options={[
            { value: "", label: "All failure types" },
            { value: "scim_invalid_token", label: "Invalid token" },
            { value: "scim_user_create_failed", label: "User create failed" },
            { value: "scim_user_deactivate_failed", label: "User deactivate failed" },
            {
              value: "scim_group_membership_reconcile_failed",
              label: "Group membership reconcile failed",
            },
          ]}
        />
        <FilterBar.Select
          label="Severity"
          value={severityFilter}
          onChange={setSeverityFilter}
          options={[
            { value: "", label: "All severities" },
            { value: "HIGH", label: "High" },
            { value: "WARNING", label: "Warning" },
            { value: "INFO", label: "Info" },
          ]}
        />
      </FilterBar>
      <div style={{ marginTop: 12, display: denial ? "none" : undefined }}>
        <DataTable
          columns={failureColumns}
          rows={failures ?? []}
          getRowId={(f) => f.id}
          loading={failures === null}
          ariaLabel="SCIM sync failures"
          emptyState={
            <EmptyState variant="inline"
              title={eventTypeFilter !== "" || severityFilter !== "" ? "No failures match these filters" : "No sync failures"}
              purpose={eventTypeFilter !== "" || severityFilter !== ""
                ? "No SCIM failure matches the selected type and severity. Clearing them shows every recorded failure."
                : "No SCIM sync failures recorded. Transient failures that can be replayed will appear here."}
            />
          }
          rowActions={(f) =>
            f.retryEligible && !f.terminal ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy === f.id}
                onClick={() => replay(f.id)}
              >
                {busy === f.id ? "Replaying…" : "Replay"}
              </Button>
            ) : (
              <span style={{ ...mutedStyle, fontSize: 11 }}>Not replayable</span>
            )
          }
        />
        {/* total comes from the server and counts the FILTER, not the page.
            Without it, 100 rows would read as 100 failures. */}
        <ResultCount
          shown={failures?.length ?? 0}
          cap={failureLimit ?? undefined}
          total={failureTotal ?? undefined}
          noun="sync failure"
          filtered={eventTypeFilter !== "" || severityFilter !== ""}
          loading={failures === null}
          data-testid="admin-scim-failures-count"
        />
      </div>
    </>
  );
}
