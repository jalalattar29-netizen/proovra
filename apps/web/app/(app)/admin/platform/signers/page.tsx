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

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { useTeamId } from "../../../../../lib/platform-context";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import "../admin-platform.css";
import { AccessGate } from "../../../../../components/access/AccessGate";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { FilterBar } from "../../../../../components/ui/FilterBar";
import { ResultCount } from "../../../../../components/ui/ResultCount";
import { redactKmsKeyReference } from "../../../../../lib/privacy/kms-reference";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import {
  AdmInline,
} from "../../../../../components/admin/AdminSurfaces";
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { TOKENS, badgeStyle, formatDateTime } from "../../identity/ui-tokens";

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

/**
 * The attestation query.
 *
 * A partial uuid is NOT sent: the endpoint validates `evidenceId` as a uuid,
 * so a half-typed value is a 400 — and an operator mid-type would see an error
 * rather than a narrowing list. Below a complete id the list stays unfiltered
 * and the input says so.
 */
function attestationQuery(teamId: string, evidenceId: string): string {
  const p = new URLSearchParams();
  p.set("teamId", teamId);
  p.set("limit", "50");
  const trimmed = evidenceId.trim();
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
  ) {
    p.set("evidenceId", trimmed);
  }
  return p.toString();
}

export default function OperationsSignersPage() {
  return (
    <PageRouteGate routeId="operations.signers">
      <OperationsSignersContent />
    </PageRouteGate>
  );
}

function OperationsSignersContent() {
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });
  const [signers, setSigners] = useState<SignerRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * The evidence filter the endpoint has always accepted.
   *
   * GET /v1/operations/custody-attestations takes `evidenceId`; this page
   * never sent it, so verifying one item's custody meant reading a 50-row
   * list. Server-side — and until this change the SERVER side of it was
   * broken too: it fetched a window and filtered in JavaScript, so a match
   * outside the window returned an empty list, which reads as "this evidence
   * has no attestation".
   */
  const [evidenceFilter, setEvidenceFilter] = useState("");
  const [attestationTotal, setAttestationTotal] = useState<number | null>(null);
  const [attestationLimit, setAttestationLimit] = useState<number | null>(null);
  const [attestations, setAttestations] =
    useState<AttestationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] =
    useState<VerifyAttestationResult | null>(null);
  const { confirm } = useConfirmAction();

  const load = useCallback(() => {
    if (!teamId) return;
    setError(null);
    Promise.all([
      apiFetch(`/v1/operations/signers?teamId=${encodeURIComponent(teamId)}`, {
        method: "GET",
      }),
      apiFetch(
        `/v1/operations/custody-attestations?${attestationQuery(
          teamId,
          evidenceFilter,
        )}`,
        { method: "GET" },
      ),
    ])
      .then(([sRes, aRes]) => {
        setSigners((sRes as { signers: SignerRecord[] }).signers ?? []);
        const a = aRes as {
          attestations?: AttestationListItem[];
          total?: number;
          limit?: number;
        };
        setAttestations(a.attestations ?? []);
        setAttestationTotal(typeof a.total === "number" ? a.total : null);
        setAttestationLimit(typeof a.limit === "number" ? a.limit : null);
      })
      .catch((err: { message?: string }) =>
        setError(toSafeUserError(err, { message: "Could not load signer governance." }).message),
      );
  }, [teamId, evidenceFilter]);

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
    if (!teamId || busy !== null) return;
    /**
     * Writes signed attestations into the custody ledger of the active
     * workspace — evidence-adjacent, not undoable, and step-up gated. The
     * operator confirms the scope and the bound before the challenge starts.
     */
    const ok = await confirm({
      title: "Backfill custody attestations for this workspace?",
      description:
        "Signs up to 50 custody events in the active workspace that have no attestation yet and records each signature in the attestation ledger. Events that are already attested are skipped, so running it twice does not sign anything twice.",
      confirmLabel: "Run backfill",
      tone: "warning",
      testId: "custody-backfill",
    });
    if (!ok) return;
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
  }, [teamId, stepUp, load, busy, confirm]);

  const pageHeader = (
    <PageHeader
      eyebrow="Platform operations"
      title="Signer Governance"
      subtitle={"Inspect the active signer per artifact kind, run KMS health probes, stage and promote rotations, and verify detached custody attestations. Historical artifacts retain their original signer metadata — promoting a new signer only affects future signatures."}
      secondaryActions={
        <>
          <button type="button" className="apf-control" onClick={load}>
          Refresh
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
          surface="Signer Governance"
          headline="Switch to a workspace to manage signers"
          reason="Signer governance is workspace-attributed for audit."
          actions={[
            { label: "Open workspaces", href: "/workspaces", variant: "primary" },
          ]}
          testid="signer-governance-no-workspace"
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="full" header={pageHeader} data-testid="operations-signers-root">

      {error ? <div className="apf-note" data-tone="critical">{error}</div> : null}
      {success ? <AdmInline state="done">{success}</AdmInline> : null}

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
        total={attestationTotal}
        limit={attestationLimit}
        evidenceFilter={evidenceFilter}
        onEvidenceFilterChange={setEvidenceFilter}
        verifyResult={verifyResult}
        busy={busy}
        onVerify={verifyAttestation}
        onBackfill={runBackfill}
      />

      <StepUpModal control={stepUp} />
    </PageShell>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function statusBadge(s: SignerStatus) {
  if (s === "active")
    return "verified";
  if (s === "staged")
    return "info";
  if (s === "retiring")
    return "pending";
  if (s === "retired")
    return "neutral";
  if (s === "revoked")
    return "risk";
  return "pending";
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
      <section className="adm-card" style={{ marginTop: 16 }}>
        <p className="apf-muted">Loading signer registry…</p>
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
          <div key={p} className="adm-card" style={{ padding: 12 }}>
            <strong style={{ fontSize: 14 }}>{PURPOSE_LABELS[p]}</strong>
            {active ? (
              <div style={{ marginTop: 8 }}>
                <Badge tone={statusBadge(active.status)}>{active.status}</Badge>
                <div
                  className="adm-help"
                  style={{
                    fontSize: 11,
                    marginTop: 4,
                    fontFamily: "monospace",
                  }}
                >
                  {active.provider} ·{" "}
                  {active.keyId ? active.keyId.slice(0, 18) : "—"}
                  {active.keyVersion ? `:v${active.keyVersion}` : ""}
                </div>
                <div className="adm-help" style={{ fontSize: 11 }}>
                  {active.algorithm ?? "—"}
                </div>
                <Button variant="secondary" size="sm" style={{ marginTop: 8 }}
                  onClick={() => onSelect(active.signerId)}
                >
                  {selectedId === active.signerId ? "Selected" : "Inspect"}
                </Button>
              </div>
            ) : (
              <p className="adm-help" style={{ marginTop: 8 }}>
                No active signer for this purpose.
              </p>
            )}
            {staged.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <div className="adm-help" style={{ fontSize: 11 }}>
                  Staged ({staged.length})
                </div>
                {staged.map((s) => (
                  <Button variant="secondary" size="sm"
                    key={s.signerId} style={{ display: "block", width: "100%", textAlign: "left", marginTop: 4, fontFamily: "monospace" }}
                    onClick={() => onSelect(s.signerId)}
                  >
                    {s.signerId.slice(0, 36)}
                    {s.signerId.length > 36 ? "…" : ""}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

/**
 * The signing key, reduced.
 *
 * This row used to print `signer.kmsKeyArn` verbatim — partition, region,
 * AWS ACCOUNT ID and full key uuid — under the label "KMS alias / ARN
 * reference". Nothing a signer-page reader does needs the account id, and
 * being allowed to see the signer registry is not authorization to publish
 * the account it runs in into a browser tab and every screenshot of it.
 *
 * The reduction keeps what the page is FOR: which key, and whether two
 * signers share one. Region stays, because a signer in the wrong region is a
 * real incident finding.
 */
function KmsKeyRow({ arn }: { arn: string | null }) {
  const ref = redactKmsKeyReference(arn);
  if (!ref) return null;
  return (
    <tr>
      <td>KMS key</td>
      <td>
        <code style={{ fontFamily: "monospace", fontSize: 11 }}>
          {ref.display}
        </code>
        {ref.redacted ? (
          <span
            style={{ marginInlineStart: 8, fontSize: 11, color: "var(--ink-muted)" }}
            title="Shortened for display. The full key reference is not shown in the console."
          >
            shortened
          </span>
        ) : null}
      </td>
    </tr>
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
  const { confirm } = useConfirmAction();

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
      if (busy !== null) return;
      if (reason.trim().length === 0) {
        onError("Operator reason is required.");
        return;
      }
      /**
       * A signer lifecycle change decides which key signs the platform's
       * material from now on. Each leg is named for what it does to THIS
       * signer before the step-up challenge starts; revoke, which cannot be
       * undone, is typed.
       */
      const label = signer
        ? `${signer.signerId} (${signer.signerPurpose.replace(/_/g, " ")})`
        : signerId;
      const ok = await confirm({
        title:
          action === "promote"
            ? "Promote this signer to active?"
            : action === "retire"
              ? "Retire this signer?"
              : "Revoke this signer?",
        description:
          action === "promote"
            ? `${label} becomes the active signer for its purpose. New material is signed with it from now on; the signer it replaces stops being used for new material.`
            : action === "retire"
              ? `${label} stops being used for new material. Material already signed with it is not changed.`
              : `${label} is withdrawn immediately and cannot be used again. Material already signed with it is not changed. This cannot be undone.`,
        confirmLabel:
          action === "promote" ? "Promote" : action === "retire" ? "Retire" : "Revoke signer",
        tone: action === "revoke" ? "danger" : "warning",
        ...(action === "revoke" ? { requireConfirmText: "REVOKE" } : {}),
        testId: `signer-${action}-confirm`,
      });
      if (!ok) return;
      setBusy(action);
      try {
        const res = (await stepUp.runStepUpAction(async (headers) => {
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
        })) as { result?: { state?: string; status?: string } } | undefined;

        // "Recorded" was the old copy, and it was the honest word for what the
        // old backend did: it recorded an event and changed nothing. Now the
        // transition is real, so the message says which of the two things
        // actually happened — a change, or a no-op because it already held.
        const state = res?.result?.state;
        onSuccess(
          state === "already"
            ? `No change — this signer is already ${String(res?.result?.status ?? "").toLowerCase()}.`
            : action === "revoke"
              ? "Signer revoked. It can no longer sign new material."
              : action === "retire"
                ? "Signer retired. It will not be selected for new material."
                : "Signer promoted.",
        );
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
    [teamId, signerId, signer, reason, stepUp, onSuccess, onError, busy, confirm],
  );

  if (!signer) {
    return (
      <section className="adm-card" style={{ marginTop: 12 }}>
        <p className="apf-muted">Loading signer detail…</p>
      </section>
    );
  }

  // Retire and revoke are terminal in the domain's transition table. Offering
  // a button the server will refuse is a worse experience than not offering
  // it, and it is the sort of thing that made the old no-op look plausible.
  const terminalState = signer.status === "revoked" || signer.status === "retired";

  return (
    <section
      className="adm-card" style={{ marginTop: 12 }}
      data-testid="signer-detail"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 className="apf-section-title">
          {PURPOSE_LABELS[signer.signerPurpose]}{" "}
          <span
            className="adm-help"
            style={{
              fontFamily: "monospace",
              fontWeight: 400,
            }}
          >
            · {signer.signerId.slice(0, 48)}
            {signer.signerId.length > 48 ? "…" : ""}
          </span>
        </h2>
        <button type="button" className="apf-control" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="apf-table-wrap">
        <table className="adm-table">
          <tbody>
            <tr>
              <td>status</td>
              <td>
                <Badge tone={statusBadge(signer.status)}>{signer.status}</Badge>
              </td>
            </tr>
            <tr>
              <td>provider</td>
              <td>{signer.provider}</td>
            </tr>
            <tr>
              <td>algorithm</td>
              <td>{signer.algorithm ?? "—"}</td>
            </tr>
            <tr>
              <td>keyId</td>
              <td>
                <code style={{ fontFamily: "monospace" }}>
                  {signer.keyId ?? "—"}
                </code>
              </td>
            </tr>
            <tr>
              <td>keyVersion</td>
              <td>{signer.keyVersion ?? "—"}</td>
            </tr>
            <KmsKeyRow arn={signer.kmsKeyArn} />
            {signer.verificationMaterialRef ? (
              <tr>
                <td>verification material</td>
                <td>
                  <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {signer.verificationMaterialRef}
                  </code>
                </td>
              </tr>
            ) : null}
            {signer.activatedAtUtc ? (
              <tr>
                <td>activatedAtUtc</td>
                <td>{formatDateTime(signer.activatedAtUtc)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <section style={{ marginTop: 16 }}>
        <h4 className="apf-section-title">Health</h4>
        <button
          type="button"
          className="apf-control"
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
                  ? { bg: "var(--success-subtle-bg)", fg: "var(--success-strong)", border: "var(--success-border)" }
                  : health.health === "unreachable" ||
                      health.health === "key_disabled"
                    ? { bg: "var(--danger-subtle-bg)", fg: "var(--danger-strong)", border: "var(--danger-border)" }
                    : { bg: "var(--warning-subtle-bg)", fg: "var(--warning-strong)", border: "var(--warning-border)" },
              )}
            >
              {health.health}
            </span>
            <p className="adm-help" style={{ marginTop: 6 }}>
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
        <h4 className="apf-section-title">Rotation workflow</h4>
        <button
          type="button"
          className="apf-control"
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
                  ? { bg: "var(--success-subtle-bg)", fg: "var(--success-strong)", border: "var(--success-border)" }
                  : { bg: "var(--warning-subtle-bg)", fg: "var(--warning-strong)", border: "var(--warning-border)" },
              )}
            >
              {preview.compatibility}
            </span>
            <ul style={{ marginTop: 8, fontSize: 12, paddingInlineStart: 18 }}>
              {preview.warnings.map((w) => (
                <li key={w}>
                  <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {w}
                  </code>
                </li>
              ))}
            </ul>
            <p className="adm-help" style={{ marginTop: 6, fontSize: 12 }}>
              {preview.rolloutPlan}
            </p>
          </div>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <label style={{ display: "block", fontSize: 12 }}>
            Operator reason (required for promote / retire / revoke)
            <input
              className="adm-input" style={{ marginTop: 4 }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. quarterly key rotation; staged signer validated by team"
              data-testid="signer-reason"
            />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button variant="primary" size="sm"
              disabled={busy !== null}
              onClick={() => runStepUpAction("promote")}
              data-testid="signer-promote"
            >
              Promote (step-up)
            </Button>
            <button
              type="button"
              className="apf-control"
              disabled={busy !== null || terminalState}
              title={terminalState ? `A ${signer.status} signer cannot be retired.` : undefined}
              onClick={() => runStepUpAction("retire")}
              data-testid="signer-retire"
            >
              Retire (step-up)
            </button>
            <Button variant="destructive" size="sm"
              disabled={busy !== null || signer.status === "revoked"}
              title={signer.status === "revoked" ? "This signer is already revoked." : undefined}
              onClick={() => runStepUpAction("revoke")}
              data-testid="signer-revoke"
            >
              Revoke (step-up)
            </Button>
          </div>
        </div>
      </section>

      {audit && audit.length > 0 ? (
        <section style={{ marginTop: 16 }}>
          <h4 className="apf-section-title">Audit timeline</h4>
          <div className="apf-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Occurred</th>
                  <th>Event</th>
                  <th>Severity</th>
                  <th>Actor</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <span className="apf-muted">
                        {formatDateTime(e.occurredAtUtc)}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontSize: 12 }}>{e.summary}</div>
                      <div
                        className="adm-help"
                        style={{
                          fontFamily: "monospace",
                          fontSize: 11,
                        }}
                      >
                        {e.eventType}
                      </div>
                    </td>
                    <td>{e.severity}</td>
                    <td>
                      <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                        {e.actorUserId ? e.actorUserId.slice(0, 12) + "…" : "—"}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function CustodyAttestationsPanel({
  attestations,
  total,
  limit,
  evidenceFilter,
  onEvidenceFilterChange,
  verifyResult,
  busy,
  onVerify,
  onBackfill,
}: {
  attestations: AttestationListItem[] | null;
  /** The server's count for the current filter; null when it sent none. */
  total: number | null;
  /** The cap the request asked for, echoed back. */
  limit: number | null;
  evidenceFilter: string;
  onEvidenceFilterChange: (value: string) => void;
  verifyResult: VerifyAttestationResult | null;
  busy: string | null;
  onVerify: (id: string) => void;
  onBackfill: () => void;
}) {
  return (
    <section
      className="adm-card" style={{ marginTop: 12, padding: 0 }}
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
        <Button variant="primary" size="sm"
          disabled={busy !== null}
          onClick={onBackfill}
          data-testid="run-backfill"
        >
          {busy === "backfill"
            ? "Running…"
            : "Backfill 50 events (step-up)"}
        </Button>
      </div>
      {/* Server-side, and only once the value is a complete uuid — the
          endpoint validates it as one, so sending a half-typed id would be a
          400 while the operator is still typing. */}
      <FilterBar style={{ padding: "0 16px 12px" }}>
        <FilterBar.Search
          label="Evidence ID"
          placeholder="Full evidence UUID"
          value={evidenceFilter}
          onChange={onEvidenceFilterChange}
        />
      </FilterBar>
      <ResultCount
        shown={attestations?.length ?? 0}
        total={total ?? undefined}
        cap={limit ?? undefined}
        noun="attestation"
        filtered={evidenceFilter.trim() !== ""}
        loading={attestations === null}
        style={{ padding: "0 16px", marginTop: 0 }}
        data-testid="admin-signers-attestations-count"
      />
      {attestations === null ? (
        <p className="adm-help" style={{ padding: 16 }}>Loading…</p>
      ) : attestations.length === 0 ? (
        <p className="adm-help" style={{ padding: 24 }}>
          {evidenceFilter.trim() !== ""
            ? "No custody attestation matches that evidence ID. Clearing the filter shows every recorded attestation."
            : "No custody attestations recorded. Run a backfill to attest historical custody events."}
        </p>
      ) : (
        <div className="apf-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Attestation id</th>
                <th>Evidence</th>
                <th>Signer</th>
                <th>Signed</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {attestations.map((a) => (
                <tr key={a.attestationId}>
                  <td>
                    <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                      {a.attestationId.slice(0, 28)}
                      {a.attestationId.length > 28 ? "…" : ""}
                    </code>
                  </td>
                  <td>
                    <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                      {a.evidenceId.slice(0, 12)}…
                    </code>
                  </td>
                  <td>
                    <code style={{ fontFamily: "monospace", fontSize: 11 }}>
                      {a.signerId.slice(0, 28)}
                      {a.signerId.length > 28 ? "…" : ""}
                    </code>
                  </td>
                  <td>
                    <span className="apf-muted">
                      {formatDateTime(a.signedAtUtc)}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="apf-control"
                      disabled={busy === a.attestationId}
                      onClick={() => onVerify(a.attestationId)}
                      aria-label={`Verify attestation ${a.attestationId} for evidence ${a.evidenceId}`}
                      title="Re-checks this attestation's signature against its custody event and shows the report. Nothing is written."
                      data-testid={`verify-${a.attestationId}`}
                    >
                      {busy === a.attestationId ? "Verifying…" : "Verify"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
                ? { bg: "var(--success-subtle-bg)", fg: "var(--success-strong)", border: "var(--success-border)" }
                : verifyResult.outcome === "missing_attestation"
                  ? { bg: "var(--surface-muted)", fg: "var(--ink-secondary)", border: "var(--border-standard)" }
                  : { bg: "var(--danger-subtle-bg)", fg: "var(--danger-strong)", border: "var(--danger-border)" },
            )}
          >
            {verifyResult.outcome}
          </span>
          <p style={{ marginTop: 6, fontSize: 13 }}>{verifyResult.summary}</p>
          {verifyResult.attestation ? (
            <p className="adm-help" style={{ fontSize: 11 }}>
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
