/**
 * EXPORT PACKAGE METER (2026-09-07).
 *
 * `QUOTA_EXPORT_PACKAGES_PER_MONTH` was a live READ authority with no writer.
 * `assertQuotaEntitlement` compared the plan's monthly allowance against a
 * counter nothing had ever incremented, so the gate could not trip and the
 * allowance was advertised but never enforced.
 *
 * The meter is now written at the one commercial completion boundary, once
 * per produced package. Idempotency is EXERCISED here against a stateful
 * double — a retry, a race and a second distinct package all run — rather
 * than asserted from source text.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const repo = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.resolve(repo, rel), "utf8");

// Comments are stripped before a pin, so a match proves a CALL and never a
// mention of one.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// A minimal exchange-package double: enough state for the transition to be
// real, so idempotency is EXERCISED rather than asserted from source text.
// ---------------------------------------------------------------------------

type PackageRow = { id: string; teamId: string; state: string };

function makePrisma(rows: PackageRow[]) {
  const usage: Array<{ teamId: string; key: string; amount: bigint }> = [];
  const packages = [...rows];
  return {
    usage,
    packages,
    client: {
      evidenceExchangePackage: {
        findFirst: async (a: { where: { id: string; teamId: string } }) =>
          packages.find(
            (p) => p.id === a.where.id && p.teamId === a.where.teamId,
          ) ?? null,
        updateMany: async (a: {
          where: { id: string; teamId: string; state: { in: string[] } };
          data: { state: string };
        }) => {
          const hit = packages.find(
            (p) =>
              p.id === a.where.id &&
              p.teamId === a.where.teamId &&
              a.where.state.in.includes(p.state),
          );
          if (!hit) return { count: 0 };
          hit.state = a.data.state;
          return { count: 1 };
        },
      },
      entitlementUsage: {
        upsert: async (a: {
          where: {
            teamId_key_periodStartUtc: {
              teamId: string;
              key: string;
              periodStartUtc: Date;
            };
          };
          create: { consumed: bigint };
        }) => {
          const k = a.where.teamId_key_periodStartUtc;
          usage.push({ teamId: k.teamId, key: k.key, amount: a.create.consumed });
          return {};
        },
      },
    },
  };
}

async function loadExchange() {
  // The webhook emitter reaches for real infrastructure on import; the meter
  // is what is under test here.
  vi.resetModules();
  return import("../src/services/exchange/evidence-exchange.service.js");
}

describe("export package meter — one produced package, one unit", () => {
  it("a first successful completion records exactly one unit", async () => {
    const { markPackageReady } = await loadExchange();
    const db = makePrisma([{ id: "pkg-1", teamId: "ws-1", state: "DRAFT" }]);

    const res = await markPackageReady({
      prisma: db.client as never,
      teamId: "ws-1",
      packageId: "pkg-1",
      storageKey: "s3://bucket/pkg-1.zip",
      packageSha256: "a".repeat(64),
      packageSizeBytes: 1024,
    });

    expect(res.ok).toBe(true);
    expect(db.usage).toHaveLength(1);
    expect(db.usage[0]!.key).toBe("QUOTA_EXPORT_PACKAGES_PER_MONTH");
    expect(db.usage[0]!.amount).toBe(1n);
  });

  it("a retry of the SAME completed package records nothing further", async () => {
    /*
     * The idempotency subject is the package id plus the state transition. The
     * second call finds the row already READY, the conditional update matches
     * zero rows, and the meter is never reached.
     */
    const { markPackageReady } = await loadExchange();
    const db = makePrisma([{ id: "pkg-1", teamId: "ws-1", state: "DRAFT" }]);
    const call = () =>
      markPackageReady({
        prisma: db.client as never,
        teamId: "ws-1",
        packageId: "pkg-1",
        storageKey: "s3://bucket/pkg-1.zip",
        packageSha256: "a".repeat(64),
        packageSizeBytes: 1024,
      });

    const first = await call();
    const retry = await call();

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(false);
    expect(db.usage).toHaveLength(1);
  });

  it("two callers racing one package charge it once", async () => {
    // Both observe DRAFT; only one transition can match.
    const { markPackageReady } = await loadExchange();
    const db = makePrisma([{ id: "pkg-1", teamId: "ws-1", state: "DRAFT" }]);
    const call = () =>
      markPackageReady({
        prisma: db.client as never,
        teamId: "ws-1",
        packageId: "pkg-1",
        storageKey: "s3://bucket/pkg-1.zip",
        packageSha256: "a".repeat(64),
        packageSizeBytes: 1024,
      });

    const [a, b] = await Promise.all([call(), call()]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(db.usage).toHaveLength(1);
  });

  it("a package that never existed records nothing", async () => {
    const { markPackageReady } = await loadExchange();
    const db = makePrisma([]);

    const res = await markPackageReady({
      prisma: db.client as never,
      teamId: "ws-1",
      packageId: "pkg-missing",
      storageKey: "s3://bucket/x.zip",
      packageSha256: "a".repeat(64),
      packageSizeBytes: 1,
    });

    expect(res.ok).toBe(false);
    expect(db.usage).toHaveLength(0);
  });

  it("a second DISTINCT package records a second unit", async () => {
    const { markPackageReady } = await loadExchange();
    const db = makePrisma([
      { id: "pkg-1", teamId: "ws-1", state: "DRAFT" },
      { id: "pkg-2", teamId: "ws-1", state: "BUILDING" },
    ]);
    const call = (id: string) =>
      markPackageReady({
        prisma: db.client as never,
        teamId: "ws-1",
        packageId: id,
        storageKey: `s3://bucket/${id}.zip`,
        packageSha256: "a".repeat(64),
        packageSizeBytes: 10,
      });

    await call("pkg-1");
    await call("pkg-2");

    expect(db.usage).toHaveLength(2);
    expect(db.usage.every((u) => u.amount === 1n)).toBe(true);
  });

  it("the meter is charged to the workspace that OWNS the package", async () => {
    /*
     * Never the actor's personal workspace and never the downloader. The
     * lookup is already tenant-scoped, so another workspace cannot complete —
     * or be charged for — this package.
     */
    const { markPackageReady } = await loadExchange();
    const db = makePrisma([{ id: "pkg-1", teamId: "ws-owner", state: "DRAFT" }]);

    const foreign = await markPackageReady({
      prisma: db.client as never,
      teamId: "ws-other",
      packageId: "pkg-1",
      storageKey: "s3://bucket/pkg-1.zip",
      packageSha256: "a".repeat(64),
      packageSizeBytes: 1,
    });
    expect(foreign.ok).toBe(false);
    expect(db.usage).toHaveLength(0);

    const owner = await markPackageReady({
      prisma: db.client as never,
      teamId: "ws-owner",
      packageId: "pkg-1",
      storageKey: "s3://bucket/pkg-1.zip",
      packageSha256: "a".repeat(64),
      packageSizeBytes: 1,
    });
    expect(owner.ok).toBe(true);
    expect(db.usage).toHaveLength(1);
    expect(db.usage[0]!.teamId).toBe("ws-owner");
  });
});

describe("export package meter — exactly one writer, agreeing with the reader", () => {
  const engine = read(
    "services/api/src/services/packaging/entitlement.service.ts",
  );

  it("the gate and the meter derive the period from the same pair", () => {
    // The previous defect class in this repo was a gate and a writer that
    // disagreed about the key or the window. Both sides resolve through
    // `classifyPeriod` / `periodStart` in this module.
    const code = codeOnly(engine);
    const writer = code.slice(code.indexOf("export async function recordExportPackageUsage"));
    expect(writer).toContain("periodStart(classifyPeriod(key))");
    expect(writer).toContain('"QUOTA_EXPORT_PACKAGES_PER_MONTH"');
    expect(writer).toContain("entitlementUsage.upsert");
  });

  it("the generic writer retired in the same programme has not come back", () => {
    expect(codeOnly(engine)).not.toContain(
      "export async function recordEntitlementUsage",
    );
  });

  it("exactly one production site writes this meter", () => {
    const hits: string[] = [];
    for (const rel of [
      "services/api/src/services/exchange/evidence-exchange.service.ts",
      "services/api/src/routes/product-and-lifecycle.routes.ts",
    ]) {
      const calls = codeOnly(read(rel)).split("recordExportPackageUsage(").length - 1;
      if (calls > 0) hits.push(`${rel}:${calls}`);
    }
    expect(hits).toEqual([
      "services/api/src/services/exchange/evidence-exchange.service.ts:1",
    ]);
  });

  it("the meter is not charged on read, re-send or delivery", () => {
    // A signed URL and a delivery are re-reads of an artifact already paid
    // for; a customer who downloads twice has not bought twice.
    const exchange = codeOnly(
      read("services/api/src/services/exchange/evidence-exchange.service.ts"),
    );
    for (const fn of [
      "export async function generateSignedUrl",
      "export async function recordPackageDelivery",
    ]) {
      const at = exchange.indexOf(fn);
      if (at < 0) continue;
      const body = exchange.slice(at, exchange.indexOf("\nexport ", at + 1));
      expect(body, `${fn} must not meter`).not.toContain(
        "recordExportPackageUsage",
      );
    }
  });

  it("creation does not meter — a DRAFT can still fail to build", () => {
    const exchange = codeOnly(
      read("services/api/src/services/exchange/evidence-exchange.service.ts"),
    );
    const at = exchange.indexOf("export async function createExchangePackage");
    const body = exchange.slice(at, exchange.indexOf("\nexport ", at + 1));
    expect(body).not.toContain("recordExportPackageUsage");
  });
});
