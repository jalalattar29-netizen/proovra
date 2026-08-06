"use client";

import { useCallback, useEffect, useState } from "react";

import { ENTITLEMENT_KEYS, PRODUCT_LINES } from "@proovra/shared";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../lib/api";
import { formatUserDate } from "../../../lib/date";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

type PermissionDenialState = { denial: string; tier: string } | null;

interface Entitlement {
  id: string;
  key: string;
  kind: string;
  value: string | number | boolean;
  source: string;
  expiresAtUtc?: string | null;
}

interface EntitlementsResponse {
  entitlements: Entitlement[];
}

export default function PackagingPage() {
  return (
    <PageRouteGate routeId="workspace.packaging">
      <Shell />
    </PageRouteGate>
  );
}

const PLAN_LINES = [
  { line: "CAPTURE_AND_VERIFY", label: "Capture & Verify", color: "#eff6ff", border: "#bfdbfe" },
  { line: "INVESTIGATIONS", label: "Investigations", color: "#f0fdf4", border: "#bbf7d0" },
  { line: "ENTERPRISE", label: "Enterprise", color: "#faf5ff", border: "#e9d5ff" },
] as const;

function applyDenial(err: unknown, setDenial: (v: PermissionDenialState) => void): void {
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  const denial =
    e?.details && typeof e.details["denial"] === "string" ? e.details["denial"] : null;
  const tier =
    e?.details && typeof e.details["requiredTier"] === "string"
      ? (e.details["requiredTier"] as string)
      : "ENTITLEMENT";
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "DELEGATED_ADMIN_REQUIRED")
  ) {
    setDenial({ denial: denial as string, tier });
  }
  if (err instanceof ApiError) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const t =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "ENTITLEMENT";
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "DELEGATED_ADMIN_REQUIRED")
    ) {
      setDenial({ denial: d, tier: t });
    }
  }
}

/**
 * PHASE 12 POINT 1 / C1 — individual entitlement grant administration.
 *
 * `POST /v1/packaging/entitlements/grant` is the ORG_ADMIN-gated operation for
 * granting ONE entitlement, as opposed to `apply-product-line` which applies a
 * whole bundle. It lives here, on the already-restricted packaging console,
 * because that is the surface an org administrator is already on when they
 * need to make a single exception.
 *
 * The key list and the product lines are the SHARED bounded catalogs — the
 * form can never post a key the server does not recognise, so an invalid grant
 * is impossible to express rather than merely rejected. `kind` decides the
 * value editor: FEATURE is boolean, QUOTA/LIMIT are integers. The server is
 * still the authority; this only stops the console from offering nonsense.
 */
const GRANT_KINDS = ["FEATURE", "QUOTA", "LIMIT"] as const;
const GRANT_SOURCES = ["CUSTOM", "PROMO", "PLAN"] as const;

type GrantKind = (typeof GRANT_KINDS)[number];
type GrantSource = (typeof GRANT_SOURCES)[number];

/** The catalog's own naming tells us which editor a key expects. */
function defaultKindFor(key: string): GrantKind {
  if (key.startsWith("FEATURE_")) return "FEATURE";
  if (key.startsWith("QUOTA_")) return "QUOTA";
  return "LIMIT";
}

function Shell() {
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);
  const [applyBusy, setApplyBusy] = useState<string | null>(null);

  // ---- C1: single-entitlement grant form -------------------------------
  const [grantKey, setGrantKey] = useState<string>(ENTITLEMENT_KEYS[0]);
  const [grantKind, setGrantKind] = useState<GrantKind>(defaultKindFor(ENTITLEMENT_KEYS[0]));
  const [grantBool, setGrantBool] = useState(true);
  const [grantNumber, setGrantNumber] = useState("1");
  const [grantSource, setGrantSource] = useState<GrantSource>("CUSTOM");
  const [grantProductLine, setGrantProductLine] = useState<string>("");
  const [grantExpiry, setGrantExpiry] = useState("");
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantResult, setGrantResult] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/packaging/entitlements", {
        method: "GET",
      })) as EntitlementsResponse | null;
      setEntitlements(res?.entitlements ?? []);
    } catch (err) {
      setEntitlements([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const applyProductLine = useCallback(
    async (line: string) => {
      setApplyBusy(line);
      setDenial(null);
      try {
        await apiFetch("/v1/packaging/entitlements/apply-product-line", {
          method: "POST",
          body: JSON.stringify({ line }),
        });
        await refresh();
      } catch (err) {
        applyDenial(err, setDenial);
      } finally {
        setApplyBusy(null);
      }
    },
    [refresh],
  );

  const numericGrantValue = Number.parseInt(grantNumber, 10);
  const grantValueValid =
    grantKind === "FEATURE" ||
    (Number.isFinite(numericGrantValue) && numericGrantValue >= 0);

  const submitGrant = useCallback(async () => {
    if (!grantValueValid) return;
    setGrantBusy(true);
    setGrantResult(null);
    setGrantError(null);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/packaging/entitlements/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: grantKey,
          kind: grantKind,
          value: grantKind === "FEATURE" ? grantBool : numericGrantValue,
          source: grantSource,
          productLine: grantProductLine ? grantProductLine : null,
          // A date-only input means "end of that day" is NOT implied — the
          // server stores the instant we send, so send an explicit UTC one.
          expiresAtUtc: grantExpiry ? new Date(`${grantExpiry}T00:00:00Z`).toISOString() : null,
        }),
      })) as { grantId?: string } | null;
      setGrantResult(res?.grantId ?? null);
      // The registry below is the authority on what is now in force.
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
      setGrantError(
        toSafeUserError(err, { message: "The entitlement could not be granted." }).message,
      );
    } finally {
      setGrantBusy(false);
    }
  }, [
    grantValueValid,
    grantKey,
    grantKind,
    grantBool,
    numericGrantValue,
    grantSource,
    grantProductLine,
    grantExpiry,
    refresh,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-packaging-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Packaging &amp; Entitlements</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Plan lines · entitlement registry · apply product bundles.
        </p>
      </header>

      {denial ? (
        <div
          data-permission-denied={denial.denial}
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <strong>Permission required:</strong> {denial.tier}
        </div>
      ) : null}

      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      {/* Plan cards */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 16 }}>
        {PLAN_LINES.map(({ line, label, color, border }) => (
          <div
            key={line}
            data-plan-card={line}
            style={{
              background: color,
              border: `1px solid ${border}`,
              borderRadius: 12,
              padding: 16,
            }}
          >
            <strong style={{ fontSize: 15, display: "block", marginBottom: 8 }}>{label}</strong>
            <p style={{ fontSize: 12, color: "#475569", margin: "0 0 12px" }}>
              Product line: <code>{line}</code>
            </p>
            <button
              type="button"
              data-apply-product-line={line}
              disabled={applyBusy === line || busy}
              onClick={() => void applyProductLine(line)}
              style={secondaryButton}
            >
              {applyBusy === line ? "Applying…" : "Apply Product Line"}
            </button>
          </div>
        ))}
      </section>

      {/* PHASE 12 POINT 1 / C1 — grant ONE entitlement (ORG_ADMIN-gated).
          The product-line cards above apply a whole bundle; this is the
          single-key exception an administrator occasionally needs. */}
      <section
        data-entitlement-grant-panel
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 14,
          marginTop: 16,
        }}
      >
        <strong style={{ fontSize: 14, display: "block" }}>Grant a single entitlement</strong>
        <p style={{ fontSize: 12, color: "#475569", margin: "4px 0 12px" }}>
          Grants one key to this workspace without applying an entire product
          line. Organization-administrator access is required; the server
          re-checks it on every grant.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: 10,
            alignItems: "end",
          }}
        >
          <label style={fieldLabel}>
            Entitlement
            <select
              data-entitlement-grant-key
              value={grantKey}
              onChange={(e) => {
                setGrantKey(e.target.value);
                setGrantKind(defaultKindFor(e.target.value));
              }}
              style={field}
            >
              {ENTITLEMENT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>

          <label style={fieldLabel}>
            Kind
            <select
              data-entitlement-grant-kind
              value={grantKind}
              onChange={(e) => setGrantKind(e.target.value as GrantKind)}
              style={field}
            >
              {GRANT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>

          <label style={fieldLabel}>
            Value
            {grantKind === "FEATURE" ? (
              <select
                data-entitlement-grant-value="boolean"
                value={grantBool ? "true" : "false"}
                onChange={(e) => setGrantBool(e.target.value === "true")}
                style={field}
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            ) : (
              <input
                data-entitlement-grant-value="number"
                type="number"
                min={0}
                step={1}
                value={grantNumber}
                onChange={(e) => setGrantNumber(e.target.value)}
                style={field}
              />
            )}
          </label>

          <label style={fieldLabel}>
            Source
            <select
              data-entitlement-grant-source
              value={grantSource}
              onChange={(e) => setGrantSource(e.target.value as GrantSource)}
              style={field}
            >
              {GRANT_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label style={fieldLabel}>
            Product line (optional)
            <select
              data-entitlement-grant-product-line
              value={grantProductLine}
              onChange={(e) => setGrantProductLine(e.target.value)}
              style={field}
            >
              <option value="">Not tied to a line</option>
              {PRODUCT_LINES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>

          <label style={fieldLabel}>
            Expires (optional)
            <input
              data-entitlement-grant-expiry
              type="date"
              value={grantExpiry}
              onChange={(e) => setGrantExpiry(e.target.value)}
              style={field}
            />
          </label>

          <button
            type="button"
            data-entitlement-grant-submit
            disabled={grantBusy || busy || !grantValueValid}
            onClick={() => void submitGrant()}
            style={primaryButton}
          >
            {grantBusy ? "Granting…" : "Grant entitlement"}
          </button>
        </div>

        {!grantValueValid ? (
          <p data-entitlement-grant-invalid style={{ fontSize: 12, color: "#991b1b", marginBottom: 0 }}>
            Enter a whole number of 0 or more for a {grantKind.toLowerCase()} entitlement.
          </p>
        ) : null}

        {grantResult ? (
          <p data-entitlement-grant-result style={{ fontSize: 12, color: "#166534", marginBottom: 0 }}>
            Granted. The entitlement registry below has been reloaded from the
            server.
          </p>
        ) : null}

        {grantError ? (
          <p data-entitlement-grant-error style={{ fontSize: 12, color: "#991b1b", marginBottom: 0 }}>
            {grantError}
          </p>
        ) : null}
      </section>

      {/* Entitlement table */}
      <section
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 16,
          overflowX: "auto",
        }}
      >
        <strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>Entitlements</strong>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Key</th>
              <th style={th}>Kind</th>
              <th style={th}>Value</th>
              <th style={th}>Source</th>
              <th style={th}>Expires</th>
            </tr>
          </thead>
          <tbody>
            {entitlements.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...td, color: "#475569" }}>
                  No entitlements.
                </td>
              </tr>
            ) : (
              entitlements.map((e) => (
                <tr key={e.id} data-entitlement-row={e.key}>
                  <td style={td}>
                    <code>{e.key}</code>
                  </td>
                  <td style={td}>{e.kind}</td>
                  <td style={td}>{String(e.value)}</td>
                  <td style={td}>{e.source}</td>
                  <td style={td}>
                    {e.expiresAtUtc
                      ? formatUserDate(e.expiresAtUtc)
                      : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const secondaryButton = {
  padding: "4px 8px",
  border: "1px solid #0f172a",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 11,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const fieldLabel = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11,
  fontWeight: 600,
  color: "#475569",
} as const;
const field = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  color: "#0f172a",
  background: "#fff",
  fontWeight: 400,
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
