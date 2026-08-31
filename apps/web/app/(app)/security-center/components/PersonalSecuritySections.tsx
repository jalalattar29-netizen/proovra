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
import {
  describeUserAgent,
  presentLocation,
} from "../../../../lib/security/sessionPresentation";
import {
  presentLoginMethods,
  summarizeLoginMethods,
  type LoginMethodsState,
} from "../../../../lib/security/loginMethodsSummary";
import { AppStatusText } from "../../../../components/app-primitives/AppStatusText";
import { useAuth } from "../../../providers";
import { useTeamId } from "../../../../lib/platform-context";
import { ContactFactorEnrollmentPanel } from "../../../../components/identity-security/ContactFactorEnrollmentPanel";

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

/* Failure — canonical red. A sign-out that did not happen must not be
   reported in any softer colour. */
const errorBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(179,38,30,0.06)",
  border: "1px solid rgba(179,38,30,0.35)",
  color: "#8f1d16",
  fontSize: 12,
};

/* Completion — canonical success. "12 other session(s) signed out" is a
   result, not an alarm, and colouring it red because the subject is security
   would be telling the person something untrue about what just happened. */
const okBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(22, 122, 91, 0.07)",
  border: "1px solid rgba(22, 122, 91, 0.35)",
  color: "var(--success-ink, #167A5B)",
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
  const [loginMethods, setLoginMethods] = useState<LoginMethodsState | null>(
    null,
  );
  const [loginMethodsError, setLoginMethodsError] = useState<string | null>(
    null,
  );

  const reloadLoginMethods = useCallback(async () => {
    setLoginMethodsError(null);
    try {
      const res = (await apiFetch("/v1/identity/links", {
        method: "GET",
      })) as LoginMethodsState;
      setLoginMethods(res);
    } catch (err) {
      setLoginMethodsError(
        toSafeUserError(err, { message: "Could not load login methods." })
          .message,
      );
    }
  }, []);

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
    void reloadLoginMethods();
  }, [reloadMfa, reloadSessions, reloadLoginMethods]);

  return {
    mfa,
    mfaError,
    reloadMfa,
    sessions,
    sessionsError,
    reloadSessions,
    loginMethods,
    loginMethodsError,
    reloadLoginMethods,
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
  loginMethods,
}: {
  mfa: MfaStatus | null;
  sessions: MySession[] | null;
  loginMethods: LoginMethodsState | null;
}) {
  const { user } = useAuth();
  const providerKey = (user?.provider ?? "").toLowerCase();
  // Real linked-method data wins; the account provider is the fallback
  // while the links call is in flight.
  const fallbackLabel =
    OAUTH_PROVIDER_LABELS[providerKey] ??
    (providerKey ? "Email & password" : "—");
  const providerLabel = loginMethods
    ? summarizeLoginMethods(loginMethods)
    : fallbackLabel;

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

function PasswordChangeCard({
  passwordConfigured,
}: {
  passwordConfigured: boolean | null;
}) {
  // 2026-07-17 remediation — this card exists ONLY for accounts that
  // actually have a password to change. Accounts without one manage all
  // sign-in methods (including "Add password") in the unified Login
  // methods card above; the old OAuth-only explanatory card duplicated
  // that state and is deleted.
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

  // No configured password → nothing to change; the Login methods card
  // owns the add-password flow. (While the links call is loading we also
  // render nothing rather than flash a form that may not apply.)
  if (passwordConfigured !== true) return null;

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

export type StepUpMethods = Array<"password" | "mfa" | "reauth">;
export type StepUpProof = { method: "password" | "mfa"; currentPassword?: string; code?: string };

export function extractStepUp(err: unknown): { methods: StepUpMethods; message: string } | null {
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

export function StepUpVerify({
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
// B2. Login methods / connected accounts (lifecycle Phase 3)
//
// Lists the account's usable sign-in methods from GET /v1/identity/links
// (password + ACTIVE provider links + a read-only legacy row for OAuth
// accounts predating the link model). Supports:
//   - Connect Google (GSI credential → POST /v1/identity/links/google,
//     server-side token verification, 409 identity_already_linked on
//     conflict — never a merge)
//   - Connect Apple (AppleID.auth.signIn → POST /v1/identity/links/apple)
//   - Add a password to an OAuth-only account (policy-checked; step-up)
//   - Disconnect a linked method (step-up + last-usable-method protection
//     surfaced by stable code)
// Organization SSO/SAML is NOT a personal method and never appears here.
// -----------------------------------------------------------------------------

function LoginMethodsCard({
  state,
  stateError,
  reload,
}: {
  state: LoginMethodsState | null;
  stateError: string | null;
  reload: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addPwOpen, setAddPwOpen] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [stepUpAction, setStepUpAction] = useState<
    null | { kind: "unlink"; id: string } | { kind: "add-password" } | {
      kind: "link";
      provider: "google" | "apple";
      idToken: string;
    }
  >(null);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");
  const { confirm } = useConfirmAction();
  const { user } = useAuth();

  const surfaceOrStepUp = useCallback(
    (
      err: unknown,
      pending: NonNullable<typeof stepUpAction>,
      fallback: string,
    ) => {
      const su = extractStepUp(err);
      if (su) {
        setStepUpAction(pending);
        setStepUpMethods(su.methods);
        setStepUpMsg(su.message);
        return;
      }
      const e = err as { body?: { error?: { code?: string; message?: string } } };
      const code = e.body?.error?.code;
      if (code === "last_login_method_protected" || code === "identity_already_linked") {
        setError(e.body?.error?.message ?? fallback);
        return;
      }
      setError(toSafeUserError(err, { message: fallback }).message);
    },
    [],
  );

  const submitLink = useCallback(
    async (provider: "google" | "apple", idToken: string, proof?: StepUpProof) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await apiFetch(`/v1/identity/links/${provider}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken, ...(proof ? { stepUp: proof } : {}) }),
        });
        setStepUpAction(null);
        setNotice(`${provider === "google" ? "Google" : "Apple"} connected.`);
        await reload();
      } catch (err) {
        surfaceOrStepUp(err, { kind: "link", provider, idToken }, "Could not connect this login method.");
      } finally {
        setBusy(false);
      }
    },
    [reload, surfaceOrStepUp],
  );

  const connectGoogle = useCallback(async () => {
    setError(null);
    try {
      const { loadGoogleIdentity } = await import("../../../../lib/oauth");
      await loadGoogleIdentity();
      const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
      const google = (
        window as unknown as {
          google?: {
            accounts?: {
              id?: {
                initialize: (o: object) => void;
                prompt: () => void;
              };
            };
          };
        }
      ).google;
      const id = google?.accounts?.id;
      if (!clientId || !id?.initialize) {
        setError("Google sign-in is not available right now.");
        return;
      }
      id.initialize({
        client_id: clientId,
        cancel_on_tap_outside: true,
        callback: (response: { credential?: string }) => {
          if (!response.credential) {
            setError("Google did not return a credential.");
            return;
          }
          void submitLink("google", response.credential);
        },
      });
      id.prompt();
    } catch {
      setError("Google sign-in is not available right now.");
    }
  }, [submitLink]);

  const connectApple = useCallback(async () => {
    setError(null);
    try {
      const { loadAppleIdentity } = await import("../../../../lib/oauth");
      await loadAppleIdentity();
      const appleClientId = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "";
      const AppleID = (
        window as unknown as {
          AppleID?: {
            auth?: {
              init: (o: object) => void;
              signIn: () => Promise<{
                authorization?: { id_token?: string };
              }>;
            };
          };
        }
      ).AppleID;
      if (!appleClientId || !AppleID?.auth?.init) {
        setError("Apple sign-in is not available right now.");
        return;
      }
      AppleID.auth.init({
        clientId: appleClientId,
        scope: "email",
        redirectURI: window.location.origin,
        usePopup: true,
      });
      const res = await AppleID.auth.signIn();
      const idToken = res.authorization?.id_token;
      if (!idToken) {
        setError("Apple did not return a credential.");
        return;
      }
      void submitLink("apple", idToken);
    } catch {
      setError("Apple sign-in was cancelled or is unavailable.");
    }
  }, [submitLink]);

  const submitAddPassword = useCallback(
    async (proof?: StepUpProof) => {
      if (!meetsPolicy(newPw)) {
        setError(ERROR_MESSAGES.weak_new_password!);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await apiFetch("/v1/identity/password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            newPassword: newPw,
            ...(proof ? { stepUp: proof } : {}),
          }),
        });
        setStepUpAction(null);
        setAddPwOpen(false);
        setNewPw("");
        setNotice("Password added. You can now sign in with email and password.");
        await reload();
      } catch (err) {
        surfaceOrStepUp(err, { kind: "add-password" }, "Could not add a password.");
      } finally {
        setBusy(false);
      }
    },
    [newPw, reload, surfaceOrStepUp],
  );

  const unlink = useCallback(
    async (linkId: string, provider: string, proof?: StepUpProof) => {
      if (!proof) {
        const ok = await confirm({
          title: `Disconnect ${provider === "GOOGLE" ? "Google" : provider === "APPLE" ? "Apple" : provider}?`,
          description:
            "You will no longer be able to sign in with this method. At least one other usable login method must remain.",
          confirmLabel: "Disconnect",
          tone: "danger",
          testId: "unlink-login-method",
        });
        if (!ok) return;
      }
      setBusy(true);
      setError(null);
      try {
        await apiFetch(`/v1/identity/links/${linkId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof ? { stepUp: proof } : {}),
        });
        setStepUpAction(null);
        setNotice("Login method disconnected.");
        await reload();
      } catch (err) {
        surfaceOrStepUp(err, { kind: "unlink", id: linkId }, "Could not disconnect this method.");
      } finally {
        setBusy(false);
      }
    },
    [confirm, reload, surfaceOrStepUp],
  );

  // Unified presentation — every personal method renders as ONE row shape
  // (Method | Status | Last used | Action) through the canonical pure
  // derivation. Apple is a normal row, never a stray standalone button.
  const rows = state ? presentLoginMethods(state) : null;

  const rowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    padding: "10px 2px",
    borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.07))",
    fontSize: 13,
    color: "var(--ink-primary, #0f172a)",
  };

  const oauthProviderLabel =
    OAUTH_PROVIDER_LABELS[(user?.provider ?? "").toLowerCase()] ?? null;

  return (
    <Card variant="admin" style={{ marginBottom: 14 }} data-cc-login-methods-card>
      {/* "Sign-in methods", not "Login methods" (AUDIT, 2026-09-03).
          Account linking is REAL here: `POST /v1/identity/links/google|apple`
          verifies the provider token server-side with the same verifiers the
          login flow uses, one provider identity belongs to exactly one account
          (DB-unique on provider+subject, 409 on conflict, accounts NEVER
          merged, email equality never treated as ownership), every mutation
          requires account step-up, and an unlink that would leave zero usable
          methods is refused. So connecting Google or Apple adds a way into
          THIS account — the copy now says so, because "Login methods" beside
          a Connect button invites exactly the opposite reading. */}
      <h2 style={sectionTitleStyle}>Sign-in methods</h2>
      <p style={mutedStyle}>
        Choose which verified methods can sign in to this same PROOVRA account.
        Connecting Google or Apple does not create a second account.
        {oauthProviderLabel && state && !state.passwordConfigured
          ? ` Your ${oauthProviderLabel} password is managed in your ${oauthProviderLabel} account; add a PROOVRA password below if you also want to sign in with email.`
          : ""}{" "}
        Organization single sign-on is managed by your organization and never
        appears here.
      </p>

      {state === null ? (
        <p style={mutedStyle} aria-live="polite">
          {stateError ?? "Loading…"}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
          {rows!.map((row) => (
            <li key={row.key} data-cc-login-method={row.key} style={rowStyle}>
              <span style={{ minWidth: 0 }}>
                {row.label}{" "}
                {/* WORDS, NOT A CAPSULE. Three grey pills down a three-row list made
                    the status the shape rather than the word, and "Configured"
                    read the same as "Not connected" until you looked closely.
                    `AppStatusText` is the canonical no-surface sibling of the
                    badge and shares its tone vocabulary, so what each colour
                    MEANS is unchanged. */}
                <AppStatusText
                  tone={row.status === "not_connected" ? "slate" : "green"}
                  size="sm"
                  className="set-method-status"
                  data-cc-login-method-status={row.key}
                >
                  {row.status === "configured"
                    ? "Configured"
                    : row.status === "connected"
                      ? "Connected"
                      : row.key === "password"
                        ? "Not configured"
                        : "Not connected"}
                </AppStatusText>
                {row.lastUsedAtUtc ? (
                  <span style={{ ...mutedStyle, display: "inline", marginLeft: 8 }}>
                    last used {fmt(row.lastUsedAtUtc)}
                  </span>
                ) : null}
                {row.disconnectBlocked && row.blockedReason ? (
                  <span
                    style={{ ...mutedStyle, display: "block", marginTop: 2 }}
                    data-cc-login-method-blocked={row.key}
                  >
                    {row.blockedReason}
                  </span>
                ) : null}
              </span>
              {row.action === "add_password" ? (
                <button
                  type="button"
                  className="app-secondary-action app-secondary-action--lg"
                  onClick={() => setAddPwOpen((v) => !v)}
                  data-cc-add-password-toggle
                >
                  Add password
                </button>
              ) : row.action === "connect" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    row.key === "google"
                      ? void connectGoogle()
                      : void connectApple()
                  }
                  disabled={busy}
                  data-cc-connect-google={row.key === "google" ? "true" : undefined}
                  data-cc-connect-apple={row.key === "apple" ? "true" : undefined}
                >
                  Connect
                </Button>
              ) : row.action === "disconnect" ? (
                // The final usable method never offers an ENABLED disconnect
                // — the UI mirrors the backend `last_login_method_protected`
                // guard instead of submitting a known-invalid request.
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    row.linkId ? void unlink(row.linkId, row.label) : undefined
                  }
                  disabled={busy || row.disconnectBlocked}
                  aria-disabled={row.disconnectBlocked || undefined}
                  title={row.blockedReason ?? undefined}
                  data-cc-unlink={row.linkId ?? "blocked"}
                >
                  Disconnect
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {addPwOpen && !state?.passwordConfigured ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitAddPassword();
          }}
        >
          <label style={labelStyle}>
            New password (12+ chars, upper- and lower-case, a number)
            <input
              type="password"
              autoComplete="new-password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              disabled={busy}
              style={{ ...inputStyle, maxWidth: 320 }}
              data-cc-add-password-input
            />
          </label>
          <div style={{ marginTop: 10 }}>
            <button
              type="submit"
              className="app-secondary-action app-secondary-action--lg"
              disabled={busy || !meetsPolicy(newPw)}
              aria-busy={busy || undefined}
              data-cc-add-password-submit
            >
              {busy ? "Adding…" : "Add password"}
            </button>
          </div>
        </form>
      ) : null}

      {stepUpAction ? (
        <StepUpVerify
          title={
            stepUpAction.kind === "unlink"
              ? "Confirm disconnecting this login method."
              : stepUpAction.kind === "add-password"
                ? "Confirm adding a password to your account."
                : "Confirm connecting this login method."
          }
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) => {
            if (stepUpAction.kind === "unlink") {
              void unlink(stepUpAction.id, "", proof);
            } else if (stepUpAction.kind === "add-password") {
              void submitAddPassword(proof);
            } else {
              void submitLink(stepUpAction.provider, stepUpAction.idToken, proof);
            }
          }}
          onCancel={() => {
            setStepUpAction(null);
            setStepUpMsg("");
          }}
        />
      ) : null}

      {error ? <div style={errorBox}>{error}</div> : null}
      {notice ? <div style={okBox}>{notice}</div> : null}
    </Card>
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
              method — however you sign in.
            </p>
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="app-secondary-action app-secondary-action--lg"
                onClick={() => void startEnrollment()}
                disabled={busy}
                aria-busy={busy || undefined}
                data-cc-mfa-enroll-start
              >
                {busy ? "Starting…" : "Set up two-factor authentication"}
              </button>
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
  const [singleStepUp, setSingleStepUp] = useState<null | {
    sessionId: string;
    deviceLabel: string;
  }>(null);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");
  const { confirm } = useConfirmAction();

  const [sessionsExpanded, setSessionsExpanded] = useState(false);
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

  const revokeSingle = useCallback(
    async (sessionId: string, deviceLabel: string, proof?: StepUpProof) => {
      if (!proof) {
        const ok = await confirm({
          title: `Sign out ${deviceLabel}?`,
          description:
            "That session ends immediately. You stay signed in on this device.",
          confirmLabel: "Sign out session",
          tone: "warning",
          testId: "security-revoke-single-session",
        });
        if (!ok) return;
      }
      setBusy(true);
      setNotice(null);
      setError(null);
      try {
        await apiFetch(`/v1/identity-security/my-sessions/${sessionId}/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof ? { stepUp: proof } : {}),
        });
        setSingleStepUp(null);
        setNotice("Session signed out.");
        await reloadSessions();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setSingleStepUp({ sessionId, deviceLabel });
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        setError(
          toSafeUserError(err, { message: "Could not sign out that session." })
            .message,
        );
      } finally {
        setBusy(false);
      }
    },
    [confirm, reloadSessions],
  );

  const sessionRow = (s: MySession) => {
    // Presentation (2026-07-17): a raw user agent or a private/container
    // network address is never primary content. Friendly device/browser +
    // reliable location only; the forensic detail stays available behind
    // the per-session Technical details disclosure.
    const device = describeUserAgent(s.uaPreview);
    const location = presentLocation(s.countryCode, s.ipPreview);
    return (
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontWeight: 700, color: "var(--ink-primary, #0f172a)" }}>
            {device}
            {s.isCurrent ? (
              <Badge tone="verified" subtle style={{ marginLeft: 8 }}>
                Current session
              </Badge>
            ) : null}
            {s.quarantined ? (
              <Badge tone="pending" subtle style={{ marginLeft: 8 }}>
                Restricted
              </Badge>
            ) : null}
          </div>
          {/* The current session carries no individual revoke — signing out
              of THIS device is the product sign-out action, not a session
              mutation. */}
          {!s.isCurrent ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void revokeSingle(s.id, device)}
              disabled={busy}
              data-cc-revoke-session={s.id}
            >
              Sign out
            </Button>
          ) : null}
        </div>
        <div style={mutedStyle} data-cc-session-meta={s.id}>
          {location ?? "Location unavailable"} · last active {fmt(s.lastSeenAtUtc)}
        </div>
        <div style={{ ...mutedStyle, marginTop: 2 }}>
          Signed in {fmt(s.issuedAtUtc)}
        </div>
        <details style={{ marginTop: 4 }}>
          <summary
            style={{ ...mutedStyle, cursor: "pointer" }}
            data-cc-session-details={s.id}
          >
            Technical details
          </summary>
          <div style={{ ...mutedStyle, marginTop: 4 }}>
            {s.uaPreview ? <div>User agent: {s.uaPreview}</div> : null}
            {s.ipPreview ? <div>IP (masked): {s.ipPreview}</div> : null}
            <div>Session reference: {s.id}</div>
            <div>
              Issued {fmt(s.issuedAtUtc)} · expires {fmt(s.expiresAtUtc)}
            </div>
          </div>
        </details>
      </li>
    );
  };

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
        <>
          {/* THE LATEST THREE, then the rest on request.
              An account with fifteen live sessions rendered fifteen cards, and
              the page below them — the security activity — was unreachable
              without a long scroll past information nobody had asked for. The
              current session is always among the three. */}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, marginTop: 10 }}>
            {current.map(sessionRow)}
            {others.length > 0 ? (
              (sessionsExpanded ? others : others.slice(0, Math.max(0, 3 - current.length))).map(
                sessionRow,
              )
            ) : (
              <li style={{ ...mutedStyle, padding: "6px 2px" }} data-cc-no-other-sessions>
                No other active sessions.
              </li>
            )}
          </ul>
          {others.length > Math.max(0, 3 - current.length) ? (
            <button
              type="button"
              className="set-disclosure"
              aria-expanded={sessionsExpanded}
              onClick={() => setSessionsExpanded((open) => !open)}
              data-cc-sessions-toggle
            >
              {sessionsExpanded
                ? "Show fewer sessions"
                : `Show ${others.length - Math.max(0, 3 - current.length)} more ${
                    others.length - Math.max(0, 3 - current.length) === 1
                      ? "session"
                      : "sessions"
                  }`}
            </button>
          ) : null}
        </>
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
      {singleStepUp ? (
        <StepUpVerify
          title={`Confirm signing out ${singleStepUp.deviceLabel}.`}
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) =>
            void revokeSingle(singleStepUp.sessionId, singleStepUp.deviceLabel, proof)
          }
          onCancel={() => {
            setSingleStepUp(null);
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

// THREE by default. This is a summary of recent account activity on a
// settings page, not an audit log — the full history belongs to the audit
// surface. "View more" still extends it a page at a time.
const EVENTS_FIRST = 3;
const EVENTS_PAGE = 8;

function SecurityEventsCard() {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Progressive disclosure (2026-07-17): latest N events render in the
  // page flow (no nested scrollbar); "View more" extends the list.
  const [visibleCount, setVisibleCount] = useState(EVENTS_FIRST);

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
      <h2 style={sectionTitleStyle}>Account &amp; security activity</h2>
      <p style={mutedStyle}>
        Bounded timeline of authentication, profile, preference, and
        membership events tied to your account. Older events live in the
        platform audit log.
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
          }}
        >
          {rows.slice(0, visibleCount).map((ev) => (
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
                {/* WORDS, IN THE TONE THE OUTCOME MEANS.
                    Every outcome rendered in the same neutral capsule, so a
                    failed sign-in and a successful one looked identical until
                    the label was read. The outcome string is unchanged; the
                    tone now follows it, and the word still carries it for
                    anyone who cannot see the colour. */}
                {presentOutcome(ev.outcome) ? (
                  <span
                    className="set-event-outcome"
                    data-cc-security-event-outcome
                    data-outcome={String(ev.outcome ?? "").toUpperCase()}
                    style={{ marginLeft: 8 }}
                  >
                    {presentOutcome(ev.outcome)}
                  </span>
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

      {events !== null && rows.length > visibleCount ? (
        <div style={{ marginTop: 10 }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setVisibleCount((v) => v + EVENTS_PAGE)}
            data-cc-security-events-more
          >
            View more ({rows.length - visibleCount} older)
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Combined export
// -----------------------------------------------------------------------------

export function PersonalSecuritySections() {
  // The FACTOR is account-owned, but the verification attempt that proves it
  // is tenant-scoped (its rate limit and audit trail are), so the enrolment
  // routes require a workspace the caller belongs to. Null while the platform
  // context resolves — the panel renders its own reason rather than guessing.
  const contactFactorTeamId = useTeamId();
  const {
    mfa,
    mfaError,
    reloadMfa,
    sessions,
    sessionsError,
    reloadSessions,
    loginMethods,
    loginMethodsError,
    reloadLoginMethods,
  } = useSecurityData();

  return (
    <>
      <SummaryStrip mfa={mfa} sessions={sessions} loginMethods={loginMethods} />
      <LoginMethodsCard
        state={loginMethods}
        stateError={loginMethodsError}
        reload={reloadLoginMethods}
      />
      <PasswordChangeCard
        passwordConfigured={loginMethods?.passwordConfigured ?? null}
      />
      <MfaCard mfa={mfa} mfaError={mfaError} reloadMfa={reloadMfa} />
      {/*
       * PHASE 13 (NEW-058) — the account-bound contact factor.
       *
       * It sits HERE, in the CORE-tier personal security module reached at
       * `/settings#security`, and NOT in `/security-center`. The surface-tier
       * table gates `/security-center` at ENTERPRISE with `directAccessPolicy:
       * "notFound"`, and its own entry says so: "Personal security lives in
       * /settings#security (CORE)". A contact factor is account-owned — one
       * enrolment serves every workspace the user can act in — so putting the
       * only enrolment surface behind an enterprise 404 would rebuild exactly
       * the unreachability NEW-058 exists to close, just for a different set
       * of users.
       */}
      {/* ENROLMENT NEEDS A WORKSPACE, so the form only renders where one
          exists (AUDIT, 2026-09-03). The factor is account-owned, but the
          verification ATTEMPT that proves it is tenant-scoped — its rate limit
          and its audit trail are — so `enroll/start` and `enroll/verify` both
          take a `teamId` in a STRICT schema. In a personal space
          `useTeamId()` is null, so the panel rendered its whole form disabled
          under the line "Open a workspace before enrolling a device": a
          prominent, permanently dead control on the account's security page.
          Every operation this factor gates — evidence publication and
          withdrawal, reviewer approve and reject, escalation resolve, bulk
          reviewer operations, destruction approve and execute, governance
          policy update, department membership grant and revoke — is a
          workspace operation, so a personal space has nothing to step up FOR.
          Hidden there rather than shown broken. */}
      {contactFactorTeamId ? (
        <ContactFactorEnrollmentPanel teamId={contactFactorTeamId} />
      ) : null}
      <ActiveSessionsCard
        sessions={sessions}
        sessionsError={sessionsError}
        reloadSessions={reloadSessions}
      />
      <SecurityEventsCard />
    </>
  );
}
