"use client";

/**
 * Personal account security sections — canonical `/settings/security` body.
 *
 * Five sections, all real-backend:
 *
 *   A. Summary strip — login method, MFA status, active-session count,
 *      last security activity. Derived from the SAME fetches the cards
 *      below use (state is lifted; nothing is fetched twice).
 *   B. Authentication — change password (password accounts) or the
 *      login-provider explanation (OAuth-only accounts).
 *   C. Two-factor authentication — full personal MFA management against
 *      the canonical /v1/identity/mfa/* API family:
 *        - status (factors + recovery codes remaining)
 *        - enrollment (QR + accessible manual secret → verify code)
 *        - one-time recovery-code display + explicit acknowledgement
 *        - recovery-code regeneration
 *        - factor removal (confirmed)
 *      Account-level for EVERY plan and EVERY login provider (OAuth users
 *      enroll too). Organization MFA *policy* is not edited here — it
 *      lives in /security-center.
 *   D. Active sessions (current + others; revoke-others preserves current).
 *   E. Recent security activity — human titles via the canonical
 *      securityEventLabels mapping; forensic detail behind a disclosure.
 *
 * Visual system (2026-07-16 remediation): this file previously carried
 * hardcoded DARK-theme inline styles (translucent black inputs, light-grey
 * foreground text) from its old /security-center home, which rendered
 * dark-on-light after the move to /settings/security. All styles now use
 * the canonical light tokens (var(--ink-*), var(--border-default),
 * var(--surface-card)) shared with the redesigned internal pages.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { apiFetch } from "../../../../lib/api";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { formatUtcAuditDateTime } from "../../../../lib/date";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import {
  presentOutcome,
  presentSecurityEvent,
} from "../../../../lib/security/securityEventLabels";
import { useAuth } from "../../../providers";

// -----------------------------------------------------------------------------
// Shared styles — canonical LIGHT tokens (no dark-theme constants).
// -----------------------------------------------------------------------------

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  marginBottom: 8,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase" as const,
  color: "var(--ink-primary, #0f172a)",
};

const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--ink-secondary, #475569)",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "9px 11px",
  borderRadius: 10,
  border: "1px solid var(--border-default, rgba(15,23,42,0.12))",
  background: "var(--surface-card, #ffffff)",
  color: "var(--ink-primary, #0f172a)",
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--ink-secondary, #475569)",
  marginTop: 8,
  marginBottom: 4,
};

const errorBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(179,38,30,0.06)",
  border: "1px solid rgba(179,38,30,0.35)",
  color: "#8f1d16",
  fontSize: 12,
};

const okBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(47,125,91,0.07)",
  border: "1px solid rgba(47,125,91,0.35)",
  color: "#215e44",
  fontSize: 12,
};

function fmt(ts: string): string {
  return formatUtcAuditDateTime(ts);
}

// -----------------------------------------------------------------------------
// Shared data — factors + sessions fetched ONCE, consumed by the summary
// strip and the cards below.
// -----------------------------------------------------------------------------

interface MfaFactorRow {
  id: string;
  label: string;
  status: string;
}

interface MfaStatus {
  hasMfa: boolean;
  factors: MfaFactorRow[];
  recoveryCodesRemaining: number;
}

interface MySession {
  id: string;
  sessionIdHash: string;
  isCurrent: boolean;
  issuedAtUtc: string;
  expiresAtUtc: string;
  lastSeenAtUtc: string;
  ipPreview: string | null;
  uaPreview: string | null;
  countryCode: string | null;
  quarantined: boolean;
}

function useSecurityData() {
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<MySession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const reloadMfa = useCallback(async () => {
    setMfaError(null);
    try {
      const res = (await apiFetch("/v1/identity/mfa/factors", {
        method: "GET",
      })) as MfaStatus;
      setMfa({
        hasMfa: !!res.hasMfa,
        factors: res.factors ?? [],
        recoveryCodesRemaining: res.recoveryCodesRemaining ?? 0,
      });
    } catch (err) {
      setMfaError(
        toSafeUserError(err, { message: "Could not load two-factor status." })
          .message,
      );
    }
  }, []);

  const reloadSessions = useCallback(async () => {
    setSessionsError(null);
    try {
      const res = (await apiFetch("/v1/identity-security/my-sessions", {
        method: "GET",
      })) as { sessions: MySession[] };
      setSessions(res.sessions ?? []);
    } catch (err) {
      setSessionsError(
        toSafeUserError(err, { message: "Could not load sessions." }).message,
      );
    }
  }, []);

  useEffect(() => {
    void reloadMfa();
    void reloadSessions();
  }, [reloadMfa, reloadSessions]);

  return {
    mfa,
    mfaError,
    reloadMfa,
    sessions,
    sessionsError,
    reloadSessions,
  };
}

// -----------------------------------------------------------------------------
// A. Summary strip
// -----------------------------------------------------------------------------

const OAUTH_PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
};

function SummaryStrip({
  mfa,
  sessions,
}: {
  mfa: MfaStatus | null;
  sessions: MySession[] | null;
}) {
  const { user } = useAuth();
  const providerKey = (user?.provider ?? "").toLowerCase();
  const providerLabel =
    OAUTH_PROVIDER_LABELS[providerKey] ??
    (providerKey ? "Email & password" : "—");

  const items: Array<{ label: string; value: string }> = [
    { label: "Login method", value: providerLabel },
    {
      label: "Two-factor",
      value: mfa === null ? "…" : mfa.hasMfa ? "Enabled" : "Not configured",
    },
    {
      label: "Active sessions",
      value: sessions === null ? "…" : String(sessions.length),
    },
  ];

  return (
    <Card
      variant="admin"
      style={{ marginBottom: 14 }}
      data-cc-security-summary
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
        }}
      >
        {items.map((it) => (
          <div key={it.label}>
            <div style={mutedStyle}>{it.label}</div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 650,
                color: "var(--ink-primary, #0f172a)",
                marginTop: 2,
              }}
              data-cc-security-summary-value={it.label}
            >
              {it.value}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// B. Password change / login method
// -----------------------------------------------------------------------------

function meetsPolicy(pw: string): boolean {
  if (pw.length < 12) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/\d/.test(pw)) return false;
  return true;
}

const ERROR_MESSAGES: Record<string, string> = {
  rate_limited:
    "Too many attempts. Please wait a minute before trying again.",
  current_password_invalid:
    "The current password is incorrect.",
  sso_user_password_unsupported:
    "Your account signs in through an identity provider. Change your password there.",
  no_password_set:
    "No password is set on this account. Use the password reset flow to create one.",
  same_as_current:
    "Your new password must be different from your current password.",
  weak_new_password:
    "Use at least 12 characters with upper- and lower-case letters and a number.",
};

function PasswordChangeCard() {
  // §5 — OAuth-only accounts previously saw the full change-password form and
  // then got a server rejection (`sso_user_password_unsupported`). The account's
  // real login provider decides what renders. We do NOT offer "Set a password":
  // the backend has no secure account-linking flow, and this remediation does
  // not invent one.
  const { user } = useAuth();
  const providerKey = (user?.provider ?? "").toLowerCase();
  const oauthProviderLabel = OAUTH_PROVIDER_LABELS[providerKey] ?? null;

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const canSubmit =
    currentPassword.length > 0 &&
    meetsPolicy(newPassword) &&
    newPassword === confirmPassword &&
    !busy;

  const submit = useCallback(async () => {
    setError(null);
    setOk(null);
    if (newPassword !== confirmPassword) {
      setError("The new password and confirmation must match.");
      return;
    }
    if (!meetsPolicy(newPassword)) {
      setError(ERROR_MESSAGES.weak_new_password!);
      return;
    }
    setBusy(true);
    try {
      const res = (await apiFetch("/v1/identity-security/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          revokeOtherSessions: revokeOthers,
        }),
      })) as { ok: true; revokedOtherSessions: number };
      setOk(
        revokeOthers
          ? `Password updated. ${res.revokedOtherSessions} other session(s) signed out.`
          : "Password updated.",
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      const e = err as {
        status?: number;
        body?: { error?: { code?: string } };
      };
      const code = e.body?.error?.code ?? "error";
      setError(
        ERROR_MESSAGES[code] ??
          "We could not change your password. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [currentPassword, newPassword, confirmPassword, revokeOthers]);

  // OAuth-only account: show the real login method instead of a form the
  // backend will always reject.
  if (oauthProviderLabel) {
    return (
      <Card
        variant="admin"
        style={{ marginBottom: 14 }}
        data-cc-password-change-card
        data-cc-password-oauth-only={providerKey}
      >
        <h2 style={sectionTitleStyle}>Login method</h2>
        <p style={mutedStyle}>
          You sign in to PROOVRA with {oauthProviderLabel}. Your password is
          managed in your {oauthProviderLabel} account, so there is no PROOVRA
          password to change here.
        </p>
        <p style={{ ...mutedStyle, marginTop: 8 }}>
          Two-factor authentication for your PROOVRA account is managed below
          and applies regardless of how you sign in.
        </p>
      </Card>
    );
  }

  return (
    <Card variant="admin" style={{ marginBottom: 14 }} data-cc-password-change-card>
      <h2 style={sectionTitleStyle}>Change password</h2>
      <p style={mutedStyle}>
        Use at least 12 characters with upper- and lower-case letters and a
        number. Your current password is required.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        autoComplete="off"
      >
        <label style={labelStyle}>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
            data-cc-password-current
          />
        </label>
        <label style={labelStyle}>
          New password
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
            data-cc-password-new
          />
        </label>
        <label style={labelStyle}>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
            data-cc-password-confirm
          />
        </label>
        <label
          style={{
            ...labelStyle,
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
            marginBottom: 0,
          }}
        >
          <input
            type="checkbox"
            checked={revokeOthers}
            onChange={(e) => setRevokeOthers(e.target.checked)}
            disabled={busy}
          />
          Sign out my other sessions after the change
        </label>

        {error ? <div style={errorBox}>{error}</div> : null}
        {ok ? <div style={okBox}>{ok}</div> : null}

        <div style={{ marginTop: 12 }}>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!canSubmit}
            loading={busy}
            data-cc-password-submit
          >
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Step-up re-authentication ("Verify it's you")
//
// Sensitive actions (factor removal, recovery-code regeneration, revoke
// other sessions) are BACKEND-enforced: the API returns 401
// STEP_UP_REQUIRED/STEP_UP_INVALID with the proof methods this account
// supports (password / current MFA code / re-sign-in). This shared prompt
// collects the proof and the caller retries the mutation with it. The
// confirmation dialog alone is never sufficient.
// -----------------------------------------------------------------------------

type StepUpMethods = Array<"password" | "mfa" | "reauth">;
type StepUpProof = { method: "password" | "mfa"; currentPassword?: string; code?: string };

function extractStepUp(err: unknown): { methods: StepUpMethods; message: string } | null {
  const e = err as {
    body?: { error?: { code?: string; methods?: StepUpMethods; message?: string } };
  };
  const code = e.body?.error?.code;
  if (code !== "STEP_UP_REQUIRED" && code !== "STEP_UP_INVALID") return null;
  return {
    methods: e.body?.error?.methods ?? ["reauth"],
    message:
      code === "STEP_UP_INVALID"
        ? (e.body?.error?.message ?? "Verification failed. Try again.")
        : "",
  };
}

function StepUpVerify({
  title,
  methods,
  initialError,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  methods: StepUpMethods;
  initialError: string;
  busy: boolean;
  onSubmit: (proof: StepUpProof) => void;
  onCancel: () => void;
}) {
  const usePassword = methods.includes("password");
  const useMfa = !usePassword && methods.includes("mfa");
  const [value, setValue] = useState("");

  return (
    <div
      data-cc-step-up-verify
      role="group"
      aria-label="Verify it's you"
      style={{
        marginTop: 10,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--border-default, rgba(15,23,42,0.14))",
        background: "var(--surface-card, #ffffff)",
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "var(--ink-primary, #0f172a)",
        }}
      >
        Verify it&apos;s you
      </div>
      <p style={{ ...mutedStyle, marginTop: 4 }}>{title}</p>
      {initialError ? <div style={errorBox}>{initialError}</div> : null}

      {usePassword || useMfa ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(
              usePassword
                ? { method: "password", currentPassword: value }
                : { method: "mfa", code: value.trim() },
            );
          }}
        >
          <label style={labelStyle}>
            {usePassword ? "Current password" : "6-digit code from your authenticator app"}
            <input
              type={usePassword ? "password" : "text"}
              inputMode={usePassword ? undefined : "numeric"}
              autoComplete={usePassword ? "current-password" : "one-time-code"}
              value={value}
              onChange={(e) =>
                setValue(
                  usePassword
                    ? e.target.value
                    : e.target.value.replace(/[^0-9]/g, "").slice(0, 8),
                )
              }
              disabled={busy}
              style={{ ...inputStyle, maxWidth: 240 }}
              data-cc-step-up-input
            />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={busy}
              disabled={busy || value.length === 0}
              data-cc-step-up-submit
            >
              Verify &amp; continue
            </Button>
            <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {/* OAuth-only account without MFA — no in-app secret to verify.
              A fresh sign-in establishes recent authentication. */}
          <p style={{ ...mutedStyle, marginTop: 6 }}>
            For this change, please sign out and sign back in with your
            identity provider, then retry within 10 minutes.
          </p>
          <div style={{ marginTop: 10 }}>
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Close
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// C. Two-factor authentication (personal MFA management)
// -----------------------------------------------------------------------------

type MfaUiPhase =
  | { kind: "status" }
  | {
      kind: "enrolling";
      factorId: string;
      otpauthUri: string;
      secretBase32: string;
    }
  | { kind: "recovery-codes"; codes: string[]; context: "enroll" | "regenerate" };

const MFA_VERIFY_ERRORS: Record<string, string> = {
  code_invalid:
    "That code didn't match. Check your authenticator app and try again.",
  factor_not_found:
    "This enrollment expired or was removed. Start enrollment again.",
  rate_limited:
    "Too many attempts. Please wait a minute before trying again.",
};

function MfaCard({
  mfa,
  mfaError,
  reloadMfa,
}: {
  mfa: MfaStatus | null;
  mfaError: string | null;
  reloadMfa: () => Promise<void>;
}) {
  const { confirm } = useConfirmAction();
  const [phase, setPhase] = useState<MfaUiPhase>({ kind: "status" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [codesAcknowledged, setCodesAcknowledged] = useState(false);
  // Backend step-up state — set when a sensitive call returns 401
  // STEP_UP_REQUIRED/STEP_UP_INVALID; the prompt retries with proof.
  const [stepUpFor, setStepUpFor] = useState<
    null | { kind: "remove"; factor: MfaFactorRow } | { kind: "regenerate" }
  >(null);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");

  const activeFactors = useMemo(
    () => (mfa?.factors ?? []).filter((f) => f.status === "ACTIVE"),
    [mfa],
  );

  const startEnrollment = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = (await apiFetch("/v1/identity/mfa/enroll/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })) as { factorId: string; otpauthUri: string; secretBase32: string };
      setCode("");
      setPhase({
        kind: "enrolling",
        factorId: res.factorId,
        otpauthUri: res.otpauthUri,
        secretBase32: res.secretBase32,
      });
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "Could not start enrollment." }).message,
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const verifyEnrollment = useCallback(async () => {
    if (phase.kind !== "enrolling") return;
    setError(null);
    setBusy(true);
    try {
      const res = (await apiFetch("/v1/identity/mfa/enroll/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ factorId: phase.factorId, code: code.trim() }),
      })) as { factorId?: string; recoveryCodes?: string[]; error?: string };
      if (res.error || !res.recoveryCodes) {
        setError(
          MFA_VERIFY_ERRORS[res.error ?? ""] ??
            "Verification failed. Try again.",
        );
        return;
      }
      // Recovery codes are shown EXACTLY ONCE — the backend never returns
      // them again. The user must explicitly acknowledge saving them.
      setCodesAcknowledged(false);
      setPhase({
        kind: "recovery-codes",
        codes: res.recoveryCodes,
        context: "enroll",
      });
      await reloadMfa();
    } catch (err) {
      const e = err as { body?: { error?: string } };
      setError(
        MFA_VERIFY_ERRORS[e.body?.error ?? ""] ??
          toSafeUserError(err, { message: "Verification failed. Try again." })
            .message,
      );
    } finally {
      setBusy(false);
    }
  }, [phase, code, reloadMfa]);

  const cancelEnrollment = useCallback(async () => {
    if (phase.kind !== "enrolling") return;
    // Best-effort cleanup of the ENROLLING factor; the status view reloads
    // regardless. An abandoned ENROLLING factor is inert (never ACTIVE).
    try {
      await apiFetch(`/v1/identity/mfa/factors/${phase.factorId}`, {
        method: "DELETE",
      });
    } catch {
      /* inert row; ignore */
    }
    setPhase({ kind: "status" });
    setCode("");
    setError(null);
    await reloadMfa();
  }, [phase, reloadMfa]);

  const regenerateCodes = useCallback(
    async (proof?: StepUpProof) => {
      if (!proof) {
        const ok = await confirm({
          title: "Regenerate recovery codes?",
          description:
            "Your existing recovery codes stop working immediately. New codes are shown once — store them in a safe place.",
          confirmLabel: "Regenerate",
          tone: "warning",
          testId: "mfa-regenerate-recovery-codes",
        });
        if (!ok) return;
      }
      setError(null);
      setBusy(true);
      try {
        const res = (await apiFetch(
          "/v1/identity/mfa/recovery-codes/regenerate",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(proof ? { stepUp: proof } : {}),
          },
        )) as { recoveryCodes: string[] };
        setStepUpFor(null);
        setCodesAcknowledged(false);
        setPhase({
          kind: "recovery-codes",
          codes: res.recoveryCodes,
          context: "regenerate",
        });
        await reloadMfa();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUpFor({ kind: "regenerate" });
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        setError(
          toSafeUserError(err, {
            message: "Could not regenerate recovery codes.",
          }).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [confirm, reloadMfa],
  );

  const removeFactor = useCallback(
    async (factor: MfaFactorRow, proof?: StepUpProof) => {
      if (!proof) {
        const ok = await confirm({
          title: "Remove two-factor authentication?",
          description:
            "Your account will no longer require a second factor at sign-in. If your organization requires MFA, you will be asked to re-enroll on your next sign-in.",
          confirmLabel: "Remove factor",
          tone: "danger",
          testId: "mfa-remove-factor",
        });
        if (!ok) return;
      }
      setError(null);
      setBusy(true);
      try {
        await apiFetch(`/v1/identity/mfa/factors/${factor.id}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof ? { stepUp: proof } : {}),
        });
        setStepUpFor(null);
        setNotice("Two-factor authentication removed.");
        await reloadMfa();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUpFor({ kind: "remove", factor });
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        setError(
          toSafeUserError(err, { message: "Could not remove the factor." })
            .message,
        );
      } finally {
        setBusy(false);
      }
    },
    [confirm, reloadMfa],
  );

  const acknowledgeCodes = useCallback(() => {
    // After acknowledgement the codes are gone from the UI for good.
    setPhase({ kind: "status" });
    setNotice(
      "Recovery codes saved. They will not be shown again — regenerate if you lose them.",
    );
  }, []);

  return (
    <Card variant="admin" style={{ marginBottom: 14 }} data-cc-mfa-card>
      <h2 style={sectionTitleStyle}>Two-factor authentication</h2>

      {mfaError ? <div style={errorBox}>{mfaError}</div> : null}

      {phase.kind === "status" ? (
        mfa === null ? (
          <p style={mutedStyle}>Loading…</p>
        ) : activeFactors.length === 0 ? (
          <>
            <p style={mutedStyle}>
              Protect your account with an authenticator app. After setup,
              sign-ins require a 6-digit code in addition to your login
              method. Available on every plan and for every sign-in provider.
            </p>
            <div style={{ marginTop: 12 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void startEnrollment()}
                loading={busy}
                disabled={busy}
                data-cc-mfa-enroll-start
              >
                Set up two-factor authentication
              </Button>
            </div>
          </>
        ) : (
          <>
            <p style={mutedStyle}>
              Two-factor authentication is <strong>enabled</strong>. Recovery
              codes remaining: {mfa.recoveryCodesRemaining}.
            </p>
            <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
              {activeFactors.map((f) => (
                <li
                  key={f.id}
                  data-cc-mfa-factor-row={f.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                    marginBottom: 6,
                    fontSize: 13,
                    color: "var(--ink-primary, #0f172a)",
                  }}
                >
                  <span>
                    {f.label || "Authenticator app"}{" "}
                    <Badge tone="verified" subtle style={{ marginLeft: 6 }}>
                      Active
                    </Badge>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void removeFactor(f)}
                    disabled={busy}
                    data-cc-mfa-remove-factor={f.id}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <div style={{ marginTop: 10 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void regenerateCodes()}
                disabled={busy}
                data-cc-mfa-regenerate-codes
              >
                Regenerate recovery codes
              </Button>
            </div>
          </>
        )
      ) : null}

      {phase.kind === "enrolling" ? (
        <div data-cc-mfa-enrolling>
          <p style={mutedStyle}>
            Scan this QR code with your authenticator app (Google
            Authenticator, 1Password, Authy, …), then enter the 6-digit code
            it shows.
          </p>
          <div
            style={{
              display: "flex",
              gap: 16,
              flexWrap: "wrap",
              alignItems: "flex-start",
              marginTop: 12,
            }}
          >
            <div
              style={{
                padding: 10,
                borderRadius: 12,
                border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                background: "#ffffff",
              }}
              aria-hidden="true"
            >
              <QRCodeSVG value={phase.otpauthUri} size={148} />
            </div>
            <div style={{ minWidth: 220, flex: 1 }}>
              {/* Accessible fallback — the manual secret works without
                  scanning. Rendered as selectable text for screen readers. */}
              <div style={labelStyle}>
                Can&apos;t scan? Enter this setup key manually:
              </div>
              <code
                data-cc-mfa-manual-secret
                style={{
                  display: "inline-block",
                  padding: "6px 9px",
                  borderRadius: 8,
                  border: "1px solid var(--border-default, rgba(15,23,42,0.12))",
                  background: "var(--surface-card, #ffffff)",
                  color: "var(--ink-primary, #0f172a)",
                  fontSize: 13,
                  letterSpacing: 1,
                  wordBreak: "break-all",
                }}
              >
                {phase.secretBase32}
              </code>

              <label style={labelStyle}>
                6-digit code from your app
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 8))
                  }
                  disabled={busy}
                  style={{ ...inputStyle, maxWidth: 160 }}
                  data-cc-mfa-verify-code
                />
              </label>

              {error ? <div style={errorBox}>{error}</div> : null}

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void verifyEnrollment()}
                  loading={busy}
                  disabled={busy || code.trim().length < 6}
                  data-cc-mfa-verify-submit
                >
                  Verify &amp; enable
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void cancelEnrollment()}
                  disabled={busy}
                  data-cc-mfa-enroll-cancel
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {phase.kind === "recovery-codes" ? (
        <div data-cc-mfa-recovery-codes>
          <p style={{ ...mutedStyle, fontWeight: 650 }}>
            {phase.context === "enroll"
              ? "Two-factor authentication is now enabled."
              : "New recovery codes generated."}{" "}
            Store these recovery codes somewhere safe — each works once, and
            they will <strong>never be shown again</strong>.
          </p>
          <ul
            aria-label="Recovery codes — shown once"
            style={{
              listStyle: "none",
              margin: "10px 0 0",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px dashed var(--border-default, rgba(15,23,42,0.18))",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
              gap: 6,
              fontFamily: "ui-monospace, monospace",
              fontSize: 13,
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            {phase.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <label
            style={{
              ...labelStyle,
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
            }}
          >
            <input
              type="checkbox"
              checked={codesAcknowledged}
              onChange={(e) => setCodesAcknowledged(e.target.checked)}
              data-cc-mfa-codes-acknowledge
            />
            I saved these recovery codes in a safe place.
          </label>
          <div style={{ marginTop: 10 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={acknowledgeCodes}
              disabled={!codesAcknowledged}
              data-cc-mfa-codes-done
            >
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {stepUpFor ? (
        <StepUpVerify
          title={
            stepUpFor.kind === "remove"
              ? "Confirm removing two-factor authentication from your account."
              : "Confirm regenerating your recovery codes (existing codes stop working)."
          }
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) =>
            stepUpFor.kind === "remove"
              ? void removeFactor(stepUpFor.factor, proof)
              : void regenerateCodes(proof)
          }
          onCancel={() => {
            setStepUpFor(null);
            setStepUpMsg("");
          }}
        />
      ) : null}

      {notice ? <div style={okBox}>{notice}</div> : null}
    </Card>
  );
}

// -----------------------------------------------------------------------------
// D. Active sessions
// -----------------------------------------------------------------------------

function ActiveSessionsCard({
  sessions,
  sessionsError,
  reloadSessions,
}: {
  sessions: MySession[] | null;
  sessionsError: string | null;
  reloadSessions: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");
  const { confirm } = useConfirmAction();

  const current = (sessions ?? []).filter((s) => s.isCurrent);
  const others = (sessions ?? []).filter((s) => !s.isCurrent);

  const revokeOthers = useCallback(
    async (proof?: StepUpProof) => {
      if (!proof) {
        const ok = await confirm({
          title: "Sign out other sessions?",
          description: `Every active session except this one will be terminated (${others.length} session(s)). You will not be signed out from this device.`,
          confirmLabel: "Sign out others",
          tone: "warning",
          testId: "security-center-self-revoke-others",
        });
        if (!ok) return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const res = (await apiFetch(
          "/v1/identity-security/my-sessions/revoke-others",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(proof ? { stepUp: proof } : {}),
          },
        )) as { revoked: number };
        setStepUpOpen(false);
        setNotice(`${res.revoked} other session(s) signed out.`);
        await reloadSessions();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUpOpen(true);
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        setError(
          toSafeUserError(err, { message: "Could not revoke sessions." }).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [confirm, others.length, reloadSessions],
  );

  const sessionRow = (s: MySession) => (
    <li
      key={s.id}
      data-cc-session-row={s.id}
      data-cc-session-current={s.isCurrent ? "true" : "false"}
      style={{
        padding: "10px 12px",
        marginBottom: 6,
        borderRadius: 10,
        border: s.isCurrent
          ? "1px solid rgba(47,125,91,0.45)"
          : "1px solid var(--border-default, rgba(15,23,42,0.09))",
        background: s.isCurrent
          ? "rgba(47,125,91,0.06)"
          : "var(--surface-card, #ffffff)",
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 700, color: "var(--ink-primary, #0f172a)" }}>
        {s.isCurrent ? "This device" : s.uaPreview ?? "Unknown device"}
        {s.isCurrent ? (
          <Badge tone="verified" subtle style={{ marginLeft: 8 }}>
            Current session
          </Badge>
        ) : null}
        {s.quarantined ? (
          <Badge tone="pending" subtle style={{ marginLeft: 8 }}>
            QUARANTINED
          </Badge>
        ) : null}
      </div>
      <div style={mutedStyle}>
        {s.ipPreview ?? "IP unknown"} · {s.countryCode ?? "??"} · last seen{" "}
        {fmt(s.lastSeenAtUtc)}
      </div>
      <div style={{ ...mutedStyle, marginTop: 2 }}>
        Issued {fmt(s.issuedAtUtc)} · expires {fmt(s.expiresAtUtc)}
      </div>
    </li>
  );

  return (
    <Card variant="admin" style={{ marginBottom: 14 }} data-cc-active-sessions-card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ ...sectionTitleStyle, marginBottom: 0 }}>
          Your active sessions
        </h2>
        {/* "Sign out other sessions" renders ONLY when another revocable
            session actually exists — never as a dead control. */}
        {others.length > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void revokeOthers()}
            loading={busy}
            disabled={busy}
            data-cc-revoke-others
          >
            Sign out other sessions
          </Button>
        ) : null}
      </div>
      <p style={mutedStyle}>
        Sessions you are signed into right now. Your current session is listed
        first and is never revoked by &ldquo;Sign out other sessions&rdquo;.
      </p>

      {sessions === null ? (
        <p style={mutedStyle}>Loading…</p>
      ) : sessions.length === 0 ? (
        <EmptyState
          compact
          title="Session inventory unavailable"
          purpose="Your current sign-in is active, but no session records could be listed right now. Try again shortly."
        />
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, marginTop: 10 }}>
          {current.map(sessionRow)}
          {others.length > 0 ? (
            others.map(sessionRow)
          ) : (
            <li style={{ ...mutedStyle, padding: "6px 2px" }} data-cc-no-other-sessions>
              No other active sessions.
            </li>
          )}
        </ul>
      )}

      {stepUpOpen ? (
        <StepUpVerify
          title="Confirm signing out every other session on your account."
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) => void revokeOthers(proof)}
          onCancel={() => {
            setStepUpOpen(false);
            setStepUpMsg("");
          }}
        />
      ) : null}

      {(error ?? sessionsError) ? (
        <div style={errorBox}>{error ?? sessionsError}</div>
      ) : null}
      {notice ? <div style={okBox}>{notice}</div> : null}
    </Card>
  );
}

// -----------------------------------------------------------------------------
// E. Security events feed
// -----------------------------------------------------------------------------

interface SecurityEvent {
  id: string;
  action: string;
  severity: string | null;
  outcome: string | null;
  occurredAtUtc: string;
  resourceType: string | null;
  resourceId: string | null;
  ipPreview: string | null;
  uaPreview: string | null;
  metadata: unknown;
}

function severityDot(sev: string | null): React.CSSProperties {
  const color =
    sev === "critical"
      ? "#b3261e"
      : sev === "warning"
        ? "#b26a00"
        : "var(--ink-secondary, #64748b)";
  return {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
    marginRight: 8,
  };
}

function SecurityEventsCard() {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = (await apiFetch(
          "/v1/identity-security/security-events?limit=50",
          { method: "GET" },
        )) as { events: SecurityEvent[] };
        setEvents(res.events ?? []);
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Could not load security events." }).message,
        );
      }
    })();
  }, []);

  const rows = useMemo(() => events ?? [], [events]);

  return (
    <Card variant="admin" style={{ marginBottom: 14 }} data-cc-security-events-card>
      <h2 style={sectionTitleStyle}>Recent security activity</h2>
      <p style={mutedStyle}>
        Bounded timeline of identity and auth events tied to your account.
        Older events live in the platform audit log.
      </p>

      {error ? <div style={errorBox}>{error}</div> : null}

      {events === null ? (
        <p style={mutedStyle}>Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          title="No security events in the recent window"
          purpose="Identity and auth events tied to your account appear here as they occur."
        />
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            marginTop: 10,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {rows.map((ev) => (
            <li
              key={ev.id}
              data-cc-security-event-row={ev.id}
              style={{
                padding: "8px 10px",
                borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.07))",
                fontSize: 12,
                color: "var(--ink-primary, #0f172a)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <span aria-hidden style={severityDot(ev.severity)} />
                {/* Human title from the ONE canonical mapping — the raw
                    internal audit key is never the primary copy. */}
                <strong style={{ fontWeight: 700 }}>
                  {presentSecurityEvent(ev.action).title}
                </strong>
                {presentOutcome(ev.outcome) ? (
                  <Badge tone="neutral" subtle style={{ marginLeft: 8 }}>
                    {presentOutcome(ev.outcome)}
                  </Badge>
                ) : null}
              </div>
              {presentSecurityEvent(ev.action).description ? (
                <div style={{ ...mutedStyle, marginTop: 2 }}>
                  {presentSecurityEvent(ev.action).description}
                </div>
              ) : null}
              <div style={{ ...mutedStyle, marginTop: 2 }}>
                {fmt(ev.occurredAtUtc)}
              </div>
              {/* Forensic detail is preserved, not removed — moved behind a
                  deliberate disclosure (§8). The exact internal key stays
                  available for defensible audit review. */}
              <details style={{ marginTop: 4 }}>
                <summary
                  style={{ ...mutedStyle, cursor: "pointer" }}
                  data-cc-security-event-details={ev.id}
                >
                  Technical details
                </summary>
                <div style={{ ...mutedStyle, marginTop: 4 }}>
                  <div>Event key: {ev.action}</div>
                  {ev.outcome ? <div>Outcome: {ev.outcome}</div> : null}
                  {ev.severity ? <div>Severity: {ev.severity}</div> : null}
                  {ev.ipPreview ? <div>IP: {ev.ipPreview}</div> : null}
                  {ev.resourceType ? <div>Resource: {ev.resourceType}</div> : null}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Combined export
// -----------------------------------------------------------------------------

export function PersonalSecuritySections() {
  const {
    mfa,
    mfaError,
    reloadMfa,
    sessions,
    sessionsError,
    reloadSessions,
  } = useSecurityData();

  return (
    <>
      <SummaryStrip mfa={mfa} sessions={sessions} />
      <PasswordChangeCard />
      <MfaCard mfa={mfa} mfaError={mfaError} reloadMfa={reloadMfa} />
      <ActiveSessionsCard
        sessions={sessions}
        sessionsError={sessionsError}
        reloadSessions={reloadSessions}
      />
      <SecurityEventsCard />
    </>
  );
}
