"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "../../components/ui";
import { apiFetch, ApiError } from "../../lib/api";
import { MarketingHeader } from "../../components/header";
import { Footer } from "../../components/Footer";

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
        requestId ? `${displayMsg} (requestId: ${requestId})` : displayMsg,
        "error",
        6000
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page landing-page">
      <div className="relative min-h-screen overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.84)_0%,rgba(8,18,22,0.74)_34%,rgba(8,18,22,0.68)_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_14%,rgba(158,216,207,0.08),transparent_24%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_22%,rgba(214,184,157,0.06),transparent_18%)]" />
        <div className="absolute inset-0 opacity-[0.035] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.022)_0px,rgba(255,255,255,0.022)_1px,transparent_1px,transparent_4px)]" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <MarketingHeader />

          <main className="flex flex-1 items-center justify-center px-6 py-10 md:px-8 md:py-14">
            <div className="w-full max-w-[540px]">
              <div
                className="auth-card auth-premium relative overflow-hidden rounded-[30px]"
                style={{
                  boxShadow: "0 30px 80px rgba(0,0,0,0.18)",
                  border: "1px solid rgba(79,112,107,0.22)",
                }}
              >
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover object-center"
                />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(245,247,244,0.45)_50%,rgba(236,239,236,0.55)_100%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_20%,rgba(214,184,157,0.18),transparent_40%)]" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_10%,rgba(255,255,255,0.35),transparent_30%)]" />

                <div className="relative z-10 p-7 md:p-8">
                  <div className="mb-6">
                    <div className="inline-flex items-center gap-2.5 rounded-full border border-[#23373b]/8 bg-[rgba(35,55,59,0.05)] px-4 py-2.5 text-[0.74rem] font-semibold uppercase tracking-[0.18em] text-[#566366]">
                      Password access
                    </div>

                    <h2 className="mt-4 text-[1.9rem] font-semibold tracking-[-0.04em] text-[#16282d] md:text-[2.15rem]">
                      Reset password
                    </h2>

                    <p className="mt-3 text-[0.96rem] leading-[1.78] text-[#5c6a6e]">
                      Enter your email address and we’ll send you a secure password reset link.
                    </p>
                  </div>

                  <div className="auth-actions" style={{ display: "grid", gap: 12 }}>
                    {done ? (
                      <>
                        <div className="rounded-[18px] border border-[rgba(79,112,107,0.14)] bg-[rgba(255,255,255,0.40)] px-4 py-4 text-[0.95rem] leading-[1.75] text-[#55666a]">
                          If an account exists for that email, we sent a reset link.
                        </div>

                        <button
                          className="auth-social-btn"
                          onClick={() =>
                            router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`)
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

                  <div
                    className="auth-switch"
                    style={{
                      marginTop: 18,
                      color: "#617074",
                    }}
                  >
                    <span>Remembered your password? </span>
                    <Link href={`/login?returnUrl=${encodeURIComponent(returnUrl)}`}>
                      Login
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </main>

          <Footer />
        </div>
      </div>
    </div>
  );
}