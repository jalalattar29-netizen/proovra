"use client";

/**
 * PV-PLACE-001 — IDENTITY ADMINISTRATION, IN THE WORKSPACE'S SECURITY CENTER.
 *
 * These pages administer ONE workspace's identity: its members and service
 * accounts, SCIM provisioning, sessions and devices, the permission matrix,
 * access reviews, the runtime monitor and the identity audit trail. Every API
 * behind them is tenant-scoped (`requireIdentityAdmin` demands ACTIVE
 * membership of the workspace and narrows to it), so they lived under the
 * PLATFORM console's `/admin` URL and gate while never administering the
 * platform — a platform operator who was not a member got 404 from every one.
 *
 * `/admin` now means PROOVRA platform administration only. The family lives
 * here, beside the SSO, MFA-recovery and posture consoles it belongs with, and
 * the old URLs redirect (next.config.js).
 *
 * One gate for the family, evaluated once: the workspace-security capability
 * in an organization workspace. The Security Center layout above already
 * applies the Enterprise surface tier. The look is the administrative visual
 * system these pages were designed and verified on.
 */

import type { ReactNode } from "react";

import { AdminVisualSystem } from "../../../../components/admin/AdminVisualSystem";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

export default function SecurityCenterIdentityLayout({ children }: { children: ReactNode }) {
  return (
    <PageRouteGate routeId="security_center.identity">
      <AdminVisualSystem>{children}</AdminVisualSystem>
    </PageRouteGate>
  );
}
