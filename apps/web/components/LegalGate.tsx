"use client";

import { useEffect, useState } from "react";

export function LegalGate({ children }: { children: React.ReactNode }) {
  const [accepted, setAccepted] = useState<boolean | null>(null);

  useEffect(() => {
    async function check() {
      try {
        const res = await fetch("/v1/users/legal-status");
        const data = await res.json();

        setAccepted(data.ok);
      } catch {
        setAccepted(false);
      }
    }

    check();
  }, []);

  const accept = async () => {
    await fetch("/v1/users/legal-acceptance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "web_gate",
        acceptances: [
          { policyKey: "terms", policyVersion: "2026-04-06" },
          { policyKey: "privacy", policyVersion: "2026-04-06" },
          { policyKey: "cookies", policyVersion: "2026-04-06" },
        ],
      }),
    });

    setAccepted(true);
  };

  if (accepted === null) return null;
  if (accepted) return <>{children}</>;

  return (
    <div className="legal-gate">
      <div className="legal-box">
        <h2>Legal Acceptance Required</h2>
        <p>You must accept Terms, Privacy, and Cookies to continue.</p>

        <button onClick={accept}>Accept & Continue</button>
      </div>
    </div>
  );
}