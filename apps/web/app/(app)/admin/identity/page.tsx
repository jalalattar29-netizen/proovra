"use client";

/**
 * PHASE 12B — Organization identity administration console.
 *
 * `/admin/identity` was a navigation hub. It is now the WORKING console for
 * enterprise identity administration, with the navigation preserved at the
 * bottom as a directory of the specialist surfaces (SAML, SCIM, sessions,
 * runtime, audit) that keep their own pages.
 *
 * This file is the ORCHESTRATOR only: it owns the workspace scope banner, the
 * single step-up host, and the section order. Every operation lives in
 * `_sections/*`:
 *
 *   MembersSection            members, roles, capabilities, delegated admin
 *   ServiceAccountsSection    machine identities (restricted)
 *   ExternalMappingsSection   SSO/SCIM subject links
 *   SessionGovernanceSection  contributor revoke + operator reconciles
 *
 * Cross-cutting guarantees (implemented in the sections, stated here so the
 * console's contract is readable in one place):
 *
 *   * The workspace/Organization is SERVER-derived. No field on this page lets
 *     an operator name a workspace or organization id; the API resolves it from
 *     the active workspace and echoes it back for display only.
 *   * Nothing is computed client-side: role precedence, effective permissions,
 *     plan gating and denial reasons all come from the server projection.
 *   * ONE step-up host for the whole console. Every sensitive mutation opens
 *     the challenge modal on the structured 401 and retries the ORIGINAL
 *     request once with the verified challenge id.
 *   * Loading, empty, DENIAL and error states are distinct in every section: a
 *     403/404 renders as an explicit refusal, never as "nothing here".
 *   * Reads are re-issued from the server after every mutation, and responses
 *     that land after a workspace switch are dropped.
 */

import { useCallback, useState } from "react";
import Link from "next/link";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { useTeamId } from "../../../../lib/platform-context";
import { MembersSection, type MemberProjection } from "./_sections/MembersSection";
import { ServiceAccountsSection } from "./_sections/ServiceAccountsSection";
import { ExternalMappingsSection } from "./_sections/ExternalMappingsSection";
import { SessionGovernanceSection } from "./_sections/SessionGovernanceSection";
import { mutedStyle, TOKENS } from "./ui-tokens";

type Surface = {
  href: string;
  title: string;
  description: string;
  /** Used by the contract test to assert each card maps to a real route. */
  canonicalPath: string;
};

const SPECIALIST_SURFACES: ReadonlyArray<Surface> = [
  {
    href: "/settings/security/saml",
    canonicalPath: "/settings/security/saml",
    title: "SAML configuration",
    description:
      "Configure identity-provider SSO. Metadata ingestion, certificate rotation, request signing, NameID + attribute mapping, connection health checks, and IdP outage detection.",
  },
  {
    href: "/admin/identity/scim",
    canonicalPath: "/settings/security/scim",
    title: "SCIM operations",
    description:
      "Provisioning token lifecycle, scope-limited bearer tokens, IP allowlist, suspend / reactivate, and revoke. Destructive operations require step-up.",
  },
  {
    href: "/admin/identity/timeline",
    canonicalPath: "/settings/security/audit",
    title: "Identity audit center",
    description:
      "Unified security-event timeline: login activity, step-up elevations, session governance, geo-risk anomalies, and provisioning events. Filters per event kind + severity.",
  },
  {
    href: "/admin/identity/sessions",
    canonicalPath: "/admin/identity/sessions",
    title: "Active sessions",
    description:
      "Live session inventory. Revoke individual sessions or revoke-all for a user (step-up gated). Filter by revoked / expired.",
  },
  {
    href: "/admin/identity/runtime",
    canonicalPath: "/admin/identity/runtime",
    title: "Runtime monitor",
    description:
      "Live SOC console: quarantine sessions, release safe sessions, re-score on demand, and emergency org-wide revoke (step-up gated).",
  },
  {
    href: "/admin/identity/access-reviews",
    canonicalPath: "/admin/identity/access-reviews",
    title: "Access reviews",
    description:
      "Periodic + triggered access reviews. Certify, revoke, or suspend each entry, or regenerate the queue on demand.",
  },
  {
    href: "/admin/identity/permission-matrix",
    canonicalPath: "/admin/identity/permission-matrix",
    title: "Permission matrix",
    description:
      "The authoritative role → permission projection, one member's effective permissions with their source, and temporary elevation.",
  },
  {
    href: "/security-center",
    canonicalPath: "/security-center",
    title: "MFA + trusted devices",
    description:
      "Per-user MFA enrollment posture, MFA policy editor, trusted device list with revocation, and own-session risk snapshot.",
  },
  {
    href: "/security-center/mfa-recovery",
    canonicalPath: "/security-center/mfa-recovery",
    title: "MFA recovery approvals",
    description:
      "Admin queue for pending recovery requests. Quorum-based approval (step-up gated). Digest notification preferences + snooze controls.",
  },
];

export default function AdminIdentityConsolePage() {
  return (
    <PageRouteGate routeId="admin.identity">
      <AdminIdentityConsoleInner />
    </PageRouteGate>
  );
}

function AdminIdentityConsoleInner() {
  const teamId = useTeamId();
  // ONE step-up host for the whole console, bound to the active workspace so
  // the challenge is issued against the right tenant.
  const stepUp = useStepUpAction({ teamId });

  // The workspace the API says it is administering, plus the member roster it
  // returned — the mappings section selects its subject from that SAME
  // projection instead of accepting a typed user id.
  const [resolvedTeamId, setResolvedTeamId] = useState<string | null>(null);
  const [memberOptions, setMemberOptions] = useState<
    ReadonlyArray<{ userId: string; role: string; status: string }>
  >([]);

  const handleWorkspaceResolved = useCallback((serverTeamId: string | null) => {
    setResolvedTeamId(serverTeamId);
  }, []);

  const handleMembersLoaded = useCallback(
    (members: ReadonlyArray<MemberProjection>) => {
      setMemberOptions(
        members.map((m) => ({
          userId: m.userId,
          role: m.role,
          status: m.status,
        })),
      );
    },
    [],
  );

  return (
    <PageShell
      data-testid="admin-identity-hub"
      data-admin-identity-console
      header={
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <PageHeader
            eyebrow="Identity operations"
            title="Identity administration"
            // PHASE 12B — this copy is a CONTRACT, pinned by
            // services/api/test/phase-p1-identity-operations.test.ts. It must stay
            // honest about what actually happens: every mutation hits an audited
            // backend endpoint, and step-up fires WHERE FLAGGED by the workspace
            // step-up policy — the hub must not promise step-up will always fire,
            // because `enforceStepUpIfFlagged` only fires when the flag is set.
            subtitle="Administer who belongs to this workspace, what extra access they hold, which machine identities can act, and which identity-provider subjects map to which member. Every action here calls a procurement-grade, audited backend endpoint that authorizes server-side, will require step-up where flagged by the workspace step-up policy, and writes to the immutable audit trail with both your identity and the target's."
          />
        </div>
      }
    >
      <Card
        variant="admin"
        padding="compact"
        data-admin-identity-scope
        data-admin-identity-scope-resolved={resolvedTeamId ? "true" : "false"}
      >
        <span style={mutedStyle}>
          {resolvedTeamId ? (
            <>
              You are administering the workspace your session is currently in (
              <code>{resolvedTeamId.slice(0, 8)}…</code>). The workspace is
              resolved by the server — it is not something you set here. Switch
              workspace to administer a different one.
            </>
          ) : (
            <>
              The administered workspace is resolved by the server from your
              active workspace. If the sections below report that nothing is
              available, switch to the workspace you intend to administer.
            </>
          )}
        </span>
      </Card>

      <MembersSection
        stepUp={stepUp}
        onWorkspaceResolved={handleWorkspaceResolved}
        onMembersLoaded={handleMembersLoaded}
      />

      <ServiceAccountsSection stepUp={stepUp} />

      <ExternalMappingsSection stepUp={stepUp} memberOptions={memberOptions} />

      <SessionGovernanceSection stepUp={stepUp} />

      <PageSection
        data-section="admin-identity-specialist"
        title="Specialist surfaces"
        description="Deeper identity surfaces that keep their own console: provider configuration, directory provisioning, live session inventory, runtime risk, access reviews, and the audit timeline."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 12,
          }}
        >
          {SPECIALIST_SURFACES.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              data-admin-identity-card={s.canonicalPath}
              style={{
                textDecoration: "none",
                color: TOKENS.ink,
                display: "block",
              }}
            >
              <Card
                variant="summary"
                padding="compact"
                title={s.title}
                subtitle={s.description}
              />
            </Link>
          ))}
        </div>
      </PageSection>

      <PageSection
        data-section="admin-identity-honest-scope"
        title="Honest scope disclosure"
        description="These capabilities are NOT shipped today and are bounded follow-up work. The platform never surfaces fake controls."
      >
        <ul
          style={{
            fontSize: 12,
            color: TOKENS.inkSubtle,
            margin: 0,
            paddingLeft: 18,
            lineHeight: 1.6,
          }}
          data-admin-identity-bounded-followups
        >
          <li>
            <strong>Step-up exemption rules</strong> — admin-defined waivers for
            specific actions/roles. Today step-up is workspace-flag driven (per
            action, on or off).
          </li>
          <li>
            <strong>Contributor session inventory</strong> — contributor
            (intake) sessions can be revoked by id above, but the platform ships
            no workspace-wide list of them; they are listed per intake link.
          </li>
          <li>
            <strong>Ownership transfer</strong> — the owner role cannot be
            changed from this console. Transfer ownership through the workspace
            ownership flow.
          </li>
        </ul>
      </PageSection>

      {/* Step-up challenge host for every section. Renders nothing until a
          mutation hits the structured 401. */}
      <StepUpModal control={stepUp} />
    </PageShell>
  );
}
