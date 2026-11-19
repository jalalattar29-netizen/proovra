"use client";

import { useEffect, useState } from "react";

import { CONTRACT_SKEW_EVENT, type ContractSkewDetail } from "../lib/contract-skew";
import BottomOverlay from "./BottomOverlay";

/**
 * AUD-32 (2026-10-20) — shown when the API answers with a newer presentation
 * contract than this page was built for, and when the page is the newer side,
 * which a reload does not fix (lib/contract-skew.ts).
 *
 * PRO-PW-08 — and when the API states a minimum client contract above this
 * build: a BLOCKING reload prompt (no dismiss), because the page must not keep
 * writing through rules the API no longer serves. The advisory notices can be
 * dismissed. Every Reload warns that unsaved work (an upload in progress, a
 * draft) is lost. The notice renders in the shared bottom overlay stack so it
 * never covers the service-worker prompt or the sign-out notice.
 */
const UNSAVED_WARNING = "Finish or save any upload or draft first: reloading discards unsaved work.";

export default function ContractSkewNotice() {
  const [direction, setDirection] = useState<ContractSkewDetail["direction"] | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      setDirection((e as CustomEvent<ContractSkewDetail>).detail?.direction ?? "CLIENT_OLDER");
      setDismissed(false);
    };
    window.addEventListener(CONTRACT_SKEW_EVENT, on);
    return () => window.removeEventListener(CONTRACT_SKEW_EVENT, on);
  }, []);
  if (!direction) return null;
  const blocking = direction === "UPDATE_REQUIRED";
  if (dismissed && !blocking) return null;
  const pageIsNewer = direction === "CLIENT_NEWER";
  const message = blocking
    ? "This page is older than PROOVRA now supports. Reload it before continuing."
    : pageIsNewer
      ? "An update to PROOVRA is finishing. Some actions may not work for a few minutes."
      : "PROOVRA has been updated. Reload this page to see current results.";
  return (
    <BottomOverlay>
      <div
        role={blocking ? "alertdialog" : "status"}
        aria-modal={blocking ? "false" : undefined}
        data-testid="contract-skew-notice"
        data-contract-skew={direction}
        style={{
          padding: "12px 16px",
          borderRadius: 10,
          background: "#0f172a",
          color: "#f8fafc",
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
        }}
      >
        <span>
          {message}
          {pageIsNewer ? null : (
            <>
              {" "}
              <small data-testid="contract-skew-unsaved-warning">{UNSAVED_WARNING}</small>
            </>
          )}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          {pageIsNewer ? null : (
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ background: "#f8fafc", color: "#0f172a", border: 0, borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
            >
              Reload
            </button>
          )}
          {blocking ? null : (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setDismissed(true)}
              style={{ background: "transparent", color: "#f8fafc", border: "1px solid #475569", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
            >
              Dismiss
            </button>
          )}
        </span>
      </div>
    </BottomOverlay>
  );
}
