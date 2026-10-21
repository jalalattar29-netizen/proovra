/**
 * Independent forward audit closure — F-39 against live PostgreSQL 16.
 *
 * Outside an explicit development / test environment the signing-key registry
 * refuses to register the repository's committed fixture (no row is written),
 * and the operator command's registry read reports, as two booleans, whether
 * a fixture row exists and whether one is unrevoked.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const FIXTURE_PUBLIC_PEM = readFileSync(resolve(__dirname, "../keys/signing-public.pem"), "utf8");

describe("F-39 — the registry and the committed fixture (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const saved = { ...process.env };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterEach(() => {
    process.env = { ...saved };
  });
  afterAll(async () => {
    await h?.cleanup();
  });

  it("staging: registering the fixture is refused and writes no row", async () => {
    const { registerSigningKey } = await import("@proovra/shared-runtime");
    const keyId = `afc-fixture-${randomUUID().slice(0, 8)}`;
    process.env.PROOVRA_ENV = "staging";
    await expect(
      registerSigningKey(prisma, { keyId, version: 1, publicKeyPem: FIXTURE_PUBLIC_PEM, purpose: "EVIDENCE_SIGNATURE" }),
    ).rejects.toMatchObject({ code: "SIGNING_KEY_COMMITTED_FIXTURE" });
    expect(await prisma.signingKey.count({ where: { keyId } })).toBe(0);
  });

  it("the operator registry read reports an unrevoked fixture row as two booleans", async () => {
    const { registerSigningKey } = await import("@proovra/shared-runtime");
    const { readCommittedFixtureRegistration } = await import("../src/ops/deployment-safety.js");
    const keyId = `afc-fixture-${randomUUID().slice(0, 8)}`;
    // A test environment may register it (that is what the fixture is for).
    process.env.PROOVRA_ENV = "test";
    await registerSigningKey(prisma, { keyId, version: 1, publicKeyPem: FIXTURE_PUBLIC_PEM, purpose: "EVIDENCE_SIGNATURE" });
    const active = await readCommittedFixtureRegistration(prisma as never);
    expect(active).toEqual({ committedFixtureRegistered: true, committedFixtureActive: true });
    // (The revoked case is covered against a stub read in afc-wave-e-environment-and-fixture:
    // revoking here would leave this shared database's fixture rows unusable to other suites.)
  });
});
