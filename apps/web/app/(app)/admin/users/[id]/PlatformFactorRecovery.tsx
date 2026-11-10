"use client";

/**
 * AUD-0039 — PLATFORM-CONTROLLED SECOND-FACTOR RECOVERY.
 *
 * A platform administrator who has lost their second factor cannot be
 * recovered by a customer workspace's administrators (the API refuses it), so
 * the platform does it here: another platform administrator, on a session that
 * verified a second factor, confirms their identity for this account and gives
 * a reason. The server removes the account's factors and unused recovery codes,
 * ends its sessions, and writes the platform audit trail; the operator signs in
 * again and is guided through enrolling a new factor.
 *
 * The server is the authority on who may be recovered: it refuses the
 * operator's own account and any account without platform authority.
 */

import * as React from "react";

import { Button } from "../../../../../components/ui/Button";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../components/identity-security/StepUpModal";
import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useActiveWorkspaceId } from "../../../../../lib/platform-context";

const REFUSALS: Record<string, string> = {
  self_recovery_forbidden: "Another platform administrator must recover your own second factor.",
  target_not_platform_authority:
    "This account does not hold platform authority. Its workspace's recovery process applies.",
};

function refusalReason(err: unknown): string | null {
  const e = err as { details?: { reason?: unknown }; body?: { error?: { details?: { reason?: unknown } } } };
  const reason = e?.details?.reason ?? e?.body?.error?.details?.reason;
  return typeof reason === "string" ? reason : null;
}

export function PlatformFactorRecovery({
  userId,
  onRecovered,
}: {
  userId: string;
  onRecovered: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<number | null>(null);

  // Step-up challenges are team-bound: the operator's own workspace is the
  // scope, and the approval names the account being recovered.
  const teamId = useActiveWorkspaceId();
  const stepUp = useStepUpAction({ teamId });
  const reasonId = React.useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (reason.trim().length < 10) {
      setFieldError("Say why, in at least 10 characters. This is recorded in the platform audit trail.");
      return;
    }
    setFieldError(null);
    if (!teamId) {
      setError("Your workspace context is still loading. Try again in a moment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch(`/v1/admin/users/${encodeURIComponent(userId)}/mfa/platform-recovery`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({ teamId, reason: reason.trim() }),
        }),
      )) as { recovered: boolean; revokedFactors: number };
      setDone(res.revokedFactors);
      onRecovered();
    } catch (err) {
      if ((err as { code?: string })?.code === "STEP_UP_CANCEL") return;
      const known = refusalReason(err);
      setError(
        (known && REFUSALS[known]) ??
          toSafeUserError(err, { message: "The recovery could not be completed." }).message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="adm-credit-grant" onSubmit={submit} noValidate data-admin-platform-recovery>
      <p className="adm-credit-grant__lede">
        Recover this platform administrator&apos;s second factor. Their current
        factors and unused recovery codes are removed and every session they hold
        ends. They sign in again and enrol a new factor before reaching platform
        administration.
      </p>
      <div className="adm-credit-grant__fields">
        <div className="adm-credit-grant__field">
          <label className="app-field-label" htmlFor={reasonId}>
            Reason
          </label>
          <input
            id={reasonId}
            className="app-form-input"
            type="text"
            maxLength={400}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="How the loss was reported and confirmed"
            disabled={busy || done !== null}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${reasonId}-err` : undefined}
            data-admin-platform-recovery-reason
          />
          {fieldError ? (
            <p className="app-field-error" id={`${reasonId}-err`} role="alert">
              {fieldError}
            </p>
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="app-alert app-alert--danger" role="alert">
          {error}
        </p>
      ) : null}
      {done !== null ? (
        <p className="app-alert app-alert--ok" role="status" data-admin-platform-recovery-result>
          <strong>Second factor recovered.</strong> {done} factor{done === 1 ? "" : "s"} removed; the
          administrator enrols a new one at their next sign-in.
        </p>
      ) : null}
      <div className="adm-credit-grant__actions">
        <Button type="submit" variant="secondary" disabled={busy || done !== null}>
          {busy ? "Recovering…" : "Recover second factor"}
        </Button>
      </div>
      <StepUpModal control={stepUp} />
    </form>
  );
}
