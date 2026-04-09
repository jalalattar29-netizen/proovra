"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, useToast } from "../../components/ui";
import { useLocale } from "../providers";
import { apiFetch, ApiError } from "../../lib/api";

export default function ResetPasswordPage() {
  const { t } = useLocale();
  const { addToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  const token = searchParams.get("token") || "";
  const returnUrl = searchParams.get("returnUrl") || "/home";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    if (!token) setError("Missing reset token.");
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    if (!token) {
      setError("Missing reset token.");
      return;
    }
    if (!newPassword) {
      setError("Please enter a new password.");
      return;
    }
    if (newPassword !== confirm) {
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
          body: JSON.stringify({ token, newPassword }),
        },
        { auth: false } // ✅ مهم
      );

      setDone(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reset failed";
      const requestId = err instanceof ApiError ? err.requestId : undefined;

      const displayMsg = msg === "invalid_or_expired" ? "This reset link is invalid or expired." : msg;

      setError(displayMsg);
      addToast(requestId ? `${displayMsg} (requestId: ${requestId})` : displayMsg, "error", 6000);
    } finally {
      setBusy(false);
    }
  };

return (
  <div className="page">
    {/* TOP — Velvet */}
    <div className="blue-shell">
      <div className="container auth-top">
        <Link href="/" className="auth-brand">
          <img src="/brand/icon-512.png?v=2" alt="PROO✓RA" />
          <span>{t("brand")}</span>
        </Link>

        <nav className="auth-top-links">
          <Link href="/login">Login</Link>
        </nav>
      </div>

      <div className="container" style={{ padding: "40px 0 60px" }}>
        <h1 className="hero-title">Reset Password</h1>
        <p className="page-subtitle">
          Choose a strong password to secure your account
        </p>
      </div>
    </div>

    {/* BODY — Dark clean */}
    <section className="section section-body">
      <div className="container" style={{ maxWidth: 460 }}>
        <div className="auth-card legal-page">
          <h2 className="auth-title" style={{ marginBottom: 16 }}>
            Choose a new password
          </h2>

          <div className="auth-actions">
            {done ? (
              <>
                <div style={{ fontSize: 14, color: "var(--app-text-muted)" }}>
                  Password updated successfully. You can now sign in.
                </div>

                <Button
                  onClick={() =>
                    router.push(
                      `/login?returnUrl=${encodeURIComponent(returnUrl)}`
                    )
                  }
                >
                  Go to login
                </Button>
              </>
            ) : (
              <form
                id="reset-form"
                onSubmit={submit}
                style={{ display: "grid", gap: 12 }}
              >
                <input
                  type="password"
                  placeholder="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={busy}
                  className="auth-input"
                />

                <input
                  type="password"
                  placeholder="Confirm password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                  className="auth-input"
                />

                <Button disabled={busy || !token}>
                  Reset password
                </Button>

                {error && <div className="error-text">{error}</div>}
              </form>
            )}
          </div>

          <div className="auth-switch">
            <span>Back to </span>
            <Link href={`/login?returnUrl=${encodeURIComponent(returnUrl)}`}>
              login
            </Link>
          </div>
        </div>
      </div>
    </section>
  </div>
);
}