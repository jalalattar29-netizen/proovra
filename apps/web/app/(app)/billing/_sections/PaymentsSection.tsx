"use client";

/**
 * PHASE 12 VERTICAL A (2026-07-30) — Payments & entitlement.
 *
 * Completes the two billing operations that had no product surface by
 * folding them into the SAME workflow a customer already performs on the
 * Billing page — "what did I pay, and does the app agree with what I
 * bought?":
 *
 *   GET  /v1/billing/payments  — the canonical payment LEDGER. The overview
 *                                aggregate carries a snapshot for the summary
 *                                cards; the history below re-reads the
 *                                dedicated ledger so it can be refreshed (and
 *                                widened) without re-deriving the aggregate.
 *   POST /v1/billing/restore   — "restore purchases". A provider checkout
 *                                completes out-of-band (Stripe/PayPal
 *                                webhook), so returning to the app early
 *                                shows a stale entitlement. This re-reads the
 *                                SERVER-AUTHORITATIVE commercial state and
 *                                reloads the whole page projection from it.
 *
 * Hard rules honoured here:
 *   - Subject is SERVER-DERIVED. Neither call sends a userId, teamId or plan;
 *     the session alone identifies the payer. There is nothing for a client
 *     to declare and therefore nothing to spoof.
 *   - NO client-side plan/role decision. The restore outcome is rendered from
 *     the server's own bounded `restore` envelope; this component never
 *     compares plan strings to decide what a customer is entitled to.
 *   - DISTINCT states. Loading, empty, DENIED (403), legal-gate (428),
 *     and error are four different renders — a denial never masquerades as
 *     "no payments yet".
 *   - Tenant-generation guard around every await, so a workspace switch
 *     mid-flight drops the stale response instead of painting it.
 *   - No token, signed URL or provider secret is ever placed in state; the
 *     ledger projection carries only the provider's own payment id, which is
 *     already operator-visible on the receipt.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { captureException } from "../../../../lib/sentry";
import { useTenantGuard } from "../../../../lib/platform-context";
import { Button } from "../../../../components/ui/Button";
import { Skeleton } from "../../../../components/ui";
import { BillingHistoryCard } from "../../../../components/billing/BillingHistoryCard";
import { formatUserDateTime } from "../../../../lib/date";
import type { BillingPaymentSummary } from "../../../../components/billing/types";

/** Bounded, server-decided restore outcome. Rendered verbatim. */
type RestoreOutcome = {
  restoredAtUtc: string;
  plan: string;
  credits: number;
  ownedWorkspaceCount: number;
};

type LedgerState =
  | { kind: "LOADING" }
  /** Server answered; `items` may legitimately be empty. */
  | { kind: "READY"; items: BillingPaymentSummary[] }
  /** 403 — authenticated, but not permitted to read this ledger. */
  | { kind: "DENIED" }
  /** 428 — the account must accept the current policies first. */
  | { kind: "LEGAL_REQUIRED" }
  | { kind: "ERROR"; title: string; message: string };

function readStatus(err: unknown): number | null {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : null;
}

function readCode(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c.toUpperCase() : "";
}

function isLegalGate(err: unknown): boolean {
  return readStatus(err) === 428 || readCode(err).includes("LEGAL_REACCEPT");
}

const noticeBox: React.CSSProperties = {
  borderRadius: 10,
  border: "1px solid",
  padding: "12px 14px",
  fontSize: 13,
  lineHeight: 1.6,
};

export function PaymentsSection({
  onEntitlementRestored,
}: {
  /**
   * Re-reads the page's own server projection after a restore, so the plan,
   * workspace and add-on panels above cannot disagree with the entitlement
   * the server just confirmed.
   */
  onEntitlementRestored: () => Promise<void> | void;
}) {
  const { stamp, isStale } = useTenantGuard();

  const [ledger, setLedger] = useState<LedgerState>({ kind: "LOADING" });
  const [restoring, setRestoring] = useState(false);
  const [restoreOutcome, setRestoreOutcome] = useState<RestoreOutcome | null>(null);
  const [restoreError, setRestoreError] = useState<{ title: string; message: string } | null>(
    null,
  );

  const loadLedger = useCallback(async () => {
    const captured = stamp();
    setLedger({ kind: "LOADING" });
    try {
      const data = (await apiFetch("/v1/billing/payments")) as {
        items?: BillingPaymentSummary[];
      } | null;
      if (isStale(captured)) return;
      setLedger({
        kind: "READY",
        items: Array.isArray(data?.items) ? data.items : [],
      });
    } catch (err) {
      if (isStale(captured)) return;
      if (readStatus(err) === 403) {
        setLedger({ kind: "DENIED" });
        return;
      }
      if (isLegalGate(err)) {
        setLedger({ kind: "LEGAL_REQUIRED" });
        return;
      }
      captureException(err, { feature: "billing_payment_ledger" });
      const safe = toSafeUserError(err, {
        message: "Payment history could not be loaded.",
      });
      setLedger({ kind: "ERROR", title: safe.title, message: safe.message });
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  const restorePurchases = useCallback(async () => {
    const captured = stamp();
    setRestoring(true);
    setRestoreError(null);
    setRestoreOutcome(null);
    try {
      const data = (await apiFetch("/v1/billing/restore", {
        method: "POST",
        body: "{}",
      })) as { restore?: RestoreOutcome } | null;
      if (isStale(captured)) return;
      // The outcome is whatever the SERVER decided — the client does not
      // infer "restored" from any local plan comparison.
      setRestoreOutcome(data?.restore ?? null);
      // Reload BOTH server projections so nothing on the page is stale.
      await onEntitlementRestored();
      if (isStale(captured)) return;
      await loadLedger();
    } catch (err) {
      if (isStale(captured)) return;
      if (isLegalGate(err)) {
        setRestoreError({
          title: "Accept the current policies first",
          message:
            "Your account must accept the latest policies before billing changes can be applied. Open Settings → Privacy & legal records to review and accept them.",
        });
        return;
      }
      captureException(err, { feature: "billing_restore_entitlement" });
      const safe = toSafeUserError(err, {
        message: "Your purchases could not be re-checked. Try again in a moment.",
      });
      setRestoreError({ title: safe.title, message: safe.message });
    } finally {
      setRestoring(false);
    }
  }, [stamp, isStale, loadLedger, onEntitlementRestored]);

  return (
    <div style={{ display: "grid", gap: 16 }} data-billing-payments-section>
      {/* ------------------------------------------------------------------
          Entitlement re-sync. Safe to repeat: the server recomputes state
          from the persisted subscription rows, so retrying converges rather
          than double-charging or double-granting.
      ------------------------------------------------------------------ */}
      <div className="cases-panel" style={{ padding: "20px 22px" }} data-billing-restore>
        <div className="text-[1.05rem] font-semibold tracking-[-0.02em] text-[#172033]">
          Missing something you paid for?
        </div>
        <p className="mt-1 mb-0 text-[0.9rem] leading-[1.7] text-[#475569]">
          Payment providers confirm a purchase a few moments after checkout. If
          you have just paid and this page still shows the old plan, re-check
          with the payment provider — nothing is charged again and it is safe to
          repeat.
        </p>

        <div className="mt-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void restorePurchases()}
            loading={restoring}
            disabled={restoring}
            data-billing-restore-action
          >
            Re-check my purchases
          </Button>
        </div>

        {restoreOutcome ? (
          <div
            role="status"
            className="mt-3"
            data-billing-restore-outcome
            style={{
              ...noticeBox,
              borderColor: "rgba(47,125,91,0.35)",
              background: "rgba(47,125,91,0.07)",
              color: "#215e44",
            }}
          >
            Checked {formatUserDateTime(restoreOutcome.restoredAtUtc)}. Your
            account is on <strong>{restoreOutcome.plan}</strong> with{" "}
            {restoreOutcome.credits} credits and{" "}
            {restoreOutcome.ownedWorkspaceCount} workspace
            {restoreOutcome.ownedWorkspaceCount === 1 ? "" : "s"} you own.
          </div>
        ) : null}

        {restoreError ? (
          <div
            role="alert"
            className="mt-3"
            data-billing-restore-error
            style={{
              ...noticeBox,
              borderColor: "rgba(179,38,30,0.35)",
              background: "rgba(179,38,30,0.06)",
              color: "#8f1d16",
            }}
          >
            <strong>{restoreError.title}</strong>
            <div>{restoreError.message}</div>
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------------------------
          Payment ledger — four distinct outcomes, never conflated.
      ------------------------------------------------------------------ */}
      {ledger.kind === "LOADING" ? (
        <div className="cases-panel" style={{ padding: "20px 22px" }} data-billing-payments-loading>
          <div className="mb-3 text-[1.05rem] font-semibold tracking-[-0.02em] text-[#172033]">
            Recent Payments
          </div>
          <Skeleton width="100%" height="120px" />
        </div>
      ) : ledger.kind === "DENIED" ? (
        <div
          className="cases-panel"
          role="status"
          style={{ padding: "20px 22px" }}
          data-billing-payments-denied
        >
          <div className="text-[1.05rem] font-semibold tracking-[-0.02em] text-[#172033]">
            Payment history is not available to you
          </div>
          <p className="mt-1 mb-0 text-[0.9rem] leading-[1.7] text-[#475569]">
            Your account is not permitted to read this billing ledger. If you
            expect access, ask the person who owns the subscription.
          </p>
        </div>
      ) : ledger.kind === "LEGAL_REQUIRED" ? (
        <div
          className="cases-panel"
          role="status"
          style={{ padding: "20px 22px" }}
          data-billing-payments-legal-required
        >
          <div className="text-[1.05rem] font-semibold tracking-[-0.02em] text-[#172033]">
            Accept the current policies to continue
          </div>
          <p className="mt-1 mb-0 text-[0.9rem] leading-[1.7] text-[#475569]">
            Billing records stay locked until your account accepts the latest
            policies.
          </p>
          <p className="mt-3 mb-0 text-[0.9rem]">
            <Link
              href="/settings#privacy"
              className="font-semibold text-[#172033] underline"
              data-billing-payments-legal-link
            >
              Review and accept them in Settings →
            </Link>
          </p>
        </div>
      ) : ledger.kind === "ERROR" ? (
        <div
          className="cases-panel"
          role="alert"
          style={{ padding: "20px 22px" }}
          data-billing-payments-error
        >
          <div className="text-[1.05rem] font-semibold tracking-[-0.02em] text-[#172033]">
            {ledger.title}
          </div>
          <p className="mt-1 mb-0 text-[0.9rem] leading-[1.7] text-[#475569]">
            {ledger.message}
          </p>
          <div className="mt-4">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void loadLedger()}
              data-billing-payments-retry
            >
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <BillingHistoryCard items={ledger.items} />
      )}
    </div>
  );
}
