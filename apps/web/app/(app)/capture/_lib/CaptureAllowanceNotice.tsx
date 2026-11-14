"use client";

/**
 * F-12 (Free-user audit 2026-11-13) — the record / storage blockers the
 * account projection already knows, shown on Capture before upload. Reuses
 * the re-attach notice's visual primitive (no new stylesheet). "View plans"
 * opens Billing in a NEW tab, so staged files and in-browser recordings on
 * this page are never lost by following it.
 */
import { AlertTriangle } from "lucide-react";

import type { CaptureAllowanceNotice as Notice } from "./capture-allowance";

export function CaptureAllowanceNotice({ notices }: { notices: Notice[] }) {
  if (notices.length === 0) return null;
  return (
    <section
      className="capture-reattach"
      data-capture-allowance
      role="status"
      aria-label="Plan limits for this capture"
    >
      {notices.map((notice) => (
        <header key={notice.code} className="capture-reattach__head" data-capture-allowance-notice={notice.code}>
          <span className="capture-reattach__icon" aria-hidden="true">
            <AlertTriangle size={16} strokeWidth={2.1} />
          </span>
          <div>
            <strong>{notice.title}</strong>
            <p>
              {notice.detail}{" "}
              <a href="/billing" target="_blank" rel="noopener noreferrer">
                View plans (opens in a new tab)
              </a>
            </p>
          </div>
        </header>
      ))}
    </section>
  );
}
