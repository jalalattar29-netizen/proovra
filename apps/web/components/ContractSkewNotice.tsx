"use client";

import { useEffect, useState } from "react";

import { CONTRACT_SKEW_EVENT } from "../lib/contract-skew";

/**
 * AUD-32 (2026-10-20) — shown once when the API answers with a newer
 * presentation contract than this page was built for (lib/contract-skew.ts).
 */
export default function ContractSkewNotice() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const on = () => setStale(true);
    window.addEventListener(CONTRACT_SKEW_EVENT, on);
    return () => window.removeEventListener(CONTRACT_SKEW_EVENT, on);
  }, []);
  if (!stale) return null;
  return (
    <div
      role="status"
      data-testid="contract-skew-notice"
      style={{
        position: "fixed",
        insetInline: 16,
        bottom: 16,
        zIndex: 1000,
        padding: "12px 16px",
        borderRadius: 10,
        background: "#0f172a",
        color: "#f8fafc",
        display: "flex",
        gap: 12,
        alignItems: "center",
        justifyContent: "space-between",
        boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
      }}
    >
      <span>PROOVRA has been updated. Reload this page to see current results.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{ background: "#f8fafc", color: "#0f172a", border: 0, borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
      >
        Reload
      </button>
    </div>
  );
}
