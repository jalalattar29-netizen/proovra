"use client";

/**
 * PHASE 12B (Evidence Operations) — messaging contact verification +
 * durable communication preference.
 *
 * Completes the journey across the three communications operations that
 * previously had no product surface:
 *
 *   1. POST /v1/communications/verify/start  — send a one-time code
 *   2. POST /v1/communications/verify/check  — server verifies the code
 *   3. POST /v1/communications/preferences   — durable channel preference
 *
 * SERVER-AUTHORITATIVE VERIFICATION
 * ---------------------------------
 * The client NEVER decides that a contact is verified:
 *   - `verified` is only ever set from the server's
 *     `{ status: "approved" }` response body;
 *   - the code entry box does not inspect, validate or compare the code —
 *     it is posted straight to the server;
 *   - the preference write is additionally gated SERVER-side: opting a
 *     contact IN returns 409 `contact_not_verified` unless the backend
 *     finds an APPROVED verification attempt for that recipient in that
 *     workspace. So even a tampered client cannot enable messaging.
 *
 * EXPIRY + REPLAY
 * ---------------
 * The backend buckets every check failure (wrong code, expired attempt,
 * exhausted attempt count, no open attempt — which is what a replay of an
 * already-approved code looks like) into a single
 * `400 { status: "denied" }`. This component therefore renders ONE
 * bounded denial message and never speculates about the cause.
 *
 * RATE LIMITING
 * -------------
 * `verify/start` answers `200 { status: "rate_limited" }` once the
 * per-recipient hourly cap is hit. That is surfaced as a calm, explicit
 * state — not as a generic failure and not as a silent success.
 *
 * The OTP code lives only in local component state for the duration of
 * the submit and is cleared afterwards. It is never logged, never placed
 * in a URL, and never included in any analytics or error payload.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../lib/date";

type Channel = "SMS" | "WHATSAPP";

const CHANNEL_LABEL: Record<Channel, string> = {
  SMS: "Text message (SMS)",
  WHATSAPP: "WhatsApp",
};

/** Safe verification-attempt projection returned by verify/start. */
type VerificationAttemptView = {
  id: string;
  channel: string;
  status: string;
  /** Masked recipient — the backend never returns the raw phone. */
  recipientPreview: string;
  checkAttemptCount: number;
  createdAt: string;
  approvedAtUtc: string | null;
  expiresAtUtc: string | null;
};

type Stage =
  /** Nothing requested yet. */
  | { kind: "IDLE" }
  /** Server accepted the start and a code is outstanding. */
  | { kind: "CODE_SENT"; attempt: VerificationAttemptView }
  /** Server refused to send another code for this recipient yet. */
  | { kind: "RATE_LIMITED" }
  /** Server confirmed the contact. `verificationId` comes from the server. */
  | {
      kind: "VERIFIED";
      verificationId: string | null;
      recipientPreview: string | null;
    };

export function ContactChannelVerificationCard({
  teamId,
}: {
  teamId: string | null;
}) {
  // Stale-context rejection: responses issued under a previous workspace
  // are discarded rather than applied to the new one.
  const activeTeamRef = useRef<string | null>(teamId);
  useEffect(() => {
    activeTeamRef.current = teamId;
  }, [teamId]);

  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<Channel>("SMS");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "IDLE" });
  const [busy, setBusy] = useState<
    null | "START" | "CHECK" | "SAVE_IN" | "SAVE_OUT"
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedPreference, setSavedPreference] = useState<{
    smsOptOut: boolean;
    whatsappOptOut: boolean;
    preferredChannel: string | null;
    updatedAt: string;
  } | null>(null);

  // A workspace switch invalidates the whole journey.
  useEffect(() => {
    setStage({ kind: "IDLE" });
    setCode("");
    setSavedPreference(null);
    setError(null);
    setNotice(null);
  }, [teamId]);

  const resetJourney = useCallback(() => {
    setStage({ kind: "IDLE" });
    setCode("");
    setSavedPreference(null);
    setError(null);
    setNotice(null);
  }, []);

  const startVerification = useCallback(async () => {
    if (!teamId) return;
    const requestTeamId = teamId;
    setBusy("START");
    setError(null);
    setNotice(null);
    try {
      const res = (await apiFetch("/v1/communications/verify/start", {
        method: "POST",
        body: JSON.stringify({
          teamId: requestTeamId,
          channel,
          phone,
          purpose: "OTP",
        }),
      })) as {
        status?: string;
        attempt?: VerificationAttemptView;
      } | null;
      if (requestTeamId !== activeTeamRef.current) return;
      // Rate limiting is a SERVER verdict returned with 200. Surface it
      // as its own state rather than as an error or a fake success.
      if (res?.status === "rate_limited") {
        setStage({ kind: "RATE_LIMITED" });
        return;
      }
      if (res?.status === "started" && res.attempt) {
        setStage({ kind: "CODE_SENT", attempt: res.attempt });
        setCode("");
        return;
      }
      setError(
        "The verification request did not complete. Try again in a moment.",
      );
    } catch (err) {
      if (requestTeamId !== activeTeamRef.current) return;
      const status = (err as { statusCode?: number } | null)?.statusCode;
      if (status === 400) {
        setError(
          "That does not look like a mobile number that can receive messages. Check the country code and try again.",
        );
        return;
      }
      if (status === 503) {
        setError(
          "Message verification is not enabled for this environment yet. Ask your administrator to configure a messaging provider.",
        );
        return;
      }
      setError(
        toSafeUserError(err, {
          message: "The verification code could not be sent.",
        }).message,
      );
    } finally {
      setBusy(null);
    }
  }, [teamId, channel, phone]);

  const checkVerification = useCallback(async () => {
    if (!teamId) return;
    const requestTeamId = teamId;
    setBusy("CHECK");
    setError(null);
    setNotice(null);
    try {
      const res = (await apiFetch("/v1/communications/verify/check", {
        method: "POST",
        // The code is forwarded verbatim; the client does no validation
        // and keeps no copy of it beyond this call.
        body: JSON.stringify({ teamId: requestTeamId, phone, code }),
      })) as { status?: string; verificationId?: string | null } | null;
      if (requestTeamId !== activeTeamRef.current) return;
      setCode("");
      // ONLY the server can move the journey to VERIFIED.
      if (res?.status === "approved") {
        setStage({
          kind: "VERIFIED",
          verificationId: res.verificationId ?? null,
          recipientPreview:
            stage.kind === "CODE_SENT" ? stage.attempt.recipientPreview : null,
        });
        setNotice("This contact is confirmed. You can now set its preference.");
        return;
      }
      setError(
        "That code was not accepted. Codes expire quickly and can only be used once — request a new one.",
      );
    } catch (err) {
      if (requestTeamId !== activeTeamRef.current) return;
      setCode("");
      const status = (err as { statusCode?: number } | null)?.statusCode;
      // 400 covers every check failure the backend buckets together:
      // wrong code, expired attempt, attempt count exhausted, and replay
      // of an already-approved code.
      if (status === 400) {
        setError(
          "That code was not accepted. Codes expire quickly and can only be used once — request a new one.",
        );
        return;
      }
      if (status === 503) {
        setError(
          "Message verification is not enabled for this environment yet.",
        );
        return;
      }
      setError(
        toSafeUserError(err, {
          message: "The code could not be checked.",
        }).message,
      );
    } finally {
      setBusy(null);
    }
  }, [teamId, phone, code, stage]);

  /**
   * Durable preference write. `optIn === true` requires server-side
   * verification (409 `contact_not_verified` otherwise); opting out is
   * always allowed so suppression can never be blocked.
   */
  const savePreference = useCallback(
    async (optIn: boolean) => {
      if (!teamId) return;
      const requestTeamId = teamId;
      setBusy(optIn ? "SAVE_IN" : "SAVE_OUT");
      setError(null);
      setNotice(null);
      try {
        const body: Record<string, unknown> = {
          teamId: requestTeamId,
          target: { kind: "contact", phone },
        };
        if (channel === "SMS") body.smsOptOut = !optIn;
        else body.whatsappOptOut = !optIn;
        if (optIn) body.preferredChannel = channel;
        else body.optOutReason = "operator_preference";

        const res = (await apiFetch("/v1/communications/preferences", {
          method: "POST",
          body: JSON.stringify(body),
        })) as {
          preference?: {
            smsOptOut?: boolean;
            whatsappOptOut?: boolean;
            preferredChannel?: string | null;
            updatedAt?: string;
          };
        } | null;
        if (requestTeamId !== activeTeamRef.current) return;
        const pref = res?.preference;
        setSavedPreference({
          smsOptOut: pref?.smsOptOut ?? !optIn,
          whatsappOptOut: pref?.whatsappOptOut ?? !optIn,
          preferredChannel: pref?.preferredChannel ?? null,
          updatedAt: pref?.updatedAt ?? new Date().toISOString(),
        });
        setNotice(
          optIn
            ? "Messaging preference saved for this contact."
            : "This contact will no longer be messaged on that channel.",
        );
      } catch (err) {
        if (requestTeamId !== activeTeamRef.current) return;
        const status = (err as { statusCode?: number } | null)?.statusCode;
        const errorCode = (err as { code?: string } | null)?.code;
        if (status === 409 || errorCode === "contact_not_verified") {
          setError(
            "This contact has not completed verification, so messaging cannot be enabled for it yet.",
          );
          return;
        }
        if (status === 403) {
          setError(
            "You do not have permission to change communication preferences in this workspace.",
          );
          return;
        }
        setError(
          toSafeUserError(err, {
            message: "The preference could not be saved.",
          }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, phone, channel],
  );

  if (!teamId) {
    return (
      <section className="ops-panel" data-contact-verification-card="NO_WORKSPACE">
        <h3 className="ops-panel__title">Message a contact</h3>
        <p className="ops-muted" style={{ margin: 0 }}>
          Select a workspace to manage verified messaging contacts.
        </p>
      </section>
    );
  }

  const phoneReady = phone.trim().length >= 6;
  const verified = stage.kind === "VERIFIED";

  return (
    <section
      className="ops-panel"
      data-contact-verification-card={stage.kind}
      data-contact-verification-channel={channel}
    >
      {/* "Messaging contact" — a DELIVERY DESTINATION (AUDIT, 2026-09-03).
          This is not MFA, not login recovery and not step-up verification: it
          is the number this workspace may send evidence requests and reminders
          to, gated by `/v1/communications/verify/*` and a durable channel
          preference. The security device on the Security page is the separate,
          step-up control. Both ask for a phone and both send a code, so the
          heading has to say which one this is. */}
      <h3 className="ops-panel__title">Messaging contact</h3>
      <div className="ops-muted" style={{ marginBottom: 12 }}>
        <p style={{ margin: "0 0 4px" }}>
          Verify a phone number that PROOVRA may use for evidence-request and
          reminder messages, by text message or WhatsApp. This is a delivery
          address for notifications — it is not used for signing in or for
          confirming sensitive actions.
        </p>
        <p style={{ margin: 0 }}>
          Confirmation is decided by the messaging provider and recorded on
          the server. Turning messaging OFF never requires a code.
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="ops-error-box"
          data-contact-verification-error
          style={{ marginBottom: 12 }}
        >
          {error}
        </div>
      ) : null}

      {notice ? (
        <div
          role="status"
          className="ops-note"
          data-contact-verification-notice
          style={{ marginBottom: 12 }}
        >
          {notice}
        </div>
      ) : null}

      <div className="ops-form">
        <label style={{ display: "grid", gap: 4 }}>
          <span className="ops-field-label">Channel</span>
          <select
            className="ops-select"
            data-contact-verification-channel-select
            value={channel}
            disabled={stage.kind !== "IDLE"}
            onChange={(e) => setChannel(e.target.value as Channel)}
          >
            {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span className="ops-field-label">Mobile number</span>
          <input
            className="ops-input"
            data-contact-verification-phone
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="+44 7700 900000"
            value={phone}
            disabled={stage.kind !== "IDLE"}
            onChange={(e) => setPhone(e.target.value)}
          />
          <span className="ops-muted">
            Include the country code. The number is stored only as a
            one-way hash — it is never shown back to you in full.
          </span>
        </label>

        {stage.kind === "IDLE" ? (
          <div>
            <button
              type="button"
              className="ops-link-btn"
              data-variant="primary"
              data-contact-verification-start
              disabled={busy !== null || !phoneReady}
              onClick={() => void startVerification()}
            >
              {busy === "START" ? "Sending code…" : "Send verification code"}
            </button>
          </div>
        ) : null}

        {stage.kind === "RATE_LIMITED" ? (
          <div className="ops-legend" data-contact-verification-rate-limited>
            <p>
              <strong>Too many verification attempts for this number.</strong>
            </p>
            <p>
              The workspace has reached the hourly limit for this recipient.
              Wait before requesting another code — the limit protects the
              recipient from being messaged repeatedly.
            </p>
            <p>
              <button
                type="button"
                className="ops-retry-btn"
                data-contact-verification-reset
                onClick={resetJourney}
              >
                Start over
              </button>
            </p>
          </div>
        ) : null}

        {stage.kind === "CODE_SENT" ? (
          <div className="ops-legend" data-contact-verification-code-sent>
            <p>
              <strong>Code sent to {stage.attempt.recipientPreview}.</strong>
            </p>
            <p>
              {stage.attempt.expiresAtUtc
                ? `The code expires ${formatUserDateTime(stage.attempt.expiresAtUtc)}.`
                : "The code expires shortly."}{" "}
              Checks used: {stage.attempt.checkAttemptCount}.
            </p>
            <label style={{ display: "grid", gap: 4, marginTop: 4 }}>
              <span className="ops-field-label">Verification code</span>
              <input
                className="ops-input"
                data-contact-verification-code
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="ops-link-btn"
                data-variant="primary"
                data-contact-verification-check
                disabled={busy !== null || code.trim().length < 3}
                onClick={() => void checkVerification()}
              >
                {busy === "CHECK" ? "Checking…" : "Confirm code"}
              </button>
              <button
                type="button"
                className="ops-retry-btn"
                data-contact-verification-reset
                disabled={busy !== null}
                onClick={resetJourney}
              >
                Use a different number
              </button>
            </p>
          </div>
        ) : null}

        {verified ? (
          <div className="ops-legend" data-contact-verification-verified>
            <p>
              <strong>
                Contact confirmed
                {stage.kind === "VERIFIED" && stage.recipientPreview
                  ? ` (${stage.recipientPreview})`
                  : ""}
                .
              </strong>
            </p>
            <p>
              Confirmation was recorded by the server. Choose whether this
              workspace may message the contact on{" "}
              {CHANNEL_LABEL[channel]}.
            </p>
            <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="ops-link-btn"
                data-variant="primary"
                data-contact-verification-opt-in
                disabled={busy !== null}
                onClick={() => void savePreference(true)}
              >
                {busy === "SAVE_IN" ? "Saving…" : "Allow messages"}
              </button>
              <button
                type="button"
                className="ops-retry-btn"
                data-contact-verification-opt-out
                disabled={busy !== null}
                onClick={() => void savePreference(false)}
              >
                {busy === "SAVE_OUT" ? "Saving…" : "Do not message"}
              </button>
              <button
                type="button"
                className="ops-retry-btn"
                data-contact-verification-reset
                disabled={busy !== null}
                onClick={resetJourney}
              >
                Add another number
              </button>
            </p>
          </div>
        ) : null}

        {savedPreference ? (
          <div className="ops-note" data-contact-verification-preference>
            <span>
              Saved preference — SMS:{" "}
              {savedPreference.smsOptOut ? "blocked" : "allowed"}; WhatsApp:{" "}
              {savedPreference.whatsappOptOut ? "blocked" : "allowed"}
              {savedPreference.preferredChannel
                ? `; preferred: ${savedPreference.preferredChannel}`
                : ""}
              .
            </span>
            <span className="ops-muted">
              Updated {formatUserDateTime(savedPreference.updatedAt)}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
