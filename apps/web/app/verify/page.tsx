"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "../../components/ui";

export default function VerifyIntroPage() {
  const [token, setToken] = useState("");
  const router = useRouter();

  const handleVerify = () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    router.push(`/verify/${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="blue-shell auth-screen">
      <div className="container">
        <header className="auth-top">
          <Link href="/" className="auth-brand">
            <img src="/brand/logo-white.svg" alt="PROO✓RA" />
            <span>PROO✓RA</span>
          </Link>
          <nav className="auth-top-links">
            <Link href="/login">Login</Link>
            <Link href="/register">Register</Link>
          </nav>
        </header>
        <main className="auth-main">
          <section className="auth-card legal-page">
            <h2 className="auth-title">Verify Evidence</h2>
            <p className="page-subtitle">
              Enter the verification token to review integrity details without exposing the original
              content.
            </p>
            <div style={{ display: "grid", gap: 12 }}>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Verification token"
              />
              <Button onClick={handleVerify}>Verify</Button>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
