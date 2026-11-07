"use client";

/**
 * PHASE R8.1.2 — Login-time MFA challenge page.
 *
 * Renders the second-factor checkpoint AFTER primary credentials
 * (password / Google / Apple / OIDC) have validated. The pending
 * token is carried in the HTTP-only `proovra_mfa_pending` cookie
 * set by the backend; this page intentionally NEVER reads it from
 * URL params, never persists it to localStorage, and never echoes
 * any user input to the URL.
 *
 * Hard rules (must not regress without owner review):
 *   - No localStorage for OTP, recovery code, or pending token.
 *   - No console.log of OTP / recovery code / session token.
 *   - No GET parameters carry secrets.
 *   - The page does NOT re-implement TOTP validation client-side.
 *   - On success, the backend rotates the cookie set: clears
 *     `proovra_mfa_pending` and sets `proovra_session`. We then
 *     fetch /v1/auth/me and route to the safe `next` target.
 *
 * AUTH-LOCKOUT-NONTOTP (2026-11-07) — the page offers the second factors THIS
 * person enrolled, read from POST /v1/auth/mfa/methods (it spends nothing and
 * never touches the verify route): a passkey, an authenticator code, a code
 * sent to their verified phone, or a recovery code. A passkey- or phone-only
 * account is asked for that factor instead of being locked out or let in with
 * a password alone.
 */

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { isSafeRedirectAfter } from "@proovra/shared";

import { Button } from "../../../components/ui";
import { MfaEnrollmentAtSignIn } from "../../../components/identity-security/MfaEnrollmentAtSignIn";
import { MfaRecoveryRequestPanel } from "../../../components/mfa-recovery/MfaRecoveryRequestPanel";
import { apiFetch } from "../../../lib/api";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { getPasskeyAssertion } from "../../../lib/identity/webauthn";

type ChallengeMode = "passkey" | "totp" | "contact" | "recovery_code";
type SignInMethod = "PASSKEY" | "TOTP" | "SMS" | "WHATSAPP" | "RECOVERY_CODE";

function modeFor(method: SignInMethod): ChallengeMode {
  if (method === "PASSKEY") return "passkey";
  if (method === "TOTP") return "totp";
  if (method === "SMS" || method === "WHATSAPP") return "contact";
  return "recovery_code";
}

const SWITCH_LABEL: Record<ChallengeMode, string> = {
  passkey: "Use a passkey or security key instead",
  totp: "Use the authenticator code instead",
  contact: "Send a code to your phone instead",
  recovery_code: "Use a recovery code instead",
};

const SAFE_NEXT_FALLBACK = "/home";

function isSafeNext(value: string | null): value is string {
  if (!value || !value.startsWith("/") || value.length > 400) return false;
  // The one safety contract, shared with the API (IDENT-012).
  return isSafeRedirectAfter(value);
}

function MfaChallengeBody() {
  const router = useRouter();
  const search = useSearchParams();
  const rawNext = search.get("next");
  const next = isSafeNext(rawNext) ? rawNext : SAFE_NEXT_FALLBACK;
  // R8.1.3 — `?enroll=1` is set by the backend when org policy
  // requires MFA but the user has no enrolled factor. We render a
  // distinct surface that guides them through enrollment instead of
  // showing the code-input form (which would never succeed). NEVER a
  // silent lockout.
  const enrollmentRequired = search.get("enroll") === "1";

  const [mode, setMode] = useState<ChallengeMode>("totp");
  // What this person enrolled (null until /v1/auth/mfa/methods answers; if it
  // cannot, the authenticator and recovery-code forms stay as they were).
  const [available, setAvailable] = useState<ChallengeMode[] | null>(null);
  const [destinationMask, setDestinationMask] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [contactCode, setContactCode] = useState("");
  const passkeyOptionsRef = useRef<Record<string, unknown> | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [challengeExpired, setChallengeExpired] = useState(false);
  const inFlightRef = useRef(false);

  // The pending cookie is HTTP-only and this page sends nothing until
  // the user submits. An operator with no challenge in flight (direct
  // navigation, or the account-recovery link from step-up, where they
  // may hold a live session) still gets the recovery panel below; a
  // submit answers 401 `mfa_pending_invalid` and routes them to /login.

  /** Reads (and, for a passkey, arms) what this sign-in can be answered with. */
  const loadMethods = useCallback(async (): Promise<ChallengeMode[] | null> => {
    try {
      const data = (await apiFetch(
        "/v1/auth/mfa/methods",
        { method: "POST", body: JSON.stringify({}) },
        { auth: false },
      )) as { methods?: unknown; destinationMask?: unknown; passkeyOptions?: unknown } | null;
      const methods = Array.isArray(data?.methods)
        ? (data!.methods as unknown[]).filter((m): m is SignInMethod =>
            ["PASSKEY", "TOTP", "SMS", "WHATSAPP", "RECOVERY_CODE"].includes(String(m)),
          )
        : null;
      if (!methods || methods.length === 0) return null;
      passkeyOptionsRef.current =
        data?.passkeyOptions && typeof data.passkeyOptions === "object"
          ? (data.passkeyOptions as Record<string, unknown>)
          : null;
      setDestinationMask(typeof data?.destinationMask === "string" ? data.destinationMask : null);
      return Array.from(new Set(methods.map(modeFor)));
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (enrollmentRequired) return;
    let cancelled = false;
    void loadMethods().then((modes) => {
      if (cancelled || !modes) return;
      setAvailable(modes);
      setMode(modes[0]!);
    });
    return () => {
      cancelled = true;
    };
  }, [enrollmentRequired, loadMethods]);

  /** The one completion path every factor shares. */
  const submitVerify = async (body: Record<string, unknown>, method: ChallengeMode) => {
    inFlightRef.current = true;
    setBusy(true);
    setStatus("Verifying second factor...");
    try {
      const data = await apiFetch(
        "/v1/auth/mfa/verify",
        { method: "POST", body: JSON.stringify(body) },
        { auth: false },
      );
      if (!data?.token) {
        throw new Error("Verification succeeded but no session was issued.");
      }
      const me = await apiFetch("/v1/auth/me", { method: "GET" });
      if (!me?.user) {
        throw new Error("Session not confirmed.");
      }
      router.replace(next);
    } catch (err) {
      const failure = err as { statusCode?: number; message?: string };
      if (failure.statusCode) {
        if (failure.statusCode === 429) {
          setError("Too many attempts. Wait a minute before trying again.");
        } else if (failure.statusCode === 401) {
          // Reads the RAW error message ON PURPOSE — internal control flow
          // matching bounded reason codes, never rendered.
          const msg = failure.message ?? "";
          if (msg === "mfa_challenge_expired") {
            setChallengeExpired(true);
            setError("Your two-factor challenge expired. Please sign in again to start a fresh challenge.");
          } else if (msg === "mfa_challenge_already_used") {
            setChallengeExpired(true);
            setError("That two-factor challenge was already used. Please sign in again to start a fresh challenge.");
          } else if (msg === "mfa_pending_invalid") {
            setChallengeExpired(true);
            setError("Your sign-in session ended. Please sign in again.");
          } else {
            setError(
              method === "totp"
                ? "That code did not match. Check the timer on your authenticator and try again."
                : method === "contact"
                  ? "That code did not match. Check the latest message and try again, or send a new code."
                  : method === "passkey"
                    ? "That passkey could not be confirmed. Try again, or choose another way to sign in."
                    : "That recovery code was not accepted. Each code is single-use.",
            );
            // A passkey challenge is armed per ceremony: re-arm for the retry.
            if (method === "passkey") void loadMethods();
          }
        } else {
          setError(toSafeUserError(err, { message: "Could not verify the second factor." }).message);
        }
      } else {
        setError(toSafeUserError(err, { message: "Verification failed." }).message);
      }
      setStatus(null);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const signInWithPasskey = async () => {
    if (busy || inFlightRef.current) return;
    setError(null);
    setStatus(null);
    if (!passkeyOptionsRef.current) await loadMethods();
    const options = passkeyOptionsRef.current;
    if (!options) {
      setError("Passkey sign-in is not available right now. Choose another way to sign in.");
      return;
    }
    const result = await getPasskeyAssertion(options);
    if (result.status === "cancelled") {
      setStatus("No problem — nothing was sent. Try again when you're ready.");
      return;
    }
    if (result.status === "unsupported") {
      setError("This browser can't use passkeys. Choose another way to sign in.");
      return;
    }
    if (result.status !== "ok") {
      setError("That passkey could not be confirmed. Try again, or choose another way to sign in.");
      void loadMethods();
      return;
    }
    passkeyOptionsRef.current = null;
    await submitVerify({ passkeyAssertion: result.assertion }, "passkey");
  };

  const sendCode = async () => {
    if (busy || inFlightRef.current) return;
    setError(null);
    setStatus(null);
    inFlightRef.current = true;
    setBusy(true);
    try {
      const data = (await apiFetch(
        "/v1/auth/mfa/send-code",
        { method: "POST", body: JSON.stringify({}) },
        { auth: false },
      )) as { destinationMask?: unknown } | null;
      setCodeSent(true);
      const mask = typeof data?.destinationMask === "string" ? data.destinationMask : destinationMask;
      setStatus(mask ? `We sent a code to ${mask}.` : "We sent a code to your phone.");
    } catch (err) {
      const failure = err as { statusCode?: number; message?: string };
      if (failure.statusCode === 429) setError("Too many codes requested. Wait a few minutes before trying again.");
      else if (failure.statusCode === 401) {
        setChallengeExpired(true);
        setError("Your sign-in session ended. Please sign in again.");
      } else setError("We couldn't send a code right now. Choose another way to sign in, or try again shortly.");
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || inFlightRef.current) return;
    setError(null);
    setStatus(null);
    if (mode === "passkey") {
      await signInWithPasskey();
      return;
    }
    if (mode === "contact") {
      const trimmed = contactCode.replace(/\s+/g, "");
      if (!codeSent) {
        await sendCode();
        return;
      }
      if (!/^\d{4,10}$/.test(trimmed)) {
        setError("Enter the code from the message we sent.");
        return;
      }
      await submitVerify({ contactCode: trimmed }, "contact");
      return;
    }
    const body: Record<string, string> = {};
    if (mode === "totp") {
      const trimmed = code.trim();
      if (!/^\d{6}$/.test(trimmed.replace(/\s+/g, ""))) {
        setError("Enter the 6-digit code from your authenticator.");
        return;
      }
      body.code = trimmed.replace(/\s+/g, "");
    } else {
      const trimmed = recoveryCode.trim();
      if (trimmed.length < 10) {
        setError("Enter a recovery code from your saved batch.");
        return;
      }
      body.recoveryCode = trimmed;
    }

    await submitVerify(body, mode);
  };

  const toggleMode = () => {
    setMode((m) => (m === "totp" ? "recovery_code" : "totp"));
    setError(null);
    setStatus(null);
    setCode("");
    setRecoveryCode("");
  };

  const switchTo = (target: ChallengeMode) => {
    setMode(target);
    setError(null);
    setStatus(null);
    setCode("");
    setRecoveryCode("");
    setContactCode("");
  };

  // R8.1.3 — enrollment-required surface. Renders when the login form
  // or the SSO gate sent the person here with `?enroll=1`. The session
  // is NOT live yet; the enrolment cookie reaches only the enrolment
  // routes, and the session is issued when a factor has been verified.
  if (enrollmentRequired) {
    return (
      <main
        data-page="auth-mfa-challenge"
        data-cc-mfa-state="enrollment-required"
        style={{
          maxWidth: 540,
          margin: "0 auto",
          padding: "48px 24px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>
          Set up two-factor authentication
        </h1>
        <p style={{ color: "#475569", marginBottom: 16 }}>
          Your organization requires two-factor authentication. Add an
          authenticator to finish signing in.
        </p>
        <MfaEnrollmentAtSignIn onSignedIn={() => router.replace(next)} />
        <p style={{ marginTop: 24, fontSize: 14, color: "#64748b" }}>
          Need help?{" "}
          <Link href="/support" style={{ color: "#1d4ed8" }}>
            Contact support
          </Link>
          .
        </p>
      </main>
    );
  }

  // R8.1.3 — expired/replayed challenge surface. The verify endpoint
  // returned a 401 with `mfa_challenge_expired` or
  // `mfa_challenge_already_used`. The pending token is dead; the
  // only path forward is restarting primary login.
  if (challengeExpired) {
    return (
      <main
        data-page="auth-mfa-challenge"
        data-cc-mfa-state="challenge-expired"
        style={{
          maxWidth: 540,
          margin: "0 auto",
          padding: "48px 24px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>
          Sign-in session expired
        </h1>
        <p role="alert" style={{ color: "#b91c1c", marginBottom: 24 }}>
          {error}
        </p>
        <Link
          href="/login"
          style={{
            display: "inline-block",
            padding: "10px 18px",
            background: "#1d4ed8",
            color: "white",
            borderRadius: 8,
            textDecoration: "none",
          }}
          data-cc-mfa-restart-login
        >
          Return to sign in
        </Link>
      </main>
    );
  }

  return (
    <main
      data-page="auth-mfa-challenge"
      data-cc-mfa-state="verify"
      style={{
        maxWidth: 480,
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>
        Two-factor verification
      </h1>
      <p style={{ color: "#475569", marginBottom: 24 }}>
        {mode === "totp"
          ? "Enter the 6-digit code from your authenticator app to finish signing in."
          : mode === "passkey"
            ? "Use your passkey or security key to finish signing in."
            : mode === "contact"
              ? `We'll send a one-time code to your verified phone${destinationMask ? ` (${destinationMask})` : ""}.`
              : "Enter one of your single-use recovery codes. Each code works exactly once."}
      </p>
      <form onSubmit={handleSubmit} aria-busy={busy}>
        {mode === "passkey" ? null : mode === "contact" ? (
          codeSent ? (
            <label style={{ display: "block", marginBottom: 16 }}>
              <span style={{ display: "block", fontSize: 14, marginBottom: 6 }}>Code from your phone</span>
              <input
                name="contactCode"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={12}
                value={contactCode}
                onChange={(e) => setContactCode(e.target.value)}
                aria-label="Code sent to your phone"
                data-cc-mfa-input="contact"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  fontSize: 18,
                  letterSpacing: "0.25em",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  border: "1px solid #cbd5e1",
                  borderRadius: 8,
                }}
                disabled={busy}
              />
            </label>
          ) : null
        ) : mode === "totp" ? (
          <label style={{ display: "block", marginBottom: 16 }}>
            <span style={{ display: "block", fontSize: 14, marginBottom: 6 }}>
              Authenticator code
            </span>
            <input
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123 456"
              aria-label="Six-digit authenticator code"
              data-cc-mfa-input="totp"
              style={{
                width: "100%",
                padding: "12px 14px",
                fontSize: 18,
                letterSpacing: "0.25em",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                border: "1px solid #cbd5e1",
                borderRadius: 8,
              }}
              disabled={busy}
            />
          </label>
        ) : (
          <label style={{ display: "block", marginBottom: 16 }}>
            <span style={{ display: "block", fontSize: 14, marginBottom: 6 }}>
              Recovery code
            </span>
            <input
              name="recoveryCode"
              type="text"
              autoComplete="off"
              autoFocus
              maxLength={20}
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              placeholder="ABCDE-FGHJK"
              aria-label="Single-use recovery code"
              data-cc-mfa-input="recovery"
              style={{
                width: "100%",
                padding: "12px 14px",
                fontSize: 16,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                border: "1px solid #cbd5e1",
                borderRadius: 8,
              }}
              disabled={busy}
            />
          </label>
        )}
        {error ? (
          <p
            role="alert"
            data-cc-mfa-error
            style={{ color: "#b91c1c", marginBottom: 12 }}
          >
            {error}
          </p>
        ) : null}
        {status ? (
          <p style={{ color: "#475569", marginBottom: 12 }}>{status}</p>
        ) : null}
        <Button type="submit" disabled={busy}>
          {busy
            ? "Verifying..."
            : mode === "passkey"
              ? "Continue with passkey"
              : mode === "contact" && !codeSent
                ? "Send code"
                : "Verify and continue"}
        </Button>
        {mode === "contact" && codeSent ? (
          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={busy}
            data-cc-mfa-resend
            style={{ marginLeft: 12, background: "none", border: "none", color: "#1d4ed8", cursor: "pointer", textDecoration: "underline" }}
          >
            Send a new code
          </button>
        ) : null}
      </form>
      {available ? (
        <ul style={{ marginTop: 24, fontSize: 14, color: "#475569", listStyle: "none", padding: 0 }} data-cc-mfa-methods>
          {available
            .filter((m) => m !== mode)
            .map((m) => (
              <li key={m} style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => switchTo(m)}
                  style={{ background: "none", border: "none", color: "#1d4ed8", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                  data-cc-mfa-switch={m}
                >
                  {SWITCH_LABEL[m]}
                </button>
              </li>
            ))}
        </ul>
      ) : (
      <p style={{ marginTop: 24, fontSize: 14, color: "#475569" }}>
        <button
          type="button"
          onClick={toggleMode}
          style={{
            background: "none",
            border: "none",
            color: "#1d4ed8",
            cursor: "pointer",
            padding: 0,
            textDecoration: "underline",
          }}
          data-cc-mfa-toggle={mode === "totp" ? "use-recovery" : "use-totp"}
        >
          {mode === "totp"
            ? "Use a recovery code instead"
            : "Use the authenticator code instead"}
        </button>
      </p>
      )}
      {/* PHASE 13 — lost-factor recovery, the CREATE leg.
          This used to be a bare "Contact support" link: the verify and
          admin-approve legs were wired, but nothing in the product could
          file the request they act on. The panel POSTs
          `/v1/identity/mfa-admin/recovery-requests` and, because that route
          refuses MFA-pending tokens, renders its submit control disabled
          with the reason spelled out when this browser has no session. */}
      <MfaRecoveryRequestPanel compact />
      <p style={{ marginTop: 16, fontSize: 14, color: "#64748b" }}>
        Still stuck?{" "}
        <Link href="/support" style={{ color: "#1d4ed8" }}>
          Contact support
        </Link>
        .
      </p>
    </main>
  );
}

export default function MfaChallengePage() {
  return (
    <Suspense
      fallback={
        <main style={{ padding: 48, textAlign: "center" }}>Loading...</main>
      }
    >
      <MfaChallengeBody />
    </Suspense>
  );
}
