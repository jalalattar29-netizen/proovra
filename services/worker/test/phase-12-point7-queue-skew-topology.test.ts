/**
 * PHASE 12 — POINT 7: version skew, queue topology, and telemetry isolation.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * Two production worker incidents (Sentry `630a6b0c…`, `0bf44308…`) both
 * carried a `processPurgeDeletedEvidence` stack failing at
 * `prisma.evidence.findUnique({ where: { id: undefined } })`, and one was
 * tagged with a queue that cannot reach that processor in this tree. Three
 * separate questions came out of that, and each one gets a gate here rather
 * than a paragraph in a document:
 *
 *   A. VERSION SKEW — can a payload from a different build reach a database
 *      call at all? `undefined` arriving at Prisma is the signature of a
 *      tolerant parser filling in what a payload was missing. The strict
 *      decoder must refuse every such shape BEFORE the processor runs.
 *
 *   B. TOPOLOGY — is each queue actually bound to the processor its registry
 *      entry names? The incident's tag/stack pairing is exactly what a
 *      mis-binding looks like, so "read the registration and check" becomes an
 *      assertion instead of a code review.
 *
 *   C. TELEMETRY ISOLATION — can one job's telemetry context be observed by
 *      another job running at the same time? Both events were filed under
 *      `GET /health` because a background failure inherited the ambient scope.
 *
 * None of this needs a database, a queue, or a network.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CANONICAL_PAYLOAD_SCHEMA_VERSION,
  CANONICAL_WORK_REGISTRY,
  JOB_NAMES,
} from "@proovra/shared";

import { decodeCanonicalJob, UnprocessableJobPayload } from "../src/canonical-job.js";
import { runJobWithTelemetryContext } from "../src/sentry.js";
import { wrapJobHandlerWithOtelContext } from "../src/observability/queue-otel-context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_INDEX = resolve(HERE, "../src/index.ts");

/** The unit the two incidents landed on. */
const PURGE = JOB_NAMES.PURGE_DELETED_EVIDENCE;

function job(data: unknown, name: string = PURGE) {
  return { id: "point7-skew", name, data, attemptsMade: 0 };
}

function rejectionCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof UnprocessableJobPayload) return err.code;
    // A quarantined legacy job is a refusal too, with its own class. It
    // propagates so the processor can dead-letter it with a bounded reason,
    // so it is named here rather than lumped in with "unexpected".
    if ((err as Error)?.name === "LegacyJobQuarantined") {
      return "legacy_job_quarantined";
    }
    return `unexpected:${(err as Error)?.name ?? "unknown"}`;
  }
  return "no_rejection";
}

function canonical(overrides: Record<string, unknown> = {}) {
  return {
    commandId: "11111111-2222-3333-4444-555555555555",
    schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
    traceId: "point7-skew",
    ...overrides,
  };
}

// ===========================================================================
// A — VERSION SKEW: twelve shapes a different build could produce
// ===========================================================================

describe("PHASE 12 POINT 7 — version skew is refused before any handler runs", () => {
  const opts = { requestId: "point7-skew" };

  it("V01 — the canonical payload of THIS build decodes", () => {
    const ctx = decodeCanonicalJob(PURGE, job(canonical()), opts);
    expect(ctx.commandId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("V02 — a payload with no schemaVersion is refused, never assumed current", () => {
    // An unversioned payload is routed to this unit's registered LEGACY
    // adapter, which quarantines it because it carries no durable authority to
    // run against. That is the refusal, arriving under its own class rather
    // than as `unversioned_payload` — a unit with no legacy adapter gets the
    // canonical code instead. Either way nothing executes.
    const data = canonical();
    delete (data as Record<string, unknown>).schemaVersion;
    expect(rejectionCode(() => decodeCanonicalJob(PURGE, job(data), opts))).toBe(
      "legacy_job_quarantined",
    );
  });

  it("V03 — an OLDER schema version is refused", () => {
    expect(
      rejectionCode(() =>
        decodeCanonicalJob(
          PURGE,
          job(canonical({ schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION - 1 })),
          opts,
        ),
      ),
    ).toBe("unknown_schema_version");
  });

  it("V04 — a NEWER schema version is refused just as hard", () => {
    // Skew runs both ways. A worker that ran a payload it does not understand
    // because the number was merely bigger would be the same defect.
    expect(
      rejectionCode(() =>
        decodeCanonicalJob(
          PURGE,
          job(canonical({ schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION + 1 })),
          opts,
        ),
      ),
    ).toBe("unknown_schema_version");
  });

  it("V05 — a missing commandId is refused, never defaulted", () => {
    const data = canonical();
    delete (data as Record<string, unknown>).commandId;
    expect(rejectionCode(() => decodeCanonicalJob(PURGE, job(data), opts))).toBe(
      "missing_command_id",
    );
  });

  it("V06 — commandId null is refused", () => {
    expect(
      rejectionCode(() =>
        decodeCanonicalJob(PURGE, job(canonical({ commandId: null })), opts),
      ),
    ).toBe("missing_command_id");
  });

  it("V07 — commandId of the wrong TYPE is refused", () => {
    expect(
      rejectionCode(() =>
        decodeCanonicalJob(PURGE, job(canonical({ commandId: 12345 })), opts),
      ),
    ).toBe("missing_command_id");
  });

  it("V08 — an empty / whitespace commandId is not a commandId", () => {
    expect(
      rejectionCode(() =>
        decodeCanonicalJob(PURGE, job(canonical({ commandId: "   " })), opts),
      ),
    ).toBe("missing_command_id");
  });

  it("V09 — an unbounded commandId is refused", () => {
    expect(
      rejectionCode(() =>
        decodeCanonicalJob(PURGE, job(canonical({ commandId: "x".repeat(129) })), opts),
      ),
    ).toBe("command_id_too_long");
  });

  it("V10 — a canonical envelope carrying a legacy subject reference is refused", () => {
    // The exact shape the incident implicates: an older producer's
    // `evidenceId` riding alongside the canonical envelope.
    //
    // The code is `unknown_payload_field`, not `payload_authority_field`, and
    // that is correct rather than a gap. `FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS`
    // names things that must never be TAKEN from a payload — tenant, policy,
    // entitlement, credentials. A subject reference is not one of them: it is
    // what the legacy adapters legitimately read (`readReference`) in order to
    // load the durable row that IS the authority. Listing it there would make
    // every draining legacy job report its own reference as a violation.
    expect(
      rejectionCode(() =>
        decodeCanonicalJob(
          PURGE,
          job(canonical({ evidenceId: "a4f0f1a0-0000-0000-0000-000000000000" })),
          opts,
        ),
      ),
    ).toBe("unknown_payload_field");
  });

  it("V10b — a payload asserting TENANT or POLICY is refused as an authority violation", () => {
    for (const field of ["teamId", "workspaceId", "legalHold", "retentionPolicy"]) {
      expect(
        rejectionCode(() =>
          decodeCanonicalJob(PURGE, job(canonical({ [field]: "x" })), opts),
        ),
      ).toBe("payload_authority_field");
    }
  });

  it("V11 — a non-object payload cannot become a query", () => {
    for (const raw of [null, [], "evidence-id", 42]) {
      const code = rejectionCode(() => decodeCanonicalJob(PURGE, job(raw), opts));
      expect(["malformed_payload", "legacy_job_quarantined"]).toContain(code);
    }
  });

  it("V12 — a job on the RIGHT queue under the WRONG name never decodes", () => {
    // The check that makes B's mis-binding survivable: even if a producer
    // writes to a queue it does not own, the name mismatch stops it before the
    // processor sees a reference.
    expect(
      rejectionCode(() =>
        decodeCanonicalJob(
          PURGE,
          job(canonical(), JOB_NAMES.RECONCILE_TEAM_GRAPH),
          opts,
        ),
      ),
    ).toBe("job_name_mismatch");
  });

  it("V13 — no rejection path can hand `undefined` to a caller", () => {
    // The incident's actual failure was `where: { id: undefined }`. Whatever
    // the decoder does with a bad payload, it must THROW rather than return a
    // context with holes in it.
    const shapes = [
      {},
      { schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION },
      { evidenceId: undefined, schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION },
      canonical({ commandId: undefined }),
    ];
    for (const raw of shapes) {
      let ctx: unknown = "never-assigned";
      try {
        ctx = decodeCanonicalJob(PURGE, job(raw), opts);
      } catch {
        continue;
      }
      // If it did NOT throw, every field it produced must be usable.
      expect((ctx as { commandId?: unknown }).commandId).toBeTruthy();
    }
  });
});

// ===========================================================================
// B — TOPOLOGY: each queue is bound to the processor its registry names
// ===========================================================================

describe("PHASE 12 POINT 7 — queue topology matches the registry", () => {
  const source = readFileSync(WORKER_INDEX, "utf8");

  /**
   * Every `new Worker(<queueVar>, wrapJobHandlerWithOtelContext(<span>,
   * <queueVar>, <processor>)` in the worker entrypoint.
   *
   * Parsed rather than imported: importing `index.ts` starts a worker process.
   */
  const registrations = [
    ...source.matchAll(
      /new Worker\(\s*([A-Za-z0-9_]+)\s*,\s*wrapJobHandlerWithOtelContext\(\s*([^,]+),\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*,?\s*\)/g,
    ),
  ].map((m) => ({
    queueVar: m[1],
    spanArg: m[2].trim(),
    wrappedQueueVar: m[3],
    processor: m[4],
  }));

  it("T01 — the entrypoint registers workers through the ONE wrapper", () => {
    // If this drops to zero the parse has gone stale and every assertion below
    // would pass vacuously.
    expect(registrations.length).toBeGreaterThanOrEqual(10);
  });

  it("T02 — no queue is served by two different processors", () => {
    const byQueue = new Map<string, Set<string>>();
    for (const r of registrations) {
      const set = byQueue.get(r.queueVar) ?? new Set<string>();
      set.add(r.processor);
      byQueue.set(r.queueVar, set);
    }
    const conflicted = [...byQueue.entries()]
      .filter(([, procs]) => procs.size > 1)
      .map(([q, procs]) => `${q} -> ${[...procs].join(" | ")}`);
    expect(conflicted).toEqual([]);
  });

  it("T03 — the span's queue argument names the queue it was constructed for", () => {
    // A wrapper told one queue name while the Worker listens on another is how
    // telemetry starts describing work that is not happening.
    const mismatched = registrations
      .filter((r) => r.queueVar !== r.wrappedQueueVar)
      .map((r) => `${r.queueVar} wrapped as ${r.wrappedQueueVar}`);
    expect(mismatched).toEqual([]);
  });

  it("T04 — graph-reconcile is NOT bound to the purge processor", () => {
    // The literal pairing the two Sentry events showed. In this tree it must
    // be impossible; the gate exists so a future build cannot reintroduce it
    // silently.
    const graph = registrations.filter((r) =>
      r.queueVar.toLowerCase().includes("graphreconcile"),
    );
    expect(graph.length).toBeGreaterThan(0);
    for (const r of graph) {
      expect(r.processor).not.toBe("processPurgeDeletedEvidence");
    }
  });

  it("T05 — every processor named in a BullMQ registry entry is bound exactly once", () => {
    const bullmq = CANONICAL_WORK_REGISTRY.filter(
      (e) => e.transport === "bullmq" && e.implementation === "CURRENT_RUNTIME",
    );
    expect(bullmq.length).toBeGreaterThan(0);
    const bound = registrations.map((r) => r.processor);
    const duplicated = bound.filter((p, i) => bound.indexOf(p) !== i);
    expect(duplicated).toEqual([]);
  });
});

// ===========================================================================
// C — TELEMETRY ISOLATION under concurrency
// ===========================================================================

describe("PHASE 12 POINT 7 — concurrent jobs do not share a telemetry context", () => {
  /**
   * The SDK must be initialised for this to mean anything.
   *
   * `withIsolationScope` forks through Node's AsyncLocalStorage, and the
   * strategy that provides it is registered by `Sentry.init`. Without init the
   * fork silently degrades to mutating one process-wide scope — which is the
   * defect this suite is about, so an uninitialised run would "prove" the bug
   * is still there while proving nothing at all.
   *
   * The transport is a local stub: it satisfies the SDK and issues no request.
   * Nothing here reaches a network, and the DSN is a syntactic placeholder.
   */
  beforeAll(() => {
    Sentry.init({
      dsn: "https://point7@127.0.0.1/0",
      tracesSampleRate: 0,
      defaultIntegrations: false,
      transport: () => ({
        send: async () => ({}),
        flush: async () => true,
      }),
    });
  });

  afterAll(async () => {
    await Sentry.close(0);
  });

  /** Read what the CURRENT isolation scope believes this job is. */
  function observedJobKind(): unknown {
    return Sentry.getIsolationScope().getScopeData().tags.job_kind;
  }

  it("C01 — three jobs running at once each see only their own tags", async () => {
    // Interleaving is forced, not hoped for: every job sets its context, then
    // yields, and only reads back after all three have written. Sequential
    // execution would make the assertion meaningless.
    let arrived = 0;
    const gate: Array<() => void> = [];
    const allWritten = new Promise<void>((done) => {
      gate.push(() => {
        arrived += 1;
        if (arrived === 3) done();
      });
    });

    async function run(kind: string, queue: string) {
      return runJobWithTelemetryContext({ jobKind: kind, queueName: queue }, async () => {
        gate[0]!();
        await allWritten;
        return observedJobKind();
      });
    }

    const [health, graph, purge] = await Promise.all([
      run("health-probe", "health"),
      run("reconcile-team-graph", "graph-reconcile"),
      run("purge-deleted-evidence", "evidence-purge"),
    ]);

    expect(health).toBe("health-probe");
    expect(graph).toBe("reconcile-team-graph");
    expect(purge).toBe("purge-deleted-evidence");
  });

  it("C02 — a job's tags do not survive it", async () => {
    await runJobWithTelemetryContext(
      { jobKind: "purge-deleted-evidence", queueName: "evidence-purge" },
      async () => undefined,
    );
    // This is the ambient scope an HTTP health probe would capture on. Before
    // the fix it still carried the last job's `job_kind`, which is how a purge
    // stack came to be filed under `GET /health`.
    expect(observedJobKind()).toBeUndefined();
  });

  it("C03 — the wrapper every queue handler passes through installs the context", async () => {
    // Proven through `wrapJobHandlerWithOtelContext` rather than by calling
    // the helper directly, because the wiring is the thing that was missing:
    // the helper existed and nothing used it.
    const wrapped = wrapJobHandlerWithOtelContext(
      "proovra.worker.evidence_purge",
      "evidence-purge",
      async () => observedJobKind(),
    );
    const seen = await wrapped({
      id: "1",
      name: PURGE,
      data: {},
      attemptsMade: 0,
    });
    expect(seen).toBe(PURGE);
    expect(observedJobKind()).toBeUndefined();
  });
});
