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

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  inputStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  sectionTitleStyle,
  statusBadgeStyle,
  subtitleStyle,
  successBoxStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  badgeStyle,
  TOKENS,
} from "../ui-tokens";

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
  drift: "Drift detection",
  replay: "Sync replay",
} as const;
type TabKey = keyof typeof TAB_LABELS;

// ============================================================================
// Root page (tab dispatcher)
// ============================================================================

export default function ScimPage() {
  const teamId = useTeamId();
  const [tab, setTab] = useState<TabKey>("tokens");

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
          <h1 style={titleStyle}>SCIM Operations</h1>
          <p style={subtitleStyle}>
            Provisioning tokens, drift reconciliation against IdP state, and
            replay of transient sync failures. The endpoint base is{" "}
            <code style={{ fontFamily: "monospace", fontSize: 12 }}>
              /v2/scim
            </code>
            . Destructive reconcile actions require step-up.
          </p>
        </div>
      </header>

      <nav
        style={{
          display: "flex",
          gap: 4,
          marginTop: 12,
          marginBottom: 12,
          borderBottom: `1px solid ${TOKENS.border}`,
        }}
        aria-label="SCIM Operations tabs"
        role="tablist"
      >
        {(Object.keys(TAB_LABELS) as TabKey[]).map((k) => {
          const active = tab === k;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(k)}
              style={{
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: 600,
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${
                  active ? TOKENS.accent : "transparent"
                }`,
                color: active ? TOKENS.ink : TOKENS.inkSubtle,
                cursor: "pointer",
                marginBottom: -1,
              }}
            >
              {TAB_LABELS[k]}
            </button>
          );
        })}
      </nav>

      {tab === "tokens" ? <TokensTab teamId={teamId} /> : null}
      {tab === "drift" ? <DriftTab teamId={teamId} /> : null}
      {tab === "replay" ? <ReplayTab teamId={teamId} /> : null}
    </main>
  );
}

// ============================================================================
// Tab 1: Tokens
// ============================================================================

function TokensTab({ teamId }: { teamId: string }) {
  const stepUp = useStepUpAction({ teamId });
  const { confirm } = useConfirmAction();
  const [tokens, setTokens] = useState<ScimToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createScopes, setCreateScopes] = useState<Set<string>>(
    new Set(["users.read", "users.write", "users.deactivate"]),
  );
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch(
      `/v1/admin/identity/scim/tokens?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: { tokens: ScimToken[] }) => {
        setTokens(r.tokens ?? []);
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load tokens." }).message),
      );
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const submitCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setBusy("create");
    setRevealedToken(null);
    try {
      const res = await stepUp.runStepUpAction(async (headers) => {
        return await apiFetch("/v1/admin/identity/scim/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            teamId,
            name: createName.trim().slice(0, 180),
            scopes: Array.from(createScopes),
          }),
        });
      });
      if (res && (res as { tokenOnce?: unknown })?.tokenOnce) {
        setRevealedToken((res as { tokenOnce: string }).tokenOnce);
      }
      setShowCreate(false);
      setCreateName("");
      load();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — token was not created.");
      } else {
        setError(
          toSafeUserError(err, { message: "Could not create token." }).message,
        );
      }
    } finally {
      setBusy(null);
    }
  }, [teamId, createName, createScopes, load, stepUp]);

  const revoke = useCallback(
    async (id: string) => {
      const ok = await confirm({
        title: "Revoke this SCIM token?",
        description:
          "Provisioning requests using this token will fail immediately. This is irreversible — issue a new token if the IdP still needs sync.",
        confirmLabel: "Revoke token",
        tone: "danger",
        testId: "scim-token-revoke",
      });
      if (!ok) return;
      setBusy(id);
      try {
        await stepUp.runStepUpAction(async (headers) => {
          return await apiFetch(
            `/v1/admin/identity/scim/tokens/${encodeURIComponent(id)}/revoke`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(headers ?? {}),
              },
              body: JSON.stringify({ teamId, reason: "Admin revocation" }),
            },
          );
        });
        load();
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setError("Step-up cancelled — token remains active.");
        } else {
          setError(toSafeUserError(err, { message: "Revoke failed." }).message);
        }
      } finally {
        setBusy(null);
      }
    },
    [teamId, load, stepUp],
  );

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
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => {
            setShowCreate(true);
            setRevealedToken(null);
          }}
        >
          New token
        </button>
      </div>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {revealedToken ? (
        <div style={successBoxStyle}>
          <strong>Token created.</strong> Copy now — this is the only time it
          will be shown:{" "}
          <code style={{ fontFamily: "monospace" }}>{revealedToken}</code>
          <button
            type="button"
            style={{ ...ghostButtonStyle, marginLeft: 12 }}
            onClick={() => setRevealedToken(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <section style={{ ...cardStyle, marginTop: 16, padding: 0 }}>
        {tokens === null ? (
          <p style={{ ...mutedStyle, padding: 16 }}>Loading…</p>
        ) : tokens.length === 0 ? (
          <p style={{ ...mutedStyle, padding: 24 }}>No SCIM tokens yet.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Prefix</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Scopes</th>
                <th style={thStyle}>Last used</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td style={tdStyle}>
                    <span style={{ fontWeight: 600 }}>{t.name}</span>
                  </td>
                  <td style={tdStyle}>
                    <code
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                        fontSize: 12,
                      }}
                    >
                      {t.tokenPrefix}…
                    </code>
                  </td>
                  <td style={tdStyle}>
                    <span style={statusBadgeStyle(t.status)}>{t.status}</span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ ...mutedStyle, fontSize: 11 }}>
                      {t.scopes.join(", ")}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(t.lastUsedAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(t.createdAt)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {t.status === "ACTIVE" ? (
                      <button
                        type="button"
                        style={{
                          ...ghostButtonStyle,
                          color: "#991b1b",
                          borderColor: "#fecaca",
                          background: "#fef2f2",
                        }}
                        disabled={busy === t.id}
                        onClick={() => revoke(t.id)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
                      color: active ? TOKENS.accentInk : "#334155",
                      borderColor: active ? TOKENS.accent : "#cbd5e1",
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
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy === "create" || createScopes.size === 0}
              onClick={submitCreate}
            >
              {busy === "create" ? "Creating…" : "Create token"}
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </button>
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
      ? { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" }
      : level === "MEDIUM"
        ? { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" }
        : { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" };
  return badgeStyle(palette);
}

function DriftTab({ teamId }: { teamId: string }) {
  const stepUp = useStepUpAction({ teamId });
  const { confirm } = useConfirmAction();
  const [report, setReport] = useState<ScimDriftReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecuteResult | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    setResult(null);
    setSelected(new Set());
    try {
      const r = (await apiFetch(
        `/v1/scim/reconciliation/preview?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { report: ScimDriftReport };
      setReport(r.report);
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "Drift scan failed." }).message,
      );
    } finally {
      setScanning(false);
    }
  }, [teamId]);

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
    try {
      const res = (await stepUp.runStepUpAction(async (headers) => {
        return (await apiFetch("/v1/scim/reconciliation/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            teamId,
            previewId: report.previewId,
            itemIds: Array.from(selected),
          }),
        })) as { result: ExecuteResult };
      })) as { result: ExecuteResult };
      setResult(res.result);
      setSelected(new Set());
      // Re-scan so the operator sees the post-reconcile state.
      scan();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — no rows were reconciled.");
      } else {
        setError(
          toSafeUserError(err, { message: "Reconciliation failed." }).message,
        );
      }
    } finally {
      setExecuting(false);
    }
  }, [report, selected, stepUp, teamId, scan]);

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
        <button
          type="button"
          style={ghostButtonStyle}
          onClick={scan}
          disabled={scanning}
        >
          {scanning ? "Scanning…" : "Re-scan"}
        </button>
      </div>

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

      {report ? (
        <>
          <section
            style={{
              ...cardStyle,
              marginTop: 16,
              display: "flex",
              gap: 24,
              flexWrap: "wrap",
            }}
          >
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
                  color: report.summary.byRisk.HIGH > 0 ? "#991b1b" : undefined,
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
            <div style={{ marginLeft: "auto" }}>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={selected.size === 0 || executing}
                onClick={execute}
              >
                {executing
                  ? "Reconciling…"
                  : `Reconcile selected (${selected.size})`}
              </button>
            </div>
          </section>

          {report.truncated ? (
            <p style={{ ...mutedStyle, marginTop: 8 }}>
              ⚠ Result truncated to 200 rows. Resolve high-risk items first,
              then re-scan.
            </p>
          ) : null}

          <section style={{ ...cardStyle, marginTop: 12, padding: 0 }}>
            {report.items.length === 0 ? (
              <p style={{ ...mutedStyle, padding: 24 }}>
                No drift detected. Workspace state matches IdP expectations.
              </p>
            ) : (
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
                                  bg: "#fef2f2",
                                  fg: "#991b1b",
                                  border: "#fecaca",
                                })
                              : badgeStyle({
                                  bg: "#eef2ff",
                                  fg: "#3730a3",
                                  border: "#c7d2fe",
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
  const [failures, setFailures] = useState<ScimSyncFailure[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch(
      `/v1/scim/sync-failures?teamId=${encodeURIComponent(teamId)}&limit=100`,
      { method: "GET" },
    )
      .then((r: { failures: ScimSyncFailure[] }) => {
        setFailures(r.failures ?? []);
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load sync failures." }).message),
      );
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const replay = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      setSuccess(null);
      try {
        await apiFetch(
          `/v1/scim/sync-failures/${encodeURIComponent(id)}/replay`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId }),
          },
        );
        setSuccess(
          "Replay recorded. The original IdP push retries automatically — this entry has been cleared from the queue.",
        );
        load();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Replay failed." }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, load],
  );

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
        <button type="button" style={ghostButtonStyle} onClick={load}>
          Refresh
        </button>
      </div>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {success ? <div style={successBoxStyle}>{success}</div> : null}

      <section style={{ ...cardStyle, marginTop: 12, padding: 0 }}>
        {failures === null ? (
          <p style={{ ...mutedStyle, padding: 16 }}>Loading…</p>
        ) : failures.length === 0 ? (
          <p style={{ ...mutedStyle, padding: 24 }}>
            No SCIM sync failures recorded.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Occurred</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Summary</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.id}>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(f.occurredAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ ...mutedStyle, fontSize: 11 }}>
                      {f.eventType}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span
                      style={badgeStyle(
                        f.severity === "HIGH"
                          ? {
                              bg: "#fef2f2",
                              fg: "#991b1b",
                              border: "#fecaca",
                            }
                          : f.severity === "WARNING"
                            ? {
                                bg: "#fef3c7",
                                fg: "#78350f",
                                border: "#fde68a",
                              }
                            : {
                                bg: "#f1f5f9",
                                fg: "#475569",
                                border: "#cbd5e1",
                              },
                      )}
                    >
                      {f.severity}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: 12 }}>{f.summary}</span>
                  </td>
                  <td style={tdStyle}>
                    {f.terminal ? (
                      <span
                        style={badgeStyle({
                          bg: "#fef2f2",
                          fg: "#991b1b",
                          border: "#fecaca",
                        })}
                      >
                        TERMINAL
                      </span>
                    ) : f.retryEligible ? (
                      <span
                        style={badgeStyle({
                          bg: "#eef2ff",
                          fg: "#3730a3",
                          border: "#c7d2fe",
                        })}
                      >
                        REPLAYABLE
                      </span>
                    ) : (
                      <span
                        style={badgeStyle({
                          bg: "#f1f5f9",
                          fg: "#475569",
                          border: "#cbd5e1",
                        })}
                      >
                        MANUAL
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {f.retryEligible && !f.terminal ? (
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        disabled={busy === f.id}
                        onClick={() => replay(f.id)}
                      >
                        {busy === f.id ? "Replaying…" : "Replay"}
                      </button>
                    ) : (
                      <span style={{ ...mutedStyle, fontSize: 11 }}>
                        Not replayable
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
