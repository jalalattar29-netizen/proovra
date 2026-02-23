"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, useToast } from "../../components/ui";
import { useLocale } from "../providers";
import { apiFetch, ApiError } from "../../lib/api";

export default function ForgotPasswordPage() {
  const { t } = useLocale();
  const { addToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = searchParams.get("returnUrl") || "/home";

  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      setError("Please enter your email.");
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
        { auth: false } // ✅ مهم
      );

      setDone(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Request failed";
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      const displayMsg = msg === "rate_limited" ? "Too many requests. Please try again later." : msg;
      setError(displayMsg);
      addToast(requestId ? `${displayMsg} (requestId: ${requestId})` : displayMsg, "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="blue-shell auth-screen">
      <div className="container">
        <header className="auth-top">
          <Link href="/" className="auth-brand">
            <img src="/brand/logo-white.svg" alt="PROO✓RA" />
            <span>{t("brand")}</span>
          </Link>

          <nav className="auth-top-links">
            <Link href="/login">Login</Link>
          </nav>
        </header>

        <main className="auth-main">
          <div className="auth-card">
            <h2 className="auth-title">Reset password</h2>

            <div className="auth-actions">
              {done ? (
                <>
                  <div style={{ fontSize: 14, color: "#0f172a" }}>
                    If an account exists for that email, we sent a reset link.
                  </div>

                  <Button variant="primary" onClick={() => router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`)}>
                    Back to login
                  </Button>
                </>
              ) : (
                <form id="forgot-form" onSubmit={submit} style={{ width: "100%", display: "grid", gap: 10 }}>
                  <input
                    type="email"
                    placeholder="Email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={busy}
                    style={{
                      width: "100%",
                      height: 44,
                      borderRadius: 10,
                      border: "1px solid #e2e8f0",
                      padding: "0 12px",
                      background: "white",
                    }}
                  />
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => (document.getElementById("forgot-form") as HTMLFormElement | null)?.requestSubmit()}
                  >
                    Send reset link
                  </Button>

                  {error && <div className="error-text">{error}</div>}
                </form>
              )}
            </div>

            <div className="auth-switch">
              <span>Remembered your password? </span>
              <Link href={`/login?returnUrl=${encodeURIComponent(returnUrl)}`}>Login</Link>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}