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

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import "../admin-platform.css";
import { AccessGate } from "../../../../../components/access/AccessGate";
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { formatCellDateTime } from "../../../../../lib/date";
import {
  AdmInline,
  AdmOverlay,
  AdmSkeleton,
} from "../../../../../components/admin/AdminSurfaces";

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
    <PageRouteGate routeId="operations.exports">
      <OperationsExportsContent />
    </PageRouteGate>
  );
}

function OperationsExportsContent() {
  const teamId = useTeamId();
  const [items, setItems] = useState<ExportListItem[] | null>(null);
  const [itemsLimit, setItemsLimit] = useState<number | undefined>(undefined);
  const [objectLock, setObjectLock] = useState<ObjectLockStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The object-lock probe fails independently of the export list. */
  const [lockError, setLockError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * A RESPONSE THAT LANDS AFTER A WORKSPACE SWITCH BELONGS TO THE OLD ONE.
   *
   * GATE B §B1 (STALE). `load` is keyed on `teamId` and re-runs when the
   * operator switches workspace, but the in-flight promise from the PREVIOUS
   * workspace had nothing to stop it: its `.then` still called `setItems`, so
   * whichever request finished last won. Switch from a busy workspace to a
   * quiet one and the quiet one could show the busy one's exports — with no
   * indication anything was wrong.
   *
   * The token is captured when the read starts and compared when it returns.
   * Sibling pages express this as a `cancelled` flag in the effect's closure;
   * this page loads through a `useCallback` that a mutation also re-invokes,
   * so the generation lives in a ref where every caller shares it.
   */
  const loadGeneration = useRef(0);

  const load = useCallback(() => {
    if (!teamId) return;
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    const isStale = () => loadGeneration.current !== generation;
    setLoading(true);
    setError(null);
    setLockError(null);
    /*
      TWO SOURCES, TWO OUTCOMES.

      This was `Promise.all([exports, objectLock])` behind ONE `.catch`, so a
      failure of either discarded BOTH: when the object-lock probe could not be
      read — a bucket-configuration question that has nothing to do with the
      export list — the page threw away an export list that had answered
      perfectly and rendered a single "Could not load exports." That is the
      state the sweep calls PARTIAL, and the invariant it protects is that one
      failed card must not blank unrelated content.

      `allSettled` keeps them independent: each source renders its own result
      or its own reason, and the page is honest about which half it has.
    */
    Promise.allSettled([
      apiFetch(`/v1/operations/exports?teamId=${encodeURIComponent(teamId)}`, {
        method: "GET",
      }),
      apiFetch(
        `/v1/operations/exports/object-lock?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      ),
    ])
      .then(([listOutcome, lockOutcome]) => {
        // The workspace moved on while this was in flight.
        if (isStale()) return;
        if (listOutcome.status === "fulfilled") {
          const listRes = listOutcome.value as {
            exports?: ExportListItem[];
            limit?: number;
          };
          setItems(listRes.exports ?? []);
          setItemsLimit(listRes.limit);
        } else {
          setError(
            toSafeUserError(listOutcome.reason, {
              message: "Could not load exports.",
            }).message,
          );
        }

        if (lockOutcome.status === "fulfilled") {
          setObjectLock(
            (lockOutcome.value as { status: ObjectLockStatus }).status,
          );
        } else {
          // The list above is unaffected and stays on screen.
          setLockError(
            toSafeUserError(lockOutcome.reason, {
              message: "Could not read the object-lock posture.",
            }).message,
          );
        }
      })
      .finally(() => {
        // A stale run must not clear the CURRENT run's loading state.
        if (!isStale()) setLoading(false);
      });
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const pageHeader = (
    <PageHeader
      eyebrow="Platform operations"
      title="Immutable Export Operations"
      subtitle={"Inspect Report PDF + Verification Package exports. Verify reproducibility against current S3 state. Confirm Object Lock status honestly (no badge unless the platform probe verified the bucket)."}
      secondaryActions={
        <>
          <button
          type="button"
          className="apf-control"
          onClick={load}
          disabled={loading}
          >
          {loading ? "Refreshing…" : "Refresh"}
          </button>
        </>
      }
    />
  );

  if (!teamId) {
    return (
      <PageShell width="full" header={pageHeader}>
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="Operations Exports"
          headline="Switch to a workspace to inspect exports"
          reason="Export history is per-workspace. Open a workspace that produced exports."
          actions={[
            { label: "Open workspaces", href: "/workspaces", variant: "primary" },
          ]}
          testid="operations-exports-no-workspace"
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="full" header={pageHeader} data-testid="operations-exports-root">

      {error ? <div className="apf-note" data-tone="critical">{error}</div> : null}

      {/* THE LOCK PROBE'S OWN FAILURE, BESIDE THE PANEL IT BELONGS TO — not at
          the top of the page where it would read as "the exports failed", and
          not merged into `error`, which is the list's. `warning` rather than
          `critical`: the export list below is unaffected and complete. */}
      {lockError ? (
        <div className="apf-note" data-tone="warning">
          {lockError} The export list below is unaffected.
        </div>
      ) : null}

      <ObjectLockPanel status={objectLock} />

      <ExportListTable
        items={items}
        itemsLimit={itemsLimit}
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
    </PageShell>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function ObjectLockPanel({ status }: { status: ObjectLockStatus | null }) {
  if (!status) {
    return (
      <section className="adm-card" style={{ marginTop: 16 }}>
        <p className="apf-muted">Loading Object Lock status…</p>
      </section>
    );
  }
  const palette =
    status.mode === "verified"
      ? "verified"
      : status.mode === "claimed-but-unsupported"
        ? "risk"
        : status.mode === "skipped"
          ? "pending"
          : "neutral";
  return (
    <section
      className="adm-card" style={{ marginTop: 16 }}
      data-testid="object-lock-panel"
    >
      <h2 className="apf-section-title">S3 Object Lock platform status</h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Badge tone={palette} data-testid="object-lock-badge">
          {status.mode}
        </Badge>
        {status.mode === "verified" ? (
          <span className="apf-muted">
            Bucket {status.bucket}
            {status.defaultMode ? ` · default ${status.defaultMode}` : ""}
            {status.defaultRetainDays
              ? ` · ${status.defaultRetainDays}d retention`
              : ""}
          </span>
        ) : status.mode === "claimed-but-unsupported" ? (
          <span className="apf-muted">
            {status.bucket} · {status.reason}
          </span>
        ) : status.mode === "skipped" ? (
          <span className="apf-muted">{status.reason}</span>
        ) : (
          <span className="apf-muted">
            Object Lock is intentionally disabled. Exports persist but cannot
            be claimed as WORM.
          </span>
        )}
      </div>
      <p className="adm-help" style={{ marginTop: 8 }}>
        Checked {formatCellDateTime(status.checkedAtUtc)}.
      </p>
    </section>
  );
}

function ExportListTable({
  items,
  itemsLimit,
  objectLockMode,
  selectedId,
  onSelect,
}: {
  items: ExportListItem[] | null;
  /** The cap the list read under, from the route. */
  itemsLimit: number | undefined;
  objectLockMode: ObjectLockPlatformMode | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (items === null) {
    return (
      <section style={{ marginTop: 12 }}>
        <AdmSkeleton shape="row" count={3} />
      </section>
    );
  }
  if (items.length === 0) {
    /* THE CONSOLE HAS ONE EMPTY STATE, AND THIS WAS NOT IT.
       A 74px card with one CENTRED muted line and no label — every other
       empty in the console is a left-aligned 56px row that says WHICH state
       it is and why. Centred prose in a tall box is the ~25-instance shape
       this phase replaced everywhere else. */
    return (
      <section style={{ marginTop: 12 }}>
        <AdmInline state="empty" label="No exports yet">
          Nothing has been exported from this workspace. A Report PDF or a
          Verification Package appears here once one is produced.
        </AdmInline>
      </section>
    );
  }
  return (
    <section
      className="adm-card" style={{ marginTop: 12, padding: 0 }}
      data-testid="export-list"
    >
      <div className="apf-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Version</th>
              <th>Generated</th>
              <th>Size</th>
              <th>Object Lock</th>
              <th>Artifact signed</th>
              <th>{" "}</th>
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
                      ? { background: "var(--surface-muted)" }
                      : undefined
                  }
                >
                  <td>
                    <strong>{it.kindLabel}</strong>
                  </td>
                  <td>v{it.exportVersion}</td>
                  <td>
                    <span className="apf-muted">
                      {formatCellDateTime(it.generatedAtUtc)}
                    </span>
                  </td>
                  <td>
                    <span className="apf-muted">
                      {it.sizeBytes
                        ? `${Math.round(Number(it.sizeBytes) / 1024)} KB`
                        : "—"}
                    </span>
                  </td>
                  <td>
                    {immutable ? (
                      <Badge tone="verified">
                        IMMUTABLE · {it.objectLockStoredMode}
                      </Badge>
                    ) : it.objectLockStoredMode ? (
                      <Badge tone="pending">
                        STORED {it.objectLockStoredMode} (platform unverified)
                      </Badge>
                    ) : (
                      <Badge tone="neutral">
                        no lock
                      </Badge>
                    )}
                  </td>
                  <td>
                    {it.artifactSigned ? (
                      <Badge tone="info">
                        SIGNED
                      </Badge>
                    ) : it.artifactUnsignedOptOut ? (
                      <Badge tone="risk">
                        UNSIGNED OPT-OUT
                      </Badge>
                    ) : it.kind === "verification_package_zip" ? (
                      <Badge tone="neutral">
                        {it.verificationPackageSignatureStatus === "UNSIGNED"
                          ? "unsigned package"
                          : "unsigned"}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">
                        unsigned
                      </Badge>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="apf-control"
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
        {/* listExports clamps to [1, 200] and defaults to 50; the route now
            reports which applied. An export archive read to answer "was this
            ever produced" must not present a window as the archive. */}
        <ResultCount
          shown={items.length}
          cap={itemsLimit}
          noun="export"
          data-testid="admin-exports-count"
        />
      </div>
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
    <AdmOverlay
      shape="drawer"
      title="Export detail"
      subtitle="The manifest this export was produced from, and the checks that were run against it."
      onClose={onClose}
      testId="export-drawer"
    >
      
      {error ? <div className="apf-note" data-tone="critical">{error}</div> : null}

      {!envelope ? (
        <p className="apf-muted">Loading manifest…</p>
      ) : (
        <>
          <section>
            <h2 className="apf-section-title">Identity</h2>
            <div className="apf-table-wrap">
              <table className="adm-table">
                <tbody>
                  <tr>
                    <td>kind</td>
                    <td>{envelope.manifest.kindLabel}</td>
                  </tr>
                  <tr>
                    <td>exportId</td>
                    <td>
                      <code
                        style={{ fontFamily: "monospace", fontSize: 12 }}
                        data-testid="manifest-export-id"
                      >
                        {envelope.manifest.exportId}
                      </code>
                    </td>
                  </tr>
                  <tr>
                    <td>version</td>
                    <td>v{envelope.manifest.exportVersion}</td>
                  </tr>
                  <tr>
                    <td>generatedAtUtc</td>
                    <td>
                      {formatCellDateTime(envelope.manifest.generatedAtUtc)}
                    </td>
                  </tr>
                  <tr>
                    <td>manifestHash</td>
                    <td>
                      <code
                        style={{ fontFamily: "monospace", fontSize: 11 }}
                        data-testid="manifest-hash"
                      >
                        {envelope.manifestHash.slice(0, 24)}…
                      </code>
                      <Button variant="secondary" size="sm" style={{ marginInlineStart: 6 }}
                        onClick={() => copy(envelope.manifestHash)}
                      >
                        Copy
                      </Button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 className="apf-section-title">Signature status</h2>
            <div className="apf-table-wrap">
              <table className="adm-table">
                <tbody>
                  <tr>
                    <td>signed</td>
                    <td>
                      {envelope.manifest.signing.artifactSigned ? "YES" : "NO"}
                    </td>
                  </tr>
                  <tr>
                    <td>signing key id</td>
                    <td>
                      <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                        {envelope.manifest.signing.artifactSigningKeyId ?? "—"}
                      </code>
                    </td>
                  </tr>
                  <tr>
                    <td>signed at</td>
                    <td>
                      {formatCellDateTime(
                        envelope.manifest.signing.artifactSignedAtUtc,
                      )}
                    </td>
                  </tr>
                  {envelope.manifest.signing.artifactUnsignedOptOut ? (
                    <tr>
                      <td>opt-out</td>
                      <td>
                        <Badge tone="pending">
                          UNSIGNED OPT-OUT
                        </Badge>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 className="apf-section-title">Reproducibility verification</h2>
            <Button variant="primary" size="sm"
              onClick={verify}
              disabled={verifying}
              data-testid="verify-button"
            >
              {verifying ? "Verifying…" : "Verify reproducibility"}
            </Button>
            {report ? (
              <div style={{ marginTop: 12 }} data-testid="verify-result">
                <ReproducibilityResultPanel report={report} />
              </div>
            ) : (
              <p className="adm-help" style={{ marginTop: 8 }}>
                Run the verifier to re-derive the manifest hash, refetch the
                S3 artifact, and compare Object Lock state against the
                row's stored intent.
              </p>
            )}
          </section>

          <section style={{ marginTop: 16 }}>
            <h2 className="apf-section-title">Canonical manifest JSON</h2>
            <pre
              style={{
                background: "var(--surface-muted)",
                border: `1px solid var(--border-default)`,
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
              className="apf-control"
              onClick={() => copy(manifestJson)}
            >
              Copy manifest JSON
            </button>
          </section>
        </>
      )}
    </AdmOverlay>
  );
}

function ReproducibilityResultPanel({
  report,
}: {
  report: ReproducibilityReport;
}) {
  const palette =
    report.outcome === "match"
      ? "verified"
      : report.outcome === "artifact_missing"
        ? "risk"
        : report.outcome === "artifact_drift"
          ? "risk"
          : report.outcome === "retention_drift"
            ? "pending"
            : "neutral";
  return (
    <div>
      <Badge tone={palette} data-testid="verify-outcome">
        {report.outcome}
      </Badge>
      <p style={{ marginTop: 8, fontSize: 13 }}>{report.summary}</p>
      {report.checks.length > 0 ? (
        <div className="apf-table-wrap">
          <table className="adm-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Check</th>
                <th>Expected</th>
                <th>Actual</th>
                <th>OK</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((c) => (
                <tr key={c.field}>
                  <td>
                    <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                      {c.field}
                    </code>
                  </td>
                  <td>
                    <span className="apf-muted">
                      {c.expected
                        ? c.expected.length > 24
                          ? c.expected.slice(0, 24) + "…"
                          : c.expected
                        : "—"}
                    </span>
                  </td>
                  <td>
                    <span className="apf-muted">
                      {c.actual
                        ? c.actual.length > 24
                          ? c.actual.slice(0, 24) + "…"
                          : c.actual
                        : "—"}
                    </span>
                  </td>
                  <td>{c.ok ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="adm-help" style={{ marginTop: 6 }}>
        Verified {formatCellDateTime(report.verifiedAtUtc)}.
      </p>
    </div>
  );
}
