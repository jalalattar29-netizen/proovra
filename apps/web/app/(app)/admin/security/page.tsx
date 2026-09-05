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

import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";

import { SectionDescription } from "./_sections/section-state";

import { MfaDigestPreferencesSection } from "./_sections/MfaDigestPreferencesSection";
import { MfaEventsSection } from "./_sections/MfaEventsSection";
import { MfaMemberPostureSection } from "./_sections/MfaMemberPostureSection";
import { MfaPolicySection } from "./_sections/MfaPolicySection";
import { MfaSelfCheckSection } from "./_sections/MfaSelfCheckSection";
import { WorkspaceSecurityPostureSection } from "./_sections/WorkspaceSecurityPostureSection";

/**
 * NO WORKSPACE READ AT THIS LEVEL ANY MORE.
 *
 * This orchestrator held `const teamId = useTeamId()` for one clause of its
 * note card — "none is selected yet" — and that clause went when the card
 * stopped restating the shell's amber scope banner. Every section below
 * resolves its own workspace and renders its own `NoWorkspaceSelected` with
 * its own reason, so the page itself has nothing left to know about it.
 */
export default function AdminSecurityPage() {
  return (
    <PageShell width="full">
      <PageHeader
        eyebrow="Workspace security"
        title="Workspace Security Center"
        subtitle={
          <SectionDescription text="Multi-factor posture, member factor lifecycle and security events for the workspace you are currently in. No secrets, authenticator seeds, recovery codes, session tokens or device fingerprints are surfaced here — every change is authorized, step-up gated and audited on the server." />
        }
      />

      {/*
        ADM-034 — this page used to carry the PLATFORM incident feed as its last
        section, so one surface served two audiences at two scopes: a workspace
        administrator configuring their own MFA policy, and a platform operator
        triaging every tenant's incidents. Those are different jobs and the mix
        made the page's scope ambiguous in both directions.

        The platform half now lives at /admin/operations, where it also gained
        tenant attribution and the ability to act. What remains here is what this
        page has always actually been: WORKSPACE security administration.
      */}
      {/*
        SAY THE ONE THING THE SHELL DOES NOT ALREADY SAY.
        This card used to open "Every section on this page acts on the workspace
        you are currently in", which is what `AdminTenantScopeNotice` states in
        an amber banner 100px above it — two full-width boxes, stacked, with the
        same content, on a page whose whole problem was scope ambiguity. And
        "none is selected yet" was a third statement of it: every section below
        already renders `NoWorkspaceSelected` with its own reason.

        What is left is the only fact neither of those carries — where the
        platform half of this page went, which a reader who remembers the old
        incident feed here specifically needs.
      */}
      <Card padding="compact" style={{ marginBottom: 4 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-muted)" }}>
          Looking for platform-wide security events or operational incidents?
          They live in <a href="/admin/operations">Operations</a>.
        </p>
      </Card>

      <WorkspaceSecurityPostureSection />
      <MfaPolicySection />
      <MfaMemberPostureSection />
      <MfaEventsSection />
      <MfaDigestPreferencesSection />
      <MfaSelfCheckSection />
    </PageShell>
  );
}
