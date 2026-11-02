"use client";

/**
 * IDENT-007 — add an authenticator during sign-in.
 *
 * Reached when the organization requires MFA and the account has no factor. The
 * API has already set an HTTP-only enrolment cookie that reaches only the
 * enrolment routes, so nothing here holds a token. Three steps: scan and confirm
 * a code, save the recovery codes, finish signing in.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";

import { apiFetch } from "../../lib/api";
import { Button } from "../ui";

type Phase =
  | { kind: "starting" }
  | { kind: "scan"; factorId: string; otpauthUri: string; secretBase32: string }
  | { kind: "recovery-codes"; codes: string[] }
  | { kind: "ended" };

/** The enrolment routes answer flat bodies, so the reason is on the plain Error. */
function failureOf(err: unknown): { statusCode: number; message: string } {
  const failure = err as { statusCode?: number; message?: string };
  return { statusCode: failure.statusCode ?? 0, message: failure.message ?? "" };
}

export function MfaEnrollmentAtSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const start = useCallback(async () => {
    setError(null);
    try {
      const res = (await apiFetch(
        "/v1/identity/mfa/enroll/start",
        { method: "POST", body: JSON.stringify({}) },
        { auth: false },
      )) as { factorId: string; otpauthUri: string; secretBase32: string };
      setPhase({ kind: "scan", ...res });
    } catch (err) {
      if (failureOf(err).statusCode === 401) setPhase({ kind: "ended" });
      else setError("Could not start setup. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  const confirmCode = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (phase.kind !== "scan" || busy) return;
    const digits = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(digits)) {
      setError("Enter the 6-digit code from your authenticator.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = (await apiFetch(
        "/v1/identity/mfa/enroll/verify",
        { method: "POST", body: JSON.stringify({ factorId: phase.factorId, code: digits }) },
        { auth: false },
      )) as { recoveryCodes: string[] };
      setCode("");
      setPhase({ kind: "recovery-codes", codes: res.recoveryCodes });
    } catch (err) {
      const failure = failureOf(err);
      if (failure.statusCode === 401) setPhase({ kind: "ended" });
      else if (failure.statusCode === 429) setError("Too many attempts. Wait a minute before trying again.");
      else if (failure.statusCode === 404) {
        setPhase({ kind: "starting" });
        await start();
      } else {
        setError("That code did not match. Check the timer on your authenticator and try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        "/v1/auth/mfa/enrollment/complete",
        { method: "POST", body: JSON.stringify({}) },
        { auth: false },
      );
      onSignedIn();
    } catch (err) {
      if (failureOf(err).statusCode === 401) setPhase({ kind: "ended" });
      else setError("Could not finish signing in. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (phase.kind === "ended") {
    return (
      <>
        <p role="alert" style={{ color: "#b91c1c", marginBottom: 24 }}>
          Your sign-in session ended. Please sign in again to continue setup.
        </p>
        <Link href="/login" data-cc-mfa-restart-login>
          Return to sign in
        </Link>
      </>
    );
  }

  if (phase.kind === "recovery-codes") {
    return (
      <div data-cc-mfa-enroll-step="recovery-codes">
        <p style={{ color: "#475569", marginBottom: 12 }}>
          Save these recovery codes somewhere safe. Each one works once, and they will not be
          shown again.
        </p>
        <ul
          data-cc-mfa-recovery-codes
          style={{
            listStyle: "none",
            padding: 12,
            margin: "0 0 16px",
            border: "1px solid #cbd5e1",
            borderRadius: 8,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {phase.codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        {error ? (
          <p role="alert" style={{ color: "#b91c1c", marginBottom: 12 }}>
            {error}
          </p>
        ) : null}
        <Button type="button" onClick={() => void finish()} disabled={busy} data-cc-mfa-enroll-finish>
          {busy ? "Finishing..." : "I saved them, continue"}
        </Button>
      </div>
    );
  }

  if (phase.kind === "starting") {
    return error ? (
      <>
        <p role="alert" style={{ color: "#b91c1c", marginBottom: 12 }}>
          {error}
        </p>
        <Button type="button" onClick={() => void start()}>
          Try again
        </Button>
      </>
    ) : (
      <p style={{ color: "#475569" }}>Preparing setup...</p>
    );
  }

  return (
    <form onSubmit={(e) => void confirmCode(e)} data-cc-mfa-enroll-step="scan" aria-busy={busy}>
      <p style={{ color: "#475569", marginBottom: 12 }}>
        Scan this code with your authenticator app, then enter the 6-digit code it shows.
      </p>
      <div
        aria-hidden="true"
        style={{
          display: "inline-block",
          padding: 10,
          marginBottom: 12,
          background: "#ffffff",
          border: "1px solid #cbd5e1",
          borderRadius: 12,
        }}
      >
        <QRCodeSVG value={phase.otpauthUri} size={148} />
      </div>
      <p style={{ fontSize: 14, color: "#475569", marginBottom: 4 }}>
        Can&apos;t scan? Enter this setup key:
      </p>
      <code data-cc-mfa-manual-secret style={{ display: "block", wordBreak: "break-all", marginBottom: 16 }}>
        {phase.secretBase32}
      </code>
      <label style={{ display: "block", marginBottom: 16 }}>
        <span style={{ display: "block", fontSize: 14, marginBottom: 6 }}>Authenticator code</span>
        <input
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Six-digit authenticator code"
          data-cc-mfa-input="enroll-totp"
          disabled={busy}
          style={{
            width: "100%",
            padding: "12px 14px",
            fontSize: 18,
            letterSpacing: "0.25em",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            border: "1px solid #cbd5e1",
            borderRadius: 8,
          }}
        />
      </label>
      {error ? (
        <p role="alert" data-cc-mfa-error style={{ color: "#b91c1c", marginBottom: 12 }}>
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {busy ? "Verifying..." : "Verify and continue"}
      </Button>
    </form>
  );
}
