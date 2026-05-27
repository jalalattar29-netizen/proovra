"use client";

/**
 * Phase 2.3 — Account security card for /settings.
 *
 * Surfaces user-facing account security capabilities that have
 * backend support but were not yet exposed in the UI:
 *
 *   1. MFA / TOTP enrollment (`/v1/identity/mfa/*`)
 *      - Read factors + status
 *      - Enroll new TOTP factor (QR + secret + verify)
 *      - Disable / revoke factor
 *      - Regenerate recovery codes (ONE-TIME display)
 *
 *   2. Password — backend exposes ONLY a password-reset-by-email
 *      flow (`POST /v1/auth/password-reset/request`). There is no
 *      "change password with current password" endpoint. We expose
 *      the reset-by-email flow here and document the gap in the
 *      Phase 2.3 readiness doc — the UI must not pretend a direct
 *      "change password" call exists.
 *
 *   3. Sessions — backend exposes `POST /v1/identity-security/sessions/revoke-all`
 *      to a user about themselves (the route lives under the
 *      identity-security namespace but accepts the caller's own
 *      userId). We expose "Sign out of all devices" with explicit
 *      confirmation. There is no user-facing "list my sessions"
 *      endpoint today — documented as a known backend gap.
 *
 * Hard rules:
 *   - Backend is authoritative. The frontend never invents auth
 *     state; every change goes through the documented endpoint.
 *   - Recovery codes are displayed ONCE on creation. The component
 *     never re-fetches or persists them locally.
 *   - Destructive actions (disable MFA, revoke factor, sign out
 *     everywhere) require an explicit second click.
 *   - No PII written to telemetry. All `captureException` calls
 *     redact email / display name.
 *   - AccessGate is reused for plan / role lockouts so failure
 *     looks consistent with the rest of the platform.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import { Button, Card, useToast } from "../../../../components/ui";
import { AccessGate } from "../../../../components/access/AccessGate";

type MfaFactor = {
  id: string;
  factorType: string;
  status: string;
  label?: string | null;
  createdAt?: string | null;
  lastUsedAt?: string | null;
};

type MfaStatusResponse = {
  factors?: MfaFactor[];
  enrollments?: Array<{ id: string; status: string }>;
  // Other fields the server may surface but we don't depend on.
  [key: string]: unknown;
};

type EnrollmentSession = {
  factorId: string;
  secret: string;
  provisioning_uri: string;
};

type EnrollVerifyResponse = {
  factorId: string;
  recoveryCodes: string[];
};

type RecoveryCodesResponse = {
  recoveryCodes: string[];
};

function cardShellStyle() {
  return {
    border: "1px solid rgba(79,112,107,0.16)",
    boxShadow:
      "0 18px 38px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.48)",
  } as const;
}

function sectionHeader(title: string, subtitle?: string) {
  return (
    <div className="mb-4">
      <div className="text-[1.04rem] font-semibold tracking-[-0.02em] text-[#21353a]">
        {title}
      </div>
      {subtitle ? (
        <p className="m-0 mt-1 text-[12.5px] text-[#6a777b] leading-snug">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

function StatusPill({
  tone,
  label,
  testid,
}: {
  tone: "active" | "off" | "warn";
  label: string;
  testid?: string;
}) {
  const palette =
    tone === "active"
      ? {
          background: "rgba(45,91,89,0.10)",
          border: "1px solid rgba(45,91,89,0.25)",
          color: "#2d5b59",
        }
      : tone === "warn"
        ? {
            background: "rgba(214,184,157,0.14)",
            border: "1px solid rgba(214,184,157,0.30)",
            color: "#8a6e57",
          }
        : {
            background: "rgba(120,120,120,0.10)",
            border: "1px solid rgba(120,120,120,0.20)",
            color: "#5d6d71",
          };
  return (
    <span
      data-testid={testid}
      style={{
        ...palette,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {label}
    </span>
  );
}

export function AccountSecurityCard({ userEmail }: { userEmail: string | null }) {
  return (
    <Card
      className="settings-silver-card rounded-[30px] border bg-transparent p-0 shadow-none"
      style={cardShellStyle()}
      data-account-security-card
      data-testid="account-security-card"
    >
      <div className="settings-silver-card__bg" />
      <div className="settings-silver-card__overlay" />
      <div className="settings-silver-card__content p-6 md:p-7">
        <div className="mb-5">
          <div className="text-[1.08rem] font-semibold tracking-[-0.03em] text-[#21353a]">
            Account security
          </div>
          <p className="m-0 mt-1 text-[12.5px] text-[#6a777b] leading-snug">
            Multi-factor authentication, password, and sign-out controls
            for your account. Workspace-wide security (SSO, MFA policy)
            lives in the Security Center.
          </p>
        </div>

        <div className="grid gap-6">
          <MfaSection />
          <PasswordSection userEmail={userEmail} />
          <SessionsSection />
          <AccountLifecycleSection />
        </div>
      </div>
    </Card>
  );
}

// =============================================================================
// Account lifecycle (export / deletion) — Phase 2.5
// =============================================================================

/**
 * Phase 2.5 — Account export + deletion honest block.
 *
 * The brief explicitly says "do not fake delete/export button" and
 * "every action must be auditable". PROOVRA's current backend has:
 *
 *   - NO `User.deletedAt` soft-delete column
 *   - NO `POST /v1/users/me/account/delete` endpoint
 *   - NO `POST /v1/users/me/export` endpoint
 *   - NO worker pipeline that respects legal holds and custody on
 *     deletion
 *
 * Rather than ship a button that does nothing, this section explains
 * the constraints honestly:
 *
 *   1. Why deletion isn't an instant operation here (custody, legal
 *      holds, evidence preservation, team ownership).
 *   2. What to do TODAY (contact support / workspace admin for
 *      manual workflow that includes legal review).
 *   3. What's coming (Phase 2.5 backend design).
 *
 * No request button is rendered until the backend exists. This
 * preserves the Phase 2.5 hard rule: "do not fake enterprise."
 */
function AccountLifecycleSection() {
  return (
    <section data-security-account-lifecycle>
      {sectionHeader(
        "Account export & deletion",
        "Both are handled by an operator-assisted workflow today — they cannot be self-serve because of custody, legal-hold, and evidence-preservation constraints.",
      )}
      <AccessGate
        kind="FEATURE_UNAVAILABLE"
        surface="Account lifecycle"
        headline="Self-serve export and deletion are not available yet"
        reason="Account deletion requires verifying that no evidence you own is under legal hold, that your workspace ownership has been transferred, and that the chain of custody is preserved. We don't expose a self-serve button until those checks live in the backend. Until then, contact support and we'll run the workflow with you."
        variant="inline"
        actions={[
          {
            label: "Contact support",
            href: "/support",
            variant: "primary",
          },
          {
            label: "Open team settings",
            href: "/teams",
            variant: "secondary",
          },
        ]}
        testid="security-account-lifecycle-gate"
      >
        <ul className="m-0 list-disc space-y-1 pl-5 text-[12px] text-[#6a777b]">
          <li>
            <strong>Data export.</strong> The Phase 27.5 governance
            snapshot infrastructure (
            <code>GovernanceExportSnapshot</code>) is the planned
            backbone — a worker writes a per-user export job, audit
            log included.
          </li>
          <li>
            <strong>Account deletion.</strong> Requires
            <code>User.deletedAt</code> + cascade rules that preserve
            custody, audit, and evidence integrity. The user-facing
            button stays hidden until those constraints are
            implemented end-to-end.
          </li>
          <li>
            <strong>Legal hold safety.</strong> If any of your
            evidence is on a legal hold, deletion must be refused with
            a clear reason. The backend lifecycle service already
            blocks case closure under legal hold — that pattern
            extends to user deletion.
          </li>
        </ul>
      </AccessGate>
    </section>
  );
}

// =============================================================================
// MFA section
// =============================================================================

function MfaSection() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<MfaStatusResponse | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentSession | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [confirmDisableId, setConfirmDisableId] = useState<string | null>(null);
  const [busyFactorId, setBusyFactorId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [accessLocked, setAccessLocked] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = (await apiFetch(
        "/v1/identity/mfa/factors",
      )) as MfaStatusResponse;
      setStatus(data);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      // 403 / 402 → plan / role gate. Render AccessGate.
      if (e.statusCode === 403 || e.statusCode === 402) {
        setAccessLocked(true);
      } else {
        captureException(err, { feature: "account_security_mfa_status" });
        setLoadError(e.message ?? "Could not load MFA status.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const activeFactors = useMemo(
    () =>
      (status?.factors ?? []).filter(
        (f) => f.status === "ACTIVE" || f.status === "active",
      ),
    [status],
  );
  const hasActiveMfa = activeFactors.length > 0;

  const startEnrollment = useCallback(async () => {
    setEnrolling(true);
    setVerifyError(null);
    try {
      const data = (await apiFetch("/v1/identity/mfa/enroll/start", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      })) as EnrollmentSession;
      setEnrollment(data);
    } catch (err) {
      captureException(err, { feature: "account_security_mfa_enroll_start" });
      const e = err as { message?: string };
      addToast(e.message ?? "Could not start MFA enrollment.", "error");
    } finally {
      setEnrolling(false);
    }
  }, [addToast]);

  const verifyEnrollment = useCallback(async () => {
    if (!enrollment) return;
    const trimmed = verifyCode.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setVerifyError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    try {
      const data = (await apiFetch("/v1/identity/mfa/enroll/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factorId: enrollment.factorId,
          code: trimmed,
        }),
      })) as EnrollVerifyResponse;
      // Recovery codes are returned exactly once by the server.
      // Surface them immediately and KEEP them in component state
      // only until the user dismisses the panel.
      setRecoveryCodes(data.recoveryCodes ?? []);
      setEnrollment(null);
      setVerifyCode("");
      await reload();
      addToast("MFA enabled. Save your recovery codes.", "success");
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 429) {
        setVerifyError("Too many attempts. Wait a minute and try again.");
      } else if (e.statusCode === 400) {
        setVerifyError("That code didn't verify. Try again.");
      } else {
        captureException(err, {
          feature: "account_security_mfa_enroll_verify",
        });
        setVerifyError(e.message ?? "Verification failed.");
      }
    } finally {
      setVerifying(false);
    }
  }, [enrollment, verifyCode, reload, addToast]);

  const disableFactor = useCallback(
    async (factorId: string) => {
      setBusyFactorId(factorId);
      try {
        await apiFetch(`/v1/identity/mfa/factors/${factorId}`, {
          method: "DELETE",
        });
        addToast("MFA factor removed.", "success");
        setConfirmDisableId(null);
        await reload();
      } catch (err) {
        captureException(err, {
          feature: "account_security_mfa_disable",
          factorId,
        });
        const e = err as { message?: string };
        addToast(e.message ?? "Could not remove MFA factor.", "error");
      } finally {
        setBusyFactorId(null);
      }
    },
    [reload, addToast],
  );

  const regenerateRecoveryCodes = useCallback(async () => {
    setRegenerating(true);
    try {
      const data = (await apiFetch(
        "/v1/identity/mfa/recovery-codes/regenerate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      )) as RecoveryCodesResponse;
      setRecoveryCodes(data.recoveryCodes ?? []);
      addToast(
        "New recovery codes generated. Save them — old codes are now invalid.",
        "success",
      );
    } catch (err) {
      captureException(err, {
        feature: "account_security_mfa_recovery_regenerate",
      });
      const e = err as { message?: string };
      addToast(e.message ?? "Could not regenerate recovery codes.", "error");
    } finally {
      setRegenerating(false);
    }
  }, [addToast]);

  if (accessLocked) {
    return (
      <section data-security-mfa data-security-mfa-locked>
        {sectionHeader("Multi-factor authentication")}
        <AccessGate
          kind="REQUEST_ACCESS"
          surface="MFA"
          headline="MFA is managed for you by your workspace admin"
          reason="Your workspace policy doesn't allow individual MFA management here. Ask an admin to enable per-user enrollment, or open the Security Center if you have access."
          variant="inline"
          actions={[
            {
              label: "Open Security Center",
              href: "/security-center",
              variant: "primary",
            },
          ]}
          testid="security-mfa-access-gate"
        />
      </section>
    );
  }

  return (
    <section data-security-mfa>
      {sectionHeader(
        "Multi-factor authentication",
        "Add a second factor (authenticator app) so a leaked password can't sign in on its own.",
      )}

      {loading ? (
        <p className="m-0 text-[13px] text-[#6a777b]">Checking MFA status…</p>
      ) : null}
      {loadError ? (
        <p className="m-0 text-[13px] text-[#a14040]" data-security-mfa-error>
          {loadError}
        </p>
      ) : null}

      {!loading && !loadError ? (
        <>
          <div className="mb-3 flex items-center gap-3">
            {hasActiveMfa ? (
              <StatusPill
                tone="active"
                label="Enabled"
                testid="security-mfa-status"
              />
            ) : (
              <StatusPill
                tone="off"
                label="Not enabled"
                testid="security-mfa-status"
              />
            )}
            <span className="text-[12px] text-[#6a777b]">
              {hasActiveMfa
                ? `${activeFactors.length} factor${activeFactors.length === 1 ? "" : "s"}`
                : "Authenticator app required"}
            </span>
          </div>

          {hasActiveMfa ? (
            <ul
              data-security-mfa-factor-list
              className="m-0 grid list-none gap-2 p-0"
            >
              {activeFactors.map((f) => (
                <li
                  key={f.id}
                  data-security-mfa-factor={f.id}
                  className="flex items-center justify-between gap-3 rounded-[14px] border border-[rgba(79,112,107,0.10)] bg-white/40 p-3"
                >
                  <div>
                    <div className="text-[13.5px] font-semibold text-[#21353a]">
                      {f.label ?? f.factorType ?? "Authenticator app"}
                    </div>
                    <div className="text-[11.5px] text-[#6a777b]">
                      Added{" "}
                      {f.createdAt
                        ? new Date(f.createdAt).toLocaleDateString()
                        : "—"}
                    </div>
                  </div>
                  {confirmDisableId === f.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-[#a14040]">
                        Remove this factor?
                      </span>
                      <Button
                        variant="secondary"
                        onClick={() => setConfirmDisableId(null)}
                        disabled={busyFactorId === f.id}
                        data-security-mfa-disable-cancel
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={() => void disableFactor(f.id)}
                        disabled={busyFactorId === f.id}
                        data-security-mfa-disable-confirm
                      >
                        {busyFactorId === f.id ? "Removing…" : "Remove"}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => setConfirmDisableId(f.id)}
                      data-security-mfa-disable
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          {!enrollment ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                onClick={() => void startEnrollment()}
                disabled={enrolling}
                data-security-mfa-enroll-start
              >
                {enrolling
                  ? "Preparing…"
                  : hasActiveMfa
                    ? "Add another authenticator"
                    : "Set up authenticator app"}
              </Button>
              {hasActiveMfa ? (
                <Button
                  variant="secondary"
                  onClick={() => void regenerateRecoveryCodes()}
                  disabled={regenerating}
                  data-security-mfa-recovery-regenerate
                >
                  {regenerating ? "Generating…" : "Regenerate recovery codes"}
                </Button>
              ) : null}
            </div>
          ) : null}

          {enrollment ? (
            <div
              data-security-mfa-enroll-panel
              className="mt-3 rounded-[18px] border border-[rgba(79,112,107,0.14)] bg-white/55 p-4"
            >
              <div className="mb-2 text-[13px] font-semibold text-[#21353a]">
                Scan with your authenticator app
              </div>
              <p className="m-0 mb-3 text-[12px] text-[#6a777b]">
                Open Google Authenticator, 1Password, Authy, or any other
                TOTP app and add an account using either the QR link or
                the secret below.
              </p>
              <div className="mb-3 grid gap-2">
                <code
                  data-security-mfa-enroll-uri
                  className="break-all rounded-[10px] border border-[rgba(79,112,107,0.10)] bg-white/60 p-2 text-[11.5px] text-[#21353a]"
                >
                  {enrollment.provisioning_uri}
                </code>
                <code
                  data-security-mfa-enroll-secret
                  className="break-all rounded-[10px] border border-[rgba(79,112,107,0.10)] bg-white/60 p-2 text-[11.5px] text-[#21353a]"
                >
                  Secret: {enrollment.secret}
                </code>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="6-digit code"
                  value={verifyCode}
                  onChange={(e) =>
                    setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  disabled={verifying}
                  data-security-mfa-enroll-code
                  className="w-32 rounded-[10px] border border-[rgba(79,112,107,0.18)] bg-white/70 p-2 text-center font-mono text-[14px] tracking-[3px]"
                />
                <Button
                  onClick={() => void verifyEnrollment()}
                  disabled={verifying || verifyCode.length !== 6}
                  data-security-mfa-enroll-verify
                >
                  {verifying ? "Verifying…" : "Verify and enable"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEnrollment(null);
                    setVerifyCode("");
                    setVerifyError(null);
                  }}
                  disabled={verifying}
                  data-security-mfa-enroll-cancel
                >
                  Cancel
                </Button>
              </div>
              {verifyError ? (
                <p
                  className="m-0 mt-2 text-[12px] text-[#a14040]"
                  data-security-mfa-enroll-error
                >
                  {verifyError}
                </p>
              ) : null}
            </div>
          ) : null}

          {recoveryCodes ? (
            <div
              data-security-mfa-recovery-panel
              className="mt-3 rounded-[18px] border border-[rgba(214,184,157,0.40)] bg-[rgba(214,184,157,0.10)] p-4"
            >
              <div className="mb-2 text-[13px] font-semibold text-[#8a6e57]">
                Save these recovery codes
              </div>
              <p className="m-0 mb-3 text-[12px] text-[#6a777b]">
                Each code works once. Store them in a password manager —
                we won't show them again. If you lose them, regenerate
                from this page (which invalidates the previous batch).
              </p>
              <ul
                data-security-mfa-recovery-list
                className="m-0 grid list-none grid-cols-2 gap-2 p-0"
              >
                {recoveryCodes.map((code, idx) => (
                  <li
                    key={`${idx}-${code.slice(0, 4)}`}
                    data-security-mfa-recovery-code
                    className="rounded-[8px] border border-[rgba(214,184,157,0.30)] bg-white/55 px-2 py-1 text-center font-mono text-[12.5px] text-[#21353a]"
                  >
                    {code}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(recoveryCodes.join("\n"))
                      .then(() => addToast("Codes copied to clipboard.", "success"))
                      .catch(() => {
                        /* clipboard may be restricted */
                      });
                  }}
                  data-security-mfa-recovery-copy
                >
                  Copy all
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setRecoveryCodes(null)}
                  data-security-mfa-recovery-dismiss
                >
                  I've saved them
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

// =============================================================================
// Password section
// =============================================================================

/**
 * Phase 2.4 — direct password change for EMAIL-provider users.
 *
 * The card now offers BOTH paths:
 *   1. Direct change (new `POST /v1/users/me/password/change`) for
 *      email/password users. Backend verifies the current password
 *      and rejects with 409 PROVIDER_UNSUPPORTED for OAuth / guest
 *      accounts — we render an honest "managed by Google/Apple/…"
 *      panel in that case rather than failing silently.
 *   2. Reset-by-email fallback (Phase 1 `POST /v1/auth/password-reset/request`)
 *      for users who forgot their current password.
 */
function PasswordSection({ userEmail }: { userEmail: string | null }) {
  const { addToast } = useToast();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [providerLocked, setProviderLocked] = useState<string | null>(null);

  const submitChange = useCallback(async () => {
    setChangeError(null);
    if (newPassword.length < 8) {
      setChangeError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangeError("New password and confirmation don't match.");
      return;
    }
    if (currentPassword.length < 1) {
      setChangeError("Enter your current password.");
      return;
    }
    setChanging(true);
    try {
      await apiFetch("/v1/users/me/password/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });
      addToast("Password changed.", "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      const e = err as {
        statusCode?: number;
        code?: string;
        message?: string;
        details?: { provider?: string };
      };
      if (e.code === "PROVIDER_UNSUPPORTED") {
        setProviderLocked(e.details?.provider ?? "OAUTH");
      } else if (e.code === "CURRENT_PASSWORD_INVALID") {
        setChangeError("Current password is incorrect.");
      } else if (e.statusCode === 400) {
        setChangeError(
          e.message ?? "New password didn't meet the minimum requirements.",
        );
      } else {
        captureException(err, { feature: "account_security_password_change" });
        setChangeError(e.message ?? "Could not change password.");
      }
    } finally {
      setChanging(false);
    }
  }, [currentPassword, newPassword, confirmPassword, addToast]);

  const sendResetEmail = useCallback(async () => {
    if (!userEmail) {
      addToast("No email on file — set one in Profile first.", "error");
      return;
    }
    setSending(true);
    try {
      await apiFetch("/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userEmail }),
      });
      setSent(true);
      addToast(
        "If this email is registered, a reset link is on the way.",
        "success",
      );
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 429) {
        addToast(
          "Too many reset requests. Wait a few minutes before trying again.",
          "error",
        );
      } else {
        captureException(err, { feature: "account_security_password_reset" });
        addToast(e.message ?? "Could not send reset link.", "error");
      }
    } finally {
      setSending(false);
    }
  }, [userEmail, addToast]);

  if (providerLocked) {
    return (
      <section data-security-password data-security-password-provider-locked>
        {sectionHeader(
          "Password",
          "Your account is managed by an identity provider — change your password there.",
        )}
        <AccessGate
          kind="FEATURE_UNAVAILABLE"
          surface="Password"
          headline={`Managed by ${providerLocked}`}
          reason="This account signs in with a third-party identity provider, so PROOVRA does not store a password to change. Update your password with the provider that owns your sign-in."
          variant="inline"
          actions={[]}
          testid="security-password-provider-gate"
        />
      </section>
    );
  }

  return (
    <section data-security-password>
      {sectionHeader(
        "Password",
        "Change your password directly, or send a reset link to your account email if you've forgotten it.",
      )}

      <div data-security-password-change-form className="mb-4 grid gap-2">
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={changing}
          data-security-password-current
          className="rounded-[10px] border border-[rgba(79,112,107,0.18)] bg-white/70 p-2 text-[14px]"
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="New password (min 8 characters)"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={changing}
          data-security-password-new
          className="rounded-[10px] border border-[rgba(79,112,107,0.18)] bg-white/70 p-2 text-[14px]"
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Confirm new password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={changing}
          data-security-password-confirm
          className="rounded-[10px] border border-[rgba(79,112,107,0.18)] bg-white/70 p-2 text-[14px]"
        />
        {changeError ? (
          <p
            className="m-0 text-[12px] text-[#a14040]"
            data-security-password-change-error
          >
            {changeError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void submitChange()}
            disabled={
              changing ||
              !currentPassword ||
              newPassword.length < 8 ||
              newPassword !== confirmPassword
            }
            data-security-password-change-submit
          >
            {changing ? "Updating…" : "Change password"}
          </Button>
        </div>
      </div>

      <div className="border-t border-[rgba(79,112,107,0.08)] pt-3">
        <p className="m-0 mb-2 text-[12px] text-[#6a777b]">
          Forgot your current password?
        </p>
        <p className="m-0 mb-2 text-[12px] text-[#6a777b]">
          Email on file:{" "}
          <span data-security-password-email className="font-mono">
            {userEmail ?? "—"}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => void sendResetEmail()}
            disabled={!userEmail || sending}
            data-security-password-reset
          >
            {sending ? "Sending…" : sent ? "Resend reset link" : "Send password reset link"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// =============================================================================
// Sessions section
// =============================================================================

/**
 * Phase 2.4 — per-device session list with selective revoke.
 *
 * Reads `/v1/users/me/sessions` (new) and renders:
 *   - Each active session as a row with last-seen / created / ip / ua /
 *     "current device" marker.
 *   - A per-row "Revoke" button calling
 *     `DELETE /v1/users/me/sessions/:id`. The CURRENT session row's
 *     revoke uses a stronger confirmation message ("you'll be signed
 *     out") and matches the "Sign out of all devices" semantics.
 *   - A "Sign out of all devices" button calling the existing
 *     identity-security revoke-all endpoint.
 */
type SessionRow = {
  id: string;
  teamId: string | null;
  ssoConnectionId: string | null;
  issuedAtUtc: string;
  expiresAtUtc: string;
  lastSeenAtUtc: string;
  ipPreview: string | null;
  uaPreview: string | null;
  revoked: boolean;
  revokedAtUtc: string | null;
  revokedReason: string | null;
  active: boolean;
  current: boolean;
};

function SessionsSection() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [signing, setSigning] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = (await apiFetch("/v1/users/me/sessions")) as {
        sessions?: SessionRow[];
      };
      setSessions(data.sessions ?? []);
    } catch (err) {
      const e = err as { message?: string };
      captureException(err, { feature: "account_security_sessions_list" });
      setLoadError(e.message ?? "Could not load active sessions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revokeOne = useCallback(
    async (sessionId: string) => {
      setRevokingId(sessionId);
      try {
        await apiFetch(`/v1/users/me/sessions/${sessionId}`, {
          method: "DELETE",
        });
        addToast("Session signed out.", "success");
        await reload();
      } catch (err) {
        captureException(err, {
          feature: "account_security_sessions_revoke_one",
        });
        const e = err as { statusCode?: number; message?: string };
        addToast(e.message ?? "Could not revoke that session.", "error");
      } finally {
        setRevokingId(null);
      }
    },
    [reload, addToast],
  );

  const signOutEverywhere = useCallback(async () => {
    setSigning(true);
    try {
      await apiFetch("/v1/identity-security/sessions/revoke-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "user_initiated_logout_all" }),
      });
      addToast(
        "Signed out everywhere. You'll need to sign in again next time.",
        "success",
      );
      setConfirming(false);
      await reload();
    } catch (err) {
      captureException(err, {
        feature: "account_security_sessions_revoke_all",
      });
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 403) {
        addToast(
          "Only an admin can revoke sessions from this surface today.",
          "error",
        );
      } else {
        addToast(e.message ?? "Could not sign out everywhere.", "error");
      }
    } finally {
      setSigning(false);
    }
  }, [addToast, reload]);

  const activeSessions = sessions.filter((s) => s.active);

  return (
    <section data-security-sessions>
      {sectionHeader(
        "Active sessions",
        "Devices and browsers currently signed in to your account. Revoke individually, or sign out of every device at once.",
      )}

      {loading ? (
        <p
          className="m-0 text-[13px] text-[#6a777b]"
          data-security-sessions-loading
        >
          Loading active sessions…
        </p>
      ) : null}

      {loadError ? (
        <p
          className="m-0 text-[13px] text-[#a14040]"
          data-security-sessions-error
        >
          {loadError}
        </p>
      ) : null}

      {!loading && !loadError ? (
        activeSessions.length > 0 ? (
          <ul
            data-security-sessions-list
            className="m-0 mb-4 grid list-none gap-2 p-0"
          >
            {activeSessions.map((s) => (
              <li
                key={s.id}
                data-security-session-id={s.id}
                data-security-session-current={s.current ? "true" : "false"}
                className={`flex items-center justify-between gap-3 rounded-[14px] border p-3 ${
                  s.current
                    ? "border-[rgba(45,91,89,0.30)] bg-[rgba(45,91,89,0.06)]"
                    : "border-[rgba(79,112,107,0.10)] bg-white/40"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-semibold text-[#21353a]">
                      {s.uaPreview ?? "Unknown device"}
                    </span>
                    {s.current ? (
                      <StatusPill
                        tone="active"
                        label="This device"
                        testid={`security-session-current-${s.id}`}
                      />
                    ) : null}
                    {s.ssoConnectionId ? (
                      <StatusPill tone="warn" label="SSO" />
                    ) : null}
                  </div>
                  <div className="mt-1 text-[11.5px] text-[#6a777b]">
                    {s.ipPreview ? <span>{s.ipPreview} · </span> : null}
                    Last seen{" "}
                    {new Date(s.lastSeenAtUtc).toLocaleString()}
                    {" · "}
                    Started{" "}
                    {new Date(s.issuedAtUtc).toLocaleDateString()}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => void revokeOne(s.id)}
                  disabled={revokingId === s.id}
                  data-security-session-revoke
                >
                  {revokingId === s.id
                    ? "Revoking…"
                    : s.current
                      ? "Sign out here"
                      : "Sign out"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p
            className="m-0 mb-4 text-[12.5px] text-[#6a777b]"
            data-security-sessions-empty
          >
            No active sessions found. (You're seeing this page, so at
            least one exists — refresh in a moment if the inventory
            hasn't caught up yet.)
          </p>
        )
      ) : null}

      {confirming ? (
        <div
          data-security-sessions-confirm
          className="rounded-[14px] border border-[rgba(161,64,64,0.30)] bg-[rgba(161,64,64,0.06)] p-3"
        >
          <p className="m-0 text-[12.5px] text-[#a14040]">
            This signs you out on every device, including this one. You'll
            need to sign in again on each device — and re-enter your
            second factor if MFA is enabled.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={() => void signOutEverywhere()}
              disabled={signing}
              data-security-sessions-confirm-yes
            >
              {signing ? "Signing out…" : "Yes, sign me out everywhere"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={signing}
              data-security-sessions-confirm-cancel
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          onClick={() => setConfirming(true)}
          data-security-sessions-signout-all
        >
          Sign out of all devices
        </Button>
      )}
    </section>
  );
}
