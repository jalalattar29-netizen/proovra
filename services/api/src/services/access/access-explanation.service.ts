/**
 * WHY THIS PERSON HAS ACCESS (members audit ACC-11).
 *
 * The decision itself already had one home per record kind
 * (`resolveCaseRecordAccess`, `resolveEvidenceRecordAccess`), but nothing could
 * EXPLAIN it, so an administrator had no way to answer "why can Dana open
 * this?". This projection answers from those same authorities — it decides
 * nothing of its own — and keeps two things apart that the old surfaces ran
 * together:
 *
 *   MANAGEMENT  what the person may administer (their workspace role). It is
 *               never content access: an OWNER or ADMIN does not open a
 *               restricted case by being one.
 *   REACH       whether they can open a given record, and the single path
 *               that gives it to them.
 *
 * Privacy: it names only this workspace's Collaboration Teams (which the
 * asking administrator administers), never an invitation address, and only
 * explains a record the ASKING administrator can open themself.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveCaseRecordAccess } from "../cases/case-permission.service.js";
import { resolveEvidenceRecordAccess } from "../evidence/evidence-record-access.service.js";
import { CASE_VISIBILITY_SELECT } from "../cases/case-visibility.js";

export type AccessPath =
  | "WORKSPACE_CAPABILITY"
  | "CASE_OWNER"
  | "DIRECT_CASE_GRANT"
  | "COLLABORATION_TEAM_GRANT"
  | "NO_CURRENT_ACCESS";

export type MemberAccessExplanation = {
  membership: {
    status: string;
    role: string;
    accessExpiresAtUtc: string | null;
    active: boolean;
  };
  management: { isOwner: boolean; administersMembers: boolean };
  collaborationTeams: Array<{ id: string; name: string; status: string }>;
  /** Active member with no Collaboration Team placement. */
  unassigned: boolean;
  directCaseGrantCount: number;
  record: null | {
    kind: "case" | "evidence";
    id: string;
    restricted: boolean;
    allowed: boolean;
    via: AccessPath;
    /** The team that grants it, when via is COLLABORATION_TEAM_GRANT. */
    viaTeam: { id: string; name: string } | null;
  };
};

export async function explainMemberAccess(
  input: {
    teamId: string;
    subjectUserId: string;
    caseId?: string | null;
    evidenceId?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<MemberAccessExplanation | null> {
  const member = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.teamId, userId: input.subjectUserId } },
    select: { status: true, role: true, accessExpiresAtUtc: true },
  });
  if (!member) return null;

  const active =
    member.status === "ACTIVE" &&
    (member.accessExpiresAtUtc === null || member.accessExpiresAtUtc.getTime() > Date.now());

  const groups = await client.collaborationTeamMember.findMany({
    where: { userId: input.subjectUserId, status: "ACTIVE", team: { workspaceId: input.teamId } },
    select: { team: { select: { id: true, name: true, status: true } } },
  });
  const collaborationTeams = groups.map((g) => g.team);
  const directCaseGrantCount = await client.caseAccess.count({
    where: { userId: input.subjectUserId, case: { teamId: input.teamId } },
  });

  let record: MemberAccessExplanation["record"] = null;
  const caseIds: string[] = [];
  let kind: "case" | "evidence" | null = null;
  let recordId: string | null = null;
  let allowed = false;

  if (input.caseId) {
    kind = "case";
    recordId = input.caseId;
    caseIds.push(input.caseId);
    allowed = (await resolveCaseRecordAccess({ userId: input.subjectUserId, caseId: input.caseId }, client))
      .allowed;
  } else if (input.evidenceId) {
    kind = "evidence";
    recordId = input.evidenceId;
    const links = await client.caseEvidenceLink.findMany({
      where: { evidenceId: input.evidenceId },
      select: { caseId: true },
    });
    caseIds.push(...links.map((l) => l.caseId));
    allowed = (
      await resolveEvidenceRecordAccess(
        { userId: input.subjectUserId, evidenceId: input.evidenceId, permission: "evidence.read" },
        client,
      )
    ).allowed;
  }

  if (kind && recordId) {
    const cases = caseIds.length
      ? await client.case.findMany({ where: { id: { in: caseIds } }, select: { id: true, ...CASE_VISIBILITY_SELECT, teamAccess: { select: { collaborationTeam: { select: { id: true, name: true, workspaceId: true, status: true, members: { select: { userId: true, status: true } } } } } } } })
      : [];
    const restricted = cases.some(
      (c) => c.restrictedAtUtc !== null || c.access.length > 0 || c.teamAccess.length > 0,
    );
    let via: AccessPath = "NO_CURRENT_ACCESS";
    let viaTeam: { id: string; name: string } | null = null;
    if (allowed) {
      via = "WORKSPACE_CAPABILITY";
      for (const c of cases.filter((x) => x.access.length > 0 || x.teamAccess.length > 0)) {
        if (c.ownerUserId === input.subjectUserId) {
          via = "CASE_OWNER";
          break;
        }
        if (c.access.some((a) => a.userId === input.subjectUserId)) {
          via = "DIRECT_CASE_GRANT";
          break;
        }
        const grant = c.teamAccess.find(
          (g) =>
            g.collaborationTeam.status === "ACTIVE" &&
            g.collaborationTeam.members.some((m) => m.userId === input.subjectUserId && m.status === "ACTIVE"),
        );
        if (grant) {
          via = "COLLABORATION_TEAM_GRANT";
          viaTeam = { id: grant.collaborationTeam.id, name: grant.collaborationTeam.name };
          break;
        }
      }
    }
    record = { kind, id: recordId, restricted, allowed, via, viaTeam };
  }

  return {
    membership: {
      status: member.status,
      role: member.role,
      accessExpiresAtUtc: member.accessExpiresAtUtc ? member.accessExpiresAtUtc.toISOString() : null,
      active,
    },
    management: {
      isOwner: member.role === "OWNER",
      administersMembers: active && (member.role === "OWNER" || member.role === "ADMIN"),
    },
    collaborationTeams,
    unassigned: active && member.role !== "OWNER" && collaborationTeams.length === 0,
    directCaseGrantCount,
    record,
  };
}
