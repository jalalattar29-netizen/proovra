"use client";

/**
 * PHASE 10 STEP 5 (2026-07-23) — persistent SUPPORT ACCESS banner.
 *
 * Renders whenever the canonical platform-context envelope reports ACTIVE
 * support access (`envelope.supportAccess.active`). It makes the dual
 * identity VISIBLE — the support actor is operating within a customer org
 * under a bounded, audited grant, never an invisible impersonation. The
 * banner is intentionally NON-dismissible: it must stay on screen for the
 * whole support session so the operator can never forget they are inside a
 * customer's tenant.
 *
 * Self-contained: reads only the envelope + the shared ProovraBanner
 * primitive. Renders nothing (null) for every ordinary user.
 */

import { usePlatformContext } from "../../lib/platform-context";
import { ProovraBanner } from "../feedback/ProovraBanner";

function formatExpiry(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "an unknown time";
  const deltaMs = t - Date.now();
  if (deltaMs <= 0) return "now (expiring)";
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`;
}

export function SupportAccessBanner() {
  const ctx = usePlatformContext();
  const support = ctx.envelope?.supportAccess;
  if (!support || !support.active) return null;

  const org = support.organizationName ?? support.organizationId;
  const modeLabel = support.mode === "ELEVATED" ? "Elevated" : "Read-only";

  return (
    <div data-support-access-banner data-support-mode={support.mode}>
      <ProovraBanner severity="warning" title="Support access active">
        You are acting as <strong>support</strong> inside{" "}
        <strong>{org}</strong> ({modeLabel} access). Your own identity is
        recorded on every action — this is not the customer&apos;s account.
        Access expires {formatExpiry(support.expiresAtUtc)}.
      </ProovraBanner>
    </div>
  );
}
