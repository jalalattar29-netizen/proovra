/**
 * TEAM-SPEC perf pass (2026-11-23) — the batched current-round decision read.
 *
 * `loadCurrentReviewDecisions` used to read the second-review requirement once
 * per workflow (`secondReviewForRound`, 5–7 statements each) and asked for the
 * current-round decision rows with one OR branch per workflow. It now reads
 * the requirement for the whole batch in a constant number of statements and
 * asks for the rows with one `workflow_id = ANY(...)`.
 *
 * This suite proves the results did not change: against a real PostgreSQL it
 * seeds every branch the derivation has (resolved rounds, first-only rounds
 * under each second-review trigger — ESCALATED status, an open escalation, an
 * ACTIVE legal hold, a redaction decision — the same triggers in ANOTHER team
 * or no longer active, rounds settled by a request for information with and
 * without a recorded round, pre-round decision events, an event in the same
 * millisecond as the decision, second decisions, conflicts, adjudications,
 * reopened rounds and legacy round-0 workflows) plus a few hundred randomised
 * combinations, and compares the result with the PREVIOUS per-workflow
 * derivation, kept below verbatim as the reference — on the default client
 * and inside an interactive transaction.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let shared: typeof import("@proovra/shared");
let secondReview: typeof import("../src/services/evidence-review/second-review.service.js");
let outcome: typeof import("../src/services/evidence-review/review-outcome.service.js");

type Ref = { id: string; teamId: string | null; evidenceId: string; status: string; decisionRound: number };
type Team = { teamId: string; organizationId: string; ownerId: string };
let A: Team;
let B: Team;

// --- The previous per-workflow derivation, verbatim (reference) -------------

function refLoggedAsResolved(nextValue: unknown) {
  const v = (nextValue ?? {}) as { state?: unknown; stage?: unknown };
  if (v.state !== "resolved") return null;
  return shared.reviewDecisionFromProjection({ state: "resolved", projectedStage: typeof v.stage === "string" ? v.stage : null });
}
function refMovedTo(value: unknown): string | null {
  const v = (value ?? {}) as { status?: unknown; stage?: unknown };
  const to = typeof v.status === "string" ? v.status : typeof v.stage === "string" ? v.stage : null;
  return to ? to.toUpperCase() : null;
}
function refLegacyVerdictFromHistory(history: ReadonlyArray<{ eventType: string; nextValue: unknown }>) {
  for (const e of history) {
    if (e.eventType === "REOPENED") return "NO_DECISION";
    const byType = shared.legacyReviewDecisionFromStatus(e.eventType);
    if (byType !== "NO_DECISION") return byType;
    const to = refMovedTo(e.nextValue);
    if (to === null || e.eventType === "CLOSED" || to === "CLOSED") continue;
    if (e.eventType === "ASSIGNED" || e.eventType === "REASSIGNED" || e.eventType === "CLAIMED" || e.eventType === "UNASSIGNED") continue;
    return shared.legacyReviewDecisionFromStatus(to);
  }
  return "NO_DECISION";
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function referenceDecisions(workflows: ReadonlyArray<Ref>, client: any): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (workflows.length === 0) return out;
  const roundOf = new Map(workflows.map((w) => [w.id, w.decisionRound]));
  const rows = await client.workflowReviewDecision.findMany({
    where: { OR: workflows.map((w) => ({ workflowId: w.id, round: w.decisionRound })) },
    orderBy: { decidedAt: "asc" },
    select: { workflowId: true, round: true, stage: true, decision: true, reviewerUserId: true },
  });
  const roundRows = new Map<string, unknown[]>();
  for (const r of rows) {
    if (r.round !== roundOf.get(r.workflowId)) continue;
    const list = roundRows.get(r.workflowId) ?? [];
    list.push(r);
    roundRows.set(r.workflowId, list);
  }
  const events = await client.evidenceReviewWorkflowEvent.findMany({
    where: { workflowId: { in: [...roundRows.keys()] }, eventType: "DECISION_LOGGED" },
    orderBy: { createdAt: "desc" },
    select: { workflowId: true, nextValue: true },
  });
  const resolvedInRound = new Map<string, string>();
  for (const e of events) {
    if (resolvedInRound.has(e.workflowId)) continue;
    const round = (e.nextValue as { round?: unknown } | null)?.round;
    if (round !== roundOf.get(e.workflowId)) continue;
    const verdict = refLoggedAsResolved(e.nextValue);
    if (verdict !== null) resolvedInRound.set(e.workflowId, verdict);
  }
  const legacyHistoryNeeded: Ref[] = [];
  for (const wf of workflows) {
    const current = roundRows.get(wf.id);
    if (current && current.length > 0 && wf.teamId) {
      const reached = resolvedInRound.get(wf.id);
      if (reached !== undefined) {
        out.set(wf.id, reached);
        continue;
      }
      const second = await secondReview.secondReviewForRound(
        { workflowId: wf.id, teamId: wf.teamId, evidenceId: wf.evidenceId, round: wf.decisionRound },
        client,
      );
      out.set(wf.id, shared.reviewDecisionFromProjection(shared.deriveDecisionProjection(current as never, second.required)));
      continue;
    }
    if (wf.decisionRound !== 0) {
      out.set(wf.id, "NO_DECISION");
      continue;
    }
    const fromStatus = shared.legacyReviewDecisionFromStatus(wf.status);
    if (fromStatus !== "NO_DECISION") {
      out.set(wf.id, fromStatus);
      continue;
    }
    if (String(wf.status).toUpperCase() === "CLOSED") legacyHistoryNeeded.push(wf);
    else out.set(wf.id, "NO_DECISION");
  }
  if (legacyHistoryNeeded.length > 0) {
    const history = await client.evidenceReviewWorkflowEvent.findMany({
      where: { workflowId: { in: legacyHistoryNeeded.map((w) => w.id) } },
      orderBy: { createdAt: "desc" },
      select: { workflowId: true, eventType: true, nextValue: true },
    });
    const byWorkflow = new Map<string, Array<{ eventType: string; nextValue: unknown }>>();
    for (const h of history) {
      const list = byWorkflow.get(h.workflowId) ?? [];
      list.push({ eventType: String(h.eventType), nextValue: h.nextValue });
      byWorkflow.set(h.workflowId, list);
    }
    for (const wf of legacyHistoryNeeded) out.set(wf.id, refLegacyVerdictFromHistory(byWorkflow.get(wf.id) ?? []));
  }
  return out;
}

// --- Seeding ------------------------------------------------------------------

type Trigger = "none" | "escalatedStatus" | "adminEscalatedStatus" | "openEsc" | "autoEsc" | "openEscOtherTeam" | "resolvedEsc" | "hold" | "holdOtherTeam" | "releasedHold" | "redaction";
type EventShape = "none" | "round" | "noRound" | "noRoundSettledByInfo" | "roundSettledByInfo" | "sameMs" | "noRoundBefore";
type Spec = {
  status: string;
  round: number;
  rounds: Array<{ round: number; first?: string; second?: string; adj?: string }>;
  events: EventShape;
  trigger: Trigger;
  history?: Array<{ eventType: string; nextValue: unknown }>;
};

const DAY = 86400_000;
let clock = Date.UTC(2026, 5, 1);
const tick = (ms = 1000) => new Date((clock += ms));

async function mkTeam(label: string): Promise<Team> {
  const email = `trp-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
  const owner = await prisma.user.create({
    data: { email, firstName: "TRP", lastName: label, provider: "EMAIL", providerUserId: email },
    select: { id: true },
  });
  const { ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js");
  const space = await ensurePersonalWorkspace({ userId: owner.id });
  const t = await prisma.team.findUniqueOrThrow({ where: { id: space.teamId }, select: { organizationId: true } });
  return { teamId: space.teamId, organizationId: t.organizationId as string, ownerId: owner.id };
}

async function mk(spec: Spec): Promise<Ref> {
  const team = A;
  const evidenceId = randomUUID();
  const id = randomUUID();
  await prisma.evidence.create({
    data: { id: evidenceId, title: "trp", type: "PHOTO", status: "CREATED", teamId: team.teamId, organizationId: team.organizationId, ownerUserId: team.ownerId } as never,
  });
  await prisma.evidenceReviewWorkflow.create({
    data: { id, evidenceId, teamId: team.teamId, workspaceType: "TEAM", status: spec.status as never, decisionRound: spec.round },
  });
  let lastDecidedAt: Date | null = null;
  for (const r of spec.rounds) {
    for (const [stage, decision] of [["FIRST", r.first], ["SECOND", r.second], ["ADJUDICATION", r.adj]] as const) {
      if (!decision) continue;
      lastDecidedAt = tick();
      await prisma.workflowReviewDecision.create({
        data: { workflowId: id, teamId: team.teamId, stage, reviewerUserId: team.ownerId, decision: decision as never, rationale: "trp", decidedAt: lastDecidedAt, round: r.round },
      });
    }
  }
  const ev = (nextValue: unknown, createdAt: Date) =>
    prisma.evidenceReviewWorkflowEvent.create({
      data: { workflowId: id, evidenceId, actorUserId: team.ownerId, eventType: "DECISION_LOGGED", nextValue: nextValue as never, createdAt },
    });
  const at = lastDecidedAt ?? tick();
  switch (spec.events) {
    case "round":
      await ev({ stage: "IN_REVIEW", round: spec.round, state: "second_required" }, new Date(at.getTime() + 5));
      break;
    case "roundSettledByInfo":
      await ev({ stage: "NEEDS_MORE_INFO", round: spec.round, state: "resolved" }, new Date(at.getTime() + 5));
      break;
    case "noRound":
      await ev({ stage: "IN_REVIEW", state: "second_required" }, new Date(at.getTime() + 5));
      break;
    case "noRoundSettledByInfo":
      await ev({ stage: "NEEDS_MORE_INFO", state: "resolved" }, new Date(at.getTime() + 5));
      await ev({ stage: "IN_REVIEW", state: "second_required" }, new Date(at.getTime() + 50));
      break;
    case "noRoundBefore":
      // Only an event BEFORE the round's latest decision: nothing settles it.
      await ev({ stage: "NEEDS_MORE_INFO", state: "resolved" }, new Date(at.getTime() - 500));
      break;
    case "sameMs":
      // Same timestamp as the decision (one transaction): `>=` decides, at the
      // database's microsecond precision.
      await ev({ stage: "NEEDS_MORE_INFO", state: "resolved" }, at);
      break;
    case "none":
      break;
  }
  for (const h of spec.history ?? []) {
    await prisma.evidenceReviewWorkflowEvent.create({
      data: { workflowId: id, evidenceId, actorUserId: team.ownerId, eventType: h.eventType as never, nextValue: h.nextValue as never, createdAt: tick() },
    });
  }
  // Team remediation T-013 — a PERSON's escalation forces a second review;
  // one the automatic overdue sweep raised alone (autoEsc) does not.
  const esc = (teamId: string, status: string, automatic = false) =>
    prisma.reviewEscalation.create({
      data: {
        teamId,
        workflowId: id,
        evidenceId,
        reason: automatic ? "REVIEW_OVERDUE" : "INTEGRITY_RISK",
        severity: "WARNING",
        status,
        safeSummary: "trp",
        fingerprint: `trp:${randomUUID()}`,
        createdByUserId: automatic ? null : team.ownerId,
      },
    });
  const hold = (teamId: string, status: string) =>
    prisma.evidenceLegalHold.create({
      data: { teamId, scope: "EVIDENCE", evidenceId, title: "trp", status, placedByUserId: team.ownerId } as never,
    });
  switch (spec.trigger) {
    case "escalatedStatus":
      // Review remediation (2026-11-27): a stored ESCALATED status forces a
      // second review only when a reviewer disagreement put it there.
      await prisma.evidenceReviewWorkflow.update({
        where: { id },
        data: { status: "ESCALATED", escalationReason: "reviewer_disagreement" },
      });
      break;
    case "adminEscalatedStatus":
      // An administrative Escalate moved the status: it adds no second reviewer.
      await prisma.evidenceReviewWorkflow.update({ where: { id }, data: { status: "ESCALATED", escalationReason: "counsel please" } });
      break;
    case "openEsc":
      await esc(team.teamId, "ACKNOWLEDGED");
      break;
    case "autoEsc":
      await esc(team.teamId, "OPEN", true);
      break;
    case "openEscOtherTeam":
      await esc(B.teamId, "OPEN");
      break;
    case "resolvedEsc":
      await esc(team.teamId, "RESOLVED");
      break;
    case "hold":
      await hold(team.teamId, "ACTIVE");
      break;
    case "holdOtherTeam":
      await hold(B.teamId, "ACTIVE");
      break;
    case "releasedHold":
      await hold(team.teamId, "RELEASED");
      break;
    case "redaction": {
      const inst = await prisma.evidenceWorkflowInstance.create({
        data: { teamId: team.teamId, intakeMode: "INTERNAL", actorRole: "MEMBER", status: "IN_REVIEW" } as never,
        select: { id: true },
      });
      await prisma.evidenceWorkflowVisibilityDecision.create({
        data: { workflowInstanceId: inst.id, evidenceId, fieldKey: "face", requiresRedaction: true, reason: "trp" } as never,
      });
      break;
    }
    case "none":
      break;
  }
  // The caller's view of the status may be stale (the batched read must still
  // read the stored status, as the per-workflow one did).
  return { id, teamId: team.teamId, evidenceId, status: spec.status, decisionRound: spec.round };
}

// Deterministic PRNG.
let seed = 0x7a11c0de;
function rnd(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

const TRIGGERS: Trigger[] = ["none", "escalatedStatus", "adminEscalatedStatus", "openEsc", "autoEsc", "openEscOtherTeam", "resolvedEsc", "hold", "holdOtherTeam", "releasedHold", "redaction"];
const EVENTS: EventShape[] = ["none", "round", "noRound", "noRoundSettledByInfo", "roundSettledByInfo", "sameMs", "noRoundBefore"];

const named: Record<string, Spec> = {};
const refs = new Map<string, Ref>();
const all: Ref[] = [];

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  shared = await import("@proovra/shared");
  secondReview = await import("../src/services/evidence-review/second-review.service.js");
  outcome = await import("../src/services/evidence-review/review-outcome.service.js");
  A = await mkTeam("a");
  B = await mkTeam("b");

  // Every first-only branch, each trigger x each event shape.
  for (const trigger of TRIGGERS)
    for (const events of EVENTS) {
      for (const first of ["APPROVE", "REJECT"]) {
        named[`first-${first}-${trigger}-${events}`] = { status: "IN_REVIEW", round: 0, rounds: [{ round: 0, first }], events, trigger };
      }
    }
  Object.assign(named, {
    "first+second agree": { status: "IN_REVIEW", round: 0, rounds: [{ round: 0, first: "APPROVE", second: "APPROVE" }], events: "noRound", trigger: "hold" },
    "first+second conflict": { status: "ESCALATED", round: 0, rounds: [{ round: 0, first: "APPROVE", second: "REJECT" }], events: "noRound", trigger: "none" },
    "adjudicated": { status: "IN_REVIEW", round: 0, rounds: [{ round: 0, first: "APPROVE", second: "REJECT", adj: "UPHOLD_SECOND" }], events: "noRound", trigger: "hold" },
    "adjudication unresolved": { status: "IN_REVIEW", round: 0, rounds: [{ round: 0, first: "APPROVE", second: "REJECT", adj: "UNRESOLVED" }], events: "none", trigger: "none" },
    "reopened, rows only in round 0": { status: "REOPENED", round: 1, rounds: [{ round: 0, first: "APPROVE" }], events: "round", trigger: "none" },
    "reopened, decided in round 1 under a hold": { status: "IN_REVIEW", round: 1, rounds: [{ round: 0, first: "REJECT" }, { round: 1, first: "APPROVE" }], events: "noRound", trigger: "hold" },
    "reopened, decided in round 1": { status: "IN_REVIEW", round: 1, rounds: [{ round: 0, first: "REJECT" }, { round: 1, first: "APPROVE" }], events: "noRound", trigger: "none" },
    "legacy approved status": { status: "APPROVED_INTERNAL", round: 0, rounds: [], events: "none", trigger: "none" },
    "legacy closed after approval": { status: "CLOSED", round: 0, rounds: [], events: "none", trigger: "none", history: [{ eventType: "APPROVED_INTERNAL", nextValue: { status: "APPROVED_INTERNAL" } }, { eventType: "CLOSED", nextValue: { status: "CLOSED" } }] },
    "legacy closed after reopen": { status: "CLOSED", round: 0, rounds: [], events: "none", trigger: "none", history: [{ eventType: "APPROVED_INTERNAL", nextValue: { status: "APPROVED_INTERNAL" } }, { eventType: "REOPENED", nextValue: { status: "REOPENED" } }, { eventType: "CLOSED", nextValue: { status: "CLOSED" } }] },
    "queued, nothing decided": { status: "QUEUED", round: 0, rounds: [], events: "none", trigger: "hold" },
  } satisfies Record<string, Spec>);
  for (const [name, spec] of Object.entries(named)) {
    const ref = await mk(spec);
    refs.set(name, ref);
    all.push(ref);
  }
  // Randomised combinations.
  for (let i = 0; i < 250; i++) {
    const round = rnd() < 0.2 ? 1 : 0;
    const shape = pick(["first", "first", "first", "agree", "conflict", "adj"] as const);
    const first = pick(["APPROVE", "REJECT", "REQUEST_INFO"]);
    const r: Spec["rounds"][number] = { round, first };
    if (shape === "agree") r.second = first;
    if (shape === "conflict" || shape === "adj") r.second = first === "APPROVE" ? "REJECT" : "APPROVE";
    if (shape === "adj") r.adj = pick(["UPHOLD_FIRST", "UPHOLD_SECOND", "UNRESOLVED"]);
    const rounds = round === 1 ? [{ round: 0, first: pick(["APPROVE", "REJECT"]) }, r] : [r];
    all.push(await mk({ status: pick(["IN_REVIEW", "ASSIGNED", "CLOSED", "APPROVED_INTERNAL", "ESCALATED"]), round, rounds, events: pick(EVENTS), trigger: pick(TRIGGERS) }));
  }
  clock += DAY;
});

afterAll(async () => {
  // This suite seeds hundreds of holds directly. CI runs every integration
  // suite on ONE shared database, where global sweeps (legal-hold custody
  // reconcile) page every hold — so the seeded holds leave that sweep when done.
  if (prisma && A && B) {
    // Holds are append-only (DELETE is refused by the database), so they are
    // marked historical, which takes them off the custody sweep.
    await prisma.evidenceLegalHold.updateMany({ where: { teamId: { in: [A.teamId, B.teamId] } }, data: { historical: true } as never });
  }
  if (harness) await harness.cleanup();
});

describe("batched current-round decisions equal the per-workflow derivation", () => {
  it("on every seeded branch and combination (default client)", async () => {
    const expected = await referenceDecisions(all, prisma);
    const actual = await outcome.loadCurrentReviewDecisions(all, prisma as never);
    expect(actual.size).toBe(all.length);
    const diff = all.filter((w) => actual.get(w.id) !== expected.get(w.id)).map((w) => ({ id: w.id, expected: expected.get(w.id), actual: actual.get(w.id) }));
    expect(diff).toEqual([]);
    // Each workflow alone gives the same answer as in the batch.
    for (const w of all.slice(0, 60)) {
      expect(await outcome.loadCurrentReviewDecision(w, prisma as never)).toBe(expected.get(w.id));
    }
  });

  it("inside an interactive transaction", async () => {
    const [expected, actual] = await prisma.$transaction(async (tx) => [
      await referenceDecisions(all, tx),
      await outcome.loadCurrentReviewDecisions(all, tx as never),
    ]);
    expect(all.filter((w) => actual.get(w.id) !== expected.get(w.id))).toEqual([]);
  });

  it("the branches carry the verdicts the rule names", async () => {
    const got = await outcome.loadCurrentReviewDecisions([...refs.values()], prisma as never);
    const v = (name: string) => got.get(refs.get(name)!.id);
    // No trigger, or a trigger that does not count (another team, no longer active): the first verdict stands.
    for (const t of ["none", "adminEscalatedStatus", "autoEsc", "openEscOtherTeam", "resolvedEsc", "holdOtherTeam", "releasedHold"]) {
      expect(v(`first-APPROVE-${t}-noRound`), t).toBe("APPROVED");
      // Team remediation T-017 / binding direction 4 — a FIRST decision logged
      // for THIS round as "second review required" keeps that requirement once
      // its trigger is gone (an event with no recorded cause is treated as
      // pinned): lifting the trigger never finalises the first verdict. The
      // explicit re-evaluation (T-014) is the way out for such legacy rounds.
      expect(v(`first-REJECT-${t}-round`), t).toBe("NO_DECISION");
    }
    // Each live trigger holds the round at "second review required".
    for (const t of ["escalatedStatus", "openEsc", "hold", "redaction"]) {
      expect(v(`first-APPROVE-${t}-noRound`), t).toBe("NO_DECISION");
      expect(v(`first-APPROVE-${t}-none`), t).toBe("NO_DECISION");
      expect(v(`first-APPROVE-${t}-noRoundBefore`), t).toBe("NO_DECISION");
      // A round a request for information settled needs no second review.
      expect(v(`first-APPROVE-${t}-noRoundSettledByInfo`), t).toBe("APPROVED");
      expect(v(`first-APPROVE-${t}-sameMs`), t).toBe("APPROVED");
    }
    expect(v("first+second agree")).toBe("APPROVED");
    expect(v("first+second conflict")).toBe("NO_DECISION");
    expect(v("adjudicated")).toBe("NOT_ACCEPTED");
    expect(v("reopened, rows only in round 0")).toBe("NO_DECISION");
    expect(v("reopened, decided in round 1")).toBe("APPROVED");
    expect(v("reopened, decided in round 1 under a hold")).toBe("NO_DECISION");
    expect(v("legacy approved status")).toBe("APPROVED");
    expect(v("legacy closed after approval")).toBe("APPROVED");
    expect(v("legacy closed after reopen")).toBe("NO_DECISION");
  });
});
