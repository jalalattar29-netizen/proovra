"use client";

/**
 * Delegated administration — retired tier console.
 *
 * ONE delegated-administration authority (owner decision 2026-10-25): the
 * tiered "delegated admin grants" this page used to list and issue are
 * retired, and `GET|POST /v1/governance/delegated-admin` (and `/:id/revoke`)
 * now answer 410 DELEGATED_ADMIN_TIERS_RETIRED. Delegated administration is a
 * member delegated SCOPE folded into the permission engine, granted,
 * updated and revoked per member in Security Center.
 *
 * Retirement was forward-only: every LIVE tier grant was carried as member
 * capability grants on the same member and still admits them (re-audit N-3 —
 * this page must never claim a former grantee holds nothing).
 *
 * The URL stays so an old bookmark lands on an explanation instead of a 404.
 * This page makes NO request to the retired endpoints.
 */

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";

export default function DelegatedAdminPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <PageShell
        data-delegated-admin-page
        data-delegated-admin-retired
        header={
          <PageHeader
            eyebrow="Governance"
            title="Delegated administration"
            subtitle="Delegated administration is now managed per member in Security Center."
            contextStrip={
              <a href="/governance-platform" style={{ fontSize: 12 }}>
                ← Back to Governance Platform
              </a>
            }
          />
        }
      >
        <Card variant="admin" padding="comfortable">
          <p style={{ marginTop: 0 }}>
            A workspace owner or admin gives a member extra administrative
            access by granting a delegated scope — for example governance,
            identity, review or retention administration — on that member in
            Security Center. Each scope adds a fixed set of permissions on top
            of the member&apos;s role, can carry an expiry and a reason, and
            can be updated or revoked at any time. Every governance action
            checks those permissions on the server.
          </p>
          <p data-delegated-admin-officer-copy>
            Officer authorities — executing or approving evidence destruction,
            authoring governance policies, running access-review campaigns,
            publishing trust and status notices, deciding evidence exchange —
            are not part of the admin role or of any scope. They are granted
            to a named member as individual permissions in Security Center,
            and only by someone who holds them.
          </p>
          <p data-delegated-admin-carried-copy>
            The earlier tiered grants were carried forward: each one that was
            live when this changed became individual permissions on the same
            member, with the same grantor and expiry, and those permissions
            still give that member access today. Review, extend or revoke them
            per member in Security Center. Past tier grants and revocations
            remain in the audit history.
          </p>
          <a
            href="/security-center/identity"
            data-delegated-admin-security-center-link
            style={{ fontWeight: 600 }}
          >
            Manage delegated administration in Security Center →
          </a>
        </Card>
      </PageShell>
    </PageRouteGate>
  );
}
