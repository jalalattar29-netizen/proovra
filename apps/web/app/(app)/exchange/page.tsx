"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch, ApiError } from "../../../lib/api";
import { formatUserDate, formatUserDateTime } from "../../../lib/date";

type PermissionDenialState = { denial: string; tier: string } | null;

interface ExchangePackage {
  id: string;
  kind: string;
  evidenceIds: string[];
  state: string;
  signedUrl?: string | null;
  signedUrlExpiresAtUtc?: string | null;
  createdAtUtc: string;
}

const PACKAGE_KINDS = ["SHARE", "EXPORT", "LEGAL_PRODUCTION", "INTERNAL_TRANSFER"] as const;

function applyDenial(err: unknown, setDenial: (v: PermissionDenialState) => void): void {
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  const denial =
    e?.details && typeof e.details["denial"] === "string" ? e.details["denial"] : null;
  const tier =
    e?.details && typeof e.details["requiredTier"] === "string"
      ? (e.details["requiredTier"] as string)
      : "DELEGATED_ADMIN";
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "DELEGATED_ADMIN_REQUIRED")
  ) {
    setDenial({ denial: denial as string, tier });
    return;
  }
  if (err instanceof ApiError) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const t =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "DELEGATED_ADMIN";
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "DELEGATED_ADMIN_REQUIRED")
    ) {
      setDenial({ denial: d, tier: t });
    }
  }
}

export default function ExchangePage() {
  return (
    <PageRouteGate routeId="workspace.exchange">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [packages, setPackages] = useState<ExchangePackage[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);

  // Create form state
  const [kind, setKind] = useState<string>(PACKAGE_KINDS[0]);
  const [evidenceIds, setEvidenceIds] = useState("");
  const [creating, setCreating] = useState(false);

  // Sign URL state
  const [signBusy, setSignBusy] = useState<string | null>(null);
  const [signResult, setSignResult] = useState<{
    id: string;
    url: string;
    expiresAtUtc: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/exchange/packages", {
        method: "GET",
      })) as { packages?: ExchangePackage[] } | null;
      setPackages((res?.packages ?? []) as ExchangePackage[]);
    } catch (err) {
      setPackages([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    setDenial(null);
    try {
      const ids = evidenceIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await apiFetch("/v1/exchange/packages", {
        method: "POST",
        body: JSON.stringify({ kind, evidenceIds: ids }),
      });
      setEvidenceIds("");
      await refresh();
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setCreating(false);
    }
  }, [kind, evidenceIds, refresh]);

  const signUrl = useCallback(async (id: string) => {
    setSignBusy(id);
    setDenial(null);
    setSignResult(null);
    try {
      const res = (await apiFetch(`/v1/exchange/packages/${id}/sign-url`, {
        method: "POST",
      })) as { signedUrl?: string; expiresAtUtc?: string } | null;
      if (res?.signedUrl && res.expiresAtUtc) {
        setSignResult({ id, url: res.signedUrl, expiresAtUtc: res.expiresAtUtc });
      }
    } catch (err) {
      applyDenial(err, setDenial);
    } finally {
      setSignBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      data-exchange-page
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>Evidence Exchange</h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Packages · signed URL distribution · chain transfers.
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

      {signResult ? (
        <div
          data-exchange-signed-url
          style={{
            padding: 12,
            background: "#f0fdf4",
            border: "2px solid #16a34a",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 14,
          }}
        >
          <strong style={{ color: "#15803d" }}>Signed URL generated (package {signResult.id}):</strong>
          <pre
            style={{
              margin: "8px 0 4px",
              fontFamily: "monospace",
              fontSize: 12,
              wordBreak: "break-all",
            }}
          >
            {signResult.url}
          </pre>
          <small>
            Expires: {formatUserDateTime(signResult.expiresAtUtc)}
          </small>
          <br />
          <button
            type="button"
            onClick={() => setSignResult(null)}
            style={{ marginTop: 6, fontSize: 11, cursor: "pointer" }}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Create form */}
      <section
        style={{
          background: "rgba(15,23,42,0.03)",
          border: "1px solid rgba(15,23,42,0.06)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <strong style={{ display: "block", marginBottom: 10, fontSize: 14 }}>
          Create Exchange Package
        </strong>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Kind
            <select style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value)}>
              {PACKAGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Evidence IDs (comma-sep)
            <input
              style={{ ...inputStyle, minWidth: 280 }}
              value={evidenceIds}
              onChange={(e) => setEvidenceIds(e.target.value)}
              placeholder="uuid1, uuid2"
            />
          </label>
          <button
            type="button"
            disabled={creating || !evidenceIds}
            onClick={() => void create()}
            style={primaryButton}
          >
            {creating ? "Creating…" : "Create Package"}
          </button>
        </div>
      </section>

      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        style={primaryButton}
      >
        {busy ? "Loading…" : "Refresh"}
      </button>

      <section
        style={{
          background: "#fff",
          border: "1px solid rgba(15,23,42,0.08)",
          borderRadius: 10,
          padding: 8,
          marginTop: 12,
          overflowX: "auto",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Kind</th>
              <th style={th}>Evidence Count</th>
              <th style={th}>State</th>
              <th style={th}>Created</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {packages.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...td, color: "#475569" }}>
                  No packages.
                </td>
              </tr>
            ) : (
              packages.map((pkg) => (
                <tr key={pkg.id} data-exchange-package-row={pkg.id}>
                  <td style={td}>
                    <code>{pkg.kind}</code>
                  </td>
                  <td style={td}>{pkg.evidenceIds.length}</td>
                  <td style={td}>
                    <strong>{pkg.state}</strong>
                  </td>
                  <td style={td}>{formatUserDate(pkg.createdAtUtc)}</td>
                  <td style={td}>
                    <button
                      type="button"
                      disabled={signBusy === pkg.id}
                      onClick={() => void signUrl(pkg.id)}
                      style={secondaryButton}
                    >
                      {signBusy === pkg.id ? "Signing…" : "Sign URL"}
                    </button>
                    {pkg.signedUrl && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "#475569" }}>
                        Exp: {pkg.signedUrlExpiresAtUtc
                          ? formatUserDate(pkg.signedUrlExpiresAtUtc)
                          : "—"}
                      </span>
                    )}
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
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 2, fontSize: 11, fontWeight: 600 };
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
