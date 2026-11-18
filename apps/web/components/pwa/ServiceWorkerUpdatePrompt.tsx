"use client";

import { useEffect, useState } from "react";

import { applyWaitingUpdate, registerServiceWorker } from "../../lib/pwa/serviceWorkerClient";
import BottomOverlay from "../BottomOverlay";

/**
 * Registers the service worker and, when a new version is WAITING, offers a
 * reload. The new version never takes over by itself: an open Capture or
 * upload is never switched to new code without the user choosing to reload.
 */
export function ServiceWorkerUpdatePrompt() {
  const [waiting, setWaiting] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    void registerServiceWorker((registration) => setWaiting(registration));
  }, []);

  if (!waiting) return null;
  // PRO-PW-08 — in the shared bottom stack, never on top of another notice.
  return (
    <BottomOverlay>
      <div
        role="status"
        data-sw-update-prompt
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: "10px 14px",
          borderRadius: 10,
          background: "var(--color-surface, #ffffff)",
          color: "var(--color-text, #0f172a)",
          border: "1px solid var(--color-border, #cbd5e1)",
          boxShadow: "0 6px 24px rgba(15, 23, 42, 0.16)",
          fontSize: 14,
        }}
      >
        <span>A new version of PROOVRA is available. Finish any upload in progress, then reload.</span>
        <button type="button" className="app-primary-action" onClick={() => applyWaitingUpdate(waiting)}>
          Reload
        </button>
        <button type="button" className="app-secondary-action" onClick={() => setWaiting(null)}>
          Later
        </button>
      </div>
    </BottomOverlay>
  );
}

export default ServiceWorkerUpdatePrompt;
