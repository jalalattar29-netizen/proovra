"use client";

/**
 * Review hub — Review settings (TEAM-SPEC §3, 2026-11-23).
 *
 * The reviewer SLA policy (deadlines, step-up rules, reviewer inactivity),
 * moved here from the Enterprise-only `/governance/policy` page, which stays
 * Enterprise and unchanged. Plus links to reviewer criteria and coding
 * schemas, each rendered only when it opens for this actor.
 *
 * Gate: `review.settings` — PERSONAL_OR_ORG + `reviewerOperationsIncluded`
 * (a Team-entitled Personal Workspace opens it). Every member who passes the
 * gate reads the policy; the edit form is offered only to a role holding
 * `governance.policy.manage` (OWNER / ADMIN), the permission
 * `POST /v1/reviewer-ops/sla-policy` enforces with a step-up.
 */

import { roleHasPermission } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { useActiveSpaceId, usePlatformContext } from "../../../../lib/platform-context";
import { actorRoleIn } from "../../../../lib/platform-context/actorRole";
import { ReviewHubNav } from "../../../../components/reviewer-experience/ReviewHubNav";
import { ReviewerSlaPolicyPanel } from "../../../../components/reviewer-experience/ReviewerSlaPolicyPanel";
import { ReviewDestinationLink } from "../../../../components/reviewer-experience/ReviewDestinationLink";
import { useReviewDestinationResolver } from "../../../../components/reviewer-experience/reviewDestination";

export default function ReviewSettingsPage() {
  return (
    <PageRouteGate routeId="review.settings">
      <ReviewSettingsInner />
    </PageRouteGate>
  );
}

function ReviewSettingsInner() {
  const teamId = useActiveSpaceId();
  const { envelope } = usePlatformContext();
  const resolve = useReviewDestinationResolver();
  // actorRoleIn also reads the active space's own role label ("Owner" on the
  // caller's Personal Space) when the envelope carries no membership row.
  const role = teamId ? actorRoleIn(envelope, teamId) : null;
  const canEdit = role !== null && roleHasPermission(role, "governance.policy.manage");
  const criteria = resolve("workspace.reviewer_criteria", { label: "Reviewer criteria" });
  const schemas = resolve("workspace.coding_schemas", { label: "Coding schemas" });

  return (
    <PageShell
      data-review-settings-page
      header={
        <PageHeader
          eyebrow="Review"
          title="Review settings"
          subtitle="Deadlines and safeguards for reviews in this workspace."
        />
      }
    >
      <ReviewHubNav active="settings" />
      {teamId ? (
        <ReviewerSlaPolicyPanel teamId={teamId} canEdit={canEdit} />
      ) : (
        <p className="app-field-help">Loading workspace…</p>
      )}
      {criteria || schemas ? (
        <PageSection
          title="Review content"
          description="What reviewers check against, and the fields they record."
        >
          <Card>
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              {criteria ? (
                <li>
                  <ReviewDestinationLink destination={criteria} testId="review-settings-criteria" />
                </li>
              ) : null}
              {schemas ? (
                <li>
                  <ReviewDestinationLink destination={schemas} testId="review-settings-schemas" />
                </li>
              ) : null}
            </ul>
          </Card>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
