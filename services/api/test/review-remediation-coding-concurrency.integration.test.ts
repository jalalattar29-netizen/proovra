/**
 * Review remediation 2026-11-27 — findings A and C (coding concurrency)
 * against a disposable PostgreSQL 16.
 *
 *   A — optimistic field revisions: a change based on a superseded revision is
 *       refused with a typed 409 CODING_VALUE_CONFLICT and nothing is written;
 *       the stored value is the one whose revision matched.
 *   C — coding write / clear, schema rebind and the final decision all take
 *       the workflow row lock first and decide INSIDE it.
 *
 * The races are DETERMINISTIC: one side holds the workflow row lock in an
 * open transaction (optionally doing its real work in it), the other side is
 * started and observed WAITING on that lock in pg_stat_activity, then the
 * holder commits. No sleeps decide an ordering. Every race states its valid
 * outcomes and asserts that no invalid combination persists.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];
type Tx = Parameters<Parameters<Prisma["$transaction"]>[0]>[0];
type SchemaSvc = typeof import("../src/services/reviewer-workspace/coding-schema.service.js");
type ValueSvc = typeof import("../src/services/reviewer-workspace/coding-value.service.js");
type DecisionSvc = typeof import("../src/services/reviewer-ops/review-decision.service.js");

describe("Review remediation — coding concurrency A + C (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let schemaSvc: SchemaSvc;
  let valueSvc: ValueSvc;
  let decisionSvc: DecisionSvc;

  const tag = () => randomUUID().slice(0, 8);
  const team = () => h.fixtures.teamA;

  const call = (opts: { method: "GET" | "POST"; url: string; token: string; payload?: unknown }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });
  const codeUrl = (wf: string) => `/v1/reviewer/work/${wf}/code?teamId=${team().teamId}`;
  const codingUrl = (wf: string) => `/v1/reviewer/work/${wf}/coding?teamId=${team().teamId}`;

  async function newWorkflow(): Promise<{ id: string; evidenceId: string }> {
    const a = team();
    const t = await prisma.team.findUniqueOrThrow({ where: { id: a.teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: {
        title: `rem coding conc ${tag()}`,
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId: a.teamId,
        organizationId: t.organizationId,
        ownerUserId: a.ownerUserId,
      },
      select: { id: true },
    });
    const wf = await prisma.evidenceReviewWorkflow.create({
      data: {
        evidenceId: evidence.id,
        teamId: a.teamId,
        workspaceType: "TEAM",
        status: "IN_REVIEW" as never,
        assignedToUserId: a.memberUserId,
      },
      select: { id: true },
    });
    return { id: wf.id, evidenceId: evidence.id };
  }

  async function publishedSchema(label = "Concurrency schema") {
    const a = team();
    const created = await schemaSvc.createSchema({
      teamId: a.teamId,
      authorUserId: a.ownerUserId,
      slug: `conc-${tag()}`,
      label,
      category: "GENERAL_EVIDENCE",
      fields: [
        { slug: "verdict", label: "Verdict", fieldType: "REVIEWER_VERDICT", required: true, orderIndex: 0 },
        { slug: "notes", label: "Notes", fieldType: "TEXT", required: false, orderIndex: 1 },
      ],
    });
    if (!created.ok) throw new Error(`createSchema refused: ${created.denial}`);
    expect(await schemaSvc.publishSchema({ teamId: a.teamId, schemaId: created.schemaId })).toMatchObject({ ok: true });
    const fields = await prisma.codingField.findMany({ where: { schemaId: created.schemaId }, orderBy: { orderIndex: "asc" } });
    return { schemaId: created.schemaId, verdict: fields[0]!, notes: fields[1]! };
  }

  async function bind(workflowId: string, schemaId: string) {
    const res = await schemaSvc.bindSchemaToWorkflow({ teamId: team().teamId, workflowId, schemaId, actorUserId: team().adminUserId });
    expect(res).toEqual({ ok: true });
  }

  const write = (workflowId: string, fieldId: string, value: Record<string, unknown>, expectedRevision?: number) =>
    valueSvc.writeCodingValue({
      teamId: team().teamId,
      workflowId,
      fieldId,
      value,
      authorUserId: team().memberUserId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
  const clear = (workflowId: string, fieldId: string, expectedRevision?: number) =>
    valueSvc.clearCodingValue({
      teamId: team().teamId,
      workflowId,
      fieldId,
      actorUserId: team().memberUserId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
  const decide = (workflowId: string, decision: "APPROVE" | "REJECT", client?: unknown) =>
    decisionSvc.recordReviewDecision(
      {
        workflowId,
        teamId: team().teamId,
        actorUserId: team().memberUserId,
        decision,
        rationale: `final ${decision} ${tag()}`,
        actorIsAdjudicator: false,
      } as never,
      client as never,
    );

  const stored = async (workflowId: string, fieldId: string) =>
    (await prisma.codingValue.findFirst({ where: { workflowId, fieldId }, select: { value: true } }))?.value ?? null;
  const historyCount = (workflowId: string, fieldId: string) =>
    prisma.codingValueHistory.count({ where: { workflowId, fieldId } });
  const statusOf = async (workflowId: string) =>
    String((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId }, select: { status: true } })).status);
  const finalSnapshots = async (workflowId: string) =>
    (
      await prisma.evidenceReviewWorkflowEvent.findMany({
        where: { workflowId, eventType: "DECISION_LOGGED" },
        orderBy: { createdAt: "asc" },
      })
    )
      .map((e) => (e.nextValue as { codingSnapshot?: { values: Array<{ fieldId: string; value: unknown }> } } | null)?.codingSnapshot)
      .filter((s): s is { values: Array<{ fieldId: string; value: unknown }> } => Boolean(s));

  // ---------------------------------------------------------------------------
  // Barriers
  // ---------------------------------------------------------------------------

  /** Settled-state probe for a promise (no timing involved). */
  function track<T>(p: Promise<T>) {
    const s = { settled: false };
    p.then(
      () => (s.settled = true),
      () => (s.settled = true),
    );
    return s;
  }

  /**
   * Wait until `n` backends are blocked on the workflow row lock. A condition
   * poll on pg_stat_activity — it proves the competing operation reached the
   * lock and is WAITING, rather than guessing with a delay.
   */
  async function waitForLockWaiters(n: number) {
    for (let i = 0; i < 5000; i++) {
      const rows = await prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE '%evidence_review_workflows%FOR UPDATE%'`;
      if (Number(rows[0]!.c) >= n) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`expected ${n} waiter(s) on the workflow lock`);
  }

  /**
   * Hold the workflow row lock in an open transaction. `during` runs the
   * holder's real work inside that transaction (it is committed on release).
   */
  function holdWorkflowLock(workflowId: string, during?: (tx: Tx) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ready!: (v: unknown) => void;
    const heldP = new Promise<unknown>((r) => (ready = r));
    const done = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "evidence_review_workflows" WHERE "id" = ${workflowId}::uuid FOR UPDATE`;
        const out = during ? await during(tx) : undefined;
        ready(out);
        await gate;
        return out;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    const held = Promise.race([heldP, done.then(() => { throw new Error("holder ended before holding"); })]);
    return { held, release, done };
  }

  /**
   * Run the REAL final decision inside a transaction that stays open (holding
   * the workflow lock the decision took) until release.
   */
  function decisionHoldingLock(workflowId: string, decision: "APPROVE" | "REJECT") {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let bodyDone!: () => void;
    const decided = new Promise<void>((r) => (bodyDone = r));
    const done = prisma.$transaction(
      async (tx0) => {
        const client = new Proxy(tx0 as object, {
          get(target, prop) {
            if (prop === "$transaction") {
              return async (fn: (tx: unknown) => Promise<unknown>) => {
                const out = await fn(tx0);
                bodyDone();
                await gate;
                return out;
              };
            }
            return Reflect.get(target, prop);
          },
        });
        return decide(workflowId, decision, client);
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    const ready = Promise.race([decided, done.then(() => undefined)]);
    return { ready, release, done };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    schemaSvc = await import("../src/services/reviewer-workspace/coding-schema.service.js");
    valueSvc = await import("../src/services/reviewer-workspace/coding-value.service.js");
    decisionSvc = await import("../src/services/reviewer-ops/review-decision.service.js");
    const { teamA } = h.fixtures;
    const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } }))
      .organizationId;
    await prisma.team.update({ where: { id: teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, {
      organizationId: orgA,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // A — revisions
  // ===========================================================================
  describe("A — optimistic field revisions (HTTP)", () => {
    it("A delayed so B commits first: A (old revision) is refused with a typed conflict; B is stored", async () => {
      const a = team();
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      const sheet = (await call({ method: "GET", url: codingUrl(wf), token: a.memberToken })).json();
      const base = (sheet.revisions as Record<string, number>)[notes.id] ?? 0;
      expect(base).toBe(0);

      const b = await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, value: { text: "B" }, expectedRevision: base } });
      expect(b.statusCode, b.body).toBe(200);
      expect(b.json().revision).toBe(1);
      const late = await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, value: { text: "A" }, expectedRevision: base } });
      expect(late.statusCode, late.body).toBe(409);
      expect(late.json()).toEqual({
        code: "CODING_VALUE_CONFLICT",
        denial: "CODING_VALUE_CONFLICT",
        message: "This field was changed in another tab or by another reviewer.",
        current: { revision: 1, value: { text: "B" } },
      });
      expect(await stored(wf, notes.id)).toEqual({ text: "B" });
      expect(await historyCount(wf, notes.id)).toBe(1);
      // The refusal is audited as a denied write.
      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: "reviewer.code.write", resourceId: wf, outcome: "denied" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).toMatchObject({ reasonCode: "CODING_VALUE_CONFLICT" });
    });

    it("write then clear then write follow the revisions; a stale clear or a stale write is refused", async () => {
      const a = team();
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      const post = (payload: Record<string, unknown>) =>
        call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, ...payload } });

      const w1 = await post({ value: { text: "one" }, expectedRevision: 0 });
      expect(w1.json()).toMatchObject({ revision: 1 });
      const c1 = await post({ clear: true, expectedRevision: 1 });
      expect(c1.statusCode, c1.body).toBe(200);
      expect(c1.json()).toMatchObject({ cleared: true, revision: 2 });
      expect(await stored(wf, notes.id)).toBeNull();
      // Write after the clear, based on the clear's revision.
      const w2 = await post({ value: { text: "two" }, expectedRevision: 2 });
      expect(w2.json()).toMatchObject({ revision: 3 });
      expect(await stored(wf, notes.id)).toEqual({ text: "two" });

      // A clear based on the write before (revision 1) must not erase "two".
      const staleClear = await post({ clear: true, expectedRevision: 1 });
      expect(staleClear.statusCode).toBe(409);
      expect(staleClear.json().current).toEqual({ revision: 3, value: { text: "two" } });
      expect(await stored(wf, notes.id)).toEqual({ text: "two" });

      // Clear then a stale write: the write (based on 3) after a clear (→4) is refused.
      expect((await post({ clear: true, expectedRevision: 3 })).json()).toMatchObject({ cleared: true, revision: 4 });
      const staleWrite = await post({ value: { text: "resurrected" }, expectedRevision: 3 });
      expect(staleWrite.statusCode).toBe(409);
      expect(staleWrite.json().current).toEqual({ revision: 4, value: null });
      expect(await stored(wf, notes.id)).toBeNull();
      expect(await historyCount(wf, notes.id)).toBe(4);

      // GET reports the cleared field's revision (no current value, but history).
      const sheet = (await call({ method: "GET", url: codingUrl(wf), token: a.memberToken })).json();
      expect(sheet.values).toEqual([]);
      expect(sheet.revisions).toEqual({ [notes.id]: 4 });
    });

    it("two tabs on the same base revision: the second is refused with a conflict; the database holds the first", async () => {
      const a = team();
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, value: { text: "start" } } });
      const read = async () => {
        const v = (await call({ method: "GET", url: codingUrl(wf), token: a.memberToken })).json().values as Array<{ fieldId: string; revision: number }>;
        return v.find((x) => x.fieldId === notes.id)!.revision;
      };
      const tab1Base = await read();
      const tab2Base = await read();
      expect(tab1Base).toBe(1);
      expect(tab2Base).toBe(1);
      const tab1 = await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, value: { text: "tab 1" }, expectedRevision: tab1Base } });
      expect(tab1.statusCode).toBe(200);
      const tab2 = await call({ method: "POST", url: codeUrl(wf), token: a.adminToken, payload: { fieldId: notes.id, value: { text: "tab 2" }, expectedRevision: tab2Base } });
      expect(tab2.statusCode).toBe(409);
      expect(tab2.json()).toMatchObject({ code: "CODING_VALUE_CONFLICT", current: { revision: 2, value: { text: "tab 1" } } });
      expect(await stored(wf, notes.id)).toEqual({ text: "tab 1" });
      expect(await historyCount(wf, notes.id)).toBe(2);
    });

    it("a request without expectedRevision (older client / bulk) keeps last-writer-wins", async () => {
      const a = team();
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      for (const text of ["x", "y"]) {
        const r = await call({ method: "POST", url: codeUrl(wf), token: a.memberToken, payload: { fieldId: notes.id, value: { text } } });
        expect(r.statusCode).toBe(200);
      }
      expect(await stored(wf, notes.id)).toEqual({ text: "y" });
    });
  });

  // ===========================================================================
  // C — the workflow lock, deterministic races
  // ===========================================================================
  describe("C — write / clear vs final approval", () => {
    /*
     * Valid outcomes:
     *   (1) the write commits first → the decision (waiting on the lock) then
     *       finalizes and its snapshot CONTAINS the written value;
     *   (2) the decision commits first → the write (waiting on the lock) sees
     *       the closed review and is refused WORKFLOW_CLOSED; nothing stored.
     * Invalid (asserted never): a value stored on a finalized review after
     * finalization; a final snapshot disagreeing with the stored values.
     */
    it("write holds the lock, decision waits: the snapshot contains the write", async () => {
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      const holder = holdWorkflowLock(wf, (tx) =>
        valueSvc.writeCodingValue({ prisma: tx as never, teamId: team().teamId, workflowId: wf, fieldId: notes.id, value: { text: "in flight" }, authorUserId: team().memberUserId }),
      );
      expect(await holder.held).toMatchObject({ ok: true });
      const decision = decide(wf, "APPROVE");
      const d = track(decision);
      await waitForLockWaiters(1);
      expect(d.settled).toBe(false);
      holder.release();
      await holder.done;
      const res = await decision;
      expect(String(res.workflow.status)).toBe("APPROVED_INTERNAL");
      const [snap] = await finalSnapshots(wf);
      expect(snap!.values.find((v) => v.fieldId === notes.id)!.value).toEqual({ text: "in flight" });
      expect(await stored(wf, notes.id)).toEqual({ text: "in flight" });
    });

    it("decision holds the lock, write waits: the write is refused WORKFLOW_CLOSED and nothing is stored", async () => {
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      const holder = decisionHoldingLock(wf, "APPROVE");
      await holder.ready;
      const w = write(wf, notes.id, { text: "too late" });
      const ws = track(w);
      await waitForLockWaiters(1);
      expect(ws.settled).toBe(false);
      holder.release();
      await holder.done;
      expect(await w).toEqual({ ok: false, denial: "WORKFLOW_CLOSED" });
      expect(await statusOf(wf)).toBe("APPROVED_INTERNAL");
      expect(await stored(wf, notes.id)).toBeNull();
      const [snap] = await finalSnapshots(wf);
      expect(snap!.values.find((v) => v.fieldId === notes.id)!.value).toBeNull();
    });

    it("a write that waited behind a finalization committed by another transaction is refused (closed before it obtained the lock)", async () => {
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      const holder = holdWorkflowLock(wf, (tx) =>
        tx.evidenceReviewWorkflow.update({ where: { id: wf }, data: { status: "APPROVED_INTERNAL" as never } }),
      );
      await holder.held;
      const w = write(wf, notes.id, { text: "x" });
      const c = clear(wf, notes.id);
      await waitForLockWaiters(2);
      holder.release();
      await holder.done;
      expect(await w).toEqual({ ok: false, denial: "WORKFLOW_CLOSED" });
      expect(await c).toEqual({ ok: false, denial: "WORKFLOW_CLOSED" });
      expect(await stored(wf, notes.id)).toBeNull();
      expect(await historyCount(wf, notes.id)).toBe(0);
    });
  });

  describe("C — clear vs final approval under the required-coding policy", () => {
    const teamId = () => team().teamId;
    async function withPolicy(fn: () => Promise<void>) {
      const since = new Date(Date.now() - 60 * 60 * 1000);
      await prisma.workspaceGovernancePolicy.upsert({
        where: { teamId: teamId() },
        create: { teamId: teamId(), reviewRequiresCompleteCoding: true, reviewRequiresCompleteCodingSince: since },
        update: { reviewRequiresCompleteCoding: true, reviewRequiresCompleteCodingSince: since },
      });
      try {
        await fn();
      } finally {
        await prisma.workspaceGovernancePolicy.update({
          where: { teamId: teamId() },
          data: { reviewRequiresCompleteCoding: false, reviewRequiresCompleteCodingSince: null },
        });
      }
    }
    async function startedRound() {
      const { schemaId, verdict } = await publishedSchema();
      const { id: wf, evidenceId } = await newWorkflow();
      await bind(wf, schemaId);
      // The round's Start is AFTER the policy's `since`: enforcement applies.
      await prisma.evidenceReviewWorkflowEvent.create({
        data: { workflowId: wf, evidenceId, eventType: "REVIEW_STARTED" as never, actorUserId: team().memberUserId },
      });
      expect(await write(wf, verdict.id, { verdict: "APPROVE" })).toMatchObject({ ok: true });
      return { wf, verdict };
    }

    /*
     * Valid outcomes:
     *   (1) the clear commits first → the decision sees the required field
     *       missing and is refused coding_incomplete; the review stays open;
     *   (2) the decision commits first → the clear is refused WORKFLOW_CLOSED;
     *       the value and the snapshot both still hold it.
     * Invalid (asserted never): a finalized review whose required field is
     * empty; a snapshot holding a value that is no longer stored.
     */
    it("clear holds the lock, decision waits: the decision is refused coding_incomplete", async () => {
      await withPolicy(async () => {
        const { wf, verdict } = await startedRound();
        const holder = holdWorkflowLock(wf, (tx) =>
          valueSvc.clearCodingValue({ prisma: tx as never, teamId: teamId(), workflowId: wf, fieldId: verdict.id, actorUserId: team().memberUserId }),
        );
        expect(await holder.held).toMatchObject({ ok: true, cleared: true });
        const decision = decide(wf, "APPROVE");
        const d = track(decision);
        await waitForLockWaiters(1);
        expect(d.settled).toBe(false);
        holder.release();
        await holder.done;
        await expect(decision).rejects.toMatchObject({ code: "coding_incomplete" });
        expect(await statusOf(wf)).toBe("IN_REVIEW");
        expect(await stored(wf, verdict.id)).toBeNull();
        expect(await finalSnapshots(wf)).toEqual([]);
      });
    });

    it("decision holds the lock, clear waits: the clear is refused; value and snapshot agree", async () => {
      await withPolicy(async () => {
        const { wf, verdict } = await startedRound();
        const holder = decisionHoldingLock(wf, "APPROVE");
        await holder.ready;
        const c = clear(wf, verdict.id);
        const cs = track(c);
        await waitForLockWaiters(1);
        expect(cs.settled).toBe(false);
        holder.release();
        expect(String((await holder.done).workflow.status)).toBe("APPROVED_INTERNAL");
        expect(await c).toEqual({ ok: false, denial: "WORKFLOW_CLOSED" });
        expect(await stored(wf, verdict.id)).toEqual({ verdict: "APPROVE" });
        const [snap] = await finalSnapshots(wf);
        expect(snap!.values.find((v) => v.fieldId === verdict.id)!.value).toEqual({ verdict: "APPROVE" });
      });
    });
  });

  describe("C — write / clear vs schema rebind", () => {
    /*
     * Valid outcomes:
     *   (1) rebind first → the old-schema write/clear is refused
     *       SCHEMA_VERSION_MISMATCH, decided under the lock; nothing changes;
     *   (2) write first → the value is stored against the old schema and,
     *       after the rebind, listed as an other-schema value (never current).
     * Invalid (asserted never): an old-schema write stored after the rebind;
     * an old-schema value presented as current.
     */
    it("rebind holds the lock, old-schema write and clear wait: both refused SCHEMA_VERSION_MISMATCH", async () => {
      const a = team();
      const first = await publishedSchema("First");
      const second = await publishedSchema("Second");
      const { id: wf } = await newWorkflow();
      await bind(wf, first.schemaId);
      expect(await write(wf, first.verdict.id, { verdict: "APPROVE" })).toMatchObject({ ok: true });
      const holder = holdWorkflowLock(wf, (tx) =>
        schemaSvc.bindSchemaToWorkflow({ prisma: tx as never, teamId: a.teamId, workflowId: wf, schemaId: second.schemaId, actorUserId: a.adminUserId }),
      );
      expect(await holder.held).toEqual({ ok: true });
      const w = write(wf, first.notes.id, { text: "old schema" });
      const c = clear(wf, first.verdict.id);
      const ws = track(w);
      await waitForLockWaiters(2);
      expect(ws.settled).toBe(false);
      holder.release();
      await holder.done;
      expect(await w).toEqual({ ok: false, denial: "SCHEMA_VERSION_MISMATCH" });
      expect(await c).toEqual({ ok: false, denial: "SCHEMA_VERSION_MISMATCH" });
      expect(await stored(wf, first.notes.id)).toBeNull();
      expect(await stored(wf, first.verdict.id)).toEqual({ verdict: "APPROVE" });
      const sheet = (await call({ method: "GET", url: codingUrl(wf), token: a.memberToken })).json();
      expect(sheet.values).toEqual([]);
      expect(sheet.otherSchemaValues.map((v: { fieldId: string }) => v.fieldId)).toEqual([first.verdict.id]);
    });

    it("write holds the lock, rebind waits: the value stays an other-schema value, never current", async () => {
      const a = team();
      const first = await publishedSchema("First");
      const second = await publishedSchema("Second");
      const { id: wf } = await newWorkflow();
      await bind(wf, first.schemaId);
      const holder = holdWorkflowLock(wf, (tx) =>
        valueSvc.writeCodingValue({ prisma: tx as never, teamId: a.teamId, workflowId: wf, fieldId: first.notes.id, value: { text: "before rebind" }, authorUserId: a.memberUserId }),
      );
      expect(await holder.held).toMatchObject({ ok: true });
      const rebind = schemaSvc.bindSchemaToWorkflow({ teamId: a.teamId, workflowId: wf, schemaId: second.schemaId, actorUserId: a.adminUserId });
      const rs = track(rebind);
      await waitForLockWaiters(1);
      expect(rs.settled).toBe(false);
      holder.release();
      await holder.done;
      expect(await rebind).toEqual({ ok: true });
      const sheet = (await call({ method: "GET", url: codingUrl(wf), token: a.memberToken })).json();
      expect(sheet.values).toEqual([]);
      expect(sheet.otherSchemaValues.map((v: { fieldId: string }) => v.fieldId)).toEqual([first.notes.id]);
      // A later write of the OLD field is refused.
      expect(await write(wf, first.notes.id, { text: "again" })).toEqual({ ok: false, denial: "SCHEMA_VERSION_MISMATCH" });
    });
  });

  describe("C — two writers on one field", () => {
    /*
     * With the same expected revision: exactly one is stored, the other is a
     * CODING_VALUE_CONFLICT naming the winner's value. Never both "saved".
     */
    it("same base revision: one stored, the other refused with the winner's value", async () => {
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      const holder = holdWorkflowLock(wf);
      await holder.held;
      const w1 = write(wf, notes.id, { text: "one" }, 0);
      const w2 = write(wf, notes.id, { text: "two" }, 0);
      await waitForLockWaiters(2);
      holder.release();
      await holder.done;
      const results = [await w1, await w2];
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const winnerText = results[0]!.ok ? "one" : "two";
      expect(losers[0]).toEqual({ ok: false, denial: "CODING_VALUE_CONFLICT", current: { revision: 1, value: { text: winnerText } } });
      expect(await stored(wf, notes.id)).toEqual({ text: winnerText });
      expect(await historyCount(wf, notes.id)).toBe(1);
    });

    it("without revisions (bulk / older clients): both serialize; the stored value is the last history row", async () => {
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      const holder = holdWorkflowLock(wf);
      await holder.held;
      const w1 = write(wf, notes.id, { text: "one" });
      const w2 = write(wf, notes.id, { text: "two" });
      await waitForLockWaiters(2);
      holder.release();
      await holder.done;
      const [r1, r2] = [await w1, await w2];
      expect(r1).toMatchObject({ ok: true });
      expect(r2).toMatchObject({ ok: true });
      // Distinct revisions: the two writes were serialized, not interleaved.
      expect(new Set([(r1 as { revision: number }).revision, (r2 as { revision: number }).revision])).toEqual(new Set([1, 2]));
      const last = await prisma.codingValueHistory.findFirst({
        where: { workflowId: wf, fieldId: notes.id },
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      });
      const lastWriter = (r1 as { revision: number }).revision === 2 ? "one" : "two";
      expect(await stored(wf, notes.id)).toEqual({ text: lastWriter });
      expect(last!.value).toEqual({ text: lastWriter });
    });
  });

  describe("C — bulk coding takes the same lock", () => {
    it("a bulk write that waited behind a closing transaction is refused for that workflow", async () => {
      const a = team();
      const { schemaId, notes } = await publishedSchema();
      const { id: wf } = await newWorkflow();
      await bind(wf, schemaId);
      const { bulkCode } = await import("../src/services/reviewer-workspace/bulk-operations.service.js");
      const holder = holdWorkflowLock(wf, (tx) =>
        tx.evidenceReviewWorkflow.update({ where: { id: wf }, data: { status: "CLOSED" as never } }),
      );
      await holder.held;
      const bulk = bulkCode({ teamId: a.teamId, actorUserId: a.ownerUserId, fieldSlug: "notes", value: { text: "bulk" }, workflowIds: [wf] });
      await waitForLockWaiters(1);
      holder.release();
      await holder.done;
      const res = await bulk;
      expect(res).toMatchObject({ ok: false });
      expect((res as { items?: Array<{ denial?: string }>; results?: Array<{ denial?: string }> })).toBeTruthy();
      expect(JSON.stringify(res)).toContain("WORKFLOW_CLOSED");
      expect(await stored(wf, notes.id)).toBeNull();
    });
  });
});
