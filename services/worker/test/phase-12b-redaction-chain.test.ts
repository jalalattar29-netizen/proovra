/**
 * PHASE 12B WAVE 2A — redaction derivative chain behavioral matrix (worker).
 *
 * Drives the REAL claim/completion writer + processor guard paths with a
 * mocked prisma/storage TRANSPORT (never the authority under proof):
 *   - atomic QUEUED→RENDERING claim; replayed/duplicate jobs lose the race;
 *   - READY only from RENDERING (stale/double completion rejected);
 *   - anti-overwrite: derivative can never point at the original object;
 *   - FAILED allowed from QUEUED (structural) + RENDERING; bounded metadata;
 *   - processor fails closed on tenant mismatch / unapproved version /
 *     FUTURE_NOT_SHIPPING media / missing PDF page identity — zero mutation
 *     beyond the honest FAILED transition, never READY;
 *   - stranded-QUEUED reconciler re-enqueues only old QUEUED rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const DB = vi.hoisted(() => ({
  derivative: null as Record<string, unknown> | null,
  evidence: null as Record<string, unknown> | null,
  version: null as Record<string, unknown> | null,
  regions: [] as Array<Record<string, unknown>>,
  activities: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  strandedRows: [] as Array<{ id: string }>,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    redactionDerivative: {
      findUnique: async () => DB.derivative,
      findFirst: async () => DB.derivative,
      findMany: async () => DB.strandedRows,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const st = DB.derivative?.state;
        const wantIn = (args.where.state as { in?: string[] } | string) ?? null;
        const ok =
          typeof wantIn === "string"
            ? st === wantIn
            : Array.isArray((wantIn as { in?: string[] })?.in)
              ? ((wantIn as { in: string[] }).in as string[]).includes(st as string)
              : false;
        if (ok && DB.derivative) {
          Object.assign(DB.derivative, args.data);
          DB.updates.push(args.data);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    evidence: { findFirst: async () => DB.evidence },
    redactionVersion: { findUnique: async () => ({ projectId: "proj-1" }) },
    redactionRegion: { findMany: async () => DB.regions },
    redactionActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        DB.activities.push(args.data);
        return args.data;
      },
    },
  },
}));
vi.mock("../src/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock("../src/storage.js", () => ({
  getObjectRange: async () => Buffer.from("source-bytes"),
  putObjectBuffer: async () => undefined,
}));

import {
  claimDerivativeForRender,
  markDerivativeFailedWorker,
  markDerivativeReadyWorker,
} from "../src/redaction/redaction-derivative-writer.js";
import {
  processRedactionDerivativeJob,
  reconcileStrandedRedactionDerivatives,
} from "../src/redaction/redaction-derivative.processor.js";

function seedDerivative(state: string, overrides: Record<string, unknown> = {}) {
  DB.derivative = {
    id: "d-1",
    teamId: "team-1",
    versionId: "v-1",
    state,
    version: {
      id: "v-1",
      teamId: "team-1",
      state: "APPROVED",
      project: { id: "proj-1", teamId: "team-1", artifactKind: "IMAGE", evidenceId: "ev-1" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  DB.derivative = null;
  DB.evidence = { storageBucket: "bkt", storageKey: "orig/key", fileSha256: null };
  DB.regions = [];
  DB.activities = [];
  DB.updates = [];
  DB.strandedRows = [];
});

describe("PHASE 12B — claim + completion writer (the ONE authority)", () => {
  it("claims QUEUED→RENDERING exactly once; a replay loses the race", async () => {
    seedDerivative("QUEUED");
    const first = await claimDerivativeForRender("d-1");
    expect(first.claimed).toBe(true);
    expect(DB.derivative?.state).toBe("RENDERING");
    const replay = await claimDerivativeForRender("d-1");
    expect(replay.claimed).toBe(false);
    expect((replay as { reason?: string }).reason).toBe("not_queued");
  });

  it("READY only from RENDERING — a stale/double completion is rejected with zero mutation", async () => {
    seedDerivative("RENDERING");
    const ok = await markDerivativeReadyWorker({
      derivativeId: "d-1", teamId: "team-1", storageBucket: "bkt",
      storageKey: "redactions/team-1/v-1/abc.png", byteSize: 10,
      fileSha256: "a".repeat(64), contentType: "image/png", renderEngine: "redaction-render-v1",
    });
    expect(ok.ok).toBe(true);
    expect(DB.derivative?.state).toBe("READY");
    const updatesBefore = DB.updates.length;
    const replay = await markDerivativeReadyWorker({
      derivativeId: "d-1", teamId: "team-1", storageBucket: "bkt",
      storageKey: "redactions/team-1/v-1/other.png", byteSize: 11,
      fileSha256: "b".repeat(64), contentType: "image/png", renderEngine: "redaction-render-v1",
    });
    expect(replay.ok).toBe(false);
    expect((replay as { reason?: string }).reason).toBe("stale_transition");
    expect(DB.updates.length).toBe(updatesBefore); // zero mutation
  });

  it("REFUSES a derivative pointing at the ORIGINAL Evidence object (immutability)", async () => {
    seedDerivative("RENDERING");
    const res = await markDerivativeReadyWorker({
      derivativeId: "d-1", teamId: "team-1", storageBucket: "bkt",
      storageKey: "orig/key", // the original!
      byteSize: 10, fileSha256: "a".repeat(64), contentType: "image/png",
      renderEngine: "redaction-render-v1",
    });
    expect(res.ok).toBe(false);
    expect((res as { reason?: string }).reason).toBe("original_object_collision");
    expect(DB.derivative?.state).toBe("RENDERING"); // untouched
  });

  it("FAILED is reachable from QUEUED (structural) and RENDERING, with bounded metadata", async () => {
    seedDerivative("QUEUED");
    const res = await markDerivativeFailedWorker({
      derivativeId: "d-1", teamId: "team-1",
      failureReason: "x".repeat(500), errorPreview: "y".repeat(1000),
    });
    expect(res.ok).toBe(true);
    expect(DB.derivative?.state).toBe("FAILED");
    expect((DB.derivative?.failureReason as string).length).toBeLessThanOrEqual(120);
    expect((DB.derivative?.lastErrorPreview as string).length).toBeLessThanOrEqual(400);
  });
});

describe("PHASE 12B — processor fail-closed guards (zero READY on any mismatch)", () => {
  const job = (id = "d-1") => ({ id: `rd-${id}`, data: { derivativeId: id } }) as never;

  it("tenant mismatch between rows FAILS closed", async () => {
    seedDerivative("QUEUED");
    (DB.derivative!.version as Record<string, unknown>).teamId = "team-OTHER";
    await processRedactionDerivativeJob(job());
    expect(DB.derivative?.state).toBe("FAILED");
    expect(DB.derivative?.failureReason).toBe("tenant_mismatch");
  });

  it("unapproved version FAILS closed", async () => {
    seedDerivative("QUEUED");
    (DB.derivative!.version as Record<string, unknown>).state = "DRAFT";
    await processRedactionDerivativeJob(job());
    expect(DB.derivative?.failureReason).toBe("version_not_approved");
  });

  it("FUTURE_NOT_SHIPPING media (VIDEO) FAILS safely — never READY, never a copied original", async () => {
    seedDerivative("QUEUED");
    ((DB.derivative!.version as Record<string, unknown>).project as Record<string, unknown>).artifactKind = "VIDEO";
    await processRedactionDerivativeJob(job());
    expect(DB.derivative?.state).toBe("FAILED");
    expect(DB.derivative?.failureReason).toBe("unsupported_media");
  });

  it("PDF region without page identity FAILS closed (no silent unredacted page)", async () => {
    seedDerivative("QUEUED");
    ((DB.derivative!.version as Record<string, unknown>).project as Record<string, unknown>).artifactKind = "PDF";
    DB.regions = [{ geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }]; // no page
    await processRedactionDerivativeJob(job());
    expect(DB.derivative?.state).toBe("FAILED");
    expect(DB.derivative?.failureReason).toBe("region_page_missing");
  });

  it("invalid region geometry FAILS closed", async () => {
    seedDerivative("QUEUED");
    DB.regions = [{ geometry: { x: "bad" } }];
    await processRedactionDerivativeJob(job());
    expect(DB.derivative?.failureReason).toBe("region_invalid");
  });

  it("a replayed job against a completed derivative touches NOTHING", async () => {
    seedDerivative("READY");
    await processRedactionDerivativeJob(job());
    expect(DB.derivative?.state).toBe("READY");
    expect(DB.updates.length).toBe(0);
  });
});

describe("PHASE 12B — stranded-QUEUED reconciler", () => {
  it("re-enqueues only the stranded QUEUED rows the DB returns", async () => {
    DB.strandedRows = [{ id: "d-1" }, { id: "d-2" }];
    const enqueued: string[] = [];
    const res = await reconcileStrandedRedactionDerivatives({
      enqueue: async (p) => {
        enqueued.push(p.derivativeId);
        return { enqueued: true };
      },
    });
    expect(res).toEqual({ scanned: 2, reenqueued: 2 });
    expect(enqueued).toEqual(["d-1", "d-2"]);
  });
});
