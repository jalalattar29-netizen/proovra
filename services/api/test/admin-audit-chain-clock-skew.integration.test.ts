/**
 * ET-CUS-05 — the platform audit chain does not fork under clock skew or
 * same-millisecond writes. Live PostgreSQL 16, the production API facade
 * (appendPlatformAuditLog) and verifier (verifyAdminAuditChain). Only `Date`
 * is faked, to model a host whose clock runs ahead.
 *
 * On a40ca76f the head was chosen by createdAt: a row written by a host whose
 * clock ran ahead stayed "latest" for the next append, the rows after it were
 * ordered before it by the verifier, and the chain reported a break with no
 * tampering.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("platform audit chain under clock skew (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let audit: typeof import("../src/services/platform-audit-log.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    audit = await import("../src/services/platform-audit-log.service.js");
  }, 180_000);
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await h?.cleanup();
  });

  const write = (tag: string) =>
    audit.appendPlatformAuditLog({
      userId: h.fixtures.teamA.ownerUserId,
      action: `skew.test.${tag}`,
      category: "test",
      metadata: { run: randomUUID() },
    } as never);

  it("a row from a host running seconds ahead does not fork the chain", async () => {
    expect((await audit.verifyAdminAuditChain({ tailLimit: 500 })).valid).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 5_000));
    await write("ahead");
    vi.useRealTimers();
    await write("after-1");
    await write("after-2");
    const verdict = await audit.verifyAdminAuditChain({ tailLimit: 500 });
    expect(verdict.valid, JSON.stringify(verdict)).toBe(true);
  });

  it("appends in the same millisecond stay in append order", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8_000));
    await write("same-ms-1");
    await write("same-ms-2");
    await write("same-ms-3");
    vi.useRealTimers();
    const verdict = await audit.verifyAdminAuditChain({ tailLimit: 500 });
    expect(verdict.valid, JSON.stringify(verdict)).toBe(true);
  });
});
