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
        <main className="auth-main" style={{ paddingTop: 48, paddingBottom: 72 }}>
          <section className="auth-card legal-page verify-intro-card">
            <div className="verify-intro-kicker">Verification Portal</div>

            <h2 className="auth-title">Review an evidence record</h2>

            <p className="page-subtitle">
              Enter the verification token to inspect integrity materials,
              custody history, timestamp status, and storage-protection metadata
              associated with a PROOVRA evidence record.
            </p>

            <div className="verify-intro-points">
              <div className="verify-intro-point">✓ File hash and fingerprint status</div>
              <div className="verify-intro-point">✓ Signature and custody timeline</div>
              <div className="verify-intro-point">✓ Timestamp, OTS, and storage indicators</div>
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Verification token"
                className="verify-intro-input"
              />

              <Button onClick={handleVerify}>Open verification</Button>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}