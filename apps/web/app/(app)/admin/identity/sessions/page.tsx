"use client";

/**
 * SESSIONS & DEVICES CONSOLE — orchestrator.
 *
 * PHASE 12B (2026-07-30): this page was an active-session table with two
 * buttons, one of which (revoke-all) could not actually succeed because the
 * server demands a step-up and the page had no step-up modal. It is now the
 * complete sessions/devices console, composed from `_sections/*`:
 *
 *   1. Active sessions       — inventory, revoke one, revoke every session for
 *                              a member, quarantine, release, bounded timeline
 *   2. Trusted devices       — inventory, trust THIS browser (self-only,
 *                              server-derived device value), remove trust
 *   3. Session policy impact — what the organization's concurrent-session
 *                              limit and timeouts mean for the live inventory
 *   4. Member risk           — the risk projection that decides when the
 *                              platform demands a step-up
 *
 * The workspace always comes from `lib/platform-context`; the operator can
 * never type a workspace or a member id. Every mutation is confirmed,
 * step-up gated on the server, and followed by a reload of the server
 * projection. Nothing on this page renders a session token, a session hash,
 * a device fingerprint or a raw network address.
 *
 * The page inherits the `platform.admin` gate from app/(app)/admin/layout.tsx;
 * the backend re-authorizes the workspace on every request, so a
 * cross-Organization id is a concealed 404 rather than a 403.
 */

import { PageShell, PageHeader } from "../../../../../components/ui/PageShell";

import { ActiveSessionsSection } from "./_sections/ActiveSessionsSection";
import { SessionPolicyImpactSection } from "./_sections/SessionPolicyImpactSection";
import { TrustedDevicesSection } from "./_sections/TrustedDevicesSection";
import { UserRiskSection } from "./_sections/UserRiskSection";

export default function SessionsPage() {
  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Identity operations"
          title="Sessions & devices"
          subtitle="Who is signed in, on what, for how long, and what the workspace policy does about it. Revocation takes effect on the session's next request. Device and network previews are shown; raw addresses, user-agent strings, session tokens and device fingerprints are never stored or displayed."
        />
      }
 >
      <ActiveSessionsSection />
      <TrustedDevicesSection />
      <SessionPolicyImpactSection />
      <UserRiskSection />
    </PageShell>
  );
}
