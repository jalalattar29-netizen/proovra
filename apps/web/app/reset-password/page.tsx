"use client";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

/**
 * FP5 — `/reset-password?token=...` complete rewrite.
 *
 * Visual language now matches /login and /register: warm sunrise
 * background, MarketingHeader (no footer), glass card, rose/coral CTA.
 *
 * Functional fix: the previous page disabled the submit button when
 * the URL had no `?token=`, which looked like the button "did nothing"
 * even though the form genuinely could not submit without a token.
 * The new design surfaces that state explicitly with a dedicated
 * "invalid link" card + Request-new-link CTA.
 *
 * Backend contract preserved exactly:
 *   POST /v1/auth/password-reset/confirm
 *   body: { token, newPassword }
 *   200 { ok: true }  |  400 { message: "invalid_or_expired" }
 *
 * Reuses the shared password rules + strength meter + show/hide UX
 * from `apps/web/lib/passwordRules.ts` so register and reset present
 * an identical validation surface.
 */

import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, ApiError } from "../../lib/api";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import {
  STRENGTH_LABELS,
  STRENGTH_COLORS,
  evaluatePassword,
} from "../../lib/passwordRules";

const NEW_PASSWORD_ID = "reset-password-new";
const CONFIRM_PASSWORD_ID = "reset-password-confirm";
const RULES_PANEL_ID = "reset-password-rules";

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2l7 3v6c0 5.25-3.438 10.125-7 11-3.562-.875-7-5.75-7-11V5l7-3Zm0 2.18L7 6.32V11c0 4.164 2.61 8.11 5 8.95 2.39-.84 5-4.786 5-8.95V6.32l-5-2.14Z"
      />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Zm-7-2a2 2 0 0 1 4 0v2h-4V7Zm3 10.73V19h-2v-1.27a2 2 0 1 1 2 0Z"
      />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 5c-5 0-9.27 3.11-11 7 1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
      />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M2.39 1.73 1 3.14l3.11 3.11A12.7 12.7 0 0 0 1 12c1.73 3.89 6 7 11 7 1.83 0 3.55-.41 5.07-1.14L20.85 21l1.41-1.41L2.39 1.73ZM12 17a5 5 0 0 1-4.92-5.92l1.86 1.86A3 3 0 0 0 12 16l1.06-.06 1.86 1.86c-.61.13-1.26.2-1.92.2Zm.86-9.94 6.96 6.96A12.74 12.74 0 0 0 23 12c-1.73-3.89-6-7-11-7-.86 0-1.7.11-2.51.31l3.37 3.37Z"
      />
    </svg>
  );
}
function AlertTriangleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2 1 21h22L12 2Zm0 4.5L19.53 19H4.47L12 6.5ZM11 10v5h2v-5h-2Zm0 6v2h2v-2h-2Z"
      />
    </svg>
  );
}
function RuleCheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19l12-12-1.4-1.4L9 16.2Z" />
    </svg>
  );
}
function RuleCrossIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4Z"
      />
    </svg>
  );
}
function RuleDotIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </svg>
  );
}
function SpinnerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ animation: "auth-spin 0.9s linear infinite" }}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 1-9 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordPageContent />
    </Suspense>
  );
}

function ResetPasswordPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = (searchParams.get("token") || "").trim();
  const hasToken = token.length > 0;

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [showPwd2, setShowPwd2] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(false);

  const newPwdRef = useRef<HTMLInputElement | null>(null);

  // Auto-focus the new-password field on mount when the token is
  // present — saves the user a click and signals the field is live.
  useEffect(() => {
    if (hasToken) newPwdRef.current?.focus();
  }, [hasToken]);

  const passwordEval = useMemo(() => evaluatePassword(password), [password]);
  const passwordsMismatch = confirm.length > 0 && password !== confirm;
  const showPasswordRules =
    passwordFocused ||
    (passwordTouched && password.length > 0 && !passwordEval.allMet);

  const handleCapsLockKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === "function") {
      setCapsLockOn(e.getModifierState("CapsLock"));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setPasswordTouched(true);

    if (!hasToken) {
      setLinkInvalid(true);
      return;
    }
    if (!passwordEval.allMet) {
      setError(
        "Your password does not meet the requirements listed below the password field.",
      );
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        "/v1/auth/password-reset/confirm",
        {
          method: "POST",
          body: JSON.stringify({ token, newPassword: password }),
        },
        { auth: false },
      );
      setDone(true);
    } catch (err) {
      const msg = toSafeUserError(err, { message: "Reset failed" }).message;
      const code = err instanceof ApiError ? err.code : undefined;
      if (
        code === "INVALID_OR_EXPIRED" ||
        msg === "invalid_or_expired" ||
        msg === "invalid_token"
      ) {
        // Surface the dedicated expired-link card so the user lands
        // on the Request-new-link CTA instead of a noisy red error.
        setLinkInvalid(true);
      } else if (code === "RATE_LIMITED" || msg === "too_many_requests") {
        setError("Too many requests. Please try again in a minute.");
      } else {
        setError(
          "We couldn’t reset your password right now. Please try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page landing-page">
      <style jsx global>{`
        @keyframes auth-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/assets/hero/register-logo...png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,229,207,0.10)_0%,rgba(255,255,255,0.02)_45%,rgba(33,22,45,0.10)_100%)]" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <MarketingHeader />

          <main className="flex flex-1 items-center px-6 pb-14 pt-24 md:px-8 md:pb-20 md:pt-28">
            <div className="mx-auto w-full max-w-[520px]">
              <div
                className="relative overflow-hidden rounded-[28px]"
                style={{
                  boxShadow: "0 28px 80px rgba(59,28,74,0.22)",
                  border: "1px solid rgba(255,255,255,0.45)",
                  background: "rgba(255,255,255,0.74)",
                  backdropFilter: "blur(22px) saturate(1.1)",
                  WebkitBackdropFilter: "blur(22px) saturate(1.1)",
                }}
              >
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgba(255,179,107,0.16),transparent_40%)]" />
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_8%,rgba(255,255,255,0.55),transparent_30%)]" />

                <div className="relative z-10 p-8 lg:p-9">
                  {done ? (
                    <SuccessCard onContinue={() => router.push("/login")} />
                  ) : !hasToken || linkInvalid ? (
                    <InvalidLinkCard />
                  ) : (
                    <form onSubmit={submit} noValidate>
                      <div
                        className="inline-flex items-center gap-2.5 rounded-full px-4 py-2.5 text-[0.74rem] font-semibold uppercase tracking-[0.18em]"
                        style={{
                          color: "#21162D",
                          background: "rgba(230,72,128,0.08)",
                          border: "1px solid rgba(230,72,128,0.20)",
                        }}
                      >
                        <span style={{ color: "#E64880" }}>
                          <ShieldIcon />
                        </span>
                        Password Access
                      </div>

                      <h1 className="mt-4 text-[1.9rem] font-semibold tracking-[-0.04em] text-[#1B1230] md:text-[2.15rem]">
                        Create a new password
                      </h1>
                      <p className="mt-3 text-[0.96rem] leading-[1.78] text-[#4B3B4F]">
                        Choose a strong password to secure your PROOVRA account.
                      </p>

                      {/* NEW PASSWORD */}
                      <label
                        htmlFor={NEW_PASSWORD_ID}
                        className="sr-only"
                        style={{
                          position: "absolute",
                          width: 1,
                          height: 1,
                          padding: 0,
                          margin: -1,
                          overflow: "hidden",
                          clip: "rect(0,0,0,0)",
                          whiteSpace: "nowrap",
                          border: 0,
                        }}
                      >
                        New password
                      </label>
                      <div
                        className="auth-input-wrap mt-6"
                        style={{ position: "relative" }}
                      >
                        <span
                          className="auth-input-icon"
                          aria-hidden="true"
                          style={{ color: "#7A687D" }}
                        >
                          <LockIcon />
                        </span>
                        <input
                          ref={newPwdRef}
                          id={NEW_PASSWORD_ID}
                          name="new-password"
                          className="auth-input"
                          placeholder="New password"
                          type={showPwd ? "text" : "password"}
                          autoComplete="new-password"
                          required
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          onFocus={() => setPasswordFocused(true)}
                          onBlur={() => {
                            setPasswordFocused(false);
                            setPasswordTouched(true);
                          }}
                          onKeyDown={handleCapsLockKey}
                          onKeyUp={handleCapsLockKey}
                          aria-invalid={passwordTouched && !passwordEval.allMet}
                          aria-describedby={RULES_PANEL_ID}
                          disabled={busy}
                          style={{
                            background: "rgba(255,255,255,0.84)",
                            border: "1px solid rgba(255,255,255,0.44)",
                            boxShadow: "0 12px 28px rgba(6,16,22,0.08)",
                            color: "#1B1230",
                            paddingRight: 42,
                          }}
                        />
                        <button
                          type="button"
                          aria-label={showPwd ? "Hide password" : "Show password"}
                          aria-pressed={showPwd}
                          onClick={() => setShowPwd((v) => !v)}
                          style={{
                            position: "absolute",
                            right: 10,
                            top: "50%",
                            transform: "translateY(-50%)",
                            background: "transparent",
                            border: 0,
                            color: "#7A687D",
                            cursor: "pointer",
                            padding: 6,
                            borderRadius: 999,
                            lineHeight: 0,
                          }}
                        >
                          {showPwd ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                      </div>

                      {/* Caps Lock warning — subtle inline, only when active */}
                      {capsLockOn ? (
                        <div
                          role="status"
                          aria-live="polite"
                          className="mt-2 inline-flex items-center gap-2 text-[12.5px]"
                          style={{
                            color: "#B45309",
                            background: "rgba(180, 83, 9, 0.08)",
                            border: "1px solid rgba(180, 83, 9, 0.18)",
                            borderRadius: 999,
                            padding: "4px 10px",
                          }}
                        >
                          <AlertTriangleIcon />
                          Caps Lock is on
                        </div>
                      ) : null}

                      {/* Password rules + strength meter — same shape as register */}
                      {showPasswordRules ? (
                        <div
                          id={RULES_PANEL_ID}
                          className="mt-3"
                          style={{
                            background: "rgba(255,255,255,0.52)",
                            border: "1px solid rgba(33,22,45,0.08)",
                            borderRadius: 14,
                            padding: "12px 14px",
                          }}
                        >
                          <ul
                            style={{
                              listStyle: "none",
                              padding: 0,
                              margin: 0,
                              display: "grid",
                              gap: 6,
                            }}
                          >
                            {passwordEval.ruleResults.map((r) => {
                              const interactedFail = passwordTouched && !r.met;
                              const color = r.met
                                ? "#0F8A5F"
                                : interactedFail
                                  ? "#D14343"
                                  : "#7A687D";
                              return (
                                <li
                                  key={r.id}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    fontSize: 13,
                                    color,
                                  }}
                                >
                                  <span style={{ display: "inline-flex" }}>
                                    {r.met ? (
                                      <RuleCheckIcon />
                                    ) : interactedFail ? (
                                      <RuleCrossIcon />
                                    ) : (
                                      <RuleDotIcon />
                                    )}
                                  </span>
                                  {r.label}
                                </li>
                              );
                            })}
                          </ul>
                          {password.length > 0 ? (
                            <div className="mt-3">
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  fontSize: 12,
                                  color: "#4B3B4F",
                                }}
                              >
                                <span>Password strength</span>
                                <span style={{ color: passwordEval.color, fontWeight: 600 }}>
                                  {passwordEval.label}
                                </span>
                              </div>
                              <div
                                aria-hidden="true"
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "repeat(5, 1fr)",
                                  gap: 4,
                                  marginTop: 6,
                                }}
                              >
                                {STRENGTH_LABELS.map((_, i) => (
                                  <span
                                    key={i}
                                    style={{
                                      height: 5,
                                      borderRadius: 3,
                                      background:
                                        i <= passwordEval.score
                                          ? STRENGTH_COLORS[passwordEval.score]
                                          : "rgba(122,104,125,0.18)",
                                      transition: "background 200ms ease",
                                    }}
                                  />
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* CONFIRM PASSWORD */}
                      <label
                        htmlFor={CONFIRM_PASSWORD_ID}
                        className="sr-only"
                        style={{
                          position: "absolute",
                          width: 1,
                          height: 1,
                          padding: 0,
                          margin: -1,
                          overflow: "hidden",
                          clip: "rect(0,0,0,0)",
                          whiteSpace: "nowrap",
                          border: 0,
                        }}
                      >
                        Confirm new password
                      </label>
                      <div
                        className="auth-input-wrap mt-3"
                        style={{ position: "relative" }}
                      >
                        <span
                          className="auth-input-icon"
                          aria-hidden="true"
                          style={{ color: "#7A687D" }}
                        >
                          <LockIcon />
                        </span>
                        <input
                          id={CONFIRM_PASSWORD_ID}
                          name="new-password-confirm"
                          className="auth-input"
                          placeholder="Confirm new password"
                          type={showPwd2 ? "text" : "password"}
                          autoComplete="new-password"
                          required
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                          onFocus={() => setPasswordFocused(false)}
                          onKeyDown={handleCapsLockKey}
                          onKeyUp={handleCapsLockKey}
                          aria-invalid={passwordsMismatch}
                          disabled={busy}
                          style={{
                            background: "rgba(255,255,255,0.84)",
                            border: passwordsMismatch
                              ? "1px solid rgba(209,67,67,0.6)"
                              : "1px solid rgba(255,255,255,0.44)",
                            boxShadow: "0 12px 28px rgba(6,16,22,0.08)",
                            color: "#1B1230",
                            paddingRight: 42,
                          }}
                        />
                        <button
                          type="button"
                          aria-label={
                            showPwd2 ? "Hide confirm password" : "Show confirm password"
                          }
                          aria-pressed={showPwd2}
                          onClick={() => setShowPwd2((v) => !v)}
                          style={{
                            position: "absolute",
                            right: 10,
                            top: "50%",
                            transform: "translateY(-50%)",
                            background: "transparent",
                            border: 0,
                            color: "#7A687D",
                            cursor: "pointer",
                            padding: 6,
                            borderRadius: 999,
                            lineHeight: 0,
                          }}
                        >
                          {showPwd2 ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                      </div>
                      {passwordsMismatch ? (
                        <div
                          role="status"
                          aria-live="polite"
                          className="mt-2 text-[12.5px]"
                          style={{ color: "#D14343" }}
                        >
                          Passwords don&rsquo;t match.
                        </div>
                      ) : null}

                      {/* Submit + back to sign in */}
                      <div className="mt-6 flex flex-wrap items-center gap-3">
                        <button
                          type="submit"
                          disabled={busy}
                          style={{
                            background: busy
                              ? "rgba(230,72,128,0.18)"
                              : "linear-gradient(90deg, #E64880 0%, #FF6B6B 52%, #FF8A6A 100%)",
                            color: busy ? "#7A687D" : "#ffffff",
                            border: "1px solid rgba(230,72,128,0.45)",
                            boxShadow: busy
                              ? "none"
                              : "0 14px 28px rgba(230,72,128,0.22)",
                            fontWeight: 600,
                            padding: "12px 20px",
                            borderRadius: 999,
                            cursor: busy ? "not-allowed" : "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          {busy ? (
                            <>
                              <SpinnerIcon />
                              Resetting password…
                            </>
                          ) : (
                            "Reset password"
                          )}
                        </button>
                        <Link
                          href="/login"
                          className="auth-link"
                          style={{ color: "#D63E76", fontWeight: 600, fontSize: 14 }}
                        >
                          Back to sign in
                        </Link>
                      </div>

                      {error ? (
                        <div
                          role="alert"
                          className="mt-4 text-[13.5px]"
                          style={{
                            color: "#D14343",
                            background: "rgba(255,255,255,0.62)",
                            border: "1px solid rgba(209,67,67,0.20)",
                            borderRadius: 14,
                            padding: "10px 12px",
                          }}
                        >
                          {error}
                        </div>
                      ) : null}
                    </form>
                  )}
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// ====================== State cards ======================

function SuccessCard({ onContinue }: { onContinue: () => void }) {
  return (
    <div role="status" aria-live="polite">
      <div
        className="inline-flex items-center gap-2.5 rounded-full px-4 py-2.5 text-[0.74rem] font-semibold uppercase tracking-[0.18em]"
        style={{
          color: "#21162D",
          background: "rgba(15,138,95,0.10)",
          border: "1px solid rgba(15,138,95,0.22)",
        }}
      >
        <span style={{ color: "#0F8A5F" }}>
          <ShieldIcon />
        </span>
        Password updated
      </div>
      <h1 className="mt-4 text-[1.9rem] font-semibold tracking-[-0.04em] text-[#1B1230] md:text-[2.15rem]">
        Password updated
      </h1>
      <p className="mt-3 text-[0.96rem] leading-[1.78] text-[#4B3B4F]">
        You can now sign in with your new password.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onContinue}
          style={{
            background: "linear-gradient(90deg, #E64880 0%, #FF6B6B 52%, #FF8A6A 100%)",
            color: "#ffffff",
            border: "1px solid rgba(230,72,128,0.45)",
            boxShadow: "0 14px 28px rgba(230,72,128,0.22)",
            fontWeight: 600,
            padding: "12px 20px",
            borderRadius: 999,
            cursor: "pointer",
          }}
        >
          Back to sign in
        </button>
      </div>
    </div>
  );
}

function InvalidLinkCard() {
  return (
    <div role="alert">
      <div
        className="inline-flex items-center gap-2.5 rounded-full px-4 py-2.5 text-[0.74rem] font-semibold uppercase tracking-[0.18em]"
        style={{
          color: "#21162D",
          background: "rgba(209,67,67,0.10)",
          border: "1px solid rgba(209,67,67,0.20)",
        }}
      >
        <span style={{ color: "#D14343" }}>
          <AlertTriangleIcon />
        </span>
        Link expired
      </div>
      <h1 className="mt-4 text-[1.9rem] font-semibold tracking-[-0.04em] text-[#1B1230] md:text-[2.15rem]">
        Reset link expired
      </h1>
      <p className="mt-3 text-[0.96rem] leading-[1.78] text-[#4B3B4F]">
        This password reset link is invalid or has expired. Request a new
        reset link to continue.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link
          href="/login?forgot=1"
          style={{
            background: "linear-gradient(90deg, #E64880 0%, #FF6B6B 52%, #FF8A6A 100%)",
            color: "#ffffff",
            border: "1px solid rgba(230,72,128,0.45)",
            boxShadow: "0 14px 28px rgba(230,72,128,0.22)",
            fontWeight: 600,
            padding: "12px 20px",
            borderRadius: 999,
            textDecoration: "none",
            display: "inline-block",
          }}
        >
          Request new link
        </Link>
        <Link
          href="/login"
          className="auth-link"
          style={{ color: "#D63E76", fontWeight: 600, fontSize: 14 }}
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
