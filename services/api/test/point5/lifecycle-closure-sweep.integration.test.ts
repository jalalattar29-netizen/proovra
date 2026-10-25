/**
 * POINT 5 — LifecycleSweep, proven by EXECUTION (members audit LIFE-11).
 *
 * The sweep is the worker-scheduled lifecycle tick (`runLifecycleTick`): it
 * executes due closure requests and resumes any an interrupted run left in
 * PROCESSING. Each of the seven common obligations below is driven against a
 * real PostgreSQL through the real tick and closure engines, and `provenCase`
 * is called only AFTER the assertion it names.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";
import { seedOwnedWorkspace, seedUser, type FixtureDeps } from "../point7/product-fixtures.js";

type Prisma = typeof import("../../src/db.js")["prisma"];

describe("Point 5 — LifecycleSweep (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: Prisma;
  let deps: FixtureDeps;
  let tick: typeof import("../../src/services/lifecycle/lifecycle-scheduler.service.js");
  let closure: typeof import("../../src/services/workspace/workspace-closure.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    tick = await import("../../src/services/lifecycle/lifecycle-scheduler.service.js");
    closure = await import("../../src/services/workspace/workspace-closure.service.js");
    const { signJwt } = await import("../../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `p5life-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, secret, 3600),
    };
  }, 900_000);

  afterAll(async () => {
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);

  /** An owned workspace with one live credential — the thing closure retires. */
  async function workspace() {
    const owner = await seedUser(deps, `p5life-${tag()}`);
    const ws = await seedOwnedWorkspace(deps, { ownerUserId: owner.userId, billingPlan: "TEAM", billingStatus: "INACTIVE" });
    const credential = await prisma.apiCredential.create({
      data: {
        teamId: ws.teamId,
        name: "ci",
        keyPrefix: `pk_${tag()}`,
        keyHash: createHash("sha256").update(randomUUID()).digest("hex"),
        createdByUserId: owner.userId,
      },
      select: { id: true },
    });
    return { ownerUserId: owner.userId, teamId: ws.teamId, credentialId: credential.id };
  }

  async function request(w: { teamId: string; ownerUserId: string }, status = "SCHEDULED", extra: Record<string, unknown> = {}) {
    return prisma.workspaceClosureRequest.create({
      data: {
        teamId: w.teamId,
        requestedByUserId: w.ownerUserId,
        status,
        coolingOffEndsAtUtc: new Date(Date.now() - 1000),
        ...extra,
      },
      select: { id: true },
    });
  }

  const closedAt = async (teamId: string) =>
    (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { closedAtUtc: true } })).closedAtUtc;
  const credentialStatus = async (id: string) =>
    (await prisma.apiCredential.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  it("durable intent before work: nothing closes without a due request row, and a due row closes", async () => {
    const idle = await workspace();
    await tick.runLifecycleTick(new Date());
    expect(await closedAt(idle.teamId)).toBeNull();
    const w = await workspace();
    const req = await request(w);
    await tick.runLifecycleTick(new Date());
    expect(await closedAt(w.teamId)).not.toBeNull();
    expect((await prisma.workspaceClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");
    provenCase("closure.durable.intent_before_work");
  });

  it("the subject is reloaded at execution: a blocker acquired after scheduling stops it", async () => {
    const w = await workspace();
    const req = await request(w);
    await prisma.subscription.create({
      data: {
        userId: w.ownerUserId,
        teamId: w.teamId,
        provider: "STRIPE",
        providerSubId: `sub_${tag()}`,
        status: "ACTIVE",
        plan: "TEAM",
      },
    });
    await tick.runLifecycleTick(new Date());
    expect((await prisma.workspaceClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("BLOCKED");
    expect(await closedAt(w.teamId)).toBeNull();
    expect(await credentialStatus(w.credentialId)).toBe("ACTIVE");
    provenCase("closure.tenant.workspace_reloaded");
  });

  it("closing one workspace touches nothing in another", async () => {
    const a = await workspace();
    const b = await workspace();
    await request(a);
    await tick.runLifecycleTick(new Date());
    expect(await closedAt(a.teamId)).not.toBeNull();
    expect(await closedAt(b.teamId)).toBeNull();
    expect(await credentialStatus(b.credentialId)).toBe("ACTIVE");
    provenCase("closure.tenant.cross_workspace_denied");
  });

  it("two concurrent ticks: one claim, one execution", async () => {
    const w = await workspace();
    const req = await request(w);
    await Promise.all([tick.runLifecycleTick(new Date()), tick.runLifecycleTick(new Date())]);
    expect((await prisma.workspaceClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");
    expect(
      await prisma.teamActivity.count({ where: { teamId: w.teamId, eventType: "workspace_closed" } }),
    ).toBe(1);
    provenCase("closure.claim.one_winner");
  });

  it("an ACTIVE claim (fresh PROCESSING) is not stolen by the reaper", async () => {
    const w = await workspace();
    const req = await request(w, "PROCESSING", { startedAtUtc: new Date() });
    await tick.runLifecycleTick(new Date());
    expect((await prisma.workspaceClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("PROCESSING");
    expect(await closedAt(w.teamId)).toBeNull();
    provenCase("closure.claim.active_not_stolen");
  });

  it("a duplicate execution is a no-op", async () => {
    const w = await workspace();
    await closure.executeWorkspaceClosure({ teamId: w.teamId, requestedByUserId: w.ownerUserId });
    const first = await closedAt(w.teamId);
    const revokedAt = (await prisma.apiCredential.findUniqueOrThrow({ where: { id: w.credentialId } })).revokedAtUtc;
    await closure.executeWorkspaceClosure({ teamId: w.teamId, requestedByUserId: w.ownerUserId });
    expect(await closedAt(w.teamId)).toEqual(first);
    expect((await prisma.apiCredential.findUniqueOrThrow({ where: { id: w.credentialId } })).revokedAtUtc).toEqual(revokedAt);
    provenCase("closure.idempotency.duplicate_is_noop");
  });

  it("a terminal request (COMPLETED / CANCELLED) is never executed again", async () => {
    const done = await workspace();
    await request(done, "COMPLETED", { completedAtUtc: new Date() });
    const cancelled = await workspace();
    await request(cancelled, "CANCELLED", { cancelledAtUtc: new Date() });
    await tick.runLifecycleTick(new Date());
    expect(await closedAt(done.teamId)).toBeNull();
    expect(await closedAt(cancelled.teamId)).toBeNull();
    expect(await credentialStatus(cancelled.credentialId)).toBe("ACTIVE");
    provenCase("closure.terminal.stale_cannot_overwrite");
  });
});
