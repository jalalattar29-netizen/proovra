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
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { useToast } from "../../../components/ui";
import { ApiError } from "../../../lib/api";
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

  return (
    <main className="cc-page" data-testid="collaboration-teams-overview">
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Teams</div>
          <h1 className="cc-title">Teams in this workspace</h1>
          <p className="cc-subtitle">
            Teams coordinate people, assignments, and evidence work.
            Personal users and organizations can both create Teams —
            no Organization is required.
          </p>
        </div>
        <div className="cc-meta" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
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
          <button
            type="button"
            className="cc-quick-action"
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
            Create Team
          </button>
          {atCapacity && planForCapacity !== null ? (
            <UpgradeCTA
              ownedTeamCount={ownedTeamCount}
              maxTeams={maxTeams}
              plan={planForCapacity}
            />
          ) : null}
        </div>
      </header>

      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState
          message={error.message}
          requestId={error.requestId}
          onRetry={() => void refresh()}
        />
      ) : teams.length === 0 ? (
        <EmptyState
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
    </main>
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
    <section
      className="cc-section"
      data-testid="teams-list"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: "1rem",
        marginTop: "1.5rem",
      }}
    >
      {teams.map((t) => (
        <TeamCard key={t.id} team={t} />
      ))}
    </section>
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
      style={{
        display: "block",
        border: "1px solid rgba(79,112,107,0.14)",
        borderRadius: 16,
        padding: "1.25rem",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(243,245,242,0.92) 100%)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <h3
          style={{
            margin: 0,
            fontSize: "1.05rem",
            fontWeight: 600,
            color: "#182b30",
          }}
        >
          {team.name}
        </h3>
        <TeamTypeBadge type={team.teamType} />
      </div>
      {team.description ? (
        <p style={{ color: "#5d6d71", fontSize: "0.9rem", margin: "0.5rem 0" }}>
          {team.description}
        </p>
      ) : null}
      <div
        style={{
          display: "flex",
          gap: "1rem",
          marginTop: "1rem",
          fontSize: "0.85rem",
          color: "#5d6d71",
          flexWrap: "wrap",
        }}
      >
        <span>
          <strong style={{ color: "#182b30" }}>{team.memberCount}</strong>{" "}
          members
        </span>
        {team.pendingInviteCount > 0 ? (
          <span>
            <strong style={{ color: "#9b826b" }}>
              {team.pendingInviteCount}
            </strong>{" "}
            pending invites
          </span>
        ) : null}
        {team.openAssignmentCount > 0 ? (
          <span>
            <strong style={{ color: "#3e6063" }}>
              {team.openAssignmentCount}
            </strong>{" "}
            open
          </span>
        ) : null}
      </div>
      <div
        style={{
          marginTop: "0.75rem",
          fontSize: "0.75rem",
          color: "#9b826b",
        }}
      >
        Last activity: {lastActivity}
      </div>
      {team.viewerRole ? (
        <div style={{ marginTop: "0.5rem" }}>
          <RoleBadge role={team.viewerRole} />
        </div>
      ) : null}
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
    <span
      style={{
        background: "rgba(62,96,99,0.10)",
        color: "#3e6063",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: "0.72rem",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {labels[type]}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span
      style={{
        background: "rgba(155,130,107,0.14)",
        color: "#9b826b",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: "0.7rem",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {role}
    </span>
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
  const tone = atCapacity
    ? {
        background: "rgba(186,80,80,0.10)",
        color: "#7c2d2d",
        border: "1px solid rgba(186,80,80,0.20)",
      }
    : {
        background: "rgba(62,96,99,0.10)",
        color: "#3e6063",
        border: "1px solid rgba(79,112,107,0.18)",
      };
  return (
    <span
      data-testid="collaboration-teams-plan-capacity-badge"
      data-at-capacity={atCapacity ? "true" : "false"}
      aria-label={`${ownedTeamCount} of ${maxTeams} Teams used on ${plan} plan`}
      title={`Plan ${plan}: ${ownedTeamCount} of ${maxTeams} Teams used`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: "0.78rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        ...tone,
      }}
    >
      <strong style={{ fontWeight: 700 }}>{ownedTeamCount}</strong>
      <span aria-hidden="true">of</span>
      <strong style={{ fontWeight: 700 }}>{maxTeams}</strong>
      <span style={{ opacity: 0.85 }}>teams used</span>
    </span>
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
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderRadius: 10,
        background: "linear-gradient(180deg, #9b826b 0%, #7c6452 100%)",
        color: "#ffffff",
        fontSize: "0.85rem",
        fontWeight: 600,
        textDecoration: "none",
        boxShadow: "0 4px 12px rgba(155,130,107,0.25)",
      }}
    >
      Upgrade plan
    </Link>
  );
}

// =============================================================================
// Empty / loading / error
// =============================================================================

function EmptyState({
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
      <section
        className="cc-section"
        data-testid="teams-empty-state"
        data-requires-upgrade="true"
        style={{
          marginTop: "2rem",
          border: "1px solid rgba(155,130,107,0.30)",
          borderRadius: 18,
          padding: "2.5rem",
          textAlign: "center",
          background:
            "linear-gradient(180deg, rgba(255,250,243,0.85) 0%, rgba(243,235,222,0.75) 100%)",
        }}
      >
        <h2 style={{ fontSize: "1.15rem", color: "#182b30", margin: 0 }}>
          Teams are part of a paid plan
        </h2>
        <p
          style={{
            color: "#5d6d71",
            marginTop: "0.5rem",
            maxWidth: 560,
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          {reason} Teams give you shared assignments, member invites, and
          collaborative review on cases and evidence.
        </p>
        <div
          style={{
            display: "inline-flex",
            gap: "0.5rem",
            marginTop: "1.25rem",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          <Link
            href="/billing"
            data-testid="teams-empty-upgrade-cta"
            aria-label={`Upgrade plan — ${reason}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "10px 16px",
              borderRadius: 10,
              background: "linear-gradient(180deg, #9b826b 0%, #7c6452 100%)",
              color: "#ffffff",
              fontSize: "0.95rem",
              fontWeight: 600,
              textDecoration: "none",
              boxShadow: "0 4px 12px rgba(155,130,107,0.25)",
            }}
          >
            Upgrade plan
          </Link>
          <button
            type="button"
            className="cc-quick-action"
            onClick={onCreate}
            disabled
            aria-disabled="true"
            aria-label={`Create Team — ${reason}`}
            title={reason}
            style={{ opacity: 0.6, cursor: "not-allowed" }}
          >
            Create Team
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      className="cc-section"
      data-testid="teams-empty-state"
      style={{
        marginTop: "2rem",
        border: "1px dashed rgba(79,112,107,0.20)",
        borderRadius: 18,
        padding: "2.5rem",
        textAlign: "center",
        background: "rgba(243,245,242,0.6)",
      }}
    >
      <h2 style={{ fontSize: "1.15rem", color: "#182b30", margin: 0 }}>
        No Teams yet
      </h2>
      <p
        style={{
          color: "#5d6d71",
          marginTop: "0.5rem",
          maxWidth: 540,
          marginLeft: "auto",
          marginRight: "auto",
        }}
      >
        Create a Team to collaborate on cases, evidence, reviews, and
        assignments. Teams work in both personal and organization
        workspaces — no Organization is required.
      </p>
      <button
        type="button"
        className="cc-quick-action"
        onClick={onCreate}
        style={{ marginTop: "1.25rem" }}
      >
        Create Team
      </button>
    </section>
  );
}

function LoadingState() {
  return (
    <section
      className="cc-section"
      data-testid="teams-loading"
      style={{ marginTop: "1.5rem" }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            height: 96,
            borderRadius: 16,
            background:
              "linear-gradient(90deg, rgba(243,245,242,0.6) 0%, rgba(229,234,231,0.9) 50%, rgba(243,245,242,0.6) 100%)",
            backgroundSize: "200% 100%",
            animation: "shimmer 1.5s linear infinite",
            marginBottom: "0.75rem",
          }}
        />
      ))}
    </section>
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
    <section
      className="cc-section"
      data-testid="teams-error"
      style={{
        marginTop: "1.5rem",
        border: "1px solid rgba(186,80,80,0.20)",
        borderRadius: 16,
        padding: "1.5rem",
        background: "rgba(255,242,242,0.6)",
      }}
    >
      <h2 style={{ margin: 0, color: "#7c2d2d", fontSize: "1.05rem" }}>
        Couldn't load Teams
      </h2>
      <p style={{ color: "#5d6d71", marginTop: "0.5rem" }}>{message}</p>
      {requestId ? (
        <p
          style={{
            color: "#9b826b",
            fontSize: "0.8rem",
            fontFamily: "monospace",
          }}
          data-testid="error-request-id"
        >
          Request id: {requestId}
        </p>
      ) : null}
      <button
        type="button"
        className="cases-filter-chip"
        onClick={onRetry}
        style={{ marginTop: "0.75rem" }}
      >
        Try again
      </button>
    </section>
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
      if (err instanceof ApiError) {
        setError({ message: err.message, requestId: err.requestId });
        addToast(err.message || "Couldn't create Team.", "error");
      } else {
        setError({ message: "Couldn't create Team. Try again." });
      }
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
        background: "rgba(24,43,48,0.45)",
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
          background: "#ffffff",
          borderRadius: 20,
          padding: "1.5rem",
          maxWidth: 560,
          width: "100%",
          boxShadow: "0 24px 64px rgba(24,43,48,0.30)",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <header>
          <h2
            id="create-team-title"
            style={{ margin: 0, fontSize: "1.2rem", color: "#182b30" }}
          >
            Create a Team
          </h2>
          <p style={{ color: "#5d6d71", margin: "0.25rem 0 0" }}>
            Teams help you coordinate on evidence, cases, and review work.
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
              color: "#9b826b",
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
              background: "rgba(255,242,242,0.85)",
              border: "1px solid rgba(186,80,80,0.20)",
              borderRadius: 10,
              padding: "0.75rem",
              color: "#7c2d2d",
              fontSize: "0.9rem",
            }}
          >
            {error.message}
            {error.requestId ? (
              <div
                style={{
                  marginTop: 4,
                  color: "#9b826b",
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
          <button
            type="button"
            onClick={onClose}
            className="cases-filter-chip"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="cc-quick-action"
            disabled={!canSubmit}
            data-testid="create-team-submit"
          >
            {submitting ? "Creating…" : "Create Team"}
          </button>
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
  color: "#182b30",
  fontSize: "0.92rem",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "10px 12px",
  border: "1px solid rgba(79,112,107,0.20)",
  borderRadius: 10,
  background: "#fff",
  color: "#182b30",
  fontSize: "0.95rem",
  outline: "none",
};
