"use client";

import { useEffect, useState } from "react";
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

  const submit = async (e: React.FormEvent) => {
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
      await apiFetch("/v1/auth/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token, newPassword }),
      });

      setDone(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reset failed";
      const requestId = err instanceof ApiError ? err.requestId : undefined;

      const displayMsg =
        msg === "invalid_or_expired"
          ? "This reset link is invalid or expired."
          : msg;

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
            <h2 className="auth-title">Choose a new password</h2>

            <div className="auth-actions">
              {done ? (
                <>
                  <div style={{ fontSize: 14, color: "#0f172a" }}>
                    Password updated successfully. You can now sign in.
                  </div>

                  <Button
                    variant="primary"
                    onClick={() => router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`)}
                  >
                    Go to login
                  </Button>
                </>
              ) : (
                <form id="reset-form" onSubmit={submit} style={{ width: "100%", display: "grid", gap: 10 }}>
                  <input
                    type="password"
                    placeholder="New password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
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
                  <input
                    type="password"
                    placeholder="Confirm new password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
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
                    disabled={busy || !token}
                    onClick={() => (document.getElementById("reset-form") as HTMLFormElement | null)?.requestSubmit()}
                  >
                    Reset password
                  </Button>

                  {error && <div className="error-text">{error}</div>}
                </form>
              )}
            </div>

            <div className="auth-switch">
              <span>Back to </span>
              <Link href={`/login?returnUrl=${encodeURIComponent(returnUrl)}`}>login</Link>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
