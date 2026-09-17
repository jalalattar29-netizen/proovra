"use client";

/**
 * D27 — the external reviewer's emailed-code step.
 *
 * A grant that requires MFA is opened only with the six-digit code the API
 * emails to the invited address. This step is the one place the portal asks
 * for it; the token-entry page, the invitation landing page and the signed-in
 * pages (when satisfaction has lapsed) all render it rather than each
 * inventing a prompt.
 *
 * Truthfulness rules:
 *   - "We emailed a code" is said only when the server says a code is live
 *     (`codeSent`), and only with the server's masked address.
 *   - Nothing here announces success. `onVerified` runs after the server has
 *     answered 200; the caller decides what signed-in looks like.
 *   - "Send a new code" is disabled, with the reason, for as long as the
 *     server's resend cooldown lasts.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "../ui/Button";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import {
  authenticate,
  readPortalFailure,
  type AuthResult,
  type PortalMfaDetail,
} from "../../lib/external-portal/portal-client";

type Problem = { denial: string | null; attemptsRemaining: number | null; fallback?: string };

export type PortalMfaCodeStepProps = {
  token: string;
  /** The denial that brought the reviewer here. */
  denial: string;
  detail: PortalMfaDetail | null;
  existingSessionId?: string | null;
  onVerified: (result: AuthResult) => void;
};

function problemCopy(p: Problem): string {
  switch (p.denial) {
    case "MFA_INVALID":
      return p.attemptsRemaining !== null && p.attemptsRemaining > 0
        ? `That code is not correct. You have ${p.attemptsRemaining} ${
            p.attemptsRemaining === 1 ? "try" : "tries"
          } left.`
        : "That code is not valid any more. Send a new code and use the newest email.";
    case "MFA_CODE_EXHAUSTED":
      return "Too many incorrect codes. That code no longer works. Send a new code to try again.";
    case "MFA_UNAVAILABLE":
      return "We can't send or check sign-in codes right now, so the portal stays closed. Try again in a few minutes.";
    case "RATE_LIMITED":
      return "Too many codes were requested for this invitation. Wait 15 minutes, then send a new code.";
    case "MFA_REQUIRED":
      return "Enter the six-digit code from your email to open the portal.";
    case "TOKEN_INVALID":
    case "TOKEN_EXPIRED":
    case "TOKEN_REVOKED":
      return "This invitation link no longer works. Ask the person who invited you for a new one.";
    default:
      return p.fallback ?? "We couldn't check your code. Try again.";
  }
}

export function PortalMfaCodeStep({
  token,
  denial,
  detail,
  existingSessionId,
  onVerified,
}: PortalMfaCodeStepProps) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [destination, setDestination] = useState<string | null>(detail?.destination ?? null);
  const [codeSent, setCodeSent] = useState<boolean>(detail?.codeSent === true);
  const [cooldownUntil, setCooldownUntil] = useState<number>(() =>
    detail?.codeSent && detail.resendAvailableInSeconds
      ? Date.now() + detail.resendAvailableInSeconds * 1000
      : 0,
  );
  const [now, setNow] = useState<number>(() => Date.now());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"verify" | "resend" | null>(null);
  const [problem, setProblem] = useState<Problem | null>(
    denial === "MFA_REQUIRED"
      ? null
      : { denial, attemptsRemaining: detail?.attemptsRemaining ?? null },
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);

  const acceptFailure = useCallback((err: unknown) => {
    const f = readPortalFailure(err);
    if (f.mfa?.codeSent) {
      setCodeSent(true);
      if (f.mfa.destination) setDestination(f.mfa.destination);
      if (f.mfa.resendAvailableInSeconds) {
        setCooldownUntil(Date.now() + f.mfa.resendAvailableInSeconds * 1000);
        setNow(Date.now());
      }
    }
    if (f.denial === "MFA_CODE_EXHAUSTED") {
      // The server destroyed the challenge; the old email is worthless now.
      setCodeSent(false);
      setCooldownUntil(0);
    }
    return f;
  }, []);

  const verify = useCallback(async () => {
    setBusy("verify");
    setProblem(null);
    try {
      const result = await authenticate({
        token,
        mfaToken: code,
        existingSessionId: existingSessionId ?? undefined,
      });
      onVerified(result);
    } catch (err) {
      const f = acceptFailure(err);
      setCode("");
      setProblem({
        denial: f.denial,
        attemptsRemaining: f.mfa?.attemptsRemaining ?? null,
        fallback: toSafeUserError(err, {
          message: "We couldn't check your code. Try again.",
        }).message,
      });
      inputRef.current?.focus();
    } finally {
      setBusy(null);
    }
  }, [token, code, existingSessionId, onVerified, acceptFailure]);

  const resend = useCallback(async () => {
    setBusy("resend");
    setProblem(null);
    try {
      // A code step with nothing owed (satisfied elsewhere meanwhile) simply
      // opens: the server said 200.
      const result = await authenticate({
        token,
        existingSessionId: existingSessionId ?? undefined,
      });
      onVerified(result);
    } catch (err) {
      const f = acceptFailure(err);
      if (!(f.denial === "MFA_REQUIRED" && f.mfa?.codeSent)) {
        setProblem({
          denial: f.denial,
          attemptsRemaining: null,
          fallback: toSafeUserError(err, {
            message: "We couldn't send a new code. Try again.",
          }).message,
        });
      }
      inputRef.current?.focus();
    } finally {
      setBusy(null);
    }
  }, [token, existingSessionId, onVerified, acceptFailure]);

  const verifyDisabledReason =
    code.length !== 6 ? "Enter the six-digit code from the email." : undefined;
  const resendDisabledReason =
    secondsLeft > 0 ? `You can ask for a new code in ${secondsLeft} seconds.` : undefined;

  return (
    <section
      data-portal-mfa-step
      aria-labelledby={`${inputId}-title`}
      style={{
        marginTop: 16,
        padding: 14,
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        background: "var(--surface-card)",
        color: "var(--ink-primary)",
      }}
    >
      <h2 id={`${inputId}-title`} style={{ fontSize: 15, margin: "0 0 6px" }}>
        Enter your sign-in code
      </h2>
      <p
        data-portal-mfa-status
        aria-live="polite"
        style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--ink-secondary)" }}
      >
        {codeSent
          ? destination
            ? `We emailed a six-digit code to ${destination}. It expires in 10 minutes and works once.`
            : "We emailed a six-digit code to the address this invitation was sent to. It expires in 10 minutes and works once."
          : "This invitation needs a six-digit code sent to the invited email address."}
      </p>

      <label
        htmlFor={inputId}
        style={{ display: "block", fontSize: 12, fontWeight: 600, marginTop: 12 }}
      >
        Six-digit code
      </label>
      <input
        ref={inputRef}
        id={inputId}
        data-portal-mfa-input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        aria-describedby={hintId}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && code.length === 6 && !busy) void verify();
        }}
        style={{
          width: "100%",
          maxWidth: 200,
          padding: "9px 12px",
          marginTop: 4,
          fontSize: 18,
          letterSpacing: 4,
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-sm)",
          boxSizing: "border-box",
          fontFamily: "inherit",
        }}
      />
      <p id={hintId} style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ink-muted)" }}>
        Check your inbox and spam folder. Only the newest code works.
      </p>

      {problem ? (
        <div
          role="alert"
          data-portal-mfa-problem={problem.denial ?? "UNKNOWN"}
          style={{
            marginTop: 10,
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--danger-border)",
            background: "var(--danger-subtle-bg)",
            color: "var(--error-ink)",
            fontSize: 12,
          }}
        >
          {problemCopy(problem)}
        </div>
      ) : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <Button
          variant="primary"
          data-portal-mfa-verify
          loading={busy === "verify"}
          disabled={busy !== null || verifyDisabledReason !== undefined}
          disabledReason={busy === null ? verifyDisabledReason : undefined}
          onClick={() => void verify()}
        >
          {busy === "verify" ? "Checking code…" : "Verify code"}
        </Button>
        <Button
          variant="secondary"
          data-portal-mfa-resend
          loading={busy === "resend"}
          disabled={busy !== null || resendDisabledReason !== undefined}
          disabledReason={busy === null ? resendDisabledReason : undefined}
          onClick={() => void resend()}
        >
          {busy === "resend" ? "Sending…" : codeSent ? "Send a new code" : "Send a code"}
        </Button>
      </div>
      {resendDisabledReason ? (
        <p
          data-portal-mfa-cooldown
          style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ink-muted)" }}
        >
          {resendDisabledReason}
        </p>
      ) : null}
    </section>
  );
}
