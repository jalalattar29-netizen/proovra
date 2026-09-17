"use client";

/**
 * PROOVRA Phase 2B — Portal token entry.
 *
 * Bounded entry surface where an external reviewer pastes the raw
 * invitation token. On submit we exchange the token for a portal
 * session and redirect to /portal/[token]. The raw token is held in
 * memory only; the session id lives in sessionStorage.
 *
 * D27 — when the invitation requires MFA the API answers MFA_REQUIRED and
 * emails a six-digit code to the invited address; the shared
 * `PortalMfaCodeStep` collects it. The portal opens only after the server
 * accepts the code.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "../../components/ui/Button";
import { PortalMfaCodeStep } from "../../components/external-portal/PortalMfaCodeStep";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import {
  authenticate,
  readPortalFailure,
  type PortalMfaDetail,
} from "../../lib/external-portal/portal-client";

/** Denials that mean "this invitation needs its emailed code". */
const CODE_STEP_DENIALS = new Set([
  "MFA_REQUIRED",
  "MFA_INVALID",
  "MFA_CODE_EXHAUSTED",
  "MFA_UNAVAILABLE",
  "RATE_LIMITED",
]);

function tokenProblem(denial: string | null, fallback: string): string {
  switch (denial) {
    case "TOKEN_EXPIRED":
      return "This invitation has expired. Ask the person who invited you for a new one.";
    case "TOKEN_REVOKED":
      return "This invitation was withdrawn. Ask the person who invited you if you still need access.";
    case "TOKEN_INVALID":
      return "We couldn't open the portal with that invitation token. Check that you pasted all of it.";
    default:
      return fallback;
  }
}

export default function PortalTokenEntryPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [codeStep, setCodeStep] = useState<{
    denial: string;
    detail: PortalMfaDetail | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback(() => {
    router.push(`/portal/${encodeURIComponent(token.trim())}`);
  }, [router, token]);

  const onSubmit = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      await authenticate({ token: token.trim() });
      open();
    } catch (err) {
      const f = readPortalFailure(err);
      if (f.denial && CODE_STEP_DENIALS.has(f.denial)) {
        setCodeStep({ denial: f.denial, detail: f.mfa });
      } else {
        setProblem(
          tokenProblem(
            f.denial,
            toSafeUserError(err, { message: "We couldn't open the portal. Try again." }).message,
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  }, [token, open]);

  return (
    <main
      data-portal-token-entry
      style={{
        maxWidth: 480,
        margin: "0 auto",
        padding: "40px 16px",
        color: "var(--ink-primary)",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>
        PROOVRA External Reviewer Portal
      </h1>
      <p style={{ color: "var(--ink-secondary)", fontSize: 13, marginTop: 0, lineHeight: 1.55 }}>
        Paste the invitation token you were sent. Your activity in the
        portal is audited. PROOVRA records what you observe and decide;
        it does not assert authenticity of content.
      </p>
      <label
        htmlFor="portal-token-input"
        style={{ display: "block", fontSize: 12, fontWeight: 600, marginTop: 14 }}
      >
        Invitation token
      </label>
      <input
        id="portal-token-input"
        data-portal-token-input
        type="password"
        autoComplete="off"
        value={token}
        readOnly={codeStep !== null}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Paste your token"
        style={{
          width: "100%",
          padding: "9px 12px",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-sm)",
          fontSize: 13,
          marginTop: 4,
          fontFamily: "inherit",
          boxSizing: "border-box",
        }}
      />
      {problem ? (
        <div
          role="alert"
          data-portal-denial
          style={{
            padding: "8px 12px",
            marginTop: 10,
            background: "var(--danger-subtle-bg)",
            border: "1px solid var(--danger-border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--error-ink)",
            fontSize: 12,
          }}
        >
          {problem}
        </div>
      ) : null}

      {codeStep ? (
        <>
          <PortalMfaCodeStep
            token={token.trim()}
            denial={codeStep.denial}
            detail={codeStep.detail}
            onVerified={open}
          />
          <div style={{ marginTop: 10 }}>
            <Button
              variant="ghost"
              size="sm"
              data-portal-use-other-token
              onClick={() => {
                setCodeStep(null);
                setToken("");
              }}
            >
              Use a different invitation
            </Button>
          </div>
        </>
      ) : (
        <div style={{ marginTop: 14 }}>
          <Button
            variant="primary"
            data-portal-submit
            loading={busy}
            disabled={busy || token.trim().length < 8}
            disabledReason={
              !busy && token.trim().length < 8 ? "Paste the full invitation token first." : undefined
            }
            onClick={() => void onSubmit()}
          >
            {busy ? "Opening portal…" : "Open portal"}
          </Button>
        </div>
      )}
    </main>
  );
}
