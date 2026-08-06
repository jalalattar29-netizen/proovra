"use client";

/**
 * Phase 8 — Org admin / Trust tab.
 *
 * PHASE 12 VERTICAL C — this tab is now the TRUST ADMINISTRATION CONSOLE, not
 * just a set of deep links. It is the one authenticated surface where an
 * operator can see whether what the platform PUBLISHES about itself is still
 * true, re-check security claims, publish status incidents and maintenance,
 * and inspect exactly what a verification package would contain.
 *
 * Every operation below is workspace-scoped on the SERVER: the API resolves
 * the workspace from the persisted active-workspace rail and applies the
 * canonical `authorizeOrFail` capability check, so nothing here declares a
 * tenant. Publishing actions additionally require a fresh, target-bound
 * step-up which the sections carry through `useStepUpAction`.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm — destructive/publishing actions use
 *     `useConfirmAction`.
 *   - No platform-context workspace-fragment reads.
 *   - Strong TypeScript types throughout.
 *
 * Phase 7 (Enterprise UX): presentation migrated to the shared design
 * system (PageSection + Card + Button). This tab renders INSIDE the org
 * admin layout shell (which already owns the org title + tab bar), so it
 * uses PageSection — not a second PageHeader — to avoid a duplicate title.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { PageSection } from "../../../../../../components/ui/PageShell";
import { Card } from "../../../../../../components/ui/Card";
import { Button } from "../../../../../../components/ui/Button";
import { useActiveWorkspaceId } from "../../../../../../lib/platform-context";
import { TrustContentIntegritySection } from "./_sections/TrustContentIntegritySection";
import { SecurityClaimsSection } from "./_sections/SecurityClaimsSection";
import { StatusPublicationSection } from "./_sections/StatusPublicationSection";
import { VerificationReferencesSection } from "./_sections/VerificationReferencesSection";

export default function OrganizationAdminTrustPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <TrustTab />
    </PageRouteGate>
  );
}

function TrustTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";
  // Used ONLY to bind a step-up challenge to the right tenant. It never
  // selects which workspace the API reads or writes — the server resolves
  // that itself from the persisted active-workspace rail.
  const activeWorkspaceId = useActiveWorkspaceId();

  return (
    <section
      data-testid="org-admin-trust"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <Card
        variant="admin"
        data-section="trust-summary"
        title="Trust Center"
      >
        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            lineHeight: 1.6,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          The Trust Center publishes versioned trust articles (security
          policy, methodology, AI disclosure, etc.) and the subprocessor
          registry. Everything below acts on the workspace you are currently
          in — the server resolves it, so switching workspaces changes what
          you are administering.
        </p>
      </Card>

      <TrustContentIntegritySection teamId={activeWorkspaceId} />

      <SecurityClaimsSection />

      <StatusPublicationSection teamId={activeWorkspaceId} />

      <VerificationReferencesSection />

      <PageSection
        title="Canonical trust surfaces"
        description="Published trust content lives on the canonical workspace-scoped pages. Open them below."
      >
        <div
          data-section="trust-deep-links"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <DeepLink
            testId="trust-deep-link-center"
            label="Open public Trust Center"
            description="Published trust articles (security, methodology, AI disclosure, …). Opens the public site in a new tab — this app stays open."
            href="/trust"
            external
          />
          <DeepLink
            testId="trust-deep-link-subprocessors"
            label="Subprocessors"
            description="Subprocessor registry + version history."
            href="/trust-center/subprocessors"
          />
          <DeepLink
            testId="trust-deep-link-status"
            label="Status page"
            description="Live + historical status of the platform's internal + external dependencies."
            href="/trust-center/status"
          />
        </div>
      </PageSection>
    </section>
  );
}

function DeepLink({
  testId,
  label,
  description,
  href,
  external = false,
}: {
  testId: string;
  label: string;
  description: string;
  href: string;
  /**
   * When true the destination is the PUBLIC site (outside the
   * authenticated App Shell). It opens in a new tab so the app stays
   * open in the current tab, and the CTA carries an external-link cue.
   * Internal (`/trust-center/*`) deep links stay in the same tab.
   */
  external?: boolean;
}) {
  return (
    <Card
      variant="summary"
      padding="compact"
      style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--ink-secondary, #475569)",
            marginTop: 2,
          }}
        >
          {description}
        </div>
      </div>
      {external ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={testId}
          aria-label={`${label} (opens in a new tab)`}
          style={{ textDecoration: "none", flexShrink: 0 }}
        >
          <Button variant="secondary" size="sm">
            Open <span aria-hidden="true">↗</span>
          </Button>
        </a>
      ) : (
        <Link href={href} data-testid={testId} style={{ textDecoration: "none", flexShrink: 0 }}>
          <Button variant="secondary" size="sm">
            Open →
          </Button>
        </Link>
      )}
    </Card>
  );
}
