"use client";

/**
 * Phase 8 — Org admin / Access reviews tab.
 *
 * Honest summary + deep-link card. Access review campaign CRUD lives on
 * the workspace-scoped Governance Platform surface (Phase 4A), where
 * mutation enforces a delegated-tier check + REVOKED outcomes actually
 * revoke grants. From an org-admin context (no required active
 * workspace) we link out rather than fabricate campaign aggregates.
 *
 * Constitutional checks satisfied:
 *
 *   - Wrapped in <PageRouteGate routeId="account.organization-detail">.
 *   - Governance remains a feature area, not a workspace.
 *   - No raw window.confirm (page is read-only).
 *   - No platform-context workspace-fragment reads.
 *   - Strong TypeScript types throughout.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";

export default function OrganizationAdminAccessReviewsPage() {
  return (
    <PageRouteGate routeId="account.organization-detail">
      <AccessReviewsTab />
    </PageRouteGate>
  );
}

function AccessReviewsTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";

  return (
    <section data-testid="org-admin-access-reviews" data-org-id={orgId}>
      <section
        data-section="access-reviews-summary"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Access reviews</h2>
        <p style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>
          Periodic access-review campaigns evaluate every grant for an
          organization's workspaces. REVOKED decisions execute against the
          underlying grant in the same transaction — campaigns are not
          paper exercises.
        </p>
        <p
          data-state="not-configured-explainer"
          style={{
            fontSize: 12,
            opacity: 0.7,
            marginTop: 8,
            padding: "0.5rem 0.6rem",
            borderLeft: "3px solid rgba(127,127,127,0.45)",
            background: "rgba(127,127,127,0.06)",
          }}
        >
          No campaign is required by default. If your org needs one, run
          it from the canonical surface so audit + revocation execute
          atomically.
        </p>
      </section>

      <section
        data-section="access-reviews-deep-links"
        style={{
          padding: "1rem 1.1rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Canonical access review surfaces</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
          <DeepLink
            testId="ar-deep-link-list"
            label="Access reviews"
            description="List, run, and decide pending access-review campaigns."
            href="/governance-platform/access-reviews"
          />
          <DeepLink
            testId="ar-deep-link-platform"
            label="Governance Platform"
            description="Cross-workspace governance dashboard (drift, policy hits, posture)."
            href="/governance-platform"
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
