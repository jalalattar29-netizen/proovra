"use client";

/**
 * VERIFICATION ACCESS — the record's canonical verification page
 * (owner decision 2026-10-14).
 *
 * Every record with an issued report has ONE permanent verification
 * reference. The report's QR code, the report text, the verification package
 * and this panel all open the same page, without login, for as long as the
 * record exists — and afterwards the page states truthfully what happened.
 * Nothing here publishes, expires or reassigns it. The page verifies the record
 * and its artifacts; it never publishes the original evidence files.
 *
 * Withdrawal is a legal / privacy / security action for owners and
 * administrators: the identity is kept and the page answers "withdrawn".
 * Recipient links (expiry, use limits, extra materials) are a separate,
 * advanced feature below this panel.
 */
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";

import { AppListbox, AppStatusBadge, type AppTone } from "../app-primitives";
import { useToast } from "../ui";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { notifyApiError } from "../../lib/feedback/notify";
import { formatUserDateTime } from "../../lib/date";
import {
  absoluteVerifyUrl,
  getVerificationAccess,
  reinstateVerificationAccess,
  withdrawVerificationAccess,
  type CanonicalVerificationStatus,
  type VerificationAccess,
  type VerificationWithdrawalReason,
} from "../../lib/api/verification-links";

export const VERIFICATION_ACCESS_STATUS_LABEL: Record<CanonicalVerificationStatus, string> = {
  NOT_ISSUED: "Issued with the first report",
  AVAILABLE: "Available",
  WITHDRAWN: "Withdrawn",
  RETAINED: "Retained",
  PURGED: "Purged",
  TEMPORARILY_UNAVAILABLE: "Temporarily unavailable",
};

const STATUS_TONE: Record<CanonicalVerificationStatus, AppTone> = {
  NOT_ISSUED: "slate",
  AVAILABLE: "green",
  WITHDRAWN: "red",
  RETAINED: "amber",
  PURGED: "slate",
  TEMPORARILY_UNAVAILABLE: "amber",
};

const STATUS_DETAIL: Record<CanonicalVerificationStatus, string> = {
  NOT_ISSUED:
    "The verification page is created automatically when this record's first report is issued. Its link never changes after that.",
  AVAILABLE: "Anyone with the link, the reference or the report's QR code can open it without logging in.",
  WITHDRAWN:
    "The page was withdrawn following a legal, privacy or security action. It now says so to anyone who opens it; the reference is kept and never points to another record.",
  RETAINED:
    "This record is in Trash or in the retention archive. The page says it is retained and no longer shows it as an active record.",
  PURGED: "The record has been permanently deleted. The page shows only a minimal record that it existed.",
  TEMPORARILY_UNAVAILABLE: "The page is temporarily unavailable. It returns once the issue is resolved.",
};

const WITHDRAW_REASONS: ReadonlyArray<{ value: VerificationWithdrawalReason; label: string }> = [
  { value: "LEGAL_REQUEST", label: "Legal request" },
  { value: "PRIVACY_REQUEST", label: "Privacy request" },
  { value: "SECURITY_INCIDENT", label: "Security incident" },
];

export function VerificationAccessPanel({ evidenceId }: { evidenceId: string }) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const [access, setAccess] = useState<VerificationAccess | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<VerificationWithdrawalReason>("LEGAL_REQUEST");

  const load = useCallback(async () => {
    try {
      setAccess(await getVerificationAccess(evidenceId));
      setState("ready");
    } catch {
      setState("error");
    }
  }, [evidenceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const url = access?.verifyPath ? absoluteVerifyUrl(access.verifyPath) : null;

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      addToast(`${what} copied`, "success");
    } catch {
      addToast(`The ${what.toLowerCase()} could not be copied. Select it and copy it manually.`, "error");
    }
  };

  const withdraw = async () => {
    const ok = await confirm({
      title: "Withdraw the verification page?",
      description:
        "Use this only for a legal, privacy or security reason. Anyone opening the page — including from a printed report — will see that it was withdrawn. The reference is kept, never reused, and you can reinstate the page later. This is recorded in the record's custody history.",
      confirmLabel: "Withdraw page",
      tone: "danger",
      testId: "verification-access-withdraw",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await withdrawVerificationAccess(evidenceId, reason);
      await load();
      addToast("Verification page withdrawn", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The verification page could not be withdrawn." });
    } finally {
      setBusy(false);
    }
  };

  const reinstate = async () => {
    setBusy(true);
    try {
      await reinstateVerificationAccess(evidenceId);
      await load();
      addToast("Verification page reinstated", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "The verification page could not be reinstated." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      id="verification-access"
      className="evidence-detail-links-panel"
      data-evidence-section="verification-access"
      aria-labelledby="verification-access-title"
    >
      <h2 id="verification-access-title" className="evidence-detail-verify-card__title">
        Verification access
      </h2>
      <p className="app-field__help" data-verification-access-explainer>
        This page verifies the record and its artifacts. It does not publish the original evidence files.
      </p>

      {state === "loading" ? <p className="app-field__help">Loading verification access…</p> : null}
      {state === "error" ? (
        <p className="app-field__help" role="alert" data-verification-access-unavailable>
          Verification access could not be loaded right now.{" "}
          <button type="button" className="evidence-detail-inline-link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}

      {state === "ready" && access ? (
        <div data-verification-access-status={access.status}>
          <div className="evidence-detail-link-row__main">
            <strong>Status</strong>
            <AppStatusBadge tone={STATUS_TONE[access.status]}>
              {VERIFICATION_ACCESS_STATUS_LABEL[access.status]}
            </AppStatusBadge>
          </div>
          <p className="app-field__help">{STATUS_DETAIL[access.status]}</p>
          {access.withdrawal?.changedAtUtc ? (
            <p className="app-field__help">Changed {formatUserDateTime(access.withdrawal.changedAtUtc)}.</p>
          ) : null}

          {url && access.reference ? (
            <>
              <input
                className="app-input"
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Verification link"
                data-verification-access-url
              />
              <div className="evidence-detail-link-row__actions">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="app-secondary-action"
                  data-verification-access-action="open"
                >
                  Open verification page
                </a>
                <button
                  type="button"
                  className="app-secondary-action"
                  onClick={() => void copy(url, "Verification link")}
                  data-verification-access-action="copy-link"
                >
                  Copy verification link
                </button>
                <button
                  type="button"
                  className="app-secondary-action"
                  onClick={() => void copy(access.reference!, "Verification reference")}
                  data-verification-access-action="copy-reference"
                >
                  Copy verification reference
                </button>
                <button
                  type="button"
                  className="evidence-detail-inline-link"
                  aria-expanded={showQr}
                  onClick={() => setShowQr((v) => !v)}
                  data-verification-access-action="qr"
                >
                  {showQr ? "Hide QR code" : "Show QR code"}
                </button>
              </div>
              <p className="app-field__help">
                Reference: <code data-verification-access-reference>{access.reference}</code>
              </p>
              {showQr ? (
                <div data-verification-access-qr>
                  <QRCodeSVG value={url} size={148} />
                </div>
              ) : null}
            </>
          ) : null}

          {access.canWithdraw && access.reference && access.status !== "PURGED" ? (
            <details className="evidence-detail-advanced" data-verification-access-withdrawal>
              <summary>Withdraw or reinstate (legal, privacy or security)</summary>
              {access.status === "WITHDRAWN" ? (
                <button
                  type="button"
                  className="app-secondary-action"
                  disabled={busy}
                  onClick={() => void reinstate()}
                  data-verification-access-action="reinstate"
                >
                  Reinstate verification page
                </button>
              ) : (
                <div className="evidence-detail-link-form">
                  <label className="app-field-label" htmlFor="verification-access-reason">
                    Reason
                  </label>
                  <AppListbox
                    id="verification-access-reason"
                    ariaLabel="Reason"
                    value={reason}
                    options={WITHDRAW_REASONS}
                    onChange={setReason}
                  />
                  <button
                    type="button"
                    className="app-secondary-action evidence-detail-destructive-action"
                    disabled={busy}
                    onClick={() => void withdraw()}
                    data-verification-access-action="withdraw"
                  >
                    Withdraw verification page
                  </button>
                </div>
              )}
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
