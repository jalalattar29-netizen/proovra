/**
 * Review remediation IR-03 (2026-11-28) — the explicit complete-coding policy
 * holds on ADJUDICATION too, against a real PostgreSQL and the real routes.
 *
 * An adjudication that upholds a reviewer's APPROVE / REJECT finishes the
 * review with that verdict, so it is refused with `coding_incomplete` (and
 * the missing labels) exactly like a verdict when the policy applies:
 *   - policy on before Start, required coding complete for FIRST / SECOND,
 *     the decisions conflict, a required field is cleared while the review is
 *     open → UPHOLD_FIRST / UPHOLD_SECOND are refused, nothing is recorded;
 *     once the field is completed the adjudication succeeds and its decision
 *     event carries the exact coding snapshot;
 *   - adjudicated NEEDS_MORE_INFO and UNRESOLVED stay exempt;
 *   - policy off: never refused;
 *   - a round started BEFORE the policy was switched on stays exempt.
 * Assertions read persisted rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let schemaSvc: typeof import("../src/services/reviewer-workspace/coding-schema.service.js");
let requiredLegalVersions: Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; token: string };

let T: { teamId: string; owner: Actor; admin: Actor; member: Actor; member2: Actor };

async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, raw: res.body };
}

let seq = 0;
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `radj-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "RADJ", lastName: label, displayName: `RADJ ${label}`, provider: "EMAIL", providerUserId: email },
    select: { id: true },
  });
  await prisma.userLegalAcceptance.createMany({
    data: Object.entries(requiredLegalVersions).map(([policyKey, policyVersion]) => ({
      userId: user.id,
      policyKey,
      policyVersion: policyVersion as string,
      source: "integration-harness",
    })),
  });
  return { userId: user.id, token: await harness.mintSessionToken(user.id, email) };
}

/** A review whose evidence is under an ACTIVE legal hold, so a second review is required. */
async function heldWorkflow(title: string) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: T.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title, type: "PHOTO", status: "CREATED", teamId: T.teamId, organizationId: t.organizationId, ownerUserId: T.owner.userId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId: T.teamId, status: "NOT_STARTED", workspaceType: "TEAM" },
      select: { id: true },
    })
  ).id;
  await prisma.evidenceLegalHold.create({
    data: { scope: "EVIDENCE", evidenceId, teamId: T.teamId, status: "ACTIVE", title: "Hold", placedByUserId: T.owner.userId } as never,
  });
  return workflowId;
}

let fields: { schemaId: string; verdict: string; notes: string };

async function setPolicy(on: boolean, since: Date | null) {
  await prisma.workspaceGovernancePolicy.upsert({
    where: { teamId: T.teamId },
    create: { teamId: T.teamId, reviewRequiresCompleteCoding: on, reviewRequiresCompleteCodingSince: since },
    update: { reviewRequiresCompleteCoding: on, reviewRequiresCompleteCodingSince: since },
  });
}

const q = () => `teamId=${T.teamId}`;
const ops = {
  assign: (a: Actor, wf: string, to: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/assign`, { teamId: T.teamId, assignedToUserId: to }),
  reassign: (a: Actor, wf: string, to: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/reassign`, { teamId: T.teamId, newAssigneeUserId: to }),
  start: (a: Actor, wf: string) => call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/start`, { teamId: T.teamId }),
  decide: (a: Actor, wf: string, decision: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/workspace/${wf}/decisions`, { teamId: T.teamId, decision, rationale: `why ${decision}` }),
  bind: (a: Actor, wf: string) => call(a.token, "POST", `/v1/reviewer/work/${wf}/bind-schema?${q()}`, { schemaId: fields.schemaId }),
  code: (a: Actor, wf: string, fieldId: string, value: Record<string, unknown>) =>
    call(a.token, "POST", `/v1/reviewer/work/${wf}/code?${q()}`, { fieldId, value }),
  clear: (a: Actor, wf: string, fieldId: string) => call(a.token, "POST", `/v1/reviewer/work/${wf}/code?${q()}`, { fieldId, clear: true }),
};

const decisionRows = (wf: string) =>
  prisma.workflowReviewDecision.findMany({ where: { workflowId: wf }, orderBy: { decidedAt: "asc" }, select: { stage: true, decision: true } });

/**
 * A bound review in conflict: member codes everything and approves (FIRST),
 * member2 rejects (SECOND). The policy state is whatever the caller set
 * BEFORE this runs (it is read at Start).
 */
async function conflictedReview(title: string): Promise<string> {
  const wf = await heldWorkflow(title);
  expect((await ops.bind(T.admin, wf)).status).toBe(200);
  expect((await ops.assign(T.owner, wf, T.member.userId)).status).toBe(200);
  expect((await ops.start(T.member, wf)).status).toBe(200);
  expect((await ops.code(T.member, wf, fields.verdict, { verdict: "APPROVE" })).status).toBe(200);
  expect((await ops.code(T.member, wf, fields.notes, { text: "custody complete" })).status).toBe(200);
  const first = await ops.decide(T.member, wf, "APPROVE");
  expect([200, 201], first.raw).toContain(first.status);
  expect((await ops.reassign(T.admin, wf, T.member2.userId)).status).toBe(200);
  const second = await ops.decide(T.member2, wf, "REJECT");
  expect([200, 201], second.raw).toContain(second.status);
  expect(second.body.outcome).toMatchObject({ reviewState: "conflict_detected", nextRequirement: "adjudication" });
  return wf;
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  schemaSvc = await import("../src/services/reviewer-workspace/coding-schema.service.js");
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));

  const owner = await newUser("owner");
  const { ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js");
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  const admin = await newUser("admin");
  const member = await newUser("member");
  const member2 = await newUser("member2");
  for (const [u, role] of [
    [admin, "ADMIN"],
    [member, "MEMBER"],
    [member2, "MEMBER"],
  ] as const) {
    await prisma.teamMember.create({ data: { teamId: space.teamId, userId: u.userId, role, status: "ACTIVE" } });
  }
  await placeInCollaborationTeam(prisma, {
    workspaceId: space.teamId,
    createdByUserId: owner.userId,
    userIds: [admin.userId, member.userId, member2.userId],
  });
  T = { teamId: space.teamId, owner, admin, member, member2 };

  const created = await schemaSvc.createSchema({
    teamId: T.teamId,
    authorUserId: owner.userId,
    slug: `radj-${Date.now()}`,
    label: "Adjudication coding",
    category: "GENERAL_EVIDENCE",
    fields: [
      { slug: "verdict", label: "Verdict", fieldType: "REVIEWER_VERDICT", required: true, orderIndex: 0 },
      { slug: "notes", label: "Custody notes", fieldType: "TEXT", required: true, orderIndex: 1 },
    ],
  });
  if (!created.ok) throw new Error(`createSchema refused: ${created.denial}`);
  expect(await schemaSvc.publishSchema({ teamId: T.teamId, schemaId: created.schemaId })).toMatchObject({ ok: true });
  const rows = await prisma.codingField.findMany({ where: { schemaId: created.schemaId }, orderBy: { orderIndex: "asc" } });
  fields = { schemaId: created.schemaId, verdict: rows[0]!.id, notes: rows[1]!.id };
}, 900_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

describe("IR-03 — complete-coding policy on adjudication", () => {
  it("policy on before Start; a required field cleared after the conflict: UPHOLD_FIRST / UPHOLD_SECOND are refused with the missing label; completed → recorded with the exact snapshot", async () => {
    await setPolicy(true, new Date(Date.now() - 60_000));
    try {
      const wf = await conflictedReview("radj-refused");
      // Clearing a required field while the review is open is allowed (coding stays editable).
      const cleared = await ops.clear(T.member2, wf, fields.notes);
      expect(cleared.status, cleared.raw).toBe(200);

      for (const kind of ["UPHOLD_FIRST", "UPHOLD_SECOND"]) {
        const refused = await ops.decide(T.admin, wf, kind);
        expect(refused.status, refused.raw).toBeGreaterThanOrEqual(400);
        expect(refused.raw).toContain("coding_incomplete");
        expect(refused.raw).toContain("Custody notes");
      }
      expect((await decisionRows(wf)).map((d) => d.stage)).toEqual(["FIRST", "SECOND"]);
      expect(String((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: wf } })).status)).not.toMatch(
        /APPROVED|REJECTED/,
      );

      expect((await ops.code(T.member2, wf, fields.notes, { text: "custody re-checked" })).status).toBe(200);
      const ok = await ops.decide(T.admin, wf, "UPHOLD_SECOND");
      expect([200, 201], ok.raw).toContain(ok.status);
      expect((await decisionRows(wf)).map((d) => `${d.stage}:${d.decision}`)).toEqual([
        "FIRST:APPROVE",
        "SECOND:REJECT",
        "ADJUDICATION:UPHOLD_SECOND",
      ]);
      const events = await prisma.evidenceReviewWorkflowEvent.findMany({
        where: { workflowId: wf, eventType: "DECISION_LOGGED" },
        orderBy: { createdAt: "asc" },
      });
      const snap = (events.at(-1)!.nextValue as { codingSnapshot?: { values: Array<{ slug: string; value: unknown }> } })
        .codingSnapshot;
      expect(snap?.values).toEqual([
        expect.objectContaining({ slug: "verdict", value: { verdict: "APPROVE" } }),
        expect.objectContaining({ slug: "notes", value: { text: "custody re-checked" } }),
      ]);
    } finally {
      await setPolicy(false, null);
    }
  });

  it("adjudicated NEEDS_MORE_INFO and UNRESOLVED stay exempt (no final approval or rejection)", async () => {
    await setPolicy(true, new Date(Date.now() - 60_000));
    try {
      for (const kind of ["NEEDS_MORE_INFO", "UNRESOLVED"]) {
        const wf = await conflictedReview(`radj-exempt-${kind}`);
        expect((await ops.clear(T.member2, wf, fields.notes)).status).toBe(200);
        const res = await ops.decide(T.admin, wf, kind);
        expect([200, 201], res.raw).toContain(res.status);
        expect(res.raw).not.toContain("coding_incomplete");
      }
    } finally {
      await setPolicy(false, null);
    }
  });

  it("policy off: an adjudication with a required field missing is recorded", async () => {
    await setPolicy(false, null);
    const wf = await conflictedReview("radj-off");
    expect((await ops.clear(T.member2, wf, fields.notes)).status).toBe(200);
    const res = await ops.decide(T.admin, wf, "UPHOLD_FIRST");
    expect([200, 201], res.raw).toContain(res.status);
  });

  it("a round started BEFORE the policy was switched on stays exempt at adjudication", async () => {
    await setPolicy(false, null);
    try {
      const wf = await conflictedReview("radj-pre-policy");
      // Switched on after this round started.
      await setPolicy(true, new Date(Date.now() + 1_000));
      expect((await ops.clear(T.member2, wf, fields.notes)).status).toBe(200);
      const res = await ops.decide(T.admin, wf, "UPHOLD_FIRST");
      expect([200, 201], res.raw).toContain(res.status);
    } finally {
      await setPolicy(false, null);
    }
  });
});
