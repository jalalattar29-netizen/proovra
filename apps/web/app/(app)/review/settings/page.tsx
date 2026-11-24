"use client";

/**
 * Review hub — Review settings (TEAM-SPEC §3; stage D, T-079).
 *
 * One place for what governs reviews in this workspace, as sections:
 *
 *   policy     the reviewer SLA policy (deadlines, step-up rules, reviewer
 *              inactivity), moved here from the Enterprise-only
 *              `/governance/policy` page, which stays Enterprise and unchanged
 *   criteria   reviewer criteria (what reviewers and the Copilot check
 *              against) — `/settings/reviewer-criteria` forwards here
 *   schemas    coding schemas — `/review/schemas` redirects here
 *
 * A section is offered only where its own route opens for this actor (the
 * same resolver as the hub tabs). External Review stays an operational task in
 * the Inbox's Review tools, not a setting.
 *
 * Gate: `review.settings` — PERSONAL_OR_ORG + `reviewerOperationsIncluded`.
 * Every member who passes the gate reads the policy; the edit form is offered
 * only to a role holding `governance.policy.manage` (OWNER / ADMIN), the
 * permission `POST /v1/reviewer-ops/sla-policy` enforces with a step-up.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { roleHasPermission } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell } from "../../../../components/ui/PageShell";
import { ReviewPageHeader } from "../../../../components/reviewer-experience/ReviewPageHeader";
import { useActiveSpaceId, usePlatformContext } from "../../../../lib/platform-context";
import { actorRoleIn } from "../../../../lib/platform-context/actorRole";
import { ReviewHubNav } from "../../../../components/reviewer-experience/ReviewHubNav";
import { ReviewerSlaPolicyPanel } from "../../../../components/reviewer-experience/ReviewerSlaPolicyPanel";
import { useReviewDestinationResolver } from "../../../../components/reviewer-experience/reviewDestination";
import { ReviewerCriteriaPanel } from "../../settings/reviewer-criteria/_panel";
import { CodingSchemasSection } from "../schemas/_section";
import "../../../../components/reviewer-experience/review-surfaces.css";

const SECTIONS = ["policy", "criteria", "schemas"] as const;
type SettingsSection = (typeof SECTIONS)[number];
const SECTION_LABELS: Readonly<Record<SettingsSection, string>> = {
  policy: "Policy",
  criteria: "Reviewer criteria",
  schemas: "Coding schemas",
};
const SECTION_ROUTE: Readonly<Record<SettingsSection, string>> = {
  policy: "review.settings",
  criteria: "workspace.reviewer_criteria",
  schemas: "workspace.coding_schemas",
};

function sectionHref(s: SettingsSection): string {
  return s === "policy" ? "/review/settings" : `/review/settings?section=${s}`;
}

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
  const searchParams = useSearchParams();
  // actorRoleIn also reads the active space's own role label ("Owner" on the
  // caller's Personal Space) when the envelope carries no membership row.
  const role = teamId ? actorRoleIn(envelope, teamId) : null;
  const canEdit = role !== null && roleHasPermission(role, "governance.policy.manage");
  const offered = SECTIONS.filter((s) => resolve(SECTION_ROUTE[s], { label: SECTION_LABELS[s] })?.kind === "link");
  const requested = searchParams?.get("section") ?? null;
  const section: SettingsSection =
    requested && (offered as ReadonlyArray<string>).includes(requested) ? (requested as SettingsSection) : "policy";

  return (
    <PageShell
      className="review-launcher-clearance"
      data-review-settings-page
      data-review-settings-section={section}
      header={
        <ReviewPageHeader
          title="Review settings"
          subtitle="The policy, reviewer criteria and coding schemas that govern reviews in this workspace."
        />
      }
    >
      <ReviewHubNav active="settings" />
      {offered.length > 1 ? (
        <div className="review-segmented" role="group" aria-label="Review settings sections" data-review-settings-sections>
          {offered.map((s) => (
            <Link
              key={s}
              href={sectionHref(s)}
              className={s === section ? "review-segmented__item is-active" : "review-segmented__item"}
              aria-current={s === section ? "true" : undefined}
              data-review-settings-section-link={s}
              scroll={false}
            >
              {SECTION_LABELS[s]}
            </Link>
          ))}
        </div>
      ) : null}
      {section === "policy" ? (
        teamId ? (
          <ReviewerSlaPolicyPanel teamId={teamId} canEdit={canEdit} />
        ) : (
          <p className="app-field-help">Loading workspace…</p>
        )
      ) : section === "criteria" ? (
        <section className="app-panel" data-review-settings-criteria>
          <div className="app-panel__body">
            <ReviewerCriteriaPanel embedded />
          </div>
        </section>
      ) : (
        <CodingSchemasSection />
      )}
    </PageShell>
  );
}
