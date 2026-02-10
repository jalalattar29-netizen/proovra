"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui";
import { MarketingHeader } from "../../components/header";

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
      <MarketingHeader />
      <div className="container">
        <main className="auth-main" style={{ paddingTop: 48 }}>
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
