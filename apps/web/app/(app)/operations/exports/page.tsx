"use client";

/**
 * Phase P2.2 — Immutable export operations console.
 *
 * Consumes the P2.1 backend:
 *
 *   GET  /v1/operations/exports
 *   GET  /v1/operations/exports/object-lock
 *   GET  /v1/operations/exports/:id
 *   GET  /v1/operations/exports/:id/manifest
 *   POST /v1/operations/exports/:id/verify
 *
 * Sections:
 *   1. Object Lock platform-status badge (honest: verified /
 *      claimed-but-unsupported / disabled / skipped).
 *   2. Export history table — kind / version / generated at /
 *      Object Lock badge / signed badge.
 *   3. Selected-export drawer — manifest JSON viewer, copy hash,
 *      reproducibility verification button + result panel.
 *
 * Hard rules:
 *   * "Immutable" badge appears ONLY when platform mode is `verified`
 *     AND the row's `storedMode` is GOVERNANCE or COMPLIANCE.
 *   * Reproducibility states are bounded: match / artifact_drift /
 *     retention_drift / artifact_missing / not_applicable.
 *   * No fake green — failure / missing / drift each have their own
 *     bounded colour + copy.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { AccessGate } from "../../../../components/access/AccessGate";
import {
  badgeStyle,
  cardStyle,
  errorBoxStyle,
  formatDateTime,
  ghostButtonStyle,
  headerRowStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  sectionTitleStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../../admin/identity/ui-tokens";

// ============================================================================
// Types (mirror the backend response shapes)
// ============================================================================

type ExportKind = "report_pdf" | "verification_package_zip";

type ExportListItem = {
  exportId: string;
  kind: ExportKind;
  kindLabel: string;
  exportVersion: number;
  evidenceId: string;
  teamId: string;
  generatedAtUtc: string;
  sizeBytes: string | null;
  objectLockStoredMode: "GOVERNANCE" | "COMPLIANCE" | null;
  artifactSigned: boolean;
  artifactSigningKeyId: string | null;
  artifactSignedAtUtc: string | null;
  artifactUnsignedOptOut: boolean;
  artifactSigningWarning: string | null;
  verificationPackageSignatureStatus: "SIGNED" | "UNSIGNED" | "NOT_APPLICABLE";
};

type ObjectLockPlatformMode =
  | "verified"
  | "claimed-but-unsupported"
  | "disabled"
  | "skipped";

type ObjectLockStatus =
  | {
      mode: "verified";
      bucket: string;
      defaultMode: "GOVERNANCE" | "COMPLIANCE" | null;
      defaultRetainDays: number | null;
      checkedAtUtc: string;
    }
  | {
      mode: "claimed-but-unsupported";
      bucket: string;
      reason: string;
      checkedAtUtc: string;
    }
  | { mode: "disabled"; checkedAtUtc: string }
  | { mode: "skipped"; reason: string; checkedAtUtc: string };

type ExportManifest = {
  manifestVersion: 1;
  kind: ExportKind;
  exportId: string;
  exportVersion: number;
  kindLabel: string;
  evidenceId: string;
  teamId: string;
  organizationId: string | null;
  generatedAtUtc: string;
  artifact: {
    storageBucket: string;
    storageKey: string;
    storageRegion: string | null;
    sizeBytes: string | null;
    contentType: string;
  };
  objectLock: {
    platformMode: ObjectLockPlatformMode;
    storedMode: "GOVERNANCE" | "COMPLIANCE" | null;
    storedRetainUntilUtc: string | null;
    storedLegalHoldStatus: "ON" | "OFF" | null;
  };
  signing: {
    artifactSigned: boolean;
    artifactSigningKeyId: string | null;
    artifactSignedAtUtc: string | null;
    artifactUnsignedOptOut: boolean;
  };
  reproducibility: {
    deterministicProjection: true;
    sourceFields: ReadonlyArray<string>;
  };
};

type ExportManifestEnvelope = {
  manifest: ExportManifest;
  manifestHash: string;
  generatedAtUtc: string;
};

type ReproducibilityOutcome =
  | "match"
  | "artifact_drift"
  | "retention_drift"
  | "artifact_missing"
  | "not_applicable";

type ReproducibilityCheck = {
  field: string;
  expected: string | null;
  actual: string | null;
  ok: boolean;
};

type ReproducibilityReport = {
  exportId: string;
  outcome: ReproducibilityOutcome;
  summary: string;
  manifestEnvelope: ExportManifestEnvelope;
  checks: ReadonlyArray<ReproducibilityCheck>;
  verifiedAtUtc: string;
};

// ============================================================================
// Page shell
// ============================================================================

export default function OperationsExportsPage() {
  return (
    <PageRouteGate routeId="workspace.security_center">
      <OperationsExportsContent />
    </PageRouteGate>
  );
}

function OperationsExportsContent() {
  const teamId = useTeamId();
  const [items, setItems] = useState<ExportListItem[] | null>(null);
  const [objectLock, setObjectLock] = useState<ObjectLockStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!teamId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch(`/v1/operations/exports?teamId=${encodeURIComponent(teamId)}`, {
        method: "GET",
      }),
      apiFetch(
        `/v1/operations/exports/object-lock?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      ),
    ])
      .then(([listRes, lockRes]) => {
        setItems((listRes as { exports: ExportListItem[] }).exports ?? []);
        setObjectLock((lockRes as { status: ObjectLockStatus }).status);
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load exports." }).message),
      )
      .finally(() => setLoading(false));
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!teamId) {
    return (
      <main style={pageStyle}>
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="Operations Exports"
          headline="Switch to a team workspace to inspect exports"
          reason="Export history is per-workspace. Open a team workspace that produced exports."
          actions={[
            { label: "Open team workspaces", href: "/workspaces", variant: "primary" },
          ]}
          testid="operations-exports-no-workspace"
        />
      </main>
    );
  }

  return (
    <main style={pageStyle} data-testid="operations-exports-root">
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Immutable Export Operations</h1>
          <p style={subtitleStyle}>
            Inspect Report PDF + Verification Package exports. Verify
            reproducibility against current S3 state. Confirm Object Lock
            status honestly (no badge unless the platform probe verified
            the bucket).
          </p>
        </div>
        <button
          type="button"
          style={ghostButtonStyle}
          onClick={load}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <ObjectLockPanel status={objectLock} />

      <ExportListTable
        items={items}
        objectLockMode={objectLock?.mode ?? null}
        onSelect={setSelectedId}
        selectedId={selectedId}
      />

      {selectedId ? (
        <ExportDrawer
          teamId={teamId}
          exportId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </main>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function ObjectLockPanel({ status }: { status: ObjectLockStatus | null }) {
  if (!status) {
    return (
      <section style={{ ...cardStyle, marginTop: 16 }}>
        <p style={mutedStyle}>Loading Object Lock status…</p>
      </section>
    );
  }
  const palette =
    status.mode === "verified"
      ? { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" }
      : status.mode === "claimed-but-unsupported"
        ? { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" }
        : status.mode === "skipped"
          ? { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" }
          : { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" };
  return (
    <section
      style={{ ...cardStyle, marginTop: 16 }}
      data-testid="object-lock-panel"
    >
      <h3 style={sectionTitleStyle}>S3 Object Lock platform status</h3>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span style={badgeStyle(palette)} data-testid="object-lock-badge">
          {status.mode}
        </span>
        {status.mode === "verified" ? (
          <span style={mutedStyle}>
            Bucket {status.bucket}
            {status.defaultMode ? ` · default ${status.defaultMode}` : ""}
            {status.defaultRetainDays
              ? ` · ${status.defaultRetainDays}d retention`
              : ""}
          </span>
        ) : status.mode === "claimed-but-unsupported" ? (
          <span style={mutedStyle}>
            {status.bucket} · {status.reason}
          </span>
        ) : status.mode === "skipped" ? (
          <span style={mutedStyle}>{status.reason}</span>
        ) : (
          <span style={mutedStyle}>
            Object Lock is intentionally disabled. Exports persist but cannot
            be claimed as WORM.
          </span>
        )}
      </div>
      <p style={{ ...mutedStyle, marginTop: 8 }}>
        Checked {formatDateTime(status.checkedAtUtc)}.
      </p>
    </section>
  );
}

function ExportListTable({
  items,
  objectLockMode,
  selectedId,
  onSelect,
}: {
  items: ExportListItem[] | null;
  objectLockMode: ObjectLockPlatformMode | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (items === null) {
    return (
      <section style={{ ...cardStyle, marginTop: 12 }}>
        <p style={mutedStyle}>Loading exports…</p>
      </section>
    );
  }
  if (items.length === 0) {
    return (
      <section
        style={{ ...cardStyle, marginTop: 12, padding: 24, textAlign: "center" }}
      >
        <p style={mutedStyle}>No exports recorded for this workspace yet.</p>
      </section>
    );
  }
  return (
    <section
      style={{ ...cardStyle, marginTop: 12, padding: 0 }}
      data-testid="export-list"
    >
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Kind</th>
            <th style={thStyle}>Version</th>
            <th style={thStyle}>Generated</th>
            <th style={thStyle}>Size</th>
            <th style={thStyle}>Object Lock</th>
            <th style={thStyle}>Artifact signed</th>
            <th style={thStyle}>{" "}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const immutable =
              objectLockMode === "verified" && it.objectLockStoredMode !== null;
            const isSelected = it.exportId === selectedId;
            return (
              <tr
                key={it.exportId}
                style={
                  isSelected
                    ? { background: TOKENS.surfaceMuted }
                    : undefined
                }
              >
                <td style={tdStyle}>
                  <strong>{it.kindLabel}</strong>
                </td>
                <td style={tdStyle}>v{it.exportVersion}</td>
                <td style={tdStyle}>
                  <span style={mutedStyle}>
                    {formatDateTime(it.generatedAtUtc)}
                  </span>
                </td>
                <td style={tdStyle}>
                  <span style={mutedStyle}>
                    {it.sizeBytes
                      ? `${Math.round(Number(it.sizeBytes) / 1024)} KB`
                      : "—"}
                  </span>
                </td>
                <td style={tdStyle}>
                  {immutable ? (
                    <span
                      style={badgeStyle({
                        bg: "#ecfdf5",
                        fg: "#065f46",
                        border: "#a7f3d0",
                      })}
                    >
                      IMMUTABLE · {it.objectLockStoredMode}
                    </span>
                  ) : it.objectLockStoredMode ? (
                    <span
                      style={badgeStyle({
                        bg: "#fef3c7",
                        fg: "#78350f",
                        border: "#fde68a",
                      })}
                    >
                      STORED {it.objectLockStoredMode} (platform unverified)
                    </span>
                  ) : (
                    <span
                      style={badgeStyle({
                        bg: "#f1f5f9",
                        fg: "#475569",
                        border: "#cbd5e1",
                      })}
                    >
                      no lock
                    </span>
                  )}
                </td>
                <td style={tdStyle}>
                  {it.artifactSigned ? (
                    <span
                      style={badgeStyle({
                        bg: "#eef2ff",
                        fg: "#3730a3",
                        border: "#c7d2fe",
                      })}
                    >
                      SIGNED
                    </span>
                  ) : it.artifactUnsignedOptOut ? (
                    <span
                      style={badgeStyle({
                        bg: "#fef2f2",
                        fg: "#991b1b",
                        border: "#fecaca",
                      })}
                    >
                      UNSIGNED OPT-OUT
                    </span>
                  ) : it.kind === "verification_package_zip" ? (
                    <span
                      style={badgeStyle({
                        bg: "#f1f5f9",
                        fg: "#475569",
                        border: "#cbd5e1",
                      })}
                    >
                      {it.verificationPackageSignatureStatus === "UNSIGNED"
                        ? "unsigned package"
                        : "unsigned"}
                    </span>
                  ) : (
                    <span
                      style={badgeStyle({
                        bg: "#f1f5f9",
                        fg: "#475569",
                        border: "#cbd5e1",
                      })}
                    >
                      unsigned
                    </span>
                  )}
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    style={ghostButtonStyle}
                    onClick={() => onSelect(it.exportId)}
                  >
                    Inspect
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function ExportDrawer({
  teamId,
  exportId,
  onClose,
}: {
  teamId: string;
  exportId: string;
  onClose: () => void;
}) {
  const [envelope, setEnvelope] = useState<ExportManifestEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReproducibilityReport | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    apiFetch(
      `/v1/operations/exports/${encodeURIComponent(
        exportId,
      )}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: { envelope: ExportManifestEnvelope }) => setEnvelope(r.envelope))
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load manifest." }).message),
      );
  }, [teamId, exportId]);

  const verify = useCallback(async () => {
    setVerifying(true);
    setReport(null);
    try {
      const r = (await apiFetch(
        `/v1/operations/exports/${encodeURIComponent(exportId)}/verify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      )) as { report: ReproducibilityReport };
      setReport(r.report);
    } catch (err) {
      setError(toSafeUserError(err, { message: "Verification failed." }).message);
    } finally {
      setVerifying(false);
    }
  }, [teamId, exportId]);

  const manifestJson = useMemo(() => {
    if (!envelope) return "";
    return JSON.stringify(envelope.manifest, null, 2);
  }, [envelope]);

  const copy = (s: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(s).catch(() => undefined);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Export details"
      data-testid="export-drawer"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        height: "100vh",
        width: "min(640px, 100vw)",
        background: TOKENS.surface,
        borderLeft: `1px solid ${TOKENS.border}`,
        boxShadow: "0 0 40px rgba(15,23,42,0.1)",
        zIndex: 50,
        overflowY: "auto",
        padding: 20,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h2 style={{ fontSize: 16, margin: 0 }}>Export detail</h2>
        <button type="button" style={ghostButtonStyle} onClick={onClose}>
          Close
        </button>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!envelope ? (
        <p style={mutedStyle}>Loading manifest…</p>
      ) : (
        <>
          <section>
            <h3 style={sectionTitleStyle}>Identity</h3>
            <table style={tableStyle}>
              <tbody>
                <tr>
                  <td style={tdStyle}>kind</td>
                  <td style={tdStyle}>{envelope.manifest.kindLabel}</td>
                </tr>
                <tr>
                  <td style={tdStyle}>exportId</td>
                  <td style={tdStyle}>
                    <code
                      style={{ fontFamily: "monospace", fontSize: 12 }}
                      data-testid="manifest-export-id"
                    >
                      {envelope.manifest.exportId}
                    </code>
                  </td>
                </tr>
                <tr>
                  <td style={tdStyle}>version</td>
                  <td style={tdStyle}>v{envelope.manifest.exportVersion}</td>
                </tr>
                <tr>
                  <td style={tdStyle}>generatedAtUtc</td>
                  <td style={tdStyle}>
                    {formatDateTime(envelope.manifest.generatedAtUtc)}
                  </td>
                </tr>
                <tr>
                  <td style={tdStyle}>manifestHash</td>
                  <td style={tdStyle}>
                    <code
                      style={{ fontFamily: "monospace", fontSize: 11 }}
                      data-testid="manifest-hash"
                    >
                      {envelope.manifestHash.slice(0, 24)}…
                    </code>
                    <button
                      type="button"
                      style={{ ...ghostButtonStyle, marginLeft: 6 }}
                      onClick={() => copy(envelope.manifestHash)}
                    >
                      Copy
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section style={{ marginTop: 16 }}>
            <h3 style={sectionTitleStyle}>Signature status</h3>
            <table style={tableStyle}>
              <tbody>
                <tr>
                  <td style={tdStyle}>signed</td>
                  <td style={tdStyle}>
                    {envelope.manifest.signing.artifactSigned ? "YES" : "NO"}
                  </td>
                </tr>
                <tr>
                  <td style={tdStyle}>signing key id</td>
                  <td style={tdStyle}>
                    <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                      {envelope.manifest.signing.artifactSigningKeyId ?? "—"}
                    </code>
                  </td>
                </tr>
                <tr>
                  <td style={tdStyle}>signed at</td>
                  <td style={tdStyle}>
                    {formatDateTime(
                      envelope.manifest.signing.artifactSignedAtUtc,
                    )}
                  </td>
                </tr>
                {envelope.manifest.signing.artifactUnsignedOptOut ? (
                  <tr>
                    <td style={tdStyle}>opt-out</td>
                    <td style={tdStyle}>
                      <span
                        style={badgeStyle({
                          bg: "#fef3c7",
                          fg: "#78350f",
                          border: "#fde68a",
                        })}
                      >
                        UNSIGNED OPT-OUT
                      </span>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          <section style={{ marginTop: 16 }}>
            <h3 style={sectionTitleStyle}>Reproducibility verification</h3>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={verify}
              disabled={verifying}
              data-testid="verify-button"
            >
              {verifying ? "Verifying…" : "Verify reproducibility"}
            </button>
            {report ? (
              <div style={{ marginTop: 12 }} data-testid="verify-result">
                <ReproducibilityResultPanel report={report} />
              </div>
            ) : (
              <p style={{ ...mutedStyle, marginTop: 8 }}>
                Run the verifier to re-derive the manifest hash, refetch the
                S3 artifact, and compare Object Lock state against the
                row's stored intent.
              </p>
            )}
          </section>

          <section style={{ marginTop: 16 }}>
            <h3 style={sectionTitleStyle}>Canonical manifest JSON</h3>
            <pre
              style={{
                background: TOKENS.surfaceMuted,
                border: `1px solid ${TOKENS.border}`,
                borderRadius: 6,
                padding: 10,
                fontSize: 11,
                maxHeight: 360,
                overflow: "auto",
              }}
              data-testid="manifest-json"
            >
              {manifestJson}
            </pre>
            <button
              type="button"
              style={ghostButtonStyle}
              onClick={() => copy(manifestJson)}
            >
              Copy manifest JSON
            </button>
          </section>
        </>
      )}
    </div>
  );
}

function ReproducibilityResultPanel({
  report,
}: {
  report: ReproducibilityReport;
}) {
  const palette =
    report.outcome === "match"
      ? { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" }
      : report.outcome === "artifact_missing"
        ? { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" }
        : report.outcome === "artifact_drift"
          ? { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" }
          : report.outcome === "retention_drift"
            ? { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" }
            : { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" };
  return (
    <div>
      <span style={badgeStyle(palette)} data-testid="verify-outcome">
        {report.outcome}
      </span>
      <p style={{ marginTop: 8, fontSize: 13 }}>{report.summary}</p>
      {report.checks.length > 0 ? (
        <table style={{ ...tableStyle, marginTop: 8 }}>
          <thead>
            <tr>
              <th style={thStyle}>Check</th>
              <th style={thStyle}>Expected</th>
              <th style={thStyle}>Actual</th>
              <th style={thStyle}>OK</th>
            </tr>
          </thead>
          <tbody>
            {report.checks.map((c) => (
              <tr key={c.field}>
                <td style={tdStyle}>
                  <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {c.field}
                  </code>
                </td>
                <td style={tdStyle}>
                  <span style={mutedStyle}>
                    {c.expected
                      ? c.expected.length > 24
                        ? c.expected.slice(0, 24) + "…"
                        : c.expected
                      : "—"}
                  </span>
                </td>
                <td style={tdStyle}>
                  <span style={mutedStyle}>
                    {c.actual
                      ? c.actual.length > 24
                        ? c.actual.slice(0, 24) + "…"
                        : c.actual
                      : "—"}
                  </span>
                </td>
                <td style={tdStyle}>{c.ok ? "✓" : "✗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p style={{ ...mutedStyle, marginTop: 6 }}>
        Verified {formatDateTime(report.verifiedAtUtc)}.
      </p>
    </div>
  );
}
