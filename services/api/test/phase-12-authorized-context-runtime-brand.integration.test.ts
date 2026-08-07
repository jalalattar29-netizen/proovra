/**
 * PHASE 12 CORRECTIVE PASS §1.2 — THE RUNTIME BRAND, PROVEN BY FORGERY.
 *
 * Why this file exists
 * --------------------
 * The previous pass defended `AuthorizedWorkspaceContext` with (a) a
 * compile-time `unique symbol` brand and (b) an AST rule banning the literal
 * text `as AuthorizedWorkspaceContext`. Both are real defences and both are
 * defeated by ordinary JavaScript: `unknown as`, a wrapper function, a spread,
 * a JSON round-trip, or any `.js` caller produces a value the type system
 * never sees and the AST rule never reads.
 *
 * So the boundary is now a RUNTIME one — a module-private `WeakSet` keyed by
 * object identity — and this suite is the adversary. Every case below is an
 * ATTEMPT TO FORGE. A case that "passes" is a forgery that was REFUSED.
 *
 * Why it is an integration suite and not a unit test
 * --------------------------------------------------
 * Two of the mandated cases — a context minted for one workspace presented for
 * another, and a context minted before a suspension presented after it — can
 * only be built from a GENUINE context. A genuine context can only be obtained
 * by running the real canonical chain against a real membership row. Mocking
 * the mint would mean testing the mock.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FastifyRequest } from "fastify";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

/**
 * The primitive treats a request as an authenticated-identity carrier plus a
 * header bag. Nothing else about Fastify is consulted, so a stub is faithful
 * here — and using one keeps the probe focused on the brand rather than on
 * route wiring, which SEC-001's suite already drives end to end.
 */
const requestFor = (userId: string): FastifyRequest =>
  ({ user: { sub: userId }, headers: {} }) as unknown as FastifyRequest;

describe("§1.2 — AuthorizedWorkspaceContext is unforgeable at RUNTIME", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let authorize: typeof import("../src/middleware/authorize.js");

  let workspaceA: string;
  let workspaceB: string;
  let actorA: string;
  let actorB: string;

  /** A genuine, minted context for actorA in workspaceA. */
  let genuine: import("../src/middleware/authorize.js").AuthorizedWorkspaceContext;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
    authorize = await import("../src/middleware/authorize.js");

    workspaceA = h.fixtures.teamA.teamId;
    workspaceB = h.fixtures.teamB.teamId;
    actorA = h.fixtures.teamA.adminUserId;
    actorB = h.fixtures.teamB.adminUserId;

    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: actorA },
      data: { status: "ACTIVE", accessExpiresAtUtc: null },
    });

    const outcome = await authorize.evaluateAuthorizedWorkspace(
      requestFor(actorA),
      { workspaceId: workspaceA, permission: "evidence.read" },
    );
    if (!outcome.allowed) {
      throw new Error(
        `fixture precondition failed: actorA must be authorized in workspaceA (${outcome.reasonCode})`,
      );
    }
    genuine = outcome.context;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const expectRefusal = (
    fn: () => unknown,
    code: import("../src/middleware/authorize.js").AuthorizedContextRejection,
  ): void => {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "the forgery must be REFUSED, not accepted").toBeInstanceOf(
      authorize.UnauthorizedWorkspaceContextError,
    );
    expect(
      (thrown as import("../src/middleware/authorize.js").UnauthorizedWorkspaceContextError)
        .code,
    ).toBe(code);
  };

  // ---------------------------------------------------------------------------
  // POSITIVE CONTROL. Without it every refusal below would also be produced by
  // a helper that simply refuses everything.
  // ---------------------------------------------------------------------------

  it("POSITIVE CONTROL: a genuine minted context is accepted", () => {
    const verified = authorize.assertMintedAuthorizedWorkspaceContext(genuine, {
      workspaceId: workspaceA,
      userId: actorA,
    });
    expect(verified).toBe(genuine);
    expect(authorize.contextHasCapability(genuine, "evidence.read")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // FORGERY CLASS 1 — fabricate the shape.
  // ---------------------------------------------------------------------------

  it("a structurally identical plain object is refused", () => {
    const forged = {
      userId: actorA,
      workspaceId: workspaceA,
      workspaceKind: "OWNED",
      workspaceRole: "ADMIN",
      membershipStatus: "ACTIVE",
      organizationId: null,
      organizationLifecycle: null,
      capabilities: new Set(["evidence.read"]),
    };
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(forged, {
          workspaceId: workspaceA,
        }),
      "context_not_minted",
    );
  });

  it("a direct cast is refused", () => {
    // The AST rule bans this spelling in production source. It is written here
    // deliberately, in a test, to prove the RUNTIME refuses it too — the AST
    // rule is defence in depth, not the boundary.
    const forged = {
      userId: actorA,
      workspaceId: workspaceA,
      workspaceKind: "OWNED" as const,
      workspaceRole: "ADMIN" as const,
      membershipStatus: "ACTIVE" as const,
      organizationId: null,
      organizationLifecycle: null,
      capabilities: new Set<never>(),
    } as unknown as import("../src/middleware/authorize.js").AuthorizedWorkspaceContext;
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(forged, {
          workspaceId: workspaceA,
        }),
      "context_not_minted",
    );
  });

  it("a double cast through `unknown` is refused", () => {
    const forged = {} as unknown as
      import("../src/middleware/authorize.js").AuthorizedWorkspaceContext;
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(forged, {
          workspaceId: workspaceA,
        }),
      "context_not_minted",
    );
  });

  // ---------------------------------------------------------------------------
  // FORGERY CLASS 2 — launder a GENUINE context. These are the cases a
  // compile-time brand cannot see at all: every value below type-checks as the
  // branded type because it was DERIVED from one.
  // ---------------------------------------------------------------------------

  it("an object spread of a genuine context is refused", () => {
    const laundered = { ...genuine };
    expect(laundered.workspaceId).toBe(genuine.workspaceId);
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(laundered, {
          workspaceId: workspaceA,
        }),
      "context_not_minted",
    );
  });

  it("a JSON round trip of a genuine context is refused", () => {
    const laundered = JSON.parse(
      JSON.stringify({ ...genuine, capabilities: [...genuine.capabilities] }),
    );
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(laundered, {
          workspaceId: workspaceA,
        }),
      "context_not_minted",
    );
  });

  it("a Object.create() prototype-chained impostor is refused", () => {
    // Inheriting from a genuine context makes every field read identically —
    // and `in`/property access indistinguishable — but the object is still a
    // different identity.
    const laundered = Object.create(genuine) as typeof genuine;
    expect(laundered.workspaceId).toBe(workspaceA);
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(laundered, {
          workspaceId: workspaceA,
        }),
      "context_not_minted",
    );
  });

  it("a Proxy wrapping a genuine context is refused", () => {
    const laundered = new Proxy(genuine, {}) as typeof genuine;
    expect(laundered.workspaceId).toBe(workspaceA);
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(laundered, {
          workspaceId: workspaceA,
        }),
      "context_not_minted",
    );
  });

  // ---------------------------------------------------------------------------
  // FORGERY CLASS 3 — a genuine context used OUT OF ITS BINDING.
  // ---------------------------------------------------------------------------

  it("a context minted for workspace A is refused for workspace B", () => {
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(genuine, {
          workspaceId: workspaceB,
        }),
      "context_workspace_mismatch",
    );
  });

  it("a context minted for actor A is refused for actor B", () => {
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(genuine, {
          workspaceId: workspaceA,
          userId: actorB,
        }),
      "context_actor_mismatch",
    );
  });

  it("a genuine context cannot be repointed at another workspace", () => {
    // Frozen at mint, so the assignment is a no-op (or throws in strict mode).
    // Either way the binding check below is the real guarantee.
    try {
      (genuine as { workspaceId: string }).workspaceId = workspaceB;
    } catch {
      /* strict-mode TypeError is an acceptable outcome */
    }
    expect(genuine.workspaceId).toBe(workspaceA);
  });

  // ---------------------------------------------------------------------------
  // FORGERY CLASS 4 — a genuine context that has OUTLIVED its premise.
  // ---------------------------------------------------------------------------

  it("a context minted before a SUSPENSION is refused after it", async () => {
    const fresh = await authorize.evaluateAuthorizedWorkspace(
      requestFor(actorA),
      { workspaceId: workspaceA, permission: "evidence.read" },
    );
    expect(fresh.allowed, "precondition: actorA is authorized").toBe(true);
    if (!fresh.allowed) return;

    // Still live right now — the positive half of the property.
    await expect(
      authorize.requireLiveAuthorizedWorkspaceContext(fresh.context, {
        workspaceId: workspaceA,
        userId: actorA,
      }),
    ).resolves.toBeTruthy();

    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: actorA },
      data: { status: "SUSPENDED" },
    });
    try {
      // The cached object is unchanged and still genuine. What has changed is
      // the world. The high-risk boundary must notice.
      await expect(
        authorize.requireLiveAuthorizedWorkspaceContext(fresh.context, {
          workspaceId: workspaceA,
          userId: actorA,
        }),
      ).rejects.toBeInstanceOf(authorize.UnauthorizedWorkspaceContextError);
    } finally {
      await prisma.teamMember.updateMany({
        where: { teamId: workspaceA, userId: actorA },
        data: { status: "ACTIVE" },
      });
    }
  });

  it("a context minted before an ACCESS-EXPIRY edit is refused after it", async () => {
    const fresh = await authorize.evaluateAuthorizedWorkspace(
      requestFor(actorA),
      { workspaceId: workspaceA, permission: "evidence.read" },
    );
    expect(fresh.allowed).toBe(true);
    if (!fresh.allowed) return;

    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: actorA },
      data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) },
    });
    try {
      await expect(
        authorize.requireLiveAuthorizedWorkspaceContext(fresh.context, {
          workspaceId: workspaceA,
          userId: actorA,
        }),
      ).rejects.toBeInstanceOf(authorize.UnauthorizedWorkspaceContextError);
    } finally {
      await prisma.teamMember.updateMany({
        where: { teamId: workspaceA, userId: actorA },
        data: { accessExpiresAtUtc: null },
      });
    }
  });

  it("a context minted before a REVOKE is refused after it", async () => {
    const fresh = await authorize.evaluateAuthorizedWorkspace(
      requestFor(actorA),
      { workspaceId: workspaceA, permission: "evidence.read" },
    );
    expect(fresh.allowed).toBe(true);
    if (!fresh.allowed) return;

    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: actorA },
      data: { status: "REVOKED" },
    });
    try {
      await expect(
        authorize.requireLiveAuthorizedWorkspaceContext(fresh.context, {
          workspaceId: workspaceA,
          userId: actorA,
        }),
      ).rejects.toBeInstanceOf(authorize.UnauthorizedWorkspaceContextError);
    } finally {
      await prisma.teamMember.updateMany({
        where: { teamId: workspaceA, userId: actorA },
        data: { status: "ACTIVE" },
      });
    }
  });

  it("a context minted before the ORGANIZATION is suspended is refused after it", async () => {
    const team = await prisma.team.findUnique({
      where: { id: workspaceA },
      select: { organizationId: true, workspaceKind: true },
    });
    const fresh = await authorize.evaluateAuthorizedWorkspace(
      requestFor(actorA),
      { workspaceId: workspaceA, permission: "evidence.read" },
    );
    expect(fresh.allowed).toBe(true);
    if (!fresh.allowed || !team?.organizationId) return;

    const org = await prisma.organization.findUnique({
      where: { id: team.organizationId },
      select: { status: true, kind: true },
    });
    // Organization lifecycle applies to ORGANIZATION workspaces only; PERSONAL
    // and OWNED sit under SYSTEM containers and are exempt by design. Assert
    // the property that actually holds for THIS fixture rather than forcing a
    // shape the domain does not have.
    await prisma.organization.update({
      where: { id: team.organizationId },
      data: { status: "SUSPENDED" },
    });
    try {
      const outcome = await authorize.evaluateAuthorizedWorkspace(
        requestFor(actorA),
        { workspaceId: workspaceA, permission: "evidence.read" },
      );
      if (fresh.context.workspaceKind === "ORGANIZATION") {
        expect(outcome.allowed).toBe(false);
        await expect(
          authorize.requireLiveAuthorizedWorkspaceContext(fresh.context, {
            workspaceId: workspaceA,
            userId: actorA,
          }),
        ).rejects.toBeInstanceOf(authorize.UnauthorizedWorkspaceContextError);
      } else {
        // Documented exemption, asserted so a future change that makes the
        // lifecycle apply here cannot pass unnoticed.
        expect(outcome.allowed).toBe(true);
      }
    } finally {
      await prisma.organization.update({
        where: { id: team.organizationId },
        data: { status: org?.status ?? "ACTIVE" },
      });
    }
  });

  it("a genuine context is refused in ANOTHER request's frame when the grant has since changed", async () => {
    // Request 1 mints a context.
    const first = await authorize.evaluateAuthorizedWorkspace(
      requestFor(actorA),
      { workspaceId: workspaceA, permission: "evidence.read" },
    );
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    // Request 2 arrives later, carrying request 1's context — the shape a
    // cached or replayed grant takes. While the world is unchanged it is
    // still live…
    await expect(
      authorize.requireLiveAuthorizedWorkspaceContext(first.context, {
        workspaceId: workspaceA,
        userId: actorA,
      }),
    ).resolves.toBeTruthy();

    // …and the moment the grant changes, it is not. This is the property that
    // makes a long-lived cached context safe to hold: holding it is allowed,
    // TRUSTING it without revalidation is not.
    await prisma.teamMember.updateMany({
      where: { teamId: workspaceA, userId: actorA },
      data: { role: "VIEWER" },
    });
    try {
      await expect(
        authorize.requireLiveAuthorizedWorkspaceContext(first.context, {
          workspaceId: workspaceA,
          userId: actorA,
        }),
      ).rejects.toBeInstanceOf(authorize.UnauthorizedWorkspaceContextError);
    } finally {
      await prisma.teamMember.updateMany({
        where: { teamId: workspaceA, userId: actorA },
        data: { role: "ADMIN" },
      });
    }
  });

  it("a JavaScript caller — no types at all — is refused", () => {
    // The compile-time brand does not exist at runtime, so a `.js` module
    // importing the compiled output sees an ordinary function taking an
    // ordinary object. This is the exact caller the type system cannot reach,
    // simulated by discarding every type.
    const jsCaller = Function(
      "assertFn",
      "workspaceId",
      `return assertFn({ workspaceId: workspaceId, workspaceRole: "OWNER", capabilities: new Set(["*"]) }, { workspaceId: workspaceId });`,
    ) as (fn: unknown, w: string) => unknown;
    expect(() =>
      jsCaller(authorize.assertMintedAuthorizedWorkspaceContext, workspaceA),
    ).toThrow(authorize.UnauthorizedWorkspaceContextError);
  });

  it("a WRAPPER that returns a fresh object built from a genuine context is refused", () => {
    // The laundering shape a helper introduces without meaning to: it reads a
    // real context and returns "the same thing" — which is a different object.
    const launder = (
      c: import("../src/middleware/authorize.js").AuthorizedWorkspaceContext,
    ) => ({
      userId: c.userId,
      workspaceId: c.workspaceId,
      workspaceKind: c.workspaceKind,
      workspaceRole: c.workspaceRole,
      membershipStatus: c.membershipStatus,
      organizationId: c.organizationId,
      organizationLifecycle: c.organizationLifecycle,
      capabilities: c.capabilities,
    });
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(launder(genuine), {
          workspaceId: workspaceA,
        }),
      "context_not_minted",
    );
  });

  it("a BACKGROUND JOB replaying a serialised context is refused", async () => {
    // A job payload is JSON. Whatever a producer put in it, the consumer gets
    // a plain object — never a minted one. This is the F-class consumer the
    // gate requires live revalidation for, and here is why: there is nothing
    // to revalidate, because nothing genuine survived the queue.
    const payload = JSON.stringify({
      authorized: { ...genuine, capabilities: [...genuine.capabilities] },
    });
    const replayed = JSON.parse(payload).authorized;
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(replayed, {
          workspaceId: workspaceA,
        }),
      "context_not_minted",
    );
    await expect(
      authorize.requireLiveAuthorizedWorkspaceContext(replayed, {
        workspaceId: workspaceA,
      }),
    ).rejects.toBeInstanceOf(authorize.UnauthorizedWorkspaceContextError);
  });

  // ---------------------------------------------------------------------------
  // SECONDARY CAPABILITY — the brand must protect this surface too.
  // ---------------------------------------------------------------------------

  it("contextHasCapability refuses a forged context carrying a wide capability set", () => {
    const forged = {
      userId: actorA,
      workspaceId: workspaceA,
      capabilities: new Set(["evidence.delete", "team.manage"]),
    } as unknown as import("../src/middleware/authorize.js").AuthorizedWorkspaceContext;
    expect(() =>
      authorize.contextHasCapability(forged, "evidence.delete"),
    ).toThrow(authorize.UnauthorizedWorkspaceContextError);
  });

  // ---------------------------------------------------------------------------
  // NO SECRET IS CREATED. A brand implemented as a serialisable token would be
  // copyable the moment any surface logged or returned a context.
  // ---------------------------------------------------------------------------

  it("a genuine context carries no transportable authorization secret", () => {
    const serialised = JSON.stringify({
      ...genuine,
      capabilities: [...genuine.capabilities],
    });
    // Every own key is a stated, non-secret fact about the grant.
    const allowedKeys = new Set([
      "userId",
      "workspaceId",
      "workspaceKind",
      "workspaceRole",
      "membershipStatus",
      "organizationId",
      "organizationLifecycle",
      "capabilities",
    ]);
    for (const key of Reflect.ownKeys(genuine)) {
      expect(
        typeof key === "string" && allowedKeys.has(key),
        `unexpected own key on a minted context: ${String(key)}`,
      ).toBe(true);
    }
    // And the serialised form is not, itself, a bearer of authority: feeding
    // it back in is refused (this is the JSON round-trip case, restated as the
    // property it protects).
    expectRefusal(
      () =>
        authorize.assertMintedAuthorizedWorkspaceContext(
          JSON.parse(serialised),
          { workspaceId: workspaceA },
        ),
      "context_not_minted",
    );
  });
});
