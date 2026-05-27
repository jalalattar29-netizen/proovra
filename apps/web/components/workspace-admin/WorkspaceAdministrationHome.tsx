"use client";

/**
 * ENTERPRISE TENANT MODEL — /teams page redefinition.
 *
 * Renders the canonical Workspace Administration index:
 *
 *   1. Personal Space card (always present; never labeled TEAM)
 *   2. Organizations list (excludes isPersonal=true)
 *   3. Create / Join organization CTA
 *   4. Invitations (placeholder — wired in a follow-up phase)
 *   5. Legacy duplicate-personal-row diagnostic (admin guidance only)
 *
 * Personal users land here and see meaningful content — they are never
 * blocked by a "no team" gate. When an organization is the active space,
 * the legacy `WorkspaceAdminPanel` is also rendered below so existing
 * operator features (members, governance, billing, integrations) remain
 * available.
 *
 * Hard rules:
 *   - Personal Space is NOT under Organizations.
 *   - duplicatePersonalCandidates are surfaced read-only with remediation
 *     guidance — never auto-deleted.
 *   - The page makes no role derivations locally.
 */

import Link from "next/link";

import {
  useAccount,
  useActiveSpace,
  useDuplicatePersonalCandidates,
  useOrganizations,
  usePersonalSpace,
  usePersonaProfile,
  workflowFromPersona,
} from "../../lib/platform-context";
import { WorkspaceAdminPanel } from "./WorkspaceAdminPanel";
import { ContextualHelp } from "../contextual-help/ContextualHelp";

export function WorkspaceAdministrationHome() {
  const account = useAccount();
  const personalSpace = usePersonalSpace();
  const organizations = useOrganizations();
  const activeSpace = useActiveSpace();
  const duplicates = useDuplicatePersonalCandidates();
  // Phase 38.18 — workflow-aware contextual help.
  const teamsPersona = usePersonaProfile();
  const teamsWorkflowCode = workflowFromPersona(
    teamsPersona.primaryProfile,
  ).code;

  return (
    <main className="cc-page" data-workspace-administration-home>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace Administration</div>
          <h1 className="cc-title">Spaces</h1>
          <p className="cc-subtitle">
            Your Personal Space is private to you. Organizations are
            collaborative tenants — members, roles, governance, and billing
            live there. For org-level governance (members, invites,
            audit timeline), open{" "}
            <Link
              href="/organizations"
              data-action="cross-link-organizations"
              data-workspace-admin-cross-link="organizations"
            >
              Organizations
            </Link>
            .
          </p>
        </div>
      </header>

      {/* Phase 38.18 — workflow-aware contextual help, collapsed by
          default so the spaces list stays primary. */}
      <ContextualHelp
        workflow={teamsWorkflowCode}
        surface="teams"
        collapsedByDefault
      />

      {/* ============================ PERSONAL ============================ */}
      <section
        className="cc-section"
        data-workspace-admin-section="personal-space"
      >
        <header className="cc-section-header">
          <h2 className="cc-section-title">Personal Space</h2>
        </header>
        <div
          className="cases-row"
          data-personal-space-card
          data-personal-space-status={personalSpace?.status ?? "loading"}
        >
          <div className="cases-row-main">
            <span className="cases-row-title">Personal Space</span>
            <span className="cases-row-scope">
              {account?.displayName ?? account?.email ?? "Your account"}
            </span>
          </div>
          <div className="cases-row-meta">
            <span data-personal-space-plan={personalSpace?.plan ?? "FREE"}>
              Plan: {personalSpace?.plan ?? account?.accountPlan ?? "FREE"}
            </span>
            <Link
              href="/billing"
              data-personal-space-billing
              className="cc-quick-action"
            >
              Manage billing
            </Link>
            <Link
              href="/evidence"
              data-personal-space-open
              className="cc-quick-action"
            >
              Open Personal Space
            </Link>
          </div>
        </div>
      </section>

      {/* ========================== ORGANIZATIONS ========================== */}
      <section
        className="cc-section"
        data-workspace-admin-section="organizations"
      >
        <header className="cc-section-header">
          <h2 className="cc-section-title">
            Organizations · {organizations.length}
          </h2>
        </header>
        {organizations.length === 0 ? (
          <div className="cases-empty" data-organizations-empty>
            <strong>You're not in any organizations yet.</strong>
            <p>
              Create an organization for collaborative investigations — members,
              roles, governance, reviewer ops, and team billing.
            </p>
            <Link
              href="/teams?action=create"
              className="cc-quick-action"
              data-workspace-action="create_organization"
            >
              Create organization
            </Link>
          </div>
        ) : (
          <ul className="cases-list" data-organizations-list>
            {organizations.map((org) => {
              const isActive =
                activeSpace?.type === "ORGANIZATION" &&
                activeSpace.id === org.id;
              return (
                <li
                  key={org.id}
                  className="cases-row"
                  data-organization-id={org.id}
                  data-organization-active={isActive ? "true" : "false"}
                >
                  <div className="cases-row-main">
                    <span className="cases-row-title">
                      {org.displayName ?? org.name ?? "Organization"}
                    </span>
                    <span className="cases-row-scope">
                      {org.memberCount}{" "}
                      {org.memberCount === 1 ? "member" : "members"}
                    </span>
                  </div>
                  <div className="cases-row-meta">
                    {org.role ? (
                      <span data-organization-role={org.role}>
                        Role: {org.role}
                      </span>
                    ) : null}
                    <span data-organization-plan={org.plan ?? "FREE"}>
                      Plan: {org.plan ?? "FREE"}
                    </span>
                    {isActive ? (
                      <span data-organization-active-chip>Active</span>
                    ) : null}
                    {/* Phase A.1B — direct deep-link into the
                        canonical org governance surface. Closes the
                        cross-surface continuity gap between
                        admin.teams (workspace admin) and
                        account.organizations (governance hub). */}
                    <Link
                      href={`/organizations/${org.id}`}
                      data-action="open-org-governance"
                      data-organization-governance-link={org.id}
                      className="cc-quick-action"
                    >
                      Manage governance
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ============================ ACTIONS ============================= */}
      <section
        className="cc-section"
        data-workspace-admin-section="actions"
      >
        <header className="cc-section-header">
          <h2 className="cc-section-title">Actions</h2>
        </header>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link
            href="/teams?action=create"
            className="cc-quick-action"
            data-workspace-action="create_organization"
          >
            Create organization
          </Link>
          <Link
            href="/teams?action=join"
            className="cc-quick-action"
            data-workspace-action="join_organization"
          >
            Join an organization
          </Link>
          {/* Phase A.1B — cross-link to the canonical org governance
              hub. The two surfaces are intentionally distinct: this
              page is workspace administration, /organizations is
              org-level governance (members / invites / audit). */}
          <Link
            href="/organizations"
            className="cc-quick-action"
            data-workspace-action="view_all_organizations"
          >
            View all organizations
          </Link>
          <Link
            href="/billing"
            className="cc-quick-action"
            data-workspace-action="account_billing"
          >
            Account billing
          </Link>
        </div>
      </section>

      {/* ===================== DUPLICATE PERSONAL DIAG ==================== */}
      {duplicates.length > 0 ? (
        <section
          className="cc-section"
          data-workspace-admin-section="duplicate-personal"
        >
          <header className="cc-section-header">
            <h2 className="cc-section-title">
              Legacy workspace diagnostics · {duplicates.length}
            </h2>
          </header>
          <p style={{ fontSize: 13, color: "#475569" }}>
            We detected {duplicates.length} workspace
            {duplicates.length === 1 ? "" : "s"} that look like an older
            personal workspace created before the Personal Space model existed.
            These rows are NOT removed automatically. Please review them — if
            you no longer need a row, archive it from its team detail page.
          </p>
          <ul className="cases-list">
            {duplicates.map((d) => (
              <li
                key={d.teamId}
                className="cases-row"
                data-duplicate-personal-id={d.teamId}
              >
                <div className="cases-row-main">
                  <span className="cases-row-title">
                    {d.name ?? "Legacy workspace"}
                  </span>
                  <span className="cases-row-scope">
                    {d.memberCount}{" "}
                    {d.memberCount === 1 ? "member" : "members"}
                  </span>
                </div>
                <div className="cases-row-meta">
                  {d.reasons.map((r) => (
                    <span
                      key={r}
                      data-duplicate-personal-reason={r}
                      style={{
                        fontSize: 11,
                        padding: "2px 6px",
                        border: "1px solid #cbd5e1",
                        borderRadius: 999,
                      }}
                    >
                      {r}
                    </span>
                  ))}
                  <Link
                    href={`/teams/${d.teamId}`}
                    data-duplicate-personal-open
                  >
                    Review
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ============== EXISTING ORG ADMIN PANEL (TEAM ONLY) ============== */}
      {activeSpace?.type === "ORGANIZATION" ? (
        <section
          className="cc-section"
          data-workspace-admin-section="active-organization-admin"
        >
          <WorkspaceAdminPanel />
        </section>
      ) : null}
    </main>
  );
}
