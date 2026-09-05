"use client";

/**
 * PLATFORM-ADMIN EVIDENCE CREDIT GRANT.
 *
 * WHY IT LIVES HERE. The grant is a decision about ONE account, taken while
 * looking at that account's commercial state — the plan, the lifecycle, the
 * balance already on the wallet. A standalone page would have to re-fetch and
 * re-render all of that to be usable, and would let an operator grant credits
 * to an id they had not looked at.
 *
 * WHAT IT IS NOT. It is not a purchase, and the copy says so in the first
 * sentence: no payment is taken, no plan changes and no limit moves. The
 * server owns everything that could be got wrong — the ledger entry type, the
 * reference format, the balance arithmetic — so this form carries a quantity,
 * a reason and the operator's own reference, and nothing else. There is no
 * provider field, no ledger-type field and no negative quantity, because none
 * of those are the operator's to choose.
 */

import * as React from "react";

import { Button } from "../../../../../components/ui/Button";
import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

/** Mirrors the server's bound. A form that offers more than the API accepts
 *  teaches an operator to discover limits by being refused. */
const MAX_CREDITS = 500;

type GrantResult = {
  userId: string;
  credits: number;
  applied: boolean;
  previousBalance: number;
  balanceAfter: number;
  grantRef: string;
};

export function EvidenceCreditGrant({
  userId,
  plan,
  availableCredits,
  onGranted,
}: {
  userId: string;
  /** The account's effective plan — shown so the operator can see it is unchanged. */
  plan: string | null;
  /** Current wallet balance, or null when it could not be read. */
  availableCredits: number | null;
  onGranted: () => void;
}) {
  const [credits, setCredits] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldError, setFieldError] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<GrantResult | null>(null);

  const quantityId = React.useId();
  const reasonId = React.useId();
  const referenceId = React.useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    /*
     * Validated here so an ordinary mistake is answered next to the field
     * that caused it rather than as a server banner — and validated again by
     * the server, which is the authority.
     */
    const n = Number(credits);
    const errs: Record<string, string> = {};
    if (!Number.isInteger(n) || n < 1) {
      errs.credits = "Enter a whole number of credits, at least 1.";
    } else if (n > MAX_CREDITS) {
      errs.credits = `The most that can be granted at once is ${MAX_CREDITS}.`;
    }
    if (reason.trim().length < 3) {
      errs.reason = "Say why. This is recorded in the audit trail.";
    }
    if (reference.trim().length < 3) {
      errs.reference = "A ticket or incident reference — it makes a retry safe.";
    }
    setFieldError(errs);
    if (Object.keys(errs).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const res = (await apiFetch("/v1/admin/billing/evidence-credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId,
          credits: n,
          reason: reason.trim(),
          idempotencyKey: reference.trim(),
        }),
      })) as GrantResult;
      setResult(res);
      onGranted();
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "The grant could not be completed." })
          .message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    /*
     * `noValidate`: the browser's own constraint bubble is not our design
     * system. `min`/`max` stay on the input because they drive the numeric
     * stepper and assistive technology, but the SENTENCE a person reads comes
     * from the validator below and appears next to the field.
     */
    <form
      className="adm-credit-grant"
      onSubmit={submit}
      noValidate
      data-admin-credit-grant
    >
      <p className="adm-credit-grant__lede">
        Add Evidence credits to this account <strong>without changing its
        plan</strong>. This is a platform grant, not a purchase — no payment is
        taken and it is recorded as a grant, not as a sale.
      </p>

      <dl className="adm-credit-grant__facts">
        <div>
          <dt>Plan</dt>
          <dd data-admin-credit-plan>{plan ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Credits now</dt>
          <dd data-admin-credit-balance>
            {availableCredits === null ? "Unavailable" : availableCredits}
          </dd>
        </div>
      </dl>

      <div className="adm-credit-grant__fields">
        <div className="adm-credit-grant__field">
          <label className="app-field-label" htmlFor={quantityId}>
            Quantity
          </label>
          <input
            id={quantityId}
            className="app-form-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_CREDITS}
            step={1}
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
            disabled={busy}
            aria-invalid={fieldError.credits ? true : undefined}
            aria-describedby={fieldError.credits ? `${quantityId}-err` : undefined}
            data-admin-credit-quantity
          />
          {fieldError.credits ? (
            <p className="app-field-error" id={`${quantityId}-err`} role="alert">
              {fieldError.credits}
            </p>
          ) : null}
        </div>

        <div className="adm-credit-grant__field">
          <label className="app-field-label" htmlFor={reasonId}>
            Reason
          </label>
          <input
            id={reasonId}
            className="app-form-input"
            type="text"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this account is being credited"
            disabled={busy}
            aria-invalid={fieldError.reason ? true : undefined}
            aria-describedby={fieldError.reason ? `${reasonId}-err` : undefined}
            data-admin-credit-reason
          />
          {fieldError.reason ? (
            <p className="app-field-error" id={`${reasonId}-err`} role="alert">
              {fieldError.reason}
            </p>
          ) : null}
        </div>

        <div className="adm-credit-grant__field">
          <label className="app-field-label" htmlFor={referenceId}>
            Reference
          </label>
          <input
            id={referenceId}
            className="app-form-input"
            type="text"
            maxLength={120}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Ticket or incident id"
            disabled={busy}
            aria-invalid={fieldError.reference ? true : undefined}
            aria-describedby={`${referenceId}-help`}
            data-admin-credit-reference
          />
          <p className="app-field-help" id={`${referenceId}-help`}>
            {fieldError.reference ??
              "Submitting the same reference for this account again changes nothing."}
          </p>
        </div>
      </div>

      {error ? (
        <p className="app-alert app-alert--danger" role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <p
          className="app-alert app-alert--ok"
          role="status"
          data-admin-credit-result
        >
          {result.applied ? (
            <>
              <strong>{result.credits} credits granted.</strong> Balance:{" "}
              {result.previousBalance} → {result.balanceAfter}
            </>
          ) : (
            <>
              <strong>Already applied.</strong> This reference had been used for
              this account, so nothing changed. Balance: {result.balanceAfter}
            </>
          )}
        </p>
      ) : null}

      <div className="adm-credit-grant__actions">
        <Button type="submit" disabled={busy}>
          {busy ? "Granting…" : "Grant credits"}
        </Button>
      </div>
    </form>
  );
}
