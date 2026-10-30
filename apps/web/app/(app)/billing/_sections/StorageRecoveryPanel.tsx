"use client";

/**
 * BILLING REMEDIATION (2026-10-30, AUD-18) — an open storage purchase, resolved
 * where the customer ran into it.
 *
 * The server refuses a second storage checkout while one is open and names the
 * attempt (`retry: "RECONCILE_STORAGE_ATTEMPT"`). Nothing read that, so the
 * refusal was a dead end inside the drawer, with the way out on the page behind
 * it. This offers the same two actions as the Billing activity row, on the same
 * endpoints, in the place the question came up.
 *
 * WHAT IT DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 * Whether the purchase may be retried. That is the server's answer, reported
 * through `onUnblocked` only when the check says the attempt is finished. Until
 * then it is an open purchase, and the only honest options are to look at it, to
 * finish it, or to give up on it.
 *
 * "Continue at PayPal" appears only when the check returned a link. PayPal's GET
 * does not promise one, so it cannot be offered on faith.
 */

import { useEffect, useRef, useState } from "react";

import { Button } from "../../../../components/ui/Button";
import { ProovraSupportReference } from "../../../../components/feedback/ProovraSupportReference";
import {
  abandonCheckoutAttempt,
  recheckCheckoutAttempt,
  type BillingAccountRef,
} from "../../../../lib/api/billing-accounts";
import { captureException } from "../../../../lib/sentry";
import {
  describeAttemptAbandon,
  describeBillingError,
  describeStorageAttemptCheck,
  safeCheckoutResumeUrl,
} from "./billingMessages";
import { formatDate } from "./format";

/** The refusal's own details, kept as the server sent them. */
export type StorageRecovery = {
  attemptId: string;
  /** Which provider holds the open purchase, as the refusal named it. */
  pendingProvider: string | null;
  createdAtUtc: string | null;
};

type PanelNotice = { message: string; supportReference?: string };

function introduction(recovery: StorageRecovery): string {
  const started = formatDate(recovery.createdAtUtc);
  const since = started ? ` (started ${started})` : "";
  const where =
    recovery.pendingProvider === "STRIPE"
      ? "by card"
      : recovery.pendingProvider === "PAYPAL"
        ? "with PayPal"
        : "with your payment provider";
  // "Open", never "waiting for your approval": this refusal does not say whether
  // the customer has approved it. Check status does.
  return `A storage purchase is already open ${where}${since}. Check it before buying again, so you are not billed twice.`;
}

export function StorageRecoveryPanel({
  recovery,
  account,
  onChanged,
  onUnblocked,
}: {
  recovery: StorageRecovery;
  account: BillingAccountRef;
  /** Billing may have moved: re-read the account behind the drawer. */
  onChanged: () => void;
  /** The attempt is finished, so another purchase can no longer double up. */
  onUnblocked: () => void;
}) {
  const [busy, setBusy] = useState<"CHECK" | "ABANDON" | null>(null);
  const [notice, setNotice] = useState<PanelNotice | null>(null);
  const [resumeUrl, setResumeUrl] = useState<string | null>(null);
  const [canAbandon, setCanAbandon] = useState(true);
  const [finished, setFinished] = useState(false);
  const [confirming, setConfirming] = useState<{
    warning: string;
    cancelsAtProvider: boolean;
  } | null>(null);

  // The refusal replaces the button the customer just pressed, so the keyboard
  // goes with it instead of being left on a control that can no longer help.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);

  async function checkStatus() {
    setBusy("CHECK");
    setConfirming(null);
    try {
      const result = await recheckCheckoutAttempt(account, recovery.attemptId);
      const resume = result.outcome === "STILL_PENDING" ? safeCheckoutResumeUrl(result.resumeUrl) : null;
      const check = describeStorageAttemptCheck({ ...result, resumeUrl: resume });
      setNotice({ message: check.message });
      setResumeUrl(resume);
      setCanAbandon(check.canAbandon);
      if (!check.blocked) {
        setFinished(true);
        onUnblocked();
      }
      onChanged();
    } catch (err) {
      captureException(err, { feature: "billing_storage_attempt_recheck" });
      setNotice(
        describeBillingError(err, {
          message: "We could not check this purchase just now. Try again in a moment.",
        }),
      );
    } finally {
      setBusy(null);
    }
  }

  async function abandon(confirmed: boolean) {
    setBusy("ABANDON");
    try {
      const result = await abandonCheckoutAttempt(account, recovery.attemptId, confirmed);
      if (result.outcome === "ABANDON_CONFIRMATION_REQUIRED") {
        setConfirming({
          warning:
            result.warning ??
            "Abandoning only removes this from PROOVRA's open purchases. It does not cancel anything at the payment provider.",
          cancelsAtProvider: result.cancelsAtProvider,
        });
        return;
      }
      setConfirming(null);
      setNotice({ message: describeAttemptAbandon(result).message });
      setResumeUrl(null);
      if (result.outcome === "ABANDON_NOT_ALLOWED") {
        setCanAbandon(false);
      } else if (result.outcome !== "PROVIDER_CANCEL_FAILED") {
        setFinished(true);
        onUnblocked();
      }
      onChanged();
    } catch (err) {
      captureException(err, { feature: "billing_storage_attempt_abandon" });
      setNotice(
        describeBillingError(err, {
          message: "We could not abandon this purchase just now. It is still open.",
        }),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      ref={panel}
      tabIndex={-1}
      className="bill-summary"
      data-billing-storage-recovery={recovery.attemptId}
    >
      <p className="bill-choice__meta">{introduction(recovery)}</p>

      {/* The answer is announced when it changes; the buttons stay outside the
          live region so they are not read out with it. */}
      <div role="status" aria-live="polite">
        {notice ? (
          <>
            <p className="bill-summary__note" data-billing-storage-recovery-notice>
              {notice.message}
            </p>
            <ProovraSupportReference reference={notice.supportReference} compact />
          </>
        ) : null}
      </div>

      {confirming ? (
        <div data-billing-storage-abandon-confirm>
          <p className="bill-summary__note">{confirming.warning}</p>
          <div className="bill-panel__actions">
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "ABANDON"}
              disabled={busy !== null}
              onClick={() => void abandon(true)}
              data-billing-storage-abandon-confirmed
            >
              {confirming.cancelsAtProvider ? "Close checkout" : "Abandon in PROOVRA"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => setConfirming(null)}
              data-billing-storage-abandon-keep
            >
              Keep it
            </Button>
          </div>
        </div>
      ) : null}

      {!finished && !confirming ? (
        <div className="bill-panel__actions">
          {resumeUrl ? (
            <a
              href={resumeUrl}
              className="bill-resume-link"
              rel="noopener noreferrer"
              data-billing-storage-recovery-resume
            >
              {recovery.pendingProvider === "STRIPE" ? "Continue checkout" : "Continue at PayPal"}
            </a>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            className="bill-secondary-action"
            loading={busy === "CHECK"}
            disabled={busy !== null}
            onClick={() => void checkStatus()}
            data-billing-storage-recovery-check
          >
            Check status
          </Button>
          {canAbandon ? (
            <Button
              variant="ghost"
              size="sm"
              loading={busy === "ABANDON"}
              disabled={busy !== null}
              onClick={() => void abandon(false)}
              data-billing-storage-recovery-abandon
            >
              Abandon
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
