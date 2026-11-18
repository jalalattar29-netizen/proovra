"use client";

/**
 * B7A-F-006 (free-audit 0ea0) — A SIGNING-KEY COMPROMISE, ON THE RECORD.
 *
 * When PROOVRA withdraws a signing key, the owner's email links to
 * `/evidence/<id>`. This notice is mounted above the record's tabs, so it is
 * visible on the default landing AND beside the Artifacts & Versions tab.
 *
 * It renders ONLY the shared sentences (`describeRecordKeyCompromise`, the same
 * ones the mobile app renders) and adds no copy of its own beyond the busy
 * label and the accepted line. The control appears only when the server offers
 * a replacement to THIS caller (`keyCompromiseReplacementOffered`): never for a
 * null field, a state other than AVAILABLE, or a caller without permission.
 *
 * The request is the existing audited regenerate route with
 * `intent: "KEY_COMPROMISE_REPLACEMENT"` (the server mints its own key). Its
 * refusals are FLAT `{ code, message }` bodies, so they are read through
 * `toSafeUserError` (which maps each code to the shared copy), never through an
 * `instanceof ApiError` branch and never as the raw server message.
 */

import { useRef, useState } from "react";
import {
  KEY_COMPROMISE_REPLACEMENT_INTENT,
  describeRecordKeyCompromise,
  keyCompromiseReplacementOffered,
  parseRecordKeyCompromise,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { toSafeUserError, type SafeUserError } from "../../lib/feedback/toSafeUserError";

const ACCEPTED_LINE = "Replacement requested. It will appear in this record's versions when it is issued.";
const BUSY_LABEL = "Requesting…";

export function KeyCompromiseNotice({
  evidenceId,
  keyCompromise,
  onRequested,
}: {
  evidenceId: string;
  /** The artifact-status `keyCompromise` field, raw (absent from an older API). */
  keyCompromise: unknown;
  /** Re-read the record so the state (and the artifact poll) moves on. */
  onRequested?: () => unknown;
}) {
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<SafeUserError | null>(null);
  // Synchronous guard: a second click in the same tick sees no re-render yet.
  const inFlight = useRef(false);

  const k = parseRecordKeyCompromise(keyCompromise);
  if (!k) return null;
  const d = describeRecordKeyCompromise(k);
  const offered = keyCompromiseReplacementOffered(k) && d.actionLabel !== null;

  const requestReplacement = async () => {
    if (inFlight.current || !evidenceId) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/v1/evidence/${evidenceId}/reports/regenerate`, {
        method: "POST",
        body: JSON.stringify({ intent: KEY_COMPROMISE_REPLACEMENT_INTENT }),
      });
      setAccepted(true);
      try {
        await onRequested?.();
      } catch {
        /* the poll or the next load shows the state; the request was accepted */
      }
    } catch (err) {
      setError(toSafeUserError(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const headingId = `key-compromise-notice-title-${evidenceId}`;
  return (
    <section
      className="evidence-detail-record-banner evidence-detail-record-banner--split"
      data-banner-tone="warn"
      aria-labelledby={headingId}
      data-testid="key-compromise-notice"
      data-key-compromise-replacement={k.replacement}
    >
      <div className="evidence-detail-record-banner__copy">
        <h2 className="evidence-detail-record-banner__title" id={headingId} style={{ margin: 0 }}>
          {d.title}
        </h2>
        <p className="evidence-detail-record-banner__body" style={{ margin: 0 }}>
          {d.message}
        </p>
        <p className="evidence-detail-record-banner__body" style={{ margin: 0 }} role="status">
          {d.replacementLine}
        </p>
        {d.notReplaced.map((line) => (
          <p key={line} className="evidence-detail-record-banner__body" style={{ margin: 0 }}>
            {line}
          </p>
        ))}
        {accepted ? (
          <p
            className="evidence-detail-record-banner__body"
            style={{ margin: 0 }}
            role="status"
            data-testid="key-compromise-notice-accepted"
          >
            {ACCEPTED_LINE}
          </p>
        ) : null}
        {error ? (
          <p
            className="evidence-detail-record-banner__body"
            style={{ margin: 0 }}
            role="alert"
            data-testid="key-compromise-notice-error"
          >
            <strong>{error.title}.</strong> {error.message}
          </p>
        ) : null}
      </div>
      {offered && !accepted ? (
        <div className="evidence-detail-record-banner__actions">
          <button
            type="button"
            className="app-primary-action"
            onClick={() => void requestReplacement()}
            disabled={busy}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            data-testid="key-compromise-notice-action"
          >
            {busy ? BUSY_LABEL : d.actionLabel}
          </button>
        </div>
      ) : null}
    </section>
  );
}
