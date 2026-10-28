/**
 * THE "COLLABORATION TEAMS" FIGURE ON MEMBERS & ACCESS (members experience B).
 *
 * The figure is the server's — active Teams in the Workspace against the
 * limit the create gate enforces (`resolveCollaborationEntitlement`): the plan
 * catalog for self-serve plans, the contract for Enterprise. This module only
 * words it, so the card cannot disagree with the gate and every state has one
 * honest sentence:
 *
 *   unknown        "—"            the read failed; never a zero
 *   not included   "Not included" FREE / PAYG, or a contract without Teams
 *   included       "1 of 2"       active of the limit, with the per-Team size
 *
 * The owner holds no Team position, and pending invitations hold none either;
 * the per-Team figure says so rather than leaving a reader to wonder.
 */

export type CollaborationTeamsStat = {
  featureIncluded: boolean;
  active: number;
  limit: number;
  limitSource: string;
  membersPerTeam: number;
};

export type CollaborationTeamsKpiTone = "neutral" | "info" | "warning";

export function describeCollaborationTeamsKpi(stat: CollaborationTeamsStat | null): {
  value: string;
  meta: string;
  tone: CollaborationTeamsKpiTone;
} {
  if (stat === null) {
    return { value: "—", meta: "Count unavailable right now", tone: "neutral" };
  }
  const contract = stat.limitSource === "ENTERPRISE_CONTRACT";
  if (!stat.featureIncluded || stat.limit <= 0) {
    return {
      value: "Not included",
      meta: contract
        ? "Your Enterprise contract does not include Collaboration Teams"
        : "Available on Pro, Team and Enterprise plans",
      tone: "neutral",
    };
  }
  const perTeam = `up to ${stat.membersPerTeam} member${stat.membersPerTeam === 1 ? "" : "s"} per Team, owner not counted`;
  return {
    value: `${stat.active} of ${stat.limit}`,
    meta: `Active · ${perTeam}${contract ? " · set by your contract" : ""}`,
    tone: stat.active >= stat.limit ? "warning" : "info",
  };
}
