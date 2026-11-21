/**
 * FINAL-VERIFY-2 closure (review) — the scheduled intelligence-run reconciler
 * judges OPEN derived write intents only when it is handed an object store,
 * and the worker's scheduler tick hands it the S3 store.
 *
 * Without the store step 6 never runs: every OPEN intent stays counted forever
 * and nothing ever resolves one. Before this test only the typecheck covered
 * the scheduler's argument.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  reconcile: [] as Array<{ store: unknown; limit: number }>,
  s3Stores: [] as unknown[],
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    // Steps 1-5 find nothing; they are not under test.
    mediaIntelligenceRun: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $queryRaw: vi.fn(async () => []),
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    evidence: { findFirst: vi.fn(async () => null) },
    evidencePartDerivedAsset: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

vi.mock("../src/storage.js", () => ({ s3: { marker: "worker-s3-client" } }));

vi.mock("../src/derived-storage-intent.js", () => ({
  reconcileDerivedAssetStorageIntents: vi.fn(async (input: { store: unknown; limit: number }) => {
    calls.reconcile.push(input);
    return { resolved: 2, kept: 1 };
  }),
  s3DerivedObjectStore: vi.fn((client: unknown) => {
    const store = { kind: "s3-derived-store", client };
    calls.s3Stores.push(store);
    return store;
  }),
}));

import { defaultDerivedObjectStore, runIntelligenceRunReconciler } from "../src/intelligence-run-reconciler.js";

beforeEach(() => {
  calls.reconcile.length = 0;
  calls.s3Stores.length = 0;
});

describe("FINAL-VERIFY-2 — the reconciler's derived-intent step needs a store", () => {
  it("with a store: step 6 runs against exactly that store and reports what it resolved and kept", async () => {
    const store = { kind: "fake-store" };
    const factory = vi.fn(async () => store as never);
    const result = await runIntelligenceRunReconciler({ trigger: "test", derivedObjectStore: factory });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(calls.reconcile).toHaveLength(1);
    expect(calls.reconcile[0]!.store).toBe(store);
    expect(result.derivedIntentsResolved).toBe(2);
    expect(result.derivedIntentsKept).toBe(1);
  });

  it("without a store: step 6 does not run and resolves nothing", async () => {
    const result = await runIntelligenceRunReconciler({ trigger: "test" });
    expect(calls.reconcile).toEqual([]);
    expect(result.derivedIntentsResolved).toBe(0);
    expect(result.derivedIntentsKept).toBe(0);
  });

  it("the default store is the S3 derived store over the worker's own S3 client", async () => {
    const store = await defaultDerivedObjectStore();
    expect(calls.s3Stores).toEqual([store]);
    expect(store).toEqual({ kind: "s3-derived-store", client: { marker: "worker-s3-client" } });
  });
});

describe("FINAL-VERIFY-2 — the worker's scheduler tick passes the default store", () => {
  it("runIntelligenceRunReconcilerTick calls the reconciler with derivedObjectStore: defaultDerivedObjectStore", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const start = src.indexOf("async function runIntelligenceRunReconcilerTick()");
    expect(start).toBeGreaterThan(-1);
    const tick = src.slice(start, src.indexOf("\n}\n", start));
    const call = /await runIntelligenceRunReconciler\(\{([^}]*)\}\)/.exec(tick);
    expect(call, "the tick calls runIntelligenceRunReconciler with an options object").not.toBeNull();
    expect(call![1]).toMatch(/\bderivedObjectStore:\s*defaultDerivedObjectStore\b/);
    expect(src).toMatch(/import \{[^}]*\bdefaultDerivedObjectStore\b[^}]*\} from "\.\/intelligence-run-reconciler\.js";/);
  });
});
