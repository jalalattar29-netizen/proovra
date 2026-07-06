"use client";

/**
 * ProovraBanner — a page-level, full-width feedback strip for persistent
 * page state (degraded service, plan/quota warning, trust/security
 * notice, report generation issue). Thin wrapper over ProovraAlert with
 * full-width layout + margin. Use a BANNER (not a toast) when the state
 * persists and belongs to the page.
 */

import type { ReactNode } from "react";

import { ProovraAlert, type ProovraAlertAction } from "./ProovraAlert";
import type { FeedbackSeverity } from "./severity";

export function ProovraBanner({
  severity = "info",
  title,
  children,
  actions,
  onDismiss,
}: {
  severity?: FeedbackSeverity;
  title?: string;
  children: ReactNode;
  actions?: ProovraAlertAction[];
  onDismiss?: () => void;
}) {
  return (
    <div data-proovra-banner style={{ width: "100%", margin: "0 0 16px 0" }}>
      <ProovraAlert
        severity={severity}
        title={title}
        actions={actions}
        onDismiss={onDismiss}
        variant="card"
      >
        {children}
      </ProovraAlert>
    </div>
  );
}
