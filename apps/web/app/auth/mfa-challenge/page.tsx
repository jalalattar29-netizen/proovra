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
 */

import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "../../../components/ui";
import { apiFetch, ApiError } from "../../../lib/api";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

type ChallengeMode = "totp" | "recovery_code";

const SAFE_NEXT_FALLBACK = "/home";

function isSafeNext(value: string | null): value is string {
  if (!value) return false;
  // The same safety contract as `sanitiseRedirectAfter` on the API
  // side: must be a relative path, must not start with "//" (which
  // would be host-relative), must not contain raw newlines.
  if (value.startsWith("//")) return false;
  if (!value.startsWith("/")) return false;
  if (/[\r\n]/.test(value)) return false;
  if (value.length > 400) return false;
  return true;
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
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [challengeExpired, setChallengeExpired] = useState(false);
  const inFlightRef = useRef(false);

  // Defensive: if the operator landed on this page with no pending
  // cookie (e.g. direct URL navigation), they cannot complete MFA.
  // Bounce them back to /login. We use a one-shot effect; the actual
  // cookie presence cannot be read from JS (HTTP-only), so we infer
  // by issuing a no-op preflight on first focus and reading the
  // 401/400 response.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await apiFetch(
          "/v1/auth/mfa/verify",
          // Body without code or recoveryCode — the route returns
          // 400 invalid_body when the pending cookie is present and
          // 401 mfa_pending_invalid when it is not. Either response
          // resolves the apiFetch promise via the error branch; we
          // disambiguate by reading the error code.
          { method: "POST", body: JSON.stringify({}) },
          { auth: false },
        );
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.statusCode === 401) {
          // No pending cookie → no challenge in flight.
          setError(
            "Your sign-in session has expired. Please sign in again.",
          );
        }
        // 400 invalid_body == cookie is present, page is operational.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || inFlightRef.current) return;
    setError(null);
    setStatus(null);
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
      // Sanity check — the canonical session cookie was set by the
      // backend; /v1/auth/me must now succeed.
      const me = await apiFetch("/v1/auth/me", { method: "GET" });
      if (!me?.user) {
        throw new Error("Session not confirmed.");
      }
      router.replace(next);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 429) {
          setError(
            "Too many attempts. Wait a minute before trying again.",
          );
        } else if (err.statusCode === 401) {
          // R8.1.3 — disambiguate the three 401 reasons surfaced by
          // the durable verify endpoint. `mfa_challenge_expired` and
          // `mfa_challenge_already_used` need the operator to re-
          // start primary login; `mfa_invalid` is a retryable
          // "wrong code" state.
          // Reads the RAW ApiError.message ON PURPOSE — internal control
          // flow matching bounded reason codes, never rendered.
          const msg = err.message ?? "";
          if (msg === "mfa_challenge_expired") {
            setChallengeExpired(true);
            setError(
              "Your two-factor challenge expired. Please sign in again to start a fresh challenge.",
            );
          } else if (msg === "mfa_challenge_already_used") {
            setChallengeExpired(true);
            setError(
              "That two-factor challenge was already used. Please sign in again to start a fresh challenge.",
            );
          } else if (msg === "mfa_pending_invalid") {
            setChallengeExpired(true);
            setError(
              "Your sign-in session ended. Please sign in again.",
            );
          } else {
            setError(
              mode === "totp"
                ? "That code did not match. Check the timer on your authenticator and try again."
                : "That recovery code was not accepted. Each code is single-use.",
            );
          }
        } else {
          setError(
            toSafeUserError(err, {
              message: "Could not verify the second factor.",
            }).message,
          );
        }
      } else {
        const msg = toSafeUserError(err, { message: "Verification failed." }).message;
        setError(msg);
      }
      setStatus(null);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const toggleMode = () => {
    setMode((m) => (m === "totp" ? "recovery_code" : "totp"));
    setError(null);
    setStatus(null);
    setCode("");
    setRecoveryCode("");
  };

  // R8.1.3 — enrollment-required surface. Renders when the SSO/OIDC
  // gate redirected here with `?enroll=1`. No code input — the path
  // forward is enrollment. The operator session is NOT live yet; we
  // route them to /login → enrollment so the enrollment endpoint's
  // requireAuth pre-handler can pick up a fresh session once they
  // re-authenticate primary credentials and complete enrollment.
  // This is explicitly NOT a silent lockout.
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
          Your organization requires two-factor authentication. To
          continue, you need to enroll an authenticator on your
          account.
        </p>
        <p style={{ color: "#475569", marginBottom: 24 }}>
          Sign in again and your operator menu will guide you through
          enrollment. You will not be able to access workspace data
          until enrollment is complete.
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
          data-cc-mfa-enrollment-cta
        >
          Sign in to start enrollment
        </Link>
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
          : "Enter one of your single-use recovery codes. Each code works exactly once."}
      </p>
      <form onSubmit={handleSubmit} aria-busy={busy}>
        {mode === "totp" ? (
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
          {busy ? "Verifying..." : "Verify and continue"}
        </Button>
      </form>
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
      <p style={{ marginTop: 24, fontSize: 14, color: "#64748b" }}>
        Lost access to your authenticator and codes?{" "}
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
