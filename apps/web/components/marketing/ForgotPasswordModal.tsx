"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "../../lib/api";

/**
 * FP2 — Forgot Password modal.
 *
 * Opens inside /login and posts to /v1/auth/password-reset/request.
 * The response is intentionally neutral — the success copy never
 * confirms whether the address belongs to a real account.
 *
 * Visual language matches the warm /login + /register pages
 * (glass card, rose/coral CTA, no green/teal). Built without
 * reusing the existing matter-modals Modal — that component is
 * dark-teal-themed and lives in the app shell.
 *
 * Accessibility:
 *  - role="dialog" + aria-modal="true"
 *  - labelled by an internal heading id
 *  - first input focused on open
 *  - focus trap (Tab cycles inside)
 *  - Escape closes
 *  - background scroll locked
 *  - returns focus to the element that triggered the modal
 */
export function ForgotPasswordModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const titleId = useId();
  const descId = useId();

  // Reset state every time the modal opens fresh (avoids the user
  // seeing a stale success card after closing + reopening).
  useEffect(() => {
    if (open) {
      setEmail("");
      setBusy(false);
      setDone(false);
      setError(null);
    }
  }, [open]);

  // Focus management + escape close + scroll lock.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const t = window.setTimeout(() => {
      firstFieldRef.current?.focus();
    }, 50);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError("Enter a valid email address.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        "/v1/auth/password-reset/request",
        {
          method: "POST",
          body: JSON.stringify({ email: cleanEmail }),
        },
        { auth: false },
      );
      setDone(true);
    } catch (err) {
      // Backend hard-rate-limits at 5/min/IP with 429 + Retry-After.
      // Treat that as the only "non-neutral" failure we surface
      // (without leaking enumeration). Everything else collapses to
      // a generic retry hint.
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "RATE_LIMITED" || (err as Error)?.message === "too_many_requests") {
        setError("Too many requests. Please try again in a minute.");
      } else {
        setError("We couldn’t send the reset email right now. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(20, 12, 32, 0.55)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative overflow-hidden rounded-[28px]"
        style={{
          width: "100%",
          maxWidth: 460,
          background: "rgba(255,255,255,0.96)",
          border: "1px solid rgba(255,255,255,0.50)",
          boxShadow: "0 28px 80px rgba(59,28,74,0.30)",
          backdropFilter: "blur(22px) saturate(1.1)",
          WebkitBackdropFilter: "blur(22px) saturate(1.1)",
        }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgba(255,179,107,0.16),transparent_40%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_8%,rgba(255,255,255,0.55),transparent_30%)]" />

        <div className="relative z-10 p-7 md:p-8">
          <div className="flex items-start justify-between">
            <div
              className="inline-flex items-center gap-2.5 rounded-full px-3.5 py-2 text-[0.72rem] font-semibold uppercase tracking-[0.18em]"
              style={{
                color: "#21162D",
                background: "rgba(230,72,128,0.08)",
                border: "1px solid rgba(230,72,128,0.20)",
              }}
            >
              Password reset
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                border: "1px solid rgba(33,22,45,0.10)",
                background: "rgba(255,255,255,0.62)",
                color: "#21162D",
                cursor: "pointer",
                lineHeight: 1,
                fontSize: 18,
              }}
            >
              ×
            </button>
          </div>

          {done ? (
            <>
              <h2
                id={titleId}
                className="mt-4 text-[1.6rem] font-semibold tracking-[-0.04em] text-[#1B1230] md:text-[1.85rem]"
              >
                Check your email
              </h2>
              <p
                id={descId}
                className="mt-3 text-[0.94rem] leading-[1.7] text-[#4B3B4F]"
              >
                If an account exists for this address, a secure password reset
                link has been sent.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    background:
                      "var(--btn-primary-bg)",
                    color: "#ffffff",
                    border: "1px solid var(--btn-primary-border)",
                    boxShadow: "var(--btn-primary-shadow)",
                    fontWeight: 600,
                    padding: "11px 18px",
                    borderRadius: 999,
                    cursor: "pointer",
                  }}
                >
                  Back to sign in
                </button>
                <button
                  type="button"
                  onClick={() => setDone(false)}
                  style={{
                    color: "#D63E76",
                    fontWeight: 600,
                    fontSize: 14,
                    background: "transparent",
                    border: 0,
                    padding: "6px 4px",
                    cursor: "pointer",
                  }}
                >
                  Send again
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={submit} noValidate>
              <h2
                id={titleId}
                className="mt-4 text-[1.6rem] font-semibold tracking-[-0.04em] text-[#1B1230] md:text-[1.85rem]"
              >
                Reset your password
              </h2>
              <p
                id={descId}
                className="mt-3 text-[0.94rem] leading-[1.7] text-[#4B3B4F]"
              >
                Enter the email address associated with your PROOVRA account.
                If an account exists, we&rsquo;ll send a secure password reset
                link.
              </p>

              <label
                htmlFor="forgot-pwd-email"
                className="mt-6 block text-[12px] font-semibold uppercase tracking-[0.18em]"
                style={{ color: "#7A687D" }}
              >
                Email address
              </label>
              <input
                ref={firstFieldRef}
                id="forgot-pwd-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                disabled={busy}
                placeholder="you@example.com"
                aria-invalid={Boolean(error)}
                className="mt-2 w-full rounded-2xl px-4 py-3 text-[15px]"
                style={{
                  color: "#1B1230",
                  background: "rgba(255,255,255,0.84)",
                  border: error
                    ? "1px solid rgba(209,67,67,0.6)"
                    : "1px solid rgba(255,255,255,0.44)",
                  boxShadow: "0 12px 28px rgba(6,16,22,0.08)",
                  outline: "none",
                }}
              />

              {error ? (
                <div
                  role="alert"
                  className="mt-3 text-[13px]"
                  style={{ color: "#D14343" }}
                >
                  {error}
                </div>
              ) : busy ? (
                <div
                  role="status"
                  className="mt-3 text-[13px]"
                  style={{ color: "#4B3B4F" }}
                >
                  Sending secure reset link…
                </div>
              ) : null}

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={busy}
                  style={{
                    background: busy
                      ? "rgba(230,72,128,0.18)"
                      : "var(--btn-primary-bg)",
                    color: busy ? "#7A687D" : "#ffffff",
                    border: "1px solid var(--btn-primary-border)",
                    boxShadow: busy ? "none" : "var(--btn-primary-shadow)",
                    fontWeight: 600,
                    padding: "11px 18px",
                    borderRadius: 999,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  Send reset link
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  style={{
                    color: "#1B1230",
                    background: "rgba(255,255,255,0.42)",
                    border: "1px solid rgba(255,255,255,0.45)",
                    borderRadius: 999,
                    padding: "10px 16px",
                    fontWeight: 500,
                    fontSize: 14,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <Link
                  href="/login"
                  onClick={onClose}
                  className="auth-link"
                  style={{ color: "#D63E76", fontWeight: 600, fontSize: 14 }}
                >
                  Back to sign in
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
