"use client";

/**
 * ENTERPRISE TENANT MODEL — /teams page redefinition.
 *
 * Renders the canonical Workspace Administration index:
 *
 *   1. Personal Space card (always present; never labeled TEAM)
 *   2. Organizations list (excludes isPersonal=true)
 *   3. Create workspace (POST /v1/teams) / Join organization CTA
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

import { planLabel, orgRoleLabel } from "../../lib/labels/adminPlatformLabels";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import {
  useAccount,
  useActiveSpace,
  useDuplicatePersonalCandidates,
  useOrganizations,
  usePersonalSpace,
  usePlatformContext,
} from "../../lib/platform-context";
import { describeActiveWorkspace } from "../../lib/platform-context/workspaceLabel";
import { WorkspaceAdminPanel } from "./WorkspaceAdminPanel";
import { ContextualHelp } from "../contextual-help/ContextualHelp";

export function WorkspaceAdministrationHome() {
  const account = useAccount();
  const personalSpace = usePersonalSpace();
  const organizations = useOrganizations();
  // PRO-T1C-05 (WS-ENT) — envelope.organizations holds WORKSPACE ids (ARCH-003);
  // the organization id lives in contextOptions.organizations. An OWNED
  // workspace has only a SYSTEM organization and no governance surface.
  const { envelope, switchWorkspace } = usePlatformContext();
  const router = useRouter();
  const organizationIdByWorkspace = new Map<string, string>();
  for (const org of envelope?.contextOptions?.organizations ?? []) {
    for (const w of org.workspaces ?? []) organizationIdByWorkspace.set(w.workspaceId, org.organizationId);
  }
  const activeSpace = useActiveSpace();
  const duplicates = useDuplicatePersonalCandidates();

  // TEAM MEMBERSHIP (2026-11-23) — every workspace the server lists for the
  // caller is reachable from here. Team collaboration happens inside the
  // OWNER's Personal Workspace, so an invited member's workspace arrives in
  // `sharedWorkspaces`; legacy OWNED workspaces arrive in `ownedWorkspaces`.
  // The page groups and renders them; it never invents a choice.
  const sharedWorkspaces = envelope?.contextOptions?.sharedWorkspaces ?? [];
  const ownedWorkspaces = envelope?.contextOptions?.ownedWorkspaces ?? [];
  const activeWorkspaceId =
    envelope?.contextOptions?.activeContext?.workspaceId ?? activeSpace?.id ?? null;
  const personalIsActive =
    activeSpace?.type === "PERSONAL" && activeSpace.shared !== true;
  // T-115 — the own workspace on a collaboration plan with members is named
  // as a Team workspace (one label rule), not "Personal Space".
  const activeDescription = describeActiveWorkspace(envelope);
  const personalTitle =
    personalIsActive && activeDescription.kind === "TEAM_OWNER"
      ? (activeDescription.name ?? activeDescription.kindLabel)
      : "Personal Space";

  // SWITCH, THEN OPEN. A plain link would open whatever workspace is active
  // (an invitee who last worked in a shared workspace landed there from
  // "Open Personal Space"). The switch goes through the canonical
  // `switchWorkspace` — `null` is the caller's own Personal Space — and the
  // page navigates only once the server has accepted it.
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const openInFlight = useRef(false);
  const openWorkspace = useCallback(
    (key: string, workspaceId: string | null, alreadyActive: boolean, destination: string) => {
      if (openInFlight.current) return;
      setOpenError(null);
      if (alreadyActive) {
        router.push(destination);
        return;
      }
      openInFlight.current = true;
      setOpening(key);
      void (async () => {
        let switched: boolean | void = false;
        try {
          switched = await switchWorkspace(workspaceId);
        } catch {
          switched = false;
        }
        openInFlight.current = false;
        setOpening(null);
        if (switched === false) {
          setOpenError(
            "We couldn't open that workspace. Your access may have changed — refresh and try again.",
          );
          return;
        }
        router.push(destination);
      })();
    },
    [router, switchWorkspace],
  );

  return (
    <div className="cc-page" data-workspace-administration-home>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace Administration</div>
          <h1 className="cc-title">Spaces</h1>
          <p className="cc-subtitle">
            Your Personal Space is your own workspace — your plan applies to
            it, and the people you invite join it. When someone invites you
            into their Personal Workspace, it appears under Shared with you.
            Manage who can access your workspace in{" "}
            <Link
              href="/people"
              data-action="cross-link-members-access"
              data-workspace-admin-cross-link="people"
            >
              Members &amp; Access
            </Link>
            . Organizations come with an Enterprise agreement; their
            governance lives in{" "}
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

      {/* Contextual help, collapsed by default so the spaces list
          stays primary. */}
      <ContextualHelp surface="teams" collapsedByDefault />

      {openError ? (
        <p role="alert" className="cases-empty" data-workspace-open-error>
          {openError}
        </p>
      ) : null}

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
            <span className="cases-row-title" data-personal-space-title>
              {personalTitle}
            </span>
            <span className="cases-row-scope">
              {account?.displayName ?? account?.email ?? "Your account"}
            </span>
          </div>
          <div className="cases-row-meta">
            {/*
              PHASE 12 — POINT 7. The Personal Space's OWN plan, or nothing.
              This read `personalSpace?.plan ?? account?.accountPlan ?? "FREE"`:
              an owner-plan fallback followed by a fabricated FREE, so an
              envelope that had resolved no plan displayed a confident "Plan:
              FREE" for a workspace whose plan was simply unknown.
            */}
            {personalSpace?.plan ? (
              <span data-personal-space-plan={personalSpace.plan}>
                Plan: {planLabel(personalSpace.plan)}
              </span>
            ) : null}
            {personalIsActive ? (
              <span data-personal-space-active-chip>Active</span>
            ) : null}
            <Link
              href="/billing"
              data-personal-space-billing
              className="cc-quick-action"
            >
              Manage billing
            </Link>
            <button
              type="button"
              data-personal-space-open
              className="cc-quick-action"
              disabled={opening !== null}
              aria-busy={opening === "personal"}
              onClick={() =>
                openWorkspace("personal", null, personalIsActive, "/evidence")
              }
            >
              {opening === "personal" ? "Opening…" : "Open Personal Space"}
            </button>
          </div>
        </div>
      </section>

      {/* ========================= SHARED WITH YOU ========================= */}
      {sharedWorkspaces.length > 0 ? (
        <section
          className="cc-section"
          data-workspace-admin-section="shared-workspaces"
        >
          <header className="cc-section-header">
            <h2 className="cc-section-title">
              Shared with you · {sharedWorkspaces.length}
            </h2>
          </header>
          <ul className="cases-list" data-shared-workspaces-list>
            {sharedWorkspaces.map((w) => {
              const isActive = !personalIsActive && activeWorkspaceId === w.workspaceId;
              const key = `shared:${w.workspaceId}`;
              return (
                <li
                  key={w.workspaceId}
                  className="cases-row"
                  data-shared-workspace-id={w.workspaceId}
                  data-shared-workspace-active={isActive ? "true" : "false"}
                >
                  <div className="cases-row-main">
                    <span className="cases-row-title">{w.name}</span>
                    <span className="cases-row-scope">
                      A Personal Workspace you were invited into
                    </span>
                  </div>
                  <div className="cases-row-meta">
                    {w.role ? (
                      <span data-shared-workspace-role={w.role}>
                        Your role: {orgRoleLabel(w.role)}
                      </span>
                    ) : null}
                    {isActive ? <span data-shared-workspace-active-chip>Active</span> : null}
                    <button
                      type="button"
                      className="cc-quick-action"
                      data-shared-workspace-open={w.workspaceId}
                      disabled={opening !== null}
                      aria-busy={opening === key}
                      aria-label={`Open ${w.name}`}
                      onClick={() => openWorkspace(key, w.workspaceId, isActive, "/home")}
                    >
                      {opening === key ? "Opening…" : "Open"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* ========================= YOUR WORKSPACES ========================= */}
      {ownedWorkspaces.length > 0 ? (
        <section
          className="cc-section"
          data-workspace-admin-section="owned-workspaces"
        >
          <header className="cc-section-header">
            <h2 className="cc-section-title">
              Your workspaces · {ownedWorkspaces.length}
            </h2>
          </header>
          <ul className="cases-list" data-owned-workspaces-list>
            {ownedWorkspaces.map((w) => {
              const isActive = !personalIsActive && activeWorkspaceId === w.workspaceId;
              const key = `owned:${w.workspaceId}`;
              const label = w.name ?? "Workspace";
              return (
                <li
                  key={w.workspaceId}
                  className="cases-row"
                  data-owned-workspace-id={w.workspaceId}
                  data-owned-workspace-active={isActive ? "true" : "false"}
                >
                  <div className="cases-row-main">
                    <span className="cases-row-title">{label}</span>
                  </div>
                  <div className="cases-row-meta">
                    {w.role ? (
                      <span data-owned-workspace-role={w.role}>
                        Your role: {orgRoleLabel(w.role)}
                      </span>
                    ) : null}
                    {isActive ? <span data-owned-workspace-active-chip>Active</span> : null}
                    <button
                      type="button"
                      className="cc-quick-action"
                      data-owned-workspace-open={w.workspaceId}
                      disabled={opening !== null}
                      aria-busy={opening === key}
                      aria-label={`Open ${label}`}
                      onClick={() => openWorkspace(key, w.workspaceId, isActive, "/home")}
                    >
                      {opening === key ? "Opening…" : "Open"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

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
          /*
           * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the create
           * control and its copy were REMOVED together.
           *
           * The copy said members, roles, governance, reviewer ops "and
           * billing" live in a workspace you should go and create. That is the
           * obsolete model stated to the user: billing lives with the PERSON,
           * collaboration is a tier of the workspace they already have, and an
           * Organization is contracted rather than created here.
           *
           * The control had already stopped working — self-service workspace
           * creation is refused, because a workspace created that way could
           * never be paid for — so leaving it would have been a button that
           * always failed, above copy that explained the wrong product.
           */
          <div className="cases-empty" data-organizations-empty>
            <strong>You're not in any organizations.</strong>
            <p>
              An organization is set up with our team as part of an Enterprise
              agreement. Collaborating doesn't need one: the people you work
              with are invited into the owner's Personal Workspace. Everything else —
              your evidence, your collaboration teams and your plan — lives in
              your Personal Workspace, and a workspace you were invited into
              appears under Shared with you.
            </p>
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
                        Role: {orgRoleLabel(org.role)}
                      </span>
                    ) : null}
                    {/* The server-resolved plan, or nothing — never a
                        fabricated FREE for a plan the envelope didn't project. */}
                    {org.plan ? (
                      <span data-organization-plan={org.plan}>
                        Plan: {planLabel(org.plan)}
                      </span>
                    ) : null}
                    {isActive ? (
                      <span data-organization-active-chip>Active</span>
                    ) : null}
                    {/* Phase A.1B — direct deep-link into the
                        canonical org governance surface. Closes the
                        cross-surface continuity gap between
                        admin.teams (workspace admin) and
                        account.organizations (governance hub). */}
                    {organizationIdByWorkspace.get(org.id) ? (
                      <Link
                        href={`/organizations/${organizationIdByWorkspace.get(org.id)}`}
                        data-action="open-org-governance"
                        data-organization-governance-link={organizationIdByWorkspace.get(org.id)}
                        className="cc-quick-action"
                      >
                        Manage governance
                      </Link>
                    ) : null}
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
        {/* BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the create
            control was removed with the capability. What remains here are the
            actions that still exist. */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {/*
            "Join an organization" DELETED — it did nothing.

            It linked `/teams?action=join`. `/teams` 308s to
            `/collaboration-teams`, and `action=join` has ZERO consumers
            anywhere in the web app: the landing page that once read it was
            removed in Phase 2B. So the control dropped the operator on the
            Collaboration Teams list with a query nothing reads, having
            promised to enrol them somewhere.

            There is no self-serve join. Someone joins an organization by
            accepting an invitation (`/org-invites/[token]/accept`), which an
            organization admin issues. "View all organizations" below is the
            real destination for everything else, so nothing is lost by
            removing a button that only looked like a third option.

            Same rule the Hub reduction applied: a button that silently does
            nothing is worse in an evidence product than a missing one.
          */}
          {/* Phase A.1B — cross-link to the canonical org governance
              hub. The two surfaces are intentionally distinct: this
              page is workspace administration, /organizations is
              org-level governance (members / invites / audit). */}
          <Link
            href="/people"
            className="cc-quick-action"
            data-workspace-action="members_access"
          >
            Members &amp; Access
          </Link>
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
    </div>
  );
}
