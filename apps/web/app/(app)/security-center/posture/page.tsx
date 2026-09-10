"use client";

/**
 * WORKSPACE SECURITY — orchestrator.
 *
 * PHASE 12B (2026-07-30): composed from `_sections/*`:
 *
 *   1. Workspace security posture  — GET /v1/security/summary | /scans | /events
 *   2. MFA policy                  — GET + versioned PATCH
 *                                    /v1/identity/mfa-admin/policy/:teamId
 *   3. Member MFA lifecycle        — GET  /v1/identity/mfa-admin/posture/:teamId/:userId
 *                                    POST .../factors/:teamId/:userId/:factorId/revoke
 *                                    POST .../factors/:teamId/:userId/require-reenrollment
 *                                    POST .../trusted-devices/:teamId/:userId/reset
 *   4. MFA activity                — GET /v1/identity/mfa-admin/events/:teamId
 *                                    GET /v1/identity/mfa-admin/recovery-events
 *   5. Recovery digest             — GET/PATCH /v1/identity/mfa-admin/digest-preferences
 *                                    GET  .../digest-preferences/preview
 *                                    POST .../digest-preferences/preview/send-test
 *   6. Authenticator self-check    — POST /v1/identity/mfa/challenge/verify
 *
 * PV-PLACE-001 — THIS PAGE MOVED FROM `/admin/security`. It never administered
 * the platform: every section acts on the workspace you are currently in (or,
 * for the digest and self-check, on your own account). Under the platform
 * console's URL and gate, a platform operator who was not a member of the
 * workspace could use none of it, and a workspace owner could not reach it.
 * It lives in the workspace's Security Center now; `/admin/security`
 * redirects here.
 *
 * WCC-NEW-011 — THE ONE MFA POLICY EDITOR. Section 2 is the canonical editor:
 * versioned, Enterprise-entitled, step-up gated. The Security Center landing
 * page shows the current level and links here instead of carrying a second
 * editor on a weaker endpoint.
 *
 * The page never lets an operator type a teamId or a userId: the workspace
 * comes from `lib/platform-context` and members from the server-projected
 * roster. Backend authorization is the real boundary: every workspace-scoped
 * route re-authorizes through `authorizeOrFail` with anti-enumeration.
 */

import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { AdminVisualSystem } from "../../../../components/admin/AdminVisualSystem";

import { SectionDescription } from "./_sections/section-state";

import { MfaDigestPreferencesSection } from "./_sections/MfaDigestPreferencesSection";
import { MfaEventsSection } from "./_sections/MfaEventsSection";
import { MfaMemberPostureSection } from "./_sections/MfaMemberPostureSection";
import { MfaPolicySection } from "./_sections/MfaPolicySection";
import { MfaSelfCheckSection } from "./_sections/MfaSelfCheckSection";
import { WorkspaceSecurityPostureSection } from "./_sections/WorkspaceSecurityPostureSection";

/**
 * NO WORKSPACE READ AT THIS LEVEL.
 *
 * Every section below resolves its own workspace and renders its own
 * `NoWorkspaceSelected` with its own reason, so the page itself has nothing
 * to know about it.
 */
export default function WorkspaceSecurityPage() {
  return (
    <PageRouteGate routeId="security_center.posture">
      <AdminVisualSystem>
        <PageShell width="full">
          <PageHeader
            eyebrow="Workspace security"
            title="Workspace security"
            subtitle={
              <SectionDescription text="Multi-factor posture, member factor lifecycle and security events for the workspace you are currently in. No secrets, authenticator seeds, recovery codes, session tokens or device fingerprints are surfaced here — every change is authorized, step-up gated and audited on the server." />
            }
          />

          <WorkspaceSecurityPostureSection />
          <div id="mfa-policy">
            <MfaPolicySection />
          </div>
          <MfaMemberPostureSection />
          <MfaEventsSection />
          <MfaDigestPreferencesSection />
          <MfaSelfCheckSection />
        </PageShell>
      </AdminVisualSystem>
    </PageRouteGate>
  );
}
