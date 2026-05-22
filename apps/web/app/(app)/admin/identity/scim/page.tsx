"use client";

/**
 * Phase 26 — SCIM Management admin page.
 *
 * Lists existing SCIM provisioning tokens and supports create + revoke.
 * Raw token shown ONCE on create.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
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
  TOKENS,
} from "../ui-tokens";

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

export default function ScimPage() {
  const teamId = useTeamId();
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
    if (!teamId) return;
    apiFetch(
      `/v1/admin/identity/scim/tokens?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: { tokens: ScimToken[] }) => {
        setTokens(r.tokens ?? []);
        setError(null);
      })
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Could not load tokens."),
      );
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const submitCreate = useCallback(async () => {
    if (!teamId || !createName.trim()) return;
    setBusy("create");
    setRevealedToken(null);
    try {
      const res = await apiFetch("/v1/admin/identity/scim/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          name: createName.trim().slice(0, 180),
          scopes: Array.from(createScopes),
        }),
      });
      if (res?.tokenOnce) setRevealedToken(res.tokenOnce as string);
      setShowCreate(false);
      setCreateName("");
      load();
    } catch (err) {
      setError(
        (err as { message?: string })?.message ?? "Could not create token.",
      );
    } finally {
      setBusy(null);
    }
  }, [teamId, createName, createScopes, load]);

  const revoke = useCallback(
    async (id: string) => {
      if (!teamId) return;
      if (!window.confirm("Revoke this SCIM token? This is irreversible.")) return;
      setBusy(id);
      try {
        await apiFetch(
          `/v1/admin/identity/scim/tokens/${encodeURIComponent(id)}/revoke`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, reason: "Admin revocation" }),
          },
        );
        load();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ?? "Revoke failed.",
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
          <h1 style={titleStyle}>SCIM Management</h1>
          <p style={subtitleStyle}>
            Bearer tokens for SCIM v2 provisioning. The endpoint base is{" "}
            <code style={{ fontFamily: "monospace", fontSize: 12 }}>
              /v2/scim
            </code>
            . Tokens are scope-bounded and hashed at rest.
          </p>
        </div>
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
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {revealedToken ? (
        <div style={successBoxStyle}>
          <strong>Token created.</strong> Copy now — this is the only time
          it will be shown:{" "}
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
    </main>
  );
}
