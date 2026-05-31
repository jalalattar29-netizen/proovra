"use client";

/**
 * PROOVRA Phase 2B — Portal token entry.
 *
 * Bounded entry surface where an external reviewer pastes the raw
 * invitation token. On submit we exchange the token for a portal
 * session and redirect to /portal/[token]. The raw token is held in
 * memory only; the session id lives in sessionStorage.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { authenticate } from "../../lib/external-portal/portal-client";

export default function PortalTokenEntryPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [mfa, setMfa] = useState("");
  const [denial, setDenial] = useState<string | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      await authenticate({
        token: token.trim(),
        mfaToken: mfaRequired ? mfa.trim() : undefined,
      });
      router.push(`/portal/${encodeURIComponent(token.trim())}`);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reason: string = (err as any)?.denial ?? "TOKEN_INVALID";
      if (reason === "MFA_REQUIRED") {
        setMfaRequired(true);
        setDenial("Enter the 6-digit MFA code.");
      } else {
        setDenial(reason);
      }
    } finally {
      setBusy(false);
    }
  }, [token, mfa, mfaRequired, router]);

  return (
    <main
      data-portal-token-entry
      style={{
        maxWidth: 480,
        margin: "0 auto",
        padding: "40px 24px",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>
        PROOVRA External Reviewer Portal
      </h1>
      <p style={{ color: "#475569", fontSize: 13, marginTop: 0, lineHeight: 1.55 }}>
        Paste the invitation token you were sent. Your activity in the
        portal is audited. PROOVRA records what you observe and decide;
        it does not assert authenticity of content.
      </p>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginTop: 14 }}>
        Invitation token
      </label>
      <input
        data-portal-token-input
        type="password"
        autoComplete="off"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="paste your token"
        style={inputStyle}
      />
      {mfaRequired ? (
        <>
          <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginTop: 12 }}>
            MFA code
          </label>
          <input
            data-portal-mfa-input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={mfa}
            onChange={(e) => setMfa(e.target.value.replace(/\D/g, ""))}
            placeholder="6-digit code"
            style={inputStyle}
          />
        </>
      ) : null}
      {denial ? (
        <div
          role="alert"
          data-portal-denial
          style={{
            padding: "8px 12px",
            marginTop: 10,
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.35)",
            borderRadius: 8,
            color: "#7f1d1d",
            fontSize: 12,
          }}
        >
          {denial}
        </div>
      ) : null}
      <button
        type="button"
        data-portal-submit
        disabled={busy || token.trim().length < 8}
        onClick={onSubmit}
        style={{
          marginTop: 14,
          padding: "9px 16px",
          borderRadius: 8,
          border: "1px solid #0f172a",
          background: busy ? "#94a3b8" : "#0f172a",
          color: "#fafafa",
          fontWeight: 600,
          fontSize: 13,
          cursor: busy ? "not-allowed" : "pointer",
        }}
      >
        {busy ? "Opening portal…" : "Open portal"}
      </button>
    </main>
  );
}

const inputStyle = {
  width: "100%",
  padding: "9px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 13,
  marginTop: 4,
  fontFamily: "inherit",
  boxSizing: "border-box" as const,
};
