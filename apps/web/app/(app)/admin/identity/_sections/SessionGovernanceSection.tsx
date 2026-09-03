"use client";

/**
 * PHASE 12B — Session governance: contributor revocation + operator-triggered
 * reconciliation.
 *
 *   POST /v1/identity/contributor-sessions/:id/revoke
 *   POST /v1/admin/identity/sessions/reconcile-stale
 *   POST /v1/admin/identity/runtime/reconcile
 *
 * The two reconciles are the SAME sweeps the scheduler runs; triggering one by
 * hand is a mutation (it revokes stale sessions, releases quarantines, decays
 * trusted devices), so each one confirms, runs through step-up, and reports the
 * SERVER's outcome counts. Nothing here is fire-and-forget: if the sweep
 * changed nothing, the surface says it changed nothing.
 *
 * Contributor sessions have no list endpoint in the platform, so revocation is
 * targeted by the session id shown on the intake surface. A session id from
 * another organization is indistinguishable from one that does not exist, and
 * an already-revoked session is reported as such rather than as a success.
 */

import { useCallback, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { useTenantGuard } from "../../../../../lib/platform-context";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { PageSection } from "../../../../../components/ui/PageShell";
import { StatusBadge } from "../../../../../components/ui/StatusBadge";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  classifyFailure,
  isStepUpCancel,
  type SurfaceFailure,
} from "./identity-admin-shared";
import { inputStyle, mutedStyle } from "../ui-tokens";

type StepUpControl = {
  runStepUpAction: <T>(action: (headers?: Record<string, string>) => Promise<T>) => Promise<T>;
};

type RevokedSession = {
  id: string;
  status: string;
  revokedAtUtc: string | null;
  revokedReason: string | null;
  lastSeenAtUtc: string | null;
};

type StaleReconcileResult = {
  sessions: { scanned: number; staleDetected: number; swept: number };
  callbackAttempts: { swept: number };
};

type RuntimeReconcileResult = {
  risk: {
    scanned: number;
    recomputed: number;
    skippedCooldown: number;
    escalatedToQuarantine: number;
    highRiskCount: number;
  };
  decay: {
    scanned: number;
    decayed: number;
    autoInvalidated: number;
    quarantined: number;
  };
  releases: { released: number };
  geo: { swept: number; remaining: number };
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatUserDateTime(iso);
  } catch {
    return iso;
  }
}

export function SessionGovernanceSection({ stepUp }: { stepUp: StepUpControl }) {
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();

  const [sessionId, setSessionId] = useState("");
  const [reason, setReason] = useState("");
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revoked, setRevoked] = useState<RevokedSession | null>(null);
  const [revokeFailure, setRevokeFailure] = useState<SurfaceFailure | null>(null);

  const [staleBusy, setStaleBusy] = useState(false);
  const [staleResult, setStaleResult] = useState<StaleReconcileResult | null>(
    null,
  );
  const [staleFailure, setStaleFailure] = useState<SurfaceFailure | null>(null);

  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeResult, setRuntimeResult] =
    useState<RuntimeReconcileResult | null>(null);
  const [runtimeFailure, setRuntimeFailure] = useState<SurfaceFailure | null>(
    null,
  );

  // ---------------------------------------------------------------------------
  // Contributor session revocation
  // ---------------------------------------------------------------------------

  const revokeContributor = useCallback(async () => {
    const id = sessionId.trim();
    if (!UUID_RE.test(id)) {
      setRevokeFailure({
        kind: "error",
        message: "Enter the contributor session id shown on the intake surface.",
      });
      return;
    }
    const ok = await confirm({
      title: "Revoke this contributor session?",
      description:
        "The external contributor loses access to the intake link immediately and cannot resume. Anything they already submitted is retained.",
      confirmLabel: "Revoke session",
      tone: "danger",
      testId: "identity-contributor-session-revoke",
    });
    if (!ok) return;
    const captured = stamp();
    setRevokeBusy(true);
    setRevokeFailure(null);
    setRevoked(null);
    try {
      const res = await stepUp.runStepUpAction((headers) =>
        apiFetch(`/v1/identity/contributor-sessions/${id}/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      );
      if (isStale(captured)) return;
      setRevoked(((res as { session?: RevokedSession })?.session ?? null));
    } catch (err) {
      if (isStale(captured)) return;
      if (isStepUpCancel(err)) return;
      setRevokeFailure(
        classifyFailure(err, "Could not revoke the contributor session."),
      );
    } finally {
      if (!isStale(captured)) setRevokeBusy(false);
    }
  }, [sessionId, reason, confirm, stepUp, stamp, isStale]);

  // ---------------------------------------------------------------------------
  // Reconciles
  // ---------------------------------------------------------------------------

  const reconcileStale = useCallback(async () => {
    const ok = await confirm({
      title: "Reconcile stale sessions now?",
      description:
        "Sessions idle past the workspace threshold are revoked, abandoned sign-in attempts are cleared, and the high-risk gauge is refreshed. People with revoked sessions must sign in again.",
      confirmLabel: "Run reconcile",
      tone: "danger",
      testId: "identity-reconcile-stale",
    });
    if (!ok) return;
    const captured = stamp();
    setStaleBusy(true);
    setStaleFailure(null);
    setStaleResult(null);
    try {
      const res = await stepUp.runStepUpAction((headers) =>
        apiFetch("/v1/admin/identity/sessions/reconcile-stale", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({}),
        }),
      );
      if (isStale(captured)) return;
      setStaleResult(res as StaleReconcileResult);
    } catch (err) {
      if (isStale(captured)) return;
      if (isStepUpCancel(err)) return;
      setStaleFailure(
        classifyFailure(err, "Could not run the stale-session reconcile."),
      );
    } finally {
      if (!isStale(captured)) setStaleBusy(false);
    }
  }, [confirm, stepUp, stamp, isStale]);

  const reconcileRuntime = useCallback(async () => {
    const ok = await confirm({
      title: "Run the runtime reconcile now?",
      description:
        "Session risk is recomputed, stale trusted devices decay, quarantines whose hold has elapsed are released, and the geo cache is swept.",
      confirmLabel: "Run reconcile",
      tone: "danger",
      testId: "identity-reconcile-runtime",
    });
    if (!ok) return;
    const captured = stamp();
    setRuntimeBusy(true);
    setRuntimeFailure(null);
    setRuntimeResult(null);
    try {
      const res = await stepUp.runStepUpAction((headers) =>
        apiFetch("/v1/admin/identity/runtime/reconcile", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({}),
        }),
      );
      if (isStale(captured)) return;
      setRuntimeResult(res as RuntimeReconcileResult);
    } catch (err) {
      if (isStale(captured)) return;
      if (isStepUpCancel(err)) return;
      setRuntimeFailure(
        classifyFailure(err, "Could not run the runtime reconcile."),
      );
    } finally {
      if (!isStale(captured)) setRuntimeBusy(false);
    }
  }, [confirm, stepUp, stamp, isStale]);

  return (
    <PageSection
      title="Session governance"
      description="Revoke a single external contributor session, or run the same reconciliation sweeps the scheduler runs and see exactly what changed."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 12,
        }}
      >
        <Card
          variant="admin"
          padding="comfortable"
          title="Contributor session"
          data-identity-contributor-session-panel
        >
          <p style={{ ...mutedStyle, marginTop: 0 }}>
            Contributor sessions belong to intake links, not to members. Copy the
            session id from the intake surface; a session from another
            organization will report as not found.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              data-identity-contributor-session-id
              aria-label="Contributor session id (UUID) to revoke"
              style={{ ...inputStyle, maxWidth: 320 }}
              value={sessionId}
              placeholder="Contributor session id (UUID)"
              onChange={(e) => setSessionId(e.target.value.trim())}
            />
            <input
              data-identity-contributor-session-reason
              aria-label="Optional reason for revoking the contributor session"
              style={{ ...inputStyle, maxWidth: 240 }}
              value={reason}
              maxLength={400}
              placeholder="Reason (optional)"
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              variant="destructive"
              size="sm"
              data-identity-contributor-session-revoke
              disabled={revokeBusy || sessionId.trim().length === 0}
              loading={revokeBusy}
              onClick={() => void revokeContributor()}
            >
              Revoke session
            </Button>
          </div>
          {revokeFailure ? (
            <div
              data-identity-contributor-session-failure={revokeFailure.kind}
              style={{ ...mutedStyle, marginTop: 8, color: "#991b1b" }}
            >
              {revokeFailure.message}
            </div>
          ) : null}
          {revoked ? (
            <div
              data-identity-contributor-session-result
              style={{ marginTop: 10, fontSize: 12 }}
            >
              <StatusBadge status={revoked.status} />
              <div style={{ ...mutedStyle, marginTop: 4 }}>
                revoked {fmt(revoked.revokedAtUtc)}
                {revoked.revokedReason ? ` · ${revoked.revokedReason}` : ""}
              </div>
            </div>
          ) : null}
        </Card>

        <Card
          variant="admin"
          padding="comfortable"
          title="Stale session reconcile"
          data-identity-reconcile-stale-panel
        >
          <p style={{ ...mutedStyle, marginTop: 0 }}>
            Revokes sessions idle beyond the workspace threshold and clears
            abandoned sign-in attempts.
          </p>
          <Button
            variant="secondary"
            size="sm"
            data-identity-reconcile-stale
            disabled={staleBusy}
            loading={staleBusy}
            onClick={() => void reconcileStale()}
          >
            Run stale reconcile
          </Button>
          {staleFailure ? (
            <div
              data-identity-reconcile-stale-failure={staleFailure.kind}
              style={{ ...mutedStyle, marginTop: 8, color: "#991b1b" }}
            >
              {staleFailure.message}
            </div>
          ) : null}
          {staleResult ? (
            <ul
              data-identity-reconcile-stale-result
              style={{ ...mutedStyle, marginTop: 10, paddingLeft: 18 }}
            >
              <li>{staleResult.sessions.scanned} sessions scanned</li>
              <li>{staleResult.sessions.staleDetected} found stale</li>
              <li>{staleResult.sessions.swept} revoked</li>
              <li>
                {staleResult.callbackAttempts.swept} abandoned sign-in attempts
                cleared
              </li>
            </ul>
          ) : null}
        </Card>

        <Card
          variant="admin"
          padding="comfortable"
          title="Runtime reconcile"
          data-identity-reconcile-runtime-panel
        >
          <p style={{ ...mutedStyle, marginTop: 0 }}>
            Recomputes session risk, decays stale trusted devices, releases
            elapsed quarantines, sweeps the geo cache.
          </p>
          <Button
            variant="secondary"
            size="sm"
            data-identity-reconcile-runtime
            disabled={runtimeBusy}
            loading={runtimeBusy}
            onClick={() => void reconcileRuntime()}
          >
            Run runtime reconcile
          </Button>
          {runtimeFailure ? (
            <div
              data-identity-reconcile-runtime-failure={runtimeFailure.kind}
              style={{ ...mutedStyle, marginTop: 8, color: "#991b1b" }}
            >
              {runtimeFailure.message}
            </div>
          ) : null}
          {runtimeResult ? (
            <ul
              data-identity-reconcile-runtime-result
              style={{ ...mutedStyle, marginTop: 10, paddingLeft: 18 }}
            >
              <li>
                {runtimeResult.risk.recomputed} of {runtimeResult.risk.scanned}{" "}
                sessions re-scored ({runtimeResult.risk.highRiskCount} high risk,{" "}
                {runtimeResult.risk.escalatedToQuarantine} quarantined)
              </li>
              <li>
                {runtimeResult.decay.decayed} trusted devices decayed,{" "}
                {runtimeResult.decay.autoInvalidated} invalidated
              </li>
              <li>{runtimeResult.releases.released} quarantines released</li>
              <li>
                geo cache: {runtimeResult.geo.swept} expired entries removed,{" "}
                {runtimeResult.geo.remaining} remaining
              </li>
            </ul>
          ) : null}
        </Card>
      </div>
    </PageSection>
  );
}
