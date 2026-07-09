/**
 * PROOVRA Phase 6 — Teams overview page.
 *
 * Route: `/collaboration-teams` (sidebar label "Teams")
 *
 * Lists every Collaboration Team the active user can see inside the
 * active workspace. Personal users see this page (constitutional
 * rule 7); organization users see it too. No Organization required.
 *
 * Page wraps in <PageRouteGate routeId="workspace.collaboration_teams">.
 * The gate's `requiredActiveSpace: "PERSONAL_OR_ORG"` plus the
 * personal-first rescue mean a fresh personal user lands here without
 * any "Activate an organization" wall.
 *
 * Phase 7C — VISUAL redesign only. Wrapper migrated from the raw
 * `.cc-page` chrome to the shared PageShell/PageHeader/PageSection +
 * Card/Badge/Button/EmptyState primitives. No data-fetching, permission,
 * billing-limit, or behaviour changes — every data-testid / data-* and
 * the plan-capacity logic are preserved verbatim.
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
  PageSection,
  useToast,
} from "../../../components/ui";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ApiError } from "../../../lib/api";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { formatUserDate } from "../../../lib/date";
import {
  createTeam,
  listTeams,
  type CollaborationTeamSummary,
} from "../../../lib/api/collaboration-teams";
import { useBillingSummary } from "../../../lib/api/billing-summary";
import { PlanLimitBadge } from "../../../components/billing/PlanLimitBadge";
import { useAccount, usePersonalSpace } from "../../../lib/platform-context";
import type { WorkspacePlan } from "../../../lib/platform-context/types";
import {
  COLLABORATION_TEAM_TYPES,
  getCollaborationTeamPlanLimits,
  type CollaborationTeamType,
} from "@proovra/shared";

export default function TeamsOverviewPage() {
  return (
    <PageRouteGate routeId="workspace.collaboration_teams">
      <TeamsOverview />
    </PageRouteGate>
  );
}

function TeamsOverview() {
  const router = useRouter();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null,
  );
  const [teams, setTeams] = useState<ReadonlyArray<CollaborationTeamSummary>>([]);
  const [createOpen, setCreateOpen] = useState(false);

  // Plan capacity is sourced from the canonical platform-context envelope
  // (no fabricated counts). Plan resolution order:
  //   1. account.accountPlan — the billing-bearing identity for owned teams.
  //   2. personalSpace.plan  — fallback for envelopes that don't surface
  //      `account` yet (back-compat with older envelope shape).
  // The owned-team count is the number of non-archived rows the API
  // already returned from GET /v1/collaboration-teams (via `listTeams`);
  // we do NOT recount or invent any number.
  const account = useAccount();
  const personalSpace = usePersonalSpace();
  const planForCapacity: WorkspacePlan | null =
    account?.accountPlan ?? personalSpace?.plan ?? null;
  const planLimits = useMemo(
    () => getCollaborationTeamPlanLimits(planForCapacity),
    [planForCapacity],
  );
  const ownedTeamCount = useMemo(
    () => teams.filter((t) => t.status === "ACTIVE").length,
    [teams],
  );
  // PROOVRA Phase 10 — additive plan-aware chip. Reads the same
  // canonical envelope as the existing `PlanCapacityBadge` but
  // through the shared `useBillingSummary` helper so all four
  // /collaboration-teams pages render identical plan UX.
  const billingSummary = useBillingSummary(ownedTeamCount);
  const maxTeams = planLimits.maxTeams;
  const planContextReady = planForCapacity !== null;
  const atCapacity = planContextReady && ownedTeamCount >= maxTeams;
  const createDisabledReason: string | null = !planContextReady
    ? null
    : atCapacity
      ? `Your ${planForCapacity} plan allows up to ${maxTeams} active Team${
          maxTeams === 1 ? "" : "s"
        }. Upgrade to add more.`
      : null;

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listTeams();
      setTeams(rows);
    } catch (err) {
      if (err instanceof ApiError) {
        setError({ message: err.message, requestId: err.requestId });
      } else {
        setError({ message: "Couldn't load Teams. Try again." });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const headerActions = (
    <div
      className="cc-meta"
      style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
    >
      {billingSummary && !loading && !error ? (
        <PlanLimitBadge
          kind="TEAMS_USED"
          current={billingSummary.teamsUsed}
          max={billingSummary.teamsMax}
          planLabel={billingSummary.plan}
        />
      ) : null}
      {planForCapacity !== null && !loading && !error ? (
        <PlanCapacityBadge
          plan={planForCapacity}
          ownedTeamCount={ownedTeamCount}
          maxTeams={maxTeams}
          atCapacity={atCapacity}
        />
      ) : null}
      {atCapacity && planForCapacity !== null ? (
        <UpgradeCTA
          ownedTeamCount={ownedTeamCount}
          maxTeams={maxTeams}
          plan={planForCapacity}
        />
      ) : null}
      <Button
        variant="primary"
        data-testid="create-team-button"
        onClick={() => setCreateOpen(true)}
        disabled={atCapacity}
        aria-disabled={atCapacity || undefined}
        aria-label={
          createDisabledReason
            ? `Create Team — ${createDisabledReason}`
            : "Create Team"
        }
        title={createDisabledReason ?? undefined}
      >
        Create team
      </Button>
    </div>
  );

  return (
    <PageShell
      data-testid="collaboration-teams-overview"
      header={
        <PageHeader
          eyebrow="Collaboration"
          title="Collaboration Teams"
          subtitle="Collaboration Teams coordinate people, assignments, and evidence work together. A Team here is a collaboration space — not a workspace or organization. Personal users and organizations can both create Teams; no Organization is required."
          primaryAction={headerActions}
        />
      }
    >
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState
          message={error.message}
          requestId={error.requestId}
          onRetry={() => void refresh()}
        />
      ) : teams.length === 0 ? (
        <TeamsEmptyState
          onCreate={() => setCreateOpen(true)}
          requiresUpgrade={planContextReady && maxTeams === 0}
          plan={planForCapacity}
          createDisabledReason={createDisabledReason}
        />
      ) : (
        <TeamsGrid teams={teams} />
      )}

      {createOpen ? (
        <CreateTeamModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            addToast("Team created.", "success");
            router.push(`/collaboration-teams/${id}`);
          }}
        />
      ) : null}
    </PageShell>
  );
}

// =============================================================================
// Teams grid
// =============================================================================

function TeamsGrid({
  teams,
}: {
  teams: ReadonlyArray<CollaborationTeamSummary>;
}) {
  return (
    <PageSection
      title="Your teams"
      description="Collaboration Teams you belong to in this workspace."
    >
      <div
        data-testid="teams-list"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 16,
        }}
      >
        {teams.map((t) => (
          <TeamCard key={t.id} team={t} />
        ))}
      </div>
    </PageSection>
  );
}

function TeamCard({ team }: { team: CollaborationTeamSummary }) {
  const lastActivity = useMemo(() => {
    if (!team.lastActivityAt) return "No activity yet";
    try {
      return formatUserDate(team.lastActivityAt);
    } catch {
      return "Recent";
    }
  }, [team.lastActivityAt]);

  return (
    <Link
      href={`/collaboration-teams/${team.id}`}
      className="proovra-card-link"
      data-testid={`team-card-${team.id}`}
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
    >
      <Card
        variant="action"
        style={{ height: "100%" }}
        header={
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 10,
            }}
          >
            <div
              style={{
                fontSize: 16,
                fontWeight: 650,
                lineHeight: 1.3,
                color: "var(--ink-primary, #0f172a)",
                minWidth: 0,
              }}
            >
              {team.name}
            </div>
            <TeamTypeBadge type={team.teamType} />
          </div>
        }
        footer={
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{ fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}
            >
              Last activity: {lastActivity}
            </span>
            {team.viewerRole ? <RoleBadge role={team.viewerRole} /> : null}
          </div>
        }
      >
        {team.description ? (
          <p
            style={{
              color: "var(--ink-secondary, #475569)",
              fontSize: 13.5,
              lineHeight: 1.5,
              margin: "0 0 12px",
            }}
          >
            {team.description}
          </p>
        ) : null}
        <div
          style={{
            display: "flex",
            gap: 16,
            fontSize: 13,
            color: "var(--ink-secondary, #475569)",
            flexWrap: "wrap",
          }}
        >
          <span>
            <strong style={{ color: "var(--ink-primary, #0f172a)" }}>
              {team.memberCount}
            </strong>{" "}
            members
          </span>
          {team.pendingInviteCount > 0 ? (
            <span>
              <strong style={{ color: "var(--status-pending-fg, #78350f)" }}>
                {team.pendingInviteCount}
              </strong>{" "}
              pending invites
            </span>
          ) : null}
          {team.openAssignmentCount > 0 ? (
            <span>
              <strong style={{ color: "var(--status-info-fg, #1e40af)" }}>
                {team.openAssignmentCount}
              </strong>{" "}
              open
            </span>
          ) : null}
        </div>
      </Card>
    </Link>
  );
}

function TeamTypeBadge({ type }: { type: CollaborationTeamType }) {
  const labels: Record<CollaborationTeamType, string> = {
    GENERAL: "General",
    INVESTIGATION: "Investigation",
    LEGAL: "Legal",
    REVIEW: "Review",
    COMPLIANCE: "Compliance",
  };
  return (
    <Badge tone="info" subtle>
      {labels[type]}
    </Badge>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge tone="governance" subtle>
      {role}
    </Badge>
  );
}

// =============================================================================
// Plan capacity badge + Upgrade CTA — Phase 10 UX surface.
//
// Mirrors the badge pattern used on /workspaces: a small inline pill that
// reports current owned-team capacity against the plan limit. Counts come
// from the canonical platform-context envelope (plan) and the already-loaded
// `listTeams()` payload (owned-team count) — never fabricated. When the
// page is at capacity the Create-Team button is disabled with an
// explanatory aria-label/title and an inline UpgradeCTA points to /billing
// (the canonical billing surface — see COLLABORATION_TEAM_BILLING_UPGRADE_CTA).
// =============================================================================

function PlanCapacityBadge({
  plan,
  ownedTeamCount,
  maxTeams,
  atCapacity,
}: {
  plan: WorkspacePlan;
  ownedTeamCount: number;
  maxTeams: number;
  atCapacity: boolean;
}) {
  return (
    <Badge
      tone={atCapacity ? "risk" : "verified"}
      dot
      data-testid="collaboration-teams-plan-capacity-badge"
      data-at-capacity={atCapacity ? "true" : "false"}
      aria-label={`${ownedTeamCount} of ${maxTeams} Teams used on ${plan} plan`}
      title={`Plan ${plan}: ${ownedTeamCount} of ${maxTeams} Teams used`}
    >
      <strong style={{ fontWeight: 700 }}>{ownedTeamCount}</strong>
      <span aria-hidden="true" style={{ margin: "0 3px" }}>
        of
      </span>
      <strong style={{ fontWeight: 700 }}>{maxTeams}</strong>
      <span style={{ opacity: 0.85, marginLeft: 4 }}>teams used</span>
    </Badge>
  );
}

function UpgradeCTA({
  ownedTeamCount,
  maxTeams,
  plan,
}: {
  ownedTeamCount: number;
  maxTeams: number;
  plan: WorkspacePlan;
}) {
  return (
    <Link
      href="/billing"
      data-testid="collaboration-teams-upgrade-cta"
      aria-label={`Upgrade — your ${plan} plan allows up to ${maxTeams} Teams (currently using ${ownedTeamCount})`}
      style={{ textDecoration: "none" }}
    >
      <Button variant="enterprise" size="sm">
        Upgrade plan
      </Button>
    </Link>
  );
}

// =============================================================================
// Empty / loading / error
// =============================================================================

function TeamsEmptyState({
  onCreate,
  requiresUpgrade = false,
  plan = null,
  createDisabledReason = null,
}: {
  onCreate: () => void;
  /**
   * PROOVRA Phase 10 — when true, the active plan grants zero Team
   * capacity. The FREE plan in COLLABORATION_TEAM_PLAN_LIMITS allows 1
   * Team, so this branch is reached primarily by downgraded or inactive
   * subscriptions. We surface an UpgradeCTA card pointing at /billing
   * (the canonical billing surface) instead of letting the Create CTA
   * silently dead-end.
   */
  requiresUpgrade?: boolean;
  plan?: WorkspacePlan | null;
  createDisabledReason?: string | null;
}) {
  if (requiresUpgrade) {
    const planLabel = plan ?? "current";
    const reason =
      createDisabledReason ??
      `Your ${planLabel} plan doesn't include Teams. Upgrade to create one.`;
    return (
      <Card
        variant="empty"
        data-testid="teams-empty-state"
        data-requires-upgrade="true"
      >
        <EmptyState
          icon={<TeamsGlyph />}
          title="Collaboration Teams are part of a paid plan"
          purpose={`${reason} Teams give you shared assignments, member invites, and collaborative review on cases and evidence.`}
          action={
            <div
              style={{
                display: "inline-flex",
                gap: 10,
                flexWrap: "wrap",
                justifyContent: "center",
              }}
            >
              <Link
                href="/billing"
                data-testid="teams-empty-upgrade-cta"
                aria-label={`Upgrade plan — ${reason}`}
                style={{ textDecoration: "none" }}
              >
                <Button variant="enterprise">Upgrade plan</Button>
              </Link>
              <Button
                variant="secondary"
                onClick={onCreate}
                disabled
                aria-disabled="true"
                aria-label={`Create Team — ${reason}`}
                title={reason}
              >
                Create team
              </Button>
            </div>
          }
        />
      </Card>
    );
  }

  return (
    <Card variant="empty" data-testid="teams-empty-state">
      <EmptyState
        icon={<TeamsGlyph />}
        title="No collaboration Teams yet"
        purpose="Create a Team to collaborate on cases, evidence, reviews, and assignments. Teams work in both personal and organization workspaces — no Organization is required."
        action={
          <Button variant="primary" onClick={onCreate}>
            Create team
          </Button>
        }
      />
    </Card>
  );
}

function TeamsGlyph() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function LoadingState() {
  return (
    <div
      data-testid="teams-loading"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        gap: 16,
      }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            height: 132,
            borderRadius: "var(--radius-card, 14px)",
            background:
              "linear-gradient(90deg, rgba(15,23,42,0.03) 0%, rgba(15,23,42,0.06) 50%, rgba(15,23,42,0.03) 100%)",
            backgroundSize: "200% 100%",
            animation: "shimmer 1.5s linear infinite",
            border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
          }}
        />
      ))}
    </div>
  );
}

function ErrorState({
  message,
  requestId,
  onRetry,
}: {
  message: string;
  requestId?: string;
  onRetry: () => void;
}) {
  return (
    <Card
      variant="status"
      tone="risk"
      data-testid="teams-error"
      title="Couldn't load Teams"
    >
      <p style={{ color: "var(--ink-secondary, #475569)", margin: "0 0 8px" }}>
        {message}
      </p>
      {requestId ? (
        <p
          style={{
            color: "var(--ink-muted, #94a3b8)",
            fontSize: 12,
            fontFamily: "monospace",
            margin: "0 0 12px",
          }}
          data-testid="error-request-id"
        >
          Request id: {requestId}
        </p>
      ) : null}
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </Card>
  );
}

// =============================================================================
// Create-Team modal
// =============================================================================

function CreateTeamModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (teamId: string) => void;
}) {
  const { addToast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teamType, setTeamType] = useState<CollaborationTeamType>("GENERAL");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null,
  );

  const canSubmit = name.trim().length > 0 && !submitting;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await createTeam({
        name: name.trim(),
        description: description.trim() || null,
        teamType,
      });
      onCreated(id);
    } catch (err) {
      const safe = toSafeUserError(err, {
        message: "We couldn't create the team. Please try again.",
      });
      setError({ message: safe.message, requestId: safe.supportReference });
      addToast(
        safe.message,
        safe.severity,
        undefined,
        safe.supportReference ? { supportReference: safe.supportReference } : undefined,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-team-title"
      data-testid="create-team-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 200,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          background: "var(--surface-card, #ffffff)",
          borderRadius: "var(--radius-card, 14px)",
          padding: "1.5rem",
          maxWidth: 560,
          width: "100%",
          boxShadow: "0 24px 64px rgba(15,23,42,0.30)",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <header>
          <h2
            id="create-team-title"
            style={{
              margin: 0,
              fontSize: "1.2rem",
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            Create a collaboration Team
          </h2>
          <p
            style={{
              color: "var(--ink-secondary, #475569)",
              margin: "0.25rem 0 0",
            }}
          >
            Teams help you coordinate on evidence, cases, and review work.
            This is a collaboration space, not a workspace or organization.
          </p>
        </header>

        <label style={{ display: "block" }}>
          <span style={labelStyle}>Name</span>
          <input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
            data-testid="create-team-name-input"
            style={inputStyle}
            placeholder="e.g. Claim Investigations"
          />
        </label>

        <label style={{ display: "block" }}>
          <span style={labelStyle}>Description (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={600}
            rows={3}
            data-testid="create-team-description-input"
            style={{ ...inputStyle, resize: "vertical" }}
            placeholder="What does this team work on?"
          />
        </label>

        <label style={{ display: "block" }}>
          <span style={labelStyle}>Template</span>
          <select
            value={teamType}
            onChange={(e) =>
              setTeamType(e.target.value as CollaborationTeamType)
            }
            data-testid="create-team-type-select"
            style={inputStyle}
          >
            {COLLABORATION_TEAM_TYPES.map((t) => (
              <option key={t} value={t}>
                {teamTypeLabel(t)}
              </option>
            ))}
          </select>
          <span
            style={{
              color: "var(--ink-muted, #94a3b8)",
              fontSize: "0.8rem",
              marginTop: 4,
              display: "block",
            }}
          >
            Templates set default ordering and emphasis. They never change
            permissions.
          </span>
        </label>

        {error ? (
          <div
            data-testid="create-team-error"
            style={{
              background: "var(--status-risk-bg, #fef2f2)",
              border: "1px solid var(--status-risk-border, #fecaca)",
              borderRadius: 10,
              padding: "0.75rem",
              color: "var(--status-risk-fg, #991b1b)",
              fontSize: "0.9rem",
            }}
          >
            {error.message}
            {error.requestId ? (
              <div
                style={{
                  marginTop: 4,
                  color: "var(--ink-muted, #94a3b8)",
                  fontSize: "0.75rem",
                  fontFamily: "monospace",
                }}
              >
                Request id: {error.requestId}
              </div>
            ) : null}
          </div>
        ) : null}

        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.5rem",
            marginTop: "0.5rem",
          }}
        >
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            loading={submitting}
            disabled={!canSubmit}
            data-testid="create-team-submit"
          >
            {submitting ? "Creating…" : "Create team"}
          </Button>
        </footer>
      </form>
    </div>
  );
}

function teamTypeLabel(t: CollaborationTeamType): string {
  switch (t) {
    case "GENERAL":
      return "General — flexible team for any work";
    case "INVESTIGATION":
      return "Investigation — reconstruction & timeline work";
    case "LEGAL":
      return "Legal — matter & disclosure";
    case "REVIEW":
      return "Review — reviewer ops & QC";
    case "COMPLIANCE":
      return "Compliance — governance & audit";
  }
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontWeight: 600,
  color: "var(--ink-primary, #0f172a)",
  fontSize: "0.92rem",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: 10,
  background: "var(--surface-card, #fff)",
  color: "var(--ink-primary, #0f172a)",
  fontSize: "0.95rem",
  outline: "none",
};
