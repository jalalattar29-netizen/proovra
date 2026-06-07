"use client";

/**
 * Phase 8 — Org admin / Trust tab.
 *
 * Surfaces canonical Trust Center deep-links. The /v1/trust/articles
 * and /v1/trust/subprocessors endpoints are workspace-scoped (require
 * an active workspace context); from a pure org-admin context we link
 * to the canonical surfaces rather than fabricate counts.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - No raw window.confirm (read-only).
 *   - No platform-context workspace-fragment reads.
 *   - Strong TypeScript types throughout.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";

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

  return (
    <section data-testid="org-admin-trust" data-org-id={orgId}>
      <section
        data-section="trust-summary"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Trust Center</h2>
        <p style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
          The Trust Center publishes versioned trust articles (security
          policy, methodology, AI disclosure, etc.) and the subprocessor
          registry. Article + subprocessor CRUD lives on the canonical
          workspace-scoped surface; drift detection runs against the
          published versions.
        </p>
      </section>

      <section
        data-section="trust-deep-links"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Canonical trust surfaces</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
          <DeepLink
            testId="trust-deep-link-center"
            label="Trust Center"
            description="Published trust articles (security, methodology, AI disclosure, …)."
            href="/trust"
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
        </ul>
      </section>
    </section>
  );
}

function DeepLink({
  testId,
  label,
  description,
  href,
}: {
  testId: string;
  label: string;
  description: string;
  href: string;
}) {
  return (
    <li
      style={{
        padding: "0.5rem 0",
        borderBottom: "1px solid rgba(127,127,127,0.18)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{description}</div>
      </div>
      <Link
        href={href}
        data-testid={testId}
        className="cases-filter-chip"
      >
        Open →
      </Link>
    </li>
  );
}
