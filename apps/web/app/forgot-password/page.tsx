"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "../../components/ui";
import { apiFetch, ApiError } from "../../lib/api";
import { MarketingHeader } from "../../components/header";

export default function ForgotPasswordPage() {
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
        { auth: false }
      );

      setDone(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Request failed";
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      const displayMsg =
        msg === "rate_limited"
          ? "Too many requests. Please try again later."
          : msg;

      setError(displayMsg);
      addToast(
        requestId
          ? `${displayMsg} (requestId: ${requestId})`
          : displayMsg,
        "error",
        6000
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page landing-page">
      <div className="blue-shell auth-screen auth-dark">
        {/* نفس هيدر الموقع */}
        <MarketingHeader />

        <div className="container">
          <main className="auth-main">
            <div className="auth-card">
              <h2 className="auth-title">Reset password</h2>

              <div className="auth-actions" style={{ display: "grid", gap: 12 }}>
                {done ? (
                  <>
                    <div
                      style={{
                        fontSize: 14,
                        color: "rgba(245, 251, 255, 0.85)",
                        lineHeight: 1.6,
                      }}
                    >
                      If an account exists for that email, we sent a reset link.
                    </div>

                    <button
                      className="auth-social-btn"
                      onClick={() =>
                        router.push(
                          `/login?returnUrl=${encodeURIComponent(returnUrl)}`
                        )
                      }
                    >
                      Back to login
                    </button>
                  </>
                ) : (
                  <form
                    id="forgot-form"
                    onSubmit={submit}
                    style={{ display: "grid", gap: 10 }}
                  >
                    <div className="auth-input-wrap">
                      <input
                        className="auth-input"
                        type="email"
                        placeholder="Email"
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={busy}
                      />
                    </div>

                    <button
                      className="auth-social-btn"
                      type="submit"
                      disabled={busy}
                    >
                      Send reset link
                    </button>

                    {error && <div className="error-text">{error}</div>}
                  </form>
                )}
              </div>

              <div className="auth-switch">
                <span>Remembered your password? </span>
                <Link
                  href={`/login?returnUrl=${encodeURIComponent(returnUrl)}`}
                >
                  Login
                </Link>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}