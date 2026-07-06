"use client";

/**
 * Phase P3.1 — Signer governance console.
 *
 * Consumes the P3.1 backend:
 *
 *   GET  /v1/operations/signers
 *   GET  /v1/operations/signers/:id
 *   GET  /v1/operations/signers/:id/health
 *   GET  /v1/operations/signers/:id/audit
 *   POST /v1/operations/signers/stage
 *   POST /v1/operations/signers/:id/preview
 *   POST /v1/operations/signers/:id/promote                 (step-up)
 *   POST /v1/operations/signers/:id/retire                  (step-up)
 *   POST /v1/operations/signers/:id/revoke                  (step-up)
 *   GET  /v1/operations/custody-attestations
 *   POST /v1/operations/custody-attestations/backfill       (step-up)
 *   POST /v1/operations/custody-attestations/:id/verify
 *
 * Sections:
 *   1. Purpose overview cards (Report PDF / Verification Package /
 *      Export Manifest / Custody Event) — each shows current active
 *      signer + provider + algorithm + health badge.
 *   2. Signer detail drawer — metadata, KMS health, rotation
 *      workflow (preview → promote / retire / revoke), audit timeline.
 *   3. Custody attestations panel — list, verify, backfill (step-up).
 *
 * Hard rules:
 *   * NO legal-overclaim copy: this surface is operational, not a
 *     legal-status assertion. Forbidden phrases are scrubbed by
 *     the source-contract test suite.
 *   * NO raw AWS credential / ARN exposure beyond the bounded
 *     `kmsKeyArn` field already present in the registry projection.
 *   * Step-up modal for promote / retire / revoke / backfill.
 *   * Bounded health states with operator-safe copy.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { AccessGate } from "../../../../components/access/AccessGate";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import {
  badgeStyle,
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
  subtitleStyle,
  successBoxStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "../../admin/identity/ui-tokens";

// ============================================================================
// Types
// ============================================================================

type SignerPurpose =
  | "report_pdf"
  | "verification_package"
  | "export_manifest"
  | "custody_event";

type SignerProvider = "aws_kms" | "local_pem" | "disabled";

type SignerStatus =
  | "active"
  | "staged"
  | "retiring"
  | "retired"
  | "revoked"
  | "degraded";

type SignerRecord = {
  signerId: string;
  signerPurpose: SignerPurpose;
  provider: SignerProvider;
  keyId: string | null;
  keyVersion: string | null;
  kmsKeyArn: string | null;
  algorithm: string | null;
  status: SignerStatus;
  activatedAtUtc: string | null;
  retiredAtUtc: string | null;
  lastUsedAtUtc: string | null;
  notes: string | null;
  verificationMaterialRef: string | null;
};

type SignerHealthState =
  | "healthy"
  | "degraded"
  | "unreachable"
  | "permission_denied"
  | "key_disabled"
  | "region_mismatch"
  | "unsupported_algorithm"
  | "unknown";

type SignerHealthSnapshot = {
  health: SignerHealthState;
  provider: SignerProvider;
  checkedAtUtc: string;
  reason: string | null;
  publicMaterialRef: string | null;
  algorithm: string | null;
  recommendedAction: string | null;
};

type SignerAuditEntry = {
  id: string;
  occurredAtUtc: string;
  eventType: string;
  severity: "INFO" | "WARNING" | "HIGH";
  actorUserId: string | null;
  signerId: string | null;
  summary: string;
};

type RotationPreview = {
  signerPurpose: SignerPurpose;
  currentActive: {
    signerId: string;
    provider: SignerProvider;
    keyId: string | null;
    keyVersion: string | null;
    algorithm: string | null;
  } | null;
  staged: {
    signerId: string;
    provider: SignerProvider;
    keyId: string | null;
    keyVersion: string | null;
    algorithm: string | null;
  };
  compatibility:
    | "compatible"
    | "algorithm_change"
    | "provider_change"
    | "purpose_change"
    | "unverifiable";
  warnings: ReadonlyArray<string>;
  rolloutPlan: string;
  generatedAtUtc: string;
};

type AttestationListItem = {
  attestationId: string;
  custodyEventId: string;
  evidenceId: string;
  signerId: string;
  signedAtUtc: string;
  outcome: "verified" | "pending" | "invalid";
};

type VerifyAttestationResult = {
  outcome:
    | "verified"
    | "missing_attestation"
    | "signature_invalid"
    | "payload_hash_mismatch"
    | "signer_unavailable"
    | "unsupported_algorithm"
    | "not_applicable";
  summary: string;
  attestation: {
    signerId: string;
    keyId: string | null;
    keyVersion: string | null;
    canonicalPayloadHash: string;
    algorithm: string;
    provider: string;
    signedAtUtc: string;
  } | null;
  recomputedPayloadHash: string | null;
  verifiedAtUtc: string;
};

const PURPOSE_LABELS: Record<SignerPurpose, string> = {
  report_pdf: "Report PDF",
  verification_package: "Verification Package",
  export_manifest: "Export Manifest",
  custody_event: "Custody Event",
};

// ============================================================================
// Page shell
// ============================================================================

export default function OperationsSignersPage() {
  return (
    <PageRouteGate routeId="workspace.security_center">
      <OperationsSignersContent />
    </PageRouteGate>
  );
}

function OperationsSignersContent() {
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });
  const [signers, setSigners] = useState<SignerRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attestations, setAttestations] =
    useState<AttestationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] =
    useState<VerifyAttestationResult | null>(null);

  const load = useCallback(() => {
    if (!teamId) return;
    setError(null);
    Promise.all([
      apiFetch(`/v1/operations/signers?teamId=${encodeURIComponent(teamId)}`, {
        method: "GET",
      }),
      apiFetch(
        `/v1/operations/custody-attestations?teamId=${encodeURIComponent(
          teamId,
        )}&limit=50`,
        { method: "GET" },
      ),
    ])
      .then(([sRes, aRes]) => {
        setSigners((sRes as { signers: SignerRecord[] }).signers ?? []);
        setAttestations(
          (aRes as { attestations: AttestationListItem[] }).attestations ?? [],
        );
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load signer governance." }).message),
      );
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const verifyAttestation = useCallback(
    async (attestationId: string) => {
      if (!teamId) return;
      setBusy(attestationId);
      setVerifyResult(null);
      try {
        const r = (await apiFetch(
          `/v1/operations/custody-attestations/${encodeURIComponent(
            attestationId,
          )}/verify`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId }),
          },
        )) as { report: VerifyAttestationResult };
        setVerifyResult(r.report);
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Verification failed." }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId],
  );

  const runBackfill = useCallback(async () => {
    if (!teamId) return;
    setBusy("backfill");
    setError(null);
    setSuccess(null);
    try {
      const r = (await stepUp.runStepUpAction(async (headers) => {
        return (await apiFetch(
          "/v1/operations/custody-attestations/backfill",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({ teamId, batchSize: 50 }),
          },
        )) as {
          result: { scanned: number; signed: number; skipped: number; failed: number };
        };
      })) as {
        result: { scanned: number; signed: number; skipped: number; failed: number };
      };
      setSuccess(
        `Backfill batch complete — scanned ${r.result.scanned}, signed ${r.result.signed}, skipped ${r.result.skipped}, failed ${r.result.failed}.`,
      );
      load();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        setError("Step-up cancelled — backfill did not run.");
      } else {
        setError(
          toSafeUserError(err, { message: "Backfill failed." }).message,
        );
      }
    } finally {
      setBusy(null);
    }
  }, [teamId, stepUp, load]);

  if (!teamId) {
    return (
      <main style={pageStyle}>
        <AccessGate
          kind="WORKSPACE_REQUIRED"
          surface="Signer Governance"
          headline="Switch to a team workspace to manage signers"
          reason="Signer governance is workspace-attributed for audit."
          actions={[
            { label: "Open team workspaces", href: "/teams", variant: "primary" },
          ]}
          testid="signer-governance-no-workspace"
        />
      </main>
    );
  }

  return (
    <main style={pageStyle} data-testid="operations-signers-root">
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Signer Governance</h1>
          <p style={subtitleStyle}>
            Inspect the active signer per artifact kind, run KMS health
            probes, stage and promote rotations, and verify detached
            custody attestations. Historical artifacts retain their
            original signer metadata — promoting a new signer only
            affects future signatures.
          </p>
        </div>
        <button type="button" style={ghostButtonStyle} onClick={load}>
          Refresh
        </button>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {success ? <div style={successBoxStyle}>{success}</div> : null}

      <PurposeOverview
        signers={signers}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />

      {selectedId ? (
        <SignerDetailDrawer
          teamId={teamId}
          signerId={selectedId}
          stepUp={stepUp}
          onClose={() => setSelectedId(null)}
          onSuccess={(msg) => {
            setSuccess(msg);
            load();
          }}
          onError={setError}
        />
      ) : null}

      <CustodyAttestationsPanel
        attestations={attestations}
        verifyResult={verifyResult}
        busy={busy}
        onVerify={verifyAttestation}
        onBackfill={runBackfill}
      />

      <StepUpModal control={stepUp} />
    </main>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function statusBadge(s: SignerStatus) {
  if (s === "active")
    return badgeStyle({ bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" });
  if (s === "staged")
    return badgeStyle({ bg: "#eef2ff", fg: "#3730a3", border: "#c7d2fe" });
  if (s === "retiring")
    return badgeStyle({ bg: "#fef3c7", fg: "#78350f", border: "#fde68a" });
  if (s === "retired")
    return badgeStyle({ bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" });
  if (s === "revoked")
    return badgeStyle({ bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" });
  return badgeStyle({ bg: "#fef3c7", fg: "#78350f", border: "#fde68a" });
}

function PurposeOverview({
  signers,
  selectedId,
  onSelect,
}: {
  signers: SignerRecord[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (signers === null) {
    return (
      <section style={{ ...cardStyle, marginTop: 16 }}>
        <p style={mutedStyle}>Loading signer registry…</p>
      </section>
    );
  }
  const purposes: SignerPurpose[] = [
    "report_pdf",
    "verification_package",
    "export_manifest",
    "custody_event",
  ];
  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: 8,
        marginTop: 16,
      }}
      data-testid="signer-overview"
    >
      {purposes.map((p) => {
        const active = signers.find(
          (s) => s.signerPurpose === p && s.status === "active",
        );
        const staged = signers.filter(
          (s) => s.signerPurpose === p && s.status === "staged",
        );
        return (
          <div key={p} style={{ ...cardStyle, padding: 12 }}>
            <strong style={{ fontSize: 14 }}>{PURPOSE_LABELS[p]}</strong>
            {active ? (
              <div style={{ marginTop: 8 }}>
                <span style={statusBadge(active.status)}>{active.status}</span>
                <div
                  style={{
                    ...mutedStyle,
                    fontSize: 11,
                    marginTop: 4,
                    fontFamily: "monospace",
                  }}
                >
                  {active.provider} ·{" "}
                  {active.keyId ? active.keyId.slice(0, 18) : "—"}
                  {active.keyVersion ? `:v${active.keyVersion}` : ""}
                </div>
                <div style={{ ...mutedStyle, fontSize: 11 }}>
                  {active.algorithm ?? "—"}
                </div>
                <button
                  type="button"
                  style={{ ...ghostButtonStyle, marginTop: 8 }}
                  onClick={() => onSelect(active.signerId)}
                >
                  {selectedId === active.signerId ? "Selected" : "Inspect"}
                </button>
              </div>
            ) : (
              <p style={{ ...mutedStyle, marginTop: 8 }}>
                No active signer for this purpose.
              </p>
            )}
            {staged.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ ...mutedStyle, fontSize: 11 }}>
                  Staged ({staged.length})
                </div>
                {staged.map((s) => (
                  <button
                    key={s.signerId}
                    type="button"
                    style={{
                      ...ghostButtonStyle,
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      marginTop: 4,
                      fontFamily: "monospace",
                      fontSize: 11,
                    }}
                    onClick={() => onSelect(s.signerId)}
                  >
                    {s.signerId.slice(0, 36)}
                    {s.signerId.length > 36 ? "…" : ""}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function SignerDetailDrawer({
  teamId,
  signerId,
  stepUp,
  onClose,
  onSuccess,
  onError,
}: {
  teamId: string;
  signerId: string;
  stepUp: ReturnType<typeof useStepUpAction>;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [signer, setSigner] = useState<SignerRecord | null>(null);
  const [health, setHealth] = useState<SignerHealthSnapshot | null>(null);
  const [audit, setAudit] = useState<SignerAuditEntry[] | null>(null);
  const [preview, setPreview] = useState<RotationPreview | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(
      `/v1/operations/signers/${encodeURIComponent(
        signerId,
      )}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: { signer: SignerRecord }) => setSigner(r.signer))
      .catch((err: { message?: string }) =>
        onError(toSafeUserError(err, { message: "Could not load signer." }).message),
      );
    apiFetch(
      `/v1/operations/signers/${encodeURIComponent(
        signerId,
      )}/audit?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: { events: SignerAuditEntry[] }) => setAudit(r.events))
      .catch(() => undefined);
  }, [teamId, signerId, onError]);

  const runHealth = useCallback(async () => {
    setBusy("health");
    try {
      const r = (await apiFetch(
        `/v1/operations/signers/${encodeURIComponent(
          signerId,
        )}/health?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { snapshot: SignerHealthSnapshot };
      setHealth(r.snapshot);
    } catch (err) {
      onError(toSafeUserError(err, { message: "Health probe failed." }).message);
    } finally {
      setBusy(null);
    }
  }, [teamId, signerId, onError]);

  const runPreview = useCallback(async () => {
    setBusy("preview");
    try {
      const r = (await apiFetch(
        `/v1/operations/signers/${encodeURIComponent(signerId)}/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      )) as { preview: RotationPreview };
      setPreview(r.preview);
    } catch (err) {
      onError(toSafeUserError(err, { message: "Preview failed." }).message);
    } finally {
      setBusy(null);
    }
  }, [teamId, signerId, onError]);

  const runStepUpAction = useCallback(
    async (action: "promote" | "retire" | "revoke") => {
      if (reason.trim().length === 0) {
        onError("Operator reason is required.");
        return;
      }
      setBusy(action);
      try {
        await stepUp.runStepUpAction(async (headers) => {
          return await apiFetch(
            `/v1/operations/signers/${encodeURIComponent(signerId)}/${action}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(headers ?? {}),
              },
              body: JSON.stringify({ teamId, reason: reason.trim() }),
            },
          );
        });
        onSuccess(`Signer ${action} recorded.`);
        setReason("");
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          onError(`Step-up cancelled — no ${action} performed.`);
        } else {
          onError(toSafeUserError(err, { message: `${action} failed.` }).message);
        }
      } finally {
        setBusy(null);
      }
    },
    [teamId, signerId, reason, stepUp, onSuccess, onError],
  );

  if (!signer) {
    return (
      <section style={{ ...cardStyle, marginTop: 12 }}>
        <p style={mutedStyle}>Loading signer detail…</p>
      </section>
    );
  }

  return (
    <section
      style={{ ...cardStyle, marginTop: 12 }}
      data-testid="signer-detail"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h3 style={sectionTitleStyle}>
          {PURPOSE_LABELS[signer.signerPurpose]}{" "}
          <span
            style={{
              ...mutedStyle,
              fontFamily: "monospace",
              fontWeight: 400,
            }}
          >
            · {signer.signerId.slice(0, 48)}
            {signer.signerId.length > 48 ? "…" : ""}
          </span>
        </h3>
        <button type="button" style={ghostButtonStyle} onClick={onClose}>
          Close
        </button>
      </div>

      <table style={tableStyle}>
        <tbody>
          <tr>
            <td style={tdStyle}>status</td>
            <td style={tdStyle}>
              <span style={statusBadge(signer.status)}>{signer.status}</span>
            </td>
          </tr>
          <tr>
            <td style={tdStyle}>provider</td>
            <td style={tdStyle}>{signer.provider}</td>
          </tr>
          <tr>
            <td style={tdStyle}>algorithm</td>
            <td style={tdStyle}>{signer.algorithm ?? "—"}</td>
          </tr>
          <tr>
            <td style={tdStyle}>keyId</td>
            <td style={tdStyle}>
              <code style={{ fontFamily: "monospace" }}>
                {signer.keyId ?? "—"}
              </code>
            </td>
          </tr>
          <tr>
            <td style={tdStyle}>keyVersion</td>
            <td style={tdStyle}>{signer.keyVersion ?? "—"}</td>
          </tr>
          {signer.kmsKeyArn ? (
            <tr>
              <td style={tdStyle}>KMS alias / ARN reference</td>
              <td style={tdStyle}>
                <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                  {signer.kmsKeyArn}
                </code>
              </td>
            </tr>
          ) : null}
          {signer.verificationMaterialRef ? (
            <tr>
              <td style={tdStyle}>verification material</td>
              <td style={tdStyle}>
                <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                  {signer.verificationMaterialRef}
                </code>
              </td>
            </tr>
          ) : null}
          {signer.activatedAtUtc ? (
            <tr>
              <td style={tdStyle}>activatedAtUtc</td>
              <td style={tdStyle}>{formatDateTime(signer.activatedAtUtc)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <section style={{ marginTop: 16 }}>
        <h4 style={sectionTitleStyle}>Health</h4>
        <button
          type="button"
          style={ghostButtonStyle}
          onClick={runHealth}
          disabled={busy !== null}
          data-testid="run-health"
        >
          {busy === "health" ? "Probing…" : "Run health probe"}
        </button>
        {health ? (
          <div style={{ marginTop: 8 }}>
            <span
              style={badgeStyle(
                health.health === "healthy"
                  ? { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" }
                  : health.health === "unreachable" ||
                      health.health === "key_disabled"
                    ? { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" }
                    : { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
              )}
            >
              {health.health}
            </span>
            <p style={{ ...mutedStyle, marginTop: 6 }}>
              {health.reason ? `Reason: ${health.reason}. ` : ""}
              Checked {formatDateTime(health.checkedAtUtc)}.
            </p>
            {health.recommendedAction ? (
              <p style={{ fontSize: 12 }}>
                <strong>Recommended:</strong> {health.recommendedAction}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section style={{ marginTop: 16 }}>
        <h4 style={sectionTitleStyle}>Rotation workflow</h4>
        <button
          type="button"
          style={ghostButtonStyle}
          onClick={runPreview}
          disabled={busy !== null || signer.status !== "staged"}
        >
          {busy === "preview" ? "Previewing…" : "Preview rotation"}
        </button>
        {preview ? (
          <div style={{ marginTop: 8 }}>
            <span
              style={badgeStyle(
                preview.compatibility === "compatible"
                  ? { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" }
                  : { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
              )}
            >
              {preview.compatibility}
            </span>
            <ul style={{ marginTop: 8, fontSize: 12, paddingLeft: 18 }}>
              {preview.warnings.map((w) => (
                <li key={w}>
                  <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {w}
                  </code>
                </li>
              ))}
            </ul>
            <p style={{ ...mutedStyle, marginTop: 6, fontSize: 12 }}>
              {preview.rolloutPlan}
            </p>
          </div>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <label style={{ display: "block", fontSize: 12 }}>
            Operator reason (required for promote / retire / revoke)
            <input
              style={{ ...inputStyle, marginTop: 4 }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. quarterly key rotation; staged signer validated by team"
              data-testid="signer-reason"
            />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy !== null}
              onClick={() => runStepUpAction("promote")}
              data-testid="signer-promote"
            >
              Promote (step-up)
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              disabled={busy !== null}
              onClick={() => runStepUpAction("retire")}
              data-testid="signer-retire"
            >
              Retire (step-up)
            </button>
            <button
              type="button"
              style={{
                ...ghostButtonStyle,
                color: "#991b1b",
                borderColor: "#fecaca",
              }}
              disabled={busy !== null}
              onClick={() => runStepUpAction("revoke")}
              data-testid="signer-revoke"
            >
              Revoke (step-up)
            </button>
          </div>
        </div>
      </section>

      {audit && audit.length > 0 ? (
        <section style={{ marginTop: 16 }}>
          <h4 style={sectionTitleStyle}>Audit timeline</h4>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Occurred</th>
                <th style={thStyle}>Event</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Actor</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e) => (
                <tr key={e.id}>
                  <td style={tdStyle}>
                    <span style={mutedStyle}>
                      {formatDateTime(e.occurredAtUtc)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontSize: 12 }}>{e.summary}</div>
                    <div
                      style={{
                        ...mutedStyle,
                        fontFamily: "monospace",
                        fontSize: 10,
                      }}
                    >
                      {e.eventType}
                    </div>
                  </td>
                  <td style={tdStyle}>{e.severity}</td>
                  <td style={tdStyle}>
                    <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                      {e.actorUserId ? e.actorUserId.slice(0, 12) + "…" : "—"}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </section>
  );
}

function CustodyAttestationsPanel({
  attestations,
  verifyResult,
  busy,
  onVerify,
  onBackfill,
}: {
  attestations: AttestationListItem[] | null;
  verifyResult: VerifyAttestationResult | null;
  busy: string | null;
  onVerify: (id: string) => void;
  onBackfill: () => void;
}) {
  return (
    <section
      style={{ ...cardStyle, marginTop: 12, padding: 0 }}
      data-testid="custody-attestations"
    >
      <div
        style={{
          padding: 12,
          borderBottom: `1px solid ${TOKENS.border}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 14 }}>Detached custody attestations</strong>
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy !== null}
          onClick={onBackfill}
          data-testid="run-backfill"
        >
          {busy === "backfill"
            ? "Running…"
            : "Backfill 50 events (step-up)"}
        </button>
      </div>
      {attestations === null ? (
        <p style={{ ...mutedStyle, padding: 16 }}>Loading…</p>
      ) : attestations.length === 0 ? (
        <p style={{ ...mutedStyle, padding: 24 }}>
          No custody attestations recorded. Run a backfill to attest historical
          custody events.
        </p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Attestation id</th>
              <th style={thStyle}>Evidence</th>
              <th style={thStyle}>Signer</th>
              <th style={thStyle}>Signed</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {attestations.map((a) => (
              <tr key={a.attestationId}>
                <td style={tdStyle}>
                  <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {a.attestationId.slice(0, 28)}
                    {a.attestationId.length > 28 ? "…" : ""}
                  </code>
                </td>
                <td style={tdStyle}>
                  <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {a.evidenceId.slice(0, 12)}…
                  </code>
                </td>
                <td style={tdStyle}>
                  <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {a.signerId.slice(0, 28)}
                    {a.signerId.length > 28 ? "…" : ""}
                  </code>
                </td>
                <td style={tdStyle}>
                  <span style={mutedStyle}>
                    {formatDateTime(a.signedAtUtc)}
                  </span>
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    style={ghostButtonStyle}
                    disabled={busy === a.attestationId}
                    onClick={() => onVerify(a.attestationId)}
                    data-testid={`verify-${a.attestationId}`}
                  >
                    {busy === a.attestationId ? "Verifying…" : "Verify"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {verifyResult ? (
        <div
          style={{
            padding: 12,
            borderTop: `1px solid ${TOKENS.border}`,
            background: TOKENS.surfaceMuted,
          }}
          data-testid="verify-result"
        >
          <span
            style={badgeStyle(
              verifyResult.outcome === "verified"
                ? { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" }
                : verifyResult.outcome === "missing_attestation"
                  ? { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" }
                  : { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
            )}
          >
            {verifyResult.outcome}
          </span>
          <p style={{ marginTop: 6, fontSize: 13 }}>{verifyResult.summary}</p>
          {verifyResult.attestation ? (
            <p style={{ ...mutedStyle, fontSize: 11 }}>
              Signer{" "}
              <code style={{ fontFamily: "monospace" }}>
                {verifyResult.attestation.signerId}
              </code>{" "}
              · key version {verifyResult.attestation.keyVersion ?? "—"} ·
              algorithm {verifyResult.attestation.algorithm}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
