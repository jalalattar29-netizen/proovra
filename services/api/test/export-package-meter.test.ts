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

/**
 * @param failUsageWrites how many `entitlementUsage.upsert` calls should throw
 *   before the double starts accepting them. Models a metering write that
 *   fails — the case that used to leave a package READY and unmetered forever.
 */
function makePrisma(rows: PackageRow[], failUsageWrites = 0) {
  const usage: Array<{ teamId: string; key: string; amount: bigint }> = [];
  const packages = [...rows];
  let remainingFailures = failUsageWrites;
  const client: Record<string, unknown> = {
    /**
     * TRANSACTION SEMANTICS, MODELLED — not stubbed away.
     *
     * A `$transaction` that merely called the callback would make every
     * assertion below about atomicity vacuous: the package would stay READY
     * after a failed meter and the test would still pass. This one snapshots
     * both tables and RESTORES them when the callback throws, which is the
     * property the production code now depends on. A double that cannot fail
     * the way the database fails proves nothing about the rollback.
     */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const packageSnapshot = packages.map((p) => ({ ...p }));
      const usageSnapshot = usage.map((u) => ({ ...u }));
      try {
        return await fn(client);
      } catch (err) {
        packages.splice(0, packages.length, ...packageSnapshot);
        usage.splice(0, usage.length, ...usageSnapshot);
        throw err;
      }
    },
  };
  Object.assign(client, {
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
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            throw new Error("entitlement_usage write failed");
          }
          const k = a.where.teamId_key_periodStartUtc;
          usage.push({ teamId: k.teamId, key: k.key, amount: a.create.consumed });
          return {};
        },
      },
  });
  return { usage, packages, client };
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

/**
 * ===========================================================================
 * THE ATOMICITY GAP — a READY package that could never be metered.
 * ===========================================================================
 * The transition and the meter used to be two sequential writes with the
 * second one swallowing its own failures. That produced a state nothing could
 * repair: the package committed READY, the usage write failed silently, and
 * every retry found no DRAFT/BUILDING row to transition — so the meter was
 * never attempted again and the month was permanently one short.
 *
 * These cases fail against that implementation and pass against the current
 * one, which is the only reason to have them.
 */
describe("export package meter — READY and metered cannot diverge", () => {
  it("a failed usage write leaves the package RETRYABLE, not READY-and-unmetered", async () => {
    const { markPackageReady } = await loadExchange();
    // The first metering write fails; the second succeeds.
    const db = makePrisma([{ id: "pkg-1", teamId: "ws-1", state: "DRAFT" }], 1);
    const call = () =>
      markPackageReady({
        prisma: db.client as never,
        teamId: "ws-1",
        packageId: "pkg-1",
        storageKey: "s3://bucket/pkg-1.zip",
        packageSha256: "a".repeat(64),
        packageSizeBytes: 1024,
      });

    // The failure is REPORTED, not swallowed. A caller told "ready" about a
    // package that is not ready is the thing that made this unrecoverable.
    await expect(call()).rejects.toThrow(/entitlement_usage write failed/);

    // THE ASSERTION THAT MATTERS: the transition rolled back with it.
    expect(db.packages[0]!.state).toBe("DRAFT");
    expect(db.usage).toHaveLength(0);

    // And because it rolled back, the retry is an ordinary first attempt.
    const retry = await call();
    expect(retry.ok).toBe(true);
    expect(db.packages[0]!.state).toBe("READY");
    // Exactly one unit for one package, across a failure and a retry.
    expect(db.usage).toHaveLength(1);
    expect(db.usage[0]!.amount).toBe(1n);
  });

  it("the meter write is inside the same transaction as the transition", async () => {
    /*
     * Ordering proof. The callback must observe the package as READY when the
     * meter runs — i.e. the meter is INSIDE the transaction, after the
     * conditional update — rather than running after a committed transition.
     */
    const { markPackageReady } = await loadExchange();
    const observed: string[] = [];
    const db = makePrisma([{ id: "pkg-1", teamId: "ws-1", state: "DRAFT" }]);
    const realUpsert = (
      db.client as unknown as {
        entitlementUsage: { upsert: (a: unknown) => Promise<unknown> };
      }
    ).entitlementUsage.upsert;
    (
      db.client as unknown as {
        entitlementUsage: { upsert: (a: unknown) => Promise<unknown> };
      }
    ).entitlementUsage.upsert = async (a: unknown) => {
      observed.push(db.packages[0]!.state);
      return realUpsert(a);
    };

    const res = await markPackageReady({
      prisma: db.client as never,
      teamId: "ws-1",
      packageId: "pkg-1",
      storageKey: "s3://bucket/pkg-1.zip",
      packageSha256: "a".repeat(64),
      packageSizeBytes: 1,
    });

    expect(res.ok).toBe(true);
    expect(observed).toEqual(["READY"]);
  });

  it("the completion boundary opens a transaction, and the writer does not swallow", () => {
    const exchange = codeOnly(
      read("services/api/src/services/exchange/evidence-exchange.service.ts"),
    );
    const boundary = exchange.slice(
      exchange.indexOf("export async function markPackageReady"),
    );
    // The transition and the meter are in ONE transaction callback.
    expect(boundary).toContain("prisma.$transaction");
    const txBody = boundary.slice(boundary.indexOf("prisma.$transaction"));
    expect(txBody).toContain("tx.evidenceExchangePackage.updateMany");
    expect(txBody).toContain("recordExportPackageUsage({ prisma: tx");

    // And the writer no longer discards its own failure — a swallow inside the
    // transaction would commit READY with no meter and rebuild the divergence.
    const writer = codeOnly(
      read("services/api/src/services/packaging/entitlement.service.ts"),
    );
    const fn = writer.slice(
      writer.indexOf("export async function recordExportPackageUsage"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    expect(body).not.toContain("catch");
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
