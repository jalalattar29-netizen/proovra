"use client";

/**
 * SECURITY CENTER — orchestrator.
 *
 * PHASE 12B (2026-07-30): this page was a read-only platform incident feed.
 * It is now the COMPLETE Security Center, composed from `_sections/*`:
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
 *   7. Platform incident feed      — the pre-existing platform-wide surface
 *
 * TWO SCOPES, LABELLED AS SUCH. Sections 1–6 act on the WORKSPACE you are
 * currently in (or, for the digest and self-check, on your own account);
 * section 7 is platform-wide. The page never lets an operator type a teamId
 * or a userId: the workspace comes from `lib/platform-context` and members
 * come from the server-projected roster.
 *
 * The page inherits the `platform.admin` gate from app/(app)/admin/layout.tsx.
 * Backend authorization is the real boundary: every workspace-scoped route
 * below re-authorizes the workspace through `authorizeOrFail` with
 * anti-enumeration, so a cross-Organization id is a concealed 404.
 */

import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import AdminConsoleNav from "../../../../components/admin/AdminConsoleNav";
import { useTeamId } from "../../../../lib/platform-context";

import { MfaDigestPreferencesSection } from "./_sections/MfaDigestPreferencesSection";
import { MfaEventsSection } from "./_sections/MfaEventsSection";
import { MfaMemberPostureSection } from "./_sections/MfaMemberPostureSection";
import { MfaPolicySection } from "./_sections/MfaPolicySection";
import { MfaSelfCheckSection } from "./_sections/MfaSelfCheckSection";
import { PlatformIncidentFeedSection } from "./_sections/PlatformIncidentFeedSection";
import { WorkspaceSecurityPostureSection } from "./_sections/WorkspaceSecurityPostureSection";

export default function AdminSecurityPage() {
  const teamId = useTeamId();

  return (
    <PageShell width="full">
      <PageHeader
        eyebrow="Security operations"
        title="Security Center"
        subtitle="Multi-factor posture, member factor lifecycle, security events and platform incidents in one place. No secrets, authenticator seeds, recovery codes, session tokens or device fingerprints are surfaced anywhere on this page — every number is read live from the backend and every change is authorized, step-up gated and audited on the server."
      />

      <AdminConsoleNav />

      <Card padding="compact" style={{ marginBottom: 4 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-muted, #64748b)" }}>
          The sections below act on the workspace you are currently in
          {teamId ? "" : " — none is selected yet"}. The platform incident feed
          at the bottom is platform-wide and read-only.
        </p>
      </Card>

      <WorkspaceSecurityPostureSection />
      <MfaPolicySection />
      <MfaMemberPostureSection />
      <MfaEventsSection />
      <MfaDigestPreferencesSection />
      <MfaSelfCheckSection />

      <PageSection
        title="Platform-wide"
        description="Everything below is aggregated across every workspace on the platform and is read-only."
      />
      <PlatformIncidentFeedSection />
    </PageShell>
  );
}
