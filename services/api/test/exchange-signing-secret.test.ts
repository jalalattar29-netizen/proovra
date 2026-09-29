/**
 * M3 — the exchange signing secret fails closed in production (2026-09-29).
 *
 * An unset WEBHOOK_SIGNING_SECRET used to fall back to a literal committed to
 * the repository, so a production deployment missing the variable signed —
 * and accepted — manifests with a public key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

const svc = await import("../src/services/exchange/signed-delivery.service.js");

const ENV = { ...process.env };
afterEach(() => {
  process.env.NODE_ENV = ENV.NODE_ENV;
  if (ENV.WEBHOOK_SIGNING_SECRET === undefined) delete process.env.WEBHOOK_SIGNING_SECRET;
  else process.env.WEBHOOK_SIGNING_SECRET = ENV.WEBHOOK_SIGNING_SECRET;
});

const input = { packageId: "pkg-1", payloadHash: "a".repeat(64), ttlSeconds: 600 };

describe("exchange manifest signing secret", () => {
  it.each([undefined, "", "   "])("production with WEBHOOK_SIGNING_SECRET=%j refuses to sign and to verify", async (value) => {
    process.env.NODE_ENV = "production";
    if (value === undefined) delete process.env.WEBHOOK_SIGNING_SECRET;
    else process.env.WEBHOOK_SIGNING_SECRET = value;
    await expect(svc.signPackageManifest(input)).rejects.toThrow("EXCHANGE_SIGNING_SECRET_MISSING");
    await expect(
      svc.verifySignedManifest({ token: "MjA5OS0wMS0wMVQwMDowMDowMC4wMDBafGFiYw", packageId: "pkg-1", payloadHash: input.payloadHash }),
    ).rejects.toThrow("EXCHANGE_SIGNING_SECRET_MISSING");
  });

  it("production with a configured secret signs, and a token made with the committed dev literal does NOT verify", async () => {
    process.env.NODE_ENV = "production";
    process.env.WEBHOOK_SIGNING_SECRET = "a-real-production-secret-value-0123456789";
    const good = await svc.signPackageManifest(input);
    expect(await svc.verifySignedManifest({ ...input, token: good.token })).toEqual({ ok: true });
    const forged = await svc.signPackageManifest({ ...input, secret: "proovra-exchange-dev-secret" });
    expect((await svc.verifySignedManifest({ ...input, token: forged.token })).ok).toBe(false);
  });

  it("development keeps the local fallback", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.WEBHOOK_SIGNING_SECRET;
    const t = await svc.signPackageManifest(input);
    expect(await svc.verifySignedManifest({ ...input, token: t.token })).toEqual({ ok: true });
  });
});
