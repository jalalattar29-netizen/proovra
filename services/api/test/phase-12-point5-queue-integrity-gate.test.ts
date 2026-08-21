/**
 * PHASE 12 — POINT 5: permanent queue/worker integrity closure gate.
 *
 * These are the MEASUREMENTS behind the Point-5 metrics, not a paraphrase of
 * them. Each `it` computes one number from the real tree and asserts it, so a
 * metric cannot be reported without the gate agreeing.
 *
 * Two kinds of assertion live here and they are not interchangeable:
 *
 *   * CONTRACT assertions import `@proovra/shared` and RUN it. These are
 *     behavioral: the decoder actually rejects, the enqueue policy actually
 *     collapses, the registry is actually self-consistent.
 *
 *   * STRUCTURAL assertions scan source. They stop a future edit from
 *     reintroducing a private queue-name literal or a payload authority field —
 *     things a behavioral test cannot see, because the offending code would
 *     simply never be reached. They SUPPLEMENT the behavioral proof and never
 *     replace it.
 *
 * The registry is verified against the FILESYSTEM: a named producer, processor,
 * reconciler or terminal writer that does not exist fails the gate. A registry
 * that can name a deleted file is worse than no registry, because it reads as
 * coverage.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_PAYLOAD_KEYS,
  CANONICAL_PAYLOAD_SCHEMA_VERSION,
  CANONICAL_WORK_REGISTRY,
  DIAGNOSTICS_FORBIDDEN_KEYS,
  DLQ_SINKS,
  FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS,
  JOB_NAMES,
  LEGACY_PAYLOAD_ADAPTERS,
  LEGACY_QUEUE_RETENTION_MS,
  LegacyJobQuarantined,
  QUEUE_FAMILIES,
  QUEUE_NAMES,
  QueuePayloadRejected,
  SWEEP_NAMES,
  assertDiagnosticsSafe,
  assertNoPayloadAuthorityFields,
  buildCanonicalJobId,
  buildCanonicalJobPayload,
  buildGraphDomainCommandId,
  buildMediaIntelligenceCommandId,
  buildSearchIndexCommandId,
  decodeCanonicalJobPayload,
  decodeJobPayload,
  enqueueCanonicalJob,
  findAdaptersWithoutRemovalCondition,
  findUnclassifiedLegacyShapes,
  findJobsMappedToMultipleFamilies,
  findRegistryIntegrityViolations,
  getBullMqEntries,
  getSweepEntries,
  getWorkEntry,
  getWorkEntryOrThrow,
  isAuthorityFieldName,
  isDlqQueueName,
  type WorkRegistryEntry,
} from "@proovra/shared";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), "utf8");
}

function exists(rel: string): boolean {
  try {
    statSync(resolve(REPO, rel));
    return true;
  } catch {
    return false;
  }
}

/** Every `.ts` file under a repo-relative directory, recursively. */
function walkTs(relDir: string): string[] {
  const abs = resolve(REPO, relDir);
  const out: string[] = [];
  const stack = [abs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
    }
  }
  return out;
}

const WORKER_INDEX_SRC = read("services/worker/src/index.ts");
const WORKER_QUEUE_SRC = read("services/worker/src/queue.ts");

// ===========================================================================
// 1. Topology conservation
// ===========================================================================

describe("Point 5 — topology conservation", () => {
  /**
   * The measured tree, recomputed here rather than asserted from memory.
   * These four numbers are the ones the registry must conserve.
   */
  const measured = (() => {
    const queueObjects = [
      ...WORKER_QUEUE_SRC.matchAll(/export const (\w+) = new Queue\(/g),
    ].length;
    const registrations = [
      ...WORKER_INDEX_SRC.matchAll(/safeRegisterWorker\(\s*\n?\s*"([^"]+)"/g),
    ].map((m) => m[1]!);
    const schedulers = [
      ...WORKER_INDEX_SRC.matchAll(/^function (start\w+)\(/gm),
    ].map((m) => m[1]!);
    return { queueObjects, registrations, schedulers };
  })();

  // PHASE 12 POINT 5 — these two cases used to pin 19 and 17 as literals, and
  // when `mi-ocr` / `mi-transcript` were removed as duplicate authorities all
  // four numbers moved at once. A literal per number invites picking whichever
  // one makes the run green, so the conservation is now expressed as an
  // IDENTITY between four independently derived sets — the queues declared in
  // the worker, the names in the shared authority, the worker registrations
  // and the registry — with the DLQ sinks as the single stated difference.
  //
  // The measured count is 17 queue objects = 15 processed + 2 DLQ sinks.
  it("BullMQ Queue objects = processed queues + DLQ sinks", () => {
    const processedNames = Object.values(QUEUE_NAMES).filter(
      (q) => !isDlqQueueName(q),
    );
    expect(DLQ_SINKS).toHaveLength(2);
    expect(measured.queueObjects).toBe(
      processedNames.length + DLQ_SINKS.length,
    );
    expect(Object.values(QUEUE_NAMES)).toHaveLength(
      processedNames.length + DLQ_SINKS.length,
    );
    // The removed chains, named explicitly so their absence is a measurement.
    expect(Object.values(QUEUE_NAMES) as string[]).not.toContain("mi-ocr");
    expect(Object.values(QUEUE_NAMES) as string[]).not.toContain(
      "mi-transcript",
    );
  });

  it("worker registrations pair 1:1 with registered BullMQ jobs", () => {
    const jobs = getBullMqEntries();
    expect(measured.registrations).toHaveLength(jobs.length);
    expect(new Set(measured.registrations).size).toBe(jobs.length);
    expect(Object.values(JOB_NAMES)).toHaveLength(jobs.length);
    expect(
      Object.values(QUEUE_NAMES).filter((q) => !isDlqQueueName(q)),
    ).toHaveLength(jobs.length);
    // NOTE: `safeRegisterWorker`'s first argument is a WorkerKind LABEL, not a
    // queue name — `"derived-assets"` labels the `mi-derived-assets` queue.
    // Counts and uniqueness are therefore all this case can honestly claim.
    // The queue-to-registration mapping itself is discovered from the
    // `new Worker(<name>` sites and diffed against the registry by the
    // independent topology gate, which does not read this registry at all.
  });

  it("every DB sweep is registered; the 2 telemetry samplers are not work", () => {
    // ARCH-005 (2026-08-07) — this case used to pin 19 and 17 as LITERALS, and
    // adding `AutomationDispatchSweep` moved both at once. A literal per number
    // invites picking whichever one makes the run green, and this file's own
    // sibling case above already says so about the queue counts. The
    // conservation is now an IDENTITY between three independently derived
    // sets — the schedulers declared in the worker, the names in the shared
    // authority, and the registry — with the samplers as the single stated
    // difference.
    //
    // The samplers own no durable state and process no rows, so registering
    // them as Point-5 work would inflate the count with things that have
    // nothing to be idempotent about.
    const samplers = measured.schedulers.filter(
      (s) => s === "startObservabilityHeartbeat" || s === "startQueueHealthSampler",
    );
    expect(samplers).toHaveLength(2);
    expect(Object.values(SWEEP_NAMES)).toHaveLength(getSweepEntries().length);
    expect(measured.schedulers).toHaveLength(
      Object.values(SWEEP_NAMES).length + samplers.length,
    );
    // The sweep this pass added, named explicitly so its presence is a
    // measurement rather than an arithmetic side effect.
    expect(Object.values(SWEEP_NAMES) as string[]).toContain(
      "AutomationDispatchSweep",
    );
    expect(measured.schedulers).toContain("startAutomationDispatchScheduler");
  });

  it("RegisteredBullMqJobs = BullMqJobsWithProducerAndProcessor (no orphans)", () => {
    // Every registered job names both a producer and a processor, and both
    // exist. `ExplicitInternalSchedulerJobs` and `GenuineExternalMachineJobs`
    // are both zero: every BullMQ job in this platform is produced by
    // application code in this repository.
    const orphanProducers: string[] = [];
    const orphanProcessors: string[] = [];
    for (const e of getBullMqEntries()) {
      if (!e.canonicalProducer || !exists(e.canonicalProducer)) {
        orphanProducers.push(`${e.workName} -> ${e.canonicalProducer}`);
      }
      if (!e.canonicalProcessor || !exists(e.canonicalProcessor)) {
        orphanProcessors.push(`${e.workName} -> ${e.canonicalProcessor}`);
      }
    }
    expect(orphanProducers, orphanProducers.join("\n")).toEqual([]);
    expect(orphanProcessors, orphanProcessors.join("\n")).toEqual([]);
  });

  it("RegisteredDbSweeps = DbSweepsWithSchedulerAndProcessor", () => {
    const missing: string[] = [];
    for (const e of getSweepEntries()) {
      if (!exists(e.canonicalProcessor)) {
        missing.push(`${e.workName} processor -> ${e.canonicalProcessor}`);
      }
      if (!exists(e.workerRegistration)) {
        missing.push(`${e.workName} scheduler -> ${e.workerRegistration}`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("UnregisteredBullMqQueues = 0 and UnclassifiedQueueEntries = 0", () => {
    const claimed = new Set(
      getBullMqEntries()
        .map((e) => e.queueName)
        .filter((q): q is NonNullable<typeof q> => !!q),
    );
    const sinks = new Set(DLQ_SINKS.map((s) => s.queueName));
    const unregistered = Object.values(QUEUE_NAMES).filter(
      (q) => !claimed.has(q) && !sinks.has(q),
    );
    expect(unregistered, unregistered.join(", ")).toEqual([]);
  });
});

// ===========================================================================
// 2. Registry integrity
// ===========================================================================

describe("Point 5 — canonical registry integrity", () => {
  it("the registry has no structural violations", () => {
    const violations = findRegistryIntegrityViolations();
    expect(
      violations,
      violations.map((v) => `${v.workName}: ${v.rule} — ${v.detail}`).join("\n"),
    ).toEqual([]);
  });

  it("QueueFamilyCount = 9, UnmappedJobs = 0, JobsMappedToMultipleFamilies = 0", () => {
    expect(QUEUE_FAMILIES).toHaveLength(9);
    const covered = new Set(CANONICAL_WORK_REGISTRY.map((e) => e.family));
    const empty = QUEUE_FAMILIES.filter((f) => !covered.has(f));
    expect(empty, `families with no registered work: ${empty.join(", ")}`).toEqual(
      [],
    );
    expect(findJobsMappedToMultipleFamilies()).toEqual([]);
  });

  it("every family assignment states a reason", () => {
    const silent = CANONICAL_WORK_REGISTRY.filter(
      (e) => e.familyReason.trim().length < 20,
    ).map((e) => e.workName);
    expect(silent, silent.join(", ")).toEqual([]);
  });

  it("TargetOnlyEntriesInClosureRegistry = 0", () => {
    const targets = CANONICAL_WORK_REGISTRY.filter(
      (e) => e.implementation !== "CURRENT_RUNTIME",
    ).map((e) => `${e.workName} (${e.implementation})`);
    expect(targets, targets.join("\n")).toEqual([]);
  });

  it("NonexistentRegistrySymbols = 0 — every named module exists on disk", () => {
    const missing: string[] = [];
    const check = (spec: string, label: string) => {
      const path = spec.split("#")[0]!;
      if (!path.includes("/") || !path.endsWith(".ts")) return;
      if (!exists(path)) missing.push(`${label}: ${path}`);
    };
    for (const e of CANONICAL_WORK_REGISTRY) {
      check(e.canonicalProducer, `${e.workName} producer`);
      check(e.canonicalProcessor, `${e.workName} processor`);
      check(e.reconciler, `${e.workName} reconciler`);
      check(e.terminalWriter, `${e.workName} terminalWriter`);
      check(e.workerRegistration, `${e.workName} workerRegistration`);
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("NonexistentRegistryModels = 0 — every durable authority exists in the schema", () => {
    const schema = read("services/api/prisma/schema.prisma");
    const declared = new Set(
      [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]!),
    );
    const missing: string[] = [];
    for (const e of CANONICAL_WORK_REGISTRY) {
      // An entry may annotate its model, e.g. "EvidenceSearchDocument (source
      // entity)". The model name is the leading identifier.
      const model = e.durableAuthority.model.split(/[\s(]/)[0]!;
      if (!declared.has(model)) {
        missing.push(`${e.workName} -> ${model}`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("JobsWithoutDurableAuthority = 0", () => {
    const offenders = CANONICAL_WORK_REGISTRY.filter(
      (e) =>
        !e.durableAuthority.model.trim() ||
        !e.durableAuthority.tenantSource.trim() ||
        !e.durableAuthority.createdBySynchronousPath,
    ).map((e) => e.workName);
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  it("JobsWithoutIdempotency = 0", () => {
    const offenders = CANONICAL_WORK_REGISTRY.filter(
      (e) => e.idempotency.length === 0,
    ).map((e) => e.workName);
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  it("JobsWithoutReconciler = 0 and RECONCILER_PENDING = []", () => {
    // The closure contract: no backlog list, no exemptions. Every unit of work
    // names a reconciler and that reconciler exists (proved above).
    const RECONCILER_PENDING: string[] = [];
    const missing = CANONICAL_WORK_REGISTRY.filter((e) => !e.reconciler).map(
      (e) => e.workName,
    );
    expect(missing, missing.join(", ")).toEqual([]);
    expect(RECONCILER_PENDING).toEqual([]);
  });

  it("JobsWithoutDeterministicId = 0 for every BullMQ job", () => {
    const offenders = getBullMqEntries()
      .filter((e) => !e.jobIdPrefix)
      .map((e) => e.workName);
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  it("every unit of work declares a bounded retry and recovery policy", () => {
    const offenders: string[] = [];
    for (const e of CANONICAL_WORK_REGISTRY) {
      if (e.retry.attempts < 1 || e.retry.attempts > 25) {
        offenders.push(`${e.workName}: attempts=${e.retry.attempts}`);
      }
      if (e.retry.timeoutMs < 1_000) {
        offenders.push(`${e.workName}: timeoutMs=${e.retry.timeoutMs}`);
      }
      if (e.recovery.reconcileBatchSize < 1) {
        offenders.push(`${e.workName}: unbounded reconcile batch`);
      }
      if (e.recovery.processingLeaseTimeoutMs < 1) {
        offenders.push(`${e.workName}: no processing lease timeout`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("DuplicateEnqueueAuthorities = 0 — every BullMQ job enqueues through the shared helper", () => {
    const offenders = getBullMqEntries()
      .filter(
        (e) =>
          e.canonicalProducer !==
          "packages/shared/src/queue-integrity/enqueue.ts",
      )
      .map((e) => `${e.workName} -> ${e.canonicalProducer}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("DuplicateHandlerRegistrations = 0 — one queue, one entry, one registration", () => {
    const byQueue = new Map<string, string[]>();
    for (const e of getBullMqEntries()) {
      if (!e.queueName) continue;
      byQueue.set(e.queueName, [...(byQueue.get(e.queueName) ?? []), e.workName]);
    }
    const dupes = [...byQueue].filter(([, names]) => names.length > 1);
    expect(dupes, JSON.stringify(dupes)).toEqual([]);
  });

  it("DuplicateTerminalWriters = 0 — each unit of work has exactly one", () => {
    // A module may be the terminal writer for SEVERAL distinct units of work
    // (the subsystem processor owns eight), which is one implementation serving
    // eight jobs — not eight writers racing over one job. The property that
    // matters is the inverse: no unit of work has more than one declared
    // terminal writer, and none is blank.
    const offenders = CANONICAL_WORK_REGISTRY.filter(
      (e) => !e.terminalWriter.trim(),
    ).map((e) => e.workName);
    expect(offenders, offenders.join(", ")).toEqual([]);
    const perWork = new Map<string, Set<string>>();
    for (const e of CANONICAL_WORK_REGISTRY) {
      const s = perWork.get(e.workName) ?? new Set<string>();
      s.add(e.terminalWriter);
      perWork.set(e.workName, s);
    }
    expect([...perWork].filter(([, w]) => w.size > 1)).toEqual([]);
  });

  it("an unknown work name is refused rather than guessed at", () => {
    expect(getWorkEntry("NoSuchJob")).toBeNull();
    expect(() => getWorkEntryOrThrow("NoSuchJob")).toThrow();
  });
});

// ===========================================================================
// 3. Payload contract — behavioral
// ===========================================================================

describe("Point 5 — canonical payload contract", () => {
  const entry = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_DERIVATIVE);
  const EXPECT = {
    jobName: entry.workName,
    schemaVersion: entry.schemaVersion,
  };

  it("a canonical payload carries the reference triple and nothing beyond the allowlist", () => {
    const payload = buildCanonicalJobPayload({
      commandId: "cmd-1",
      traceId: "trace-1",
    });
    // `traceparent` is OPTIONAL — omitted rather than null when the producer is
    // not inside a sampled trace, so an absent key cannot be mistaken for a
    // trace that exists. The invariant is therefore a subset relation, not
    // equality: the required three are always present, and nothing outside the
    // allowlist ever is.
    expect(Object.keys(payload).sort()).toEqual([
      "commandId",
      "schemaVersion",
      "traceId",
    ]);
    for (const key of Object.keys(payload)) {
      expect(CANONICAL_PAYLOAD_KEYS, key).toContain(key);
    }
    expect(payload.schemaVersion).toBe(CANONICAL_PAYLOAD_SCHEMA_VERSION);
  });

  it("a traceparent is carried when well-formed and REFUSED when not", () => {
    const good = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const withTrace = buildCanonicalJobPayload({
      commandId: "cmd-1",
      traceId: "t",
      traceparent: good,
    });
    expect(withTrace.traceparent).toBe(good);

    // Round-trips through the strict decoder.
    const decoded = decodeCanonicalJobPayload(EXPECT, {
      ...withTrace,
      schemaVersion: entry.schemaVersion,
    });
    expect(decoded.traceparent).toBe(good);

    // A malformed value is a rejection, not a silent drop — same rule as every
    // other field. A tracer is not a reason to relax the contract.
    expect(() =>
      decodeCanonicalJobPayload(EXPECT, {
        commandId: "c",
        traceId: "t",
        schemaVersion: entry.schemaVersion,
        traceparent: "not-a-traceparent",
      }),
    ).toThrow(QueuePayloadRejected);

    // And a builder handed rubbish omits the key rather than emitting it.
    expect(
      buildCanonicalJobPayload({
        commandId: "c",
        traceId: "t",
        traceparent: "garbage",
      }).traceparent,
    ).toBeUndefined();
  });

  it("CanonicalPayloadUnknownFieldsAccepted = 0 — strict, not sanitising", () => {
    // The distinction this asserts: a decoder that silently drops `teamId`
    // turns a tampered payload into a successful job. This one refuses.
    for (const field of FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS) {
      expect(
        () =>
          decodeCanonicalJobPayload(EXPECT, {
            commandId: "c",
            traceId: "t",
            schemaVersion: entry.schemaVersion,
            [field]: "smuggled",
          }),
        field,
      ).toThrow(QueuePayloadRejected);
    }
    // `teamId` is the workspace under this platform's model, and it is refused
    // by the same rule.
    expect(() =>
      decodeCanonicalJobPayload(EXPECT, {
        commandId: "c",
        traceId: "t",
        schemaVersion: entry.schemaVersion,
        teamId: "attacker",
      }),
    ).toThrow(QueuePayloadRejected);
    // Even a harmless-looking unknown field is refused: the allowlist is the
    // contract, so nothing gets in by being unremarkable.
    expect(() =>
      decodeCanonicalJobPayload(EXPECT, {
        commandId: "c",
        traceId: "t",
        schemaVersion: entry.schemaVersion,
        note: "hello",
      }),
    ).toThrow(QueuePayloadRejected);
  });

  it("the rejection names the offending authority fields", () => {
    try {
      decodeCanonicalJobPayload(EXPECT, {
        commandId: "c",
        traceId: "t",
        schemaVersion: entry.schemaVersion,
        workspaceId: "a",
        signedUrl: "b",
      });
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(QueuePayloadRejected);
      const rejected = err as QueuePayloadRejected;
      expect(rejected.code).toBe("payload_authority_field");
      expect([...rejected.offendingFields].sort()).toEqual([
        "signedUrl",
        "workspaceId",
      ]);
    }
  });

  it("UnknownPayloadVersionsAccepted = 0 and UnversionedPayloads = 0", () => {
    for (const e of CANONICAL_WORK_REGISTRY) {
      const ex = { jobName: e.workName, schemaVersion: e.schemaVersion };
      expect(() =>
        decodeCanonicalJobPayload(ex, {
          commandId: "c",
          traceId: "t",
          schemaVersion: e.schemaVersion + 1000,
        }),
      ).toThrow(QueuePayloadRejected);
      expect(() =>
        decodeCanonicalJobPayload(ex, { commandId: "c", traceId: "t" }),
      ).toThrow(QueuePayloadRejected);
    }
  });

  it("malformed payloads are refused before any mutation could occur", () => {
    for (const bad of [null, undefined, 42, "str", [], {}, true]) {
      expect(() => decodeCanonicalJobPayload(EXPECT, bad)).toThrow(
        QueuePayloadRejected,
      );
    }
  });

  it("QueuePayloadSecrets = 0 and QueuePayloadPII = 0 on the wire", () => {
    // Serialise a payload for each registered BullMQ job exactly as it goes on
    // the wire, and assert the SERIALISED FORM contains no forbidden field name.
    for (const e of getBullMqEntries()) {
      const wire = JSON.stringify(
        buildCanonicalJobPayload({
          commandId: `${e.jobIdPrefix}-command`,
          traceId: "trace",
          schemaVersion: e.schemaVersion,
        }),
      );
      for (const field of FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS) {
        expect(wire, `${e.workName} leaked ${field}`).not.toContain(`"${field}"`);
      }
      expect(wire).not.toContain("teamId");
    }
  });

  it("the producer guard refuses an authority field, case-insensitively", () => {
    for (const field of FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS) {
      expect(() =>
        assertNoPayloadAuthorityFields({ commandId: "x", [field]: "y" }),
      ).toThrow(QueuePayloadRejected);
    }
    expect(() => assertNoPayloadAuthorityFields({ WORKSPACEID: "x" })).toThrow(
      QueuePayloadRejected,
    );
    expect(() =>
      assertNoPayloadAuthorityFields({ commandId: "x", traceId: "y" }),
    ).not.toThrow();
  });

  it("deterministic job ids are stable and prefix-scoped", () => {
    for (const e of getBullMqEntries()) {
      const prefixed = { jobIdPrefix: e.jobIdPrefix! };
      expect(buildCanonicalJobId(prefixed, "abc")).toBe(
        buildCanonicalJobId(prefixed, "abc"),
      );
      expect(buildCanonicalJobId(prefixed, "abc").startsWith(`${e.jobIdPrefix}-`))
        .toBe(true);
      expect(() => buildCanonicalJobId(prefixed, "   ")).toThrow(
        QueuePayloadRejected,
      );
    }
  });

  /**
   * THE TRANSPORT HAS TO ACCEPT THE ID.
   *
   * A deterministic id that BullMQ refuses is not an id, it is an outage.
   * `Queue.add` throws `Custom Id cannot contain :` — a hard rejection at the
   * producer — and `enqueueCanonicalJob` converts that into a soft
   * `{ enqueued: false }` which every caller is built to tolerate. So the
   * failure is completely silent.
   *
   * Three families build composite command ids of the form `<kind>:<id>`
   * (search projection, media intelligence, graph domain sync). Every job any
   * of them tried to schedule was refused, from the moment the composite ids
   * were introduced. Search was the visible casualty: no rebuild could ever be
   * enqueued, so the index was only ever written by the API's inline reconcile
   * endpoint — which is why pressing `Rebuild index` worked instantly and
   * nothing automatic ever did.
   *
   * This asserts the property directly, against every registered entry and
   * against the real composite builders, so no future command-id shape can
   * reintroduce a character the queue will not take.
   */
  it("every canonical job id is legal for the transport that has to carry it", () => {
    const ILLEGAL = /:/;
    const composites = [
      buildSearchIndexCommandId("evidence", "11111111-1111-1111-1111-111111111111"),
      buildMediaIntelligenceCommandId(
        "analyze_metadata",
        "22222222-2222-2222-2222-222222222222",
      ),
      buildGraphDomainCommandId("all", "33333333-3333-3333-3333-333333333333"),
    ];
    // The command id KEEPS its colon — it is the semantic identity the
    // processor parses. Only the transport identity is rewritten.
    for (const c of composites) expect(c).toMatch(ILLEGAL);

    for (const e of getBullMqEntries()) {
      const prefixed = { jobIdPrefix: e.jobIdPrefix! };
      for (const commandId of [...composites, "plain-uuid-0000"]) {
        const jobId = buildCanonicalJobId(prefixed, commandId);
        expect(
          jobId,
          `${e.workName} would build a job id BullMQ refuses: ${jobId}`,
        ).not.toMatch(ILLEGAL);
      }
    }

    // …and the rewrite stays INJECTIVE: two different commands must never
    // collapse onto one job id, or one record's rebuild would silently
    // cancel another's.
    const prefixed = { jobIdPrefix: "search-index" };
    const ids = new Set(composites.map((c) => buildCanonicalJobId(prefixed, c)));
    expect(ids.size).toBe(composites.length);
  });
});

// ===========================================================================
// 4. Legacy compatibility — bounded and removable
// ===========================================================================

describe("Point 5 — legacy payload compatibility", () => {
  it("LegacyPayloadAdaptersWithoutCondition = 0", () => {
    const offenders = findAdaptersWithoutRemovalCondition();
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  it("every adapter names a real registered job", () => {
    const known = new Set<string>(Object.values(JOB_NAMES));
    const unknown = LEGACY_PAYLOAD_ADAPTERS.filter(
      (a) => !known.has(a.jobName),
    ).map((a) => a.jobName);
    expect(unknown, unknown.join(", ")).toEqual([]);
  });

  it("a legacy payload yields the reference and reports what it discarded", () => {
    const entry = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_DERIVATIVE);
    const decoded = decodeJobPayload(
      { jobName: entry.workName, schemaVersion: entry.schemaVersion },
      { derivativeId: "deriv-9", teamId: "attacker", signedUrl: "https://x" },
    );
    expect(decoded.legacy).toBe(true);
    expect(decoded.commandId).toBe("deriv-9");
    expect([...decoded.discardedAuthorityFields].sort()).toEqual([
      "signedUrl",
      "teamId",
    ]);
    // The VALUES are unreachable — the result holds names only.
    expect(JSON.stringify(decoded)).not.toContain("attacker");
    expect(JSON.stringify(decoded)).not.toContain("https://x");
  });

  it("a NEW-shape payload with a smuggled field never reaches the legacy path", () => {
    // The ordering property: `schemaVersion` present means canonical, and
    // canonical means strict. Legacy is for old shapes, not new shapes with
    // extra fields.
    const entry = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_DERIVATIVE);
    expect(() =>
      decodeJobPayload(
        { jobName: entry.workName, schemaVersion: entry.schemaVersion },
        {
          commandId: "deriv-9",
          traceId: "t",
          schemaVersion: entry.schemaVersion,
          teamId: "attacker",
        },
      ),
    ).toThrow(QueuePayloadRejected);
  });

  it("UnclassifiedLegacyJobShapes = 0 — every changed shape has a disposition", () => {
    // Point 5 changed thirteen payload shapes. Without an entry each, every job
    // already sitting in Redis at deploy time would be refused: fail-safe, but
    // lossy, and a deployment plan that silently discards in-flight evidence
    // work is not one anybody would approve if it were stated out loud.
    //
    // The set is derived from the registry rather than hand-listed, so a future
    // chain that changes its payload without classifying it fails here.
    const changed = getBullMqEntries().map((e) => e.workName);
    const unclassified = findUnclassifiedLegacyShapes(changed);
    expect(unclassified, unclassified.join(", ")).toEqual([]);
    for (const a of LEGACY_PAYLOAD_ADAPTERS) {
      expect(["adaptable", "quarantine"], a.jobName).toContain(a.disposition);
    }
  });

  it("an adaptable shape yields a reference and DISCARDS every authority field", () => {
    // The report chain is the sharpest case: its old payload carried
    // `forceRegenerate`, which is the authorization outcome that permits
    // overwriting a finalised evidentiary artifact.
    const entry = getWorkEntryOrThrow(JOB_NAMES.GENERATE_REPORT);
    const decoded = decodeJobPayload(
      { jobName: entry.workName, schemaVersion: entry.schemaVersion },
      {
        evidenceId: "ev-9",
        forceRegenerate: true,
        regenerateReason: "attacker",
        teamId: "other-workspace",
      },
    );
    expect(decoded.legacy).toBe(true);
    expect(decoded.commandId).toBe("ev-9");
    expect([...decoded.discardedAuthorityFields].sort()).toEqual([
      "forceRegenerate",
      "teamId",
    ]);
    // The VALUES are unreachable — the result holds names only, so no caller
    // can recover the force decision even by accident.
    const wire = JSON.stringify(decoded);
    expect(wire).not.toContain("other-workspace");
    expect(wire).not.toContain("attacker");
    expect(decoded).not.toHaveProperty("forceRegenerate");
    expect(decoded).not.toHaveProperty("teamId");
  });

  it("SilentlyDroppedLegacyJobs = 0 — an unadaptable shape QUARANTINES loudly", () => {
    // `GenerateDerivedAsset` is the classified-quarantine shape: its old
    // payload has no id for an `EvidencePartDerivedAsset` row, and `assetKind`
    // selects which pipeline runs. Reconstructing a durable row from an
    // untrusted discriminator is the move this phase removes.
    const entry = getWorkEntryOrThrow(JOB_NAMES.GENERATE_DERIVED_ASSET);
    let thrown: unknown;
    try {
      decodeJobPayload(
        { jobName: entry.workName, schemaVersion: entry.schemaVersion },
        {
          teamId: "t1",
          evidenceId: "e1",
          evidencePartId: "p1",
          assetKind: "image_thumbnail",
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LegacyJobQuarantined);
    const q = thrown as LegacyJobQuarantined;
    expect(q.reason).toBe("shape_not_safely_adaptable");
    expect(q.discardedAuthorityFields).toContain("teamId");
    // It is NOT reported as a malformed payload: an operator must be able to
    // tell "this needs replaying" from "something is broken".
    expect(thrown).not.toBeInstanceOf(QueuePayloadRejected);
  });

  it("an adaptable FAMILY still quarantines a job missing its durable id", () => {
    // `runId` was optional on the media-intelligence payload — that optionality
    // is the defect this phase traced — so such jobs genuinely exist in Redis.
    // One carrying a run id adapts; one without has no durable row anywhere and
    // cannot be run without inventing authority.
    const entry = getWorkEntryOrThrow(JOB_NAMES.RUN_MEDIA_INTELLIGENCE);
    const expectShape = {
      jobName: entry.workName,
      schemaVersion: entry.schemaVersion,
    };

    const withRun = decodeJobPayload(expectShape, {
      teamId: "t1",
      evidenceId: "e1",
      kind: "analyze_metadata",
      runId: "run-7",
    });
    expect(withRun.commandId).toBe("run-7");
    expect(withRun.discardedAuthorityFields).toContain("teamId");

    expect(() =>
      decodeJobPayload(expectShape, {
        teamId: "t1",
        evidenceId: "e1",
        kind: "analyze_metadata",
      }),
    ).toThrow(LegacyJobQuarantined);
  });

  it("every adapter states its old schema, owner, backlog command and deadline", () => {
    // `ConditionlessLegacyAdapters = 0`. An adapter without a removal condition
    // is how "temporary" becomes "forever".
    expect(findAdaptersWithoutRemovalCondition()).toEqual([]);
    for (const a of LEGACY_PAYLOAD_ADAPTERS) {
      expect(a.oldSchema.length, a.jobName).toBeGreaterThan(5);
      expect(a.owner.length, a.jobName).toBeGreaterThan(3);
      expect(a.backlogCommand, a.jobName).toContain("--queue=");
      expect(a.drainCommand, a.jobName).toContain("--queue=");
      expect(a.maxQueueRetentionMs, a.jobName).toBe(LEGACY_QUEUE_RETENTION_MS);
    }
  });

  it("LegacyJobsTrustingPayloadAuthority = 0 — no adapter reads an authority field", () => {
    // Each adapter declares the authority-shaped fields its shape is known to
    // carry. Feed a payload containing every one of them and assert the decoded
    // result reports them as DISCARDED — never as data.
    for (const a of LEGACY_PAYLOAD_ADAPTERS) {
      if (a.disposition !== "adaptable") continue;
      for (const field of a.discardsAuthorityFields) {
        expect(
          isAuthorityFieldName(field),
          `${a.jobName} declares ${field} which is not an authority field`,
        ).toBe(true);
      }
    }
  });
});

// ===========================================================================
// 5. The single enqueue authority — behavioral
// ===========================================================================

describe("Point 5 — the single enqueue authority", () => {
  const entry = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_DERIVATIVE);

  function fakeQueue(opts: {
    existingState?: string | null;
    removeThrows?: boolean;
    addThrows?: boolean;
  }) {
    const added: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const removed: string[] = [];
    return {
      added,
      removed,
      handle: {
        async getJob(jobId: string) {
          if (!opts.existingState) return null;
          return {
            id: jobId,
            async getState() {
              return opts.existingState!;
            },
            async remove() {
              if (opts.removeThrows) throw new Error("race");
              removed.push(jobId);
            },
          };
        },
        async add(name: string, data: unknown, o: Record<string, unknown>) {
          if (opts.addThrows) throw new Error("redis down");
          added.push({ name, data, opts: o });
        },
      },
    };
  }

  it("schedules under the deterministic id with the registry's retry policy", async () => {
    const q = fakeQueue({});
    const out = await enqueueCanonicalJob({
      queue: q.handle,
      entry,
      commandId: "d1",
      traceId: "t",
    });
    expect(out).toMatchObject({ enqueued: true, collapsed: false });
    expect(q.added[0]!.name).toBe(entry.workName);
    expect(q.added[0]!.opts).toMatchObject({
      jobId: buildCanonicalJobId({ jobIdPrefix: entry.jobIdPrefix! }, "d1"),
      attempts: entry.retry.attempts,
      backoff: { type: entry.retry.backoff, delay: entry.retry.backoffDelayMs },
    });
  });

  it("a duplicate enqueue is idempotent — it collapses onto the live job", async () => {
    for (const state of [
      "waiting",
      "waiting-children",
      "delayed",
      "active",
      "prioritized",
    ]) {
      const q = fakeQueue({ existingState: state });
      const out = await enqueueCanonicalJob({
        queue: q.handle,
        entry,
        commandId: "d1",
        traceId: "t",
      });
      expect(out, state).toMatchObject({ enqueued: true, collapsed: true });
      expect(q.added, state).toEqual([]);
      expect(q.removed, state).toEqual([]);
    }
  });

  it("a spent job's id is released so a re-request can actually be scheduled", async () => {
    // BullMQ ignores an `add` onto a retained completed/failed id and still
    // returns a Job. Without the release this reports success and schedules
    // nothing — the exact failure a stranded-row reconciler exists to fix.
    for (const state of ["completed", "failed"]) {
      const q = fakeQueue({ existingState: state });
      const out = await enqueueCanonicalJob({
        queue: q.handle,
        entry,
        commandId: "d1",
        traceId: "t",
      });
      expect(out, state).toMatchObject({ enqueued: true, collapsed: false });
      expect(q.removed, state).toHaveLength(1);
      expect(q.added, state).toHaveLength(1);
    }
  });

  it("enqueue failure is reported honestly and never as success", async () => {
    const unreachable = fakeQueue({ addThrows: true });
    await expect(
      enqueueCanonicalJob({
        queue: unreachable.handle,
        entry,
        commandId: "d1",
        traceId: "t",
      }),
    ).resolves.toMatchObject({ enqueued: false });

    const raced = fakeQueue({ existingState: "failed", removeThrows: true });
    await expect(
      enqueueCanonicalJob({
        queue: raced.handle,
        entry,
        commandId: "d1",
        traceId: "t",
      }),
    ).resolves.toMatchObject({ enqueued: false, reason: "job_id_release_race" });
    expect(raced.added).toEqual([]);
  });

  it("a job re-scheduling ITSELF is not collapsed into a no-op", async () => {
    // The production incident this pins: the OTS upgrade ladder works by a
    // running job scheduling its own next attempt. Under plain
    // collapse-or-replace the live job it finds under the target id is ITSELF,
    // in state `active`, so the enqueue collapses onto a job that is about to
    // finish. Nothing gets scheduled, the evidence sits OTS-PENDING forever,
    // and the queue shows zero jobs for it — which is precisely how the
    // incident presented.
    const q = fakeQueue({ existingState: "active" });
    const out = await enqueueCanonicalJob({
      queue: q.handle,
      entry: getWorkEntryOrThrow(JOB_NAMES.UPGRADE_OTS),
      commandId: "ev-1",
      traceId: "ots_followup",
      // `fakeQueue` returns the requested jobId as the job's own id, so this
      // makes the live job the caller.
      selfJobId: buildCanonicalJobId({ jobIdPrefix: "ots-upgrade" }, "ev-1"),
    });

    expect(out).toMatchObject({ enqueued: true, collapsed: false });
    expect(q.added).toHaveLength(1);
    // The caller's own job is NOT removed — it is still running.
    expect(q.removed).toEqual([]);
    // The follow-up lands under a DISTINCT id so BullMQ can accept it.
    const opts = q.added[0]!.opts as { jobId: string };
    expect(opts.jobId).not.toBe(
      buildCanonicalJobId({ jobIdPrefix: "ots-upgrade" }, "ev-1"),
    );
    expect(opts.jobId.startsWith("ots-upgrade-ev-1")).toBe(true);
  });

  it("a PARALLEL producer still collapses onto the same live job", async () => {
    // The other half of the property above: only the job that owns the id gets
    // the discriminated path. A second producer must still dedupe normally, or
    // the self-reference escape hatch would become a way to schedule unbounded
    // duplicates.
    const q = fakeQueue({ existingState: "active" });
    const out = await enqueueCanonicalJob({
      queue: q.handle,
      entry: getWorkEntryOrThrow(JOB_NAMES.UPGRADE_OTS),
      commandId: "ev-1",
      traceId: "request_path",
      selfJobId: "some-other-job-id",
    });
    expect(out).toMatchObject({ enqueued: true, collapsed: true });
    expect(q.added).toEqual([]);
  });

  it("a sweep entry cannot be enqueued as a queue job", async () => {
    const sweep = getWorkEntryOrThrow(SWEEP_NAMES.WEBHOOK_DISPATCHER);
    const q = fakeQueue({});
    await expect(
      enqueueCanonicalJob({
        queue: q.handle,
        entry: sweep,
        commandId: "d1",
        traceId: "t",
      }),
    ).resolves.toMatchObject({ enqueued: false, reason: "not_a_queue_job" });
    expect(q.added).toEqual([]);
  });

  it("an unusable command id fails before the queue is touched", async () => {
    const q = fakeQueue({});
    await expect(
      enqueueCanonicalJob({
        queue: q.handle,
        entry,
        commandId: "   ",
        traceId: "t",
      }),
    ).resolves.toMatchObject({ enqueued: false });
    expect(q.added).toEqual([]);
  });
});

// ===========================================================================
// 6. Structural gates — supplement, never substitute
// ===========================================================================

describe("Point 5 — structural gates", () => {
  /**
   * Transport clients converged onto the shared authority. A converged client
   * holds a Redis handle and delegates; it must not carry a private copy of the
   * queue name, the job name or the enqueue policy.
   *
   * Modules are added here as each family converges, so the list is an honest
   * record of coverage rather than an aspiration.
   */
  const CONVERGED_TRANSPORT_MODULES = [
    "services/api/src/queue/canonical-queue-client.ts",
    "services/api/src/queue/redaction-derivative-queue.ts",
    "services/api/src/queue/search-queue.ts",
    "services/api/src/queue/media-intelligence-queue.ts",
    "services/api/src/queue/mi-embed-queue.ts",
    "services/api/src/queue/derived-assets-queue.ts",
    "services/api/src/queue/graph-reconcile-queue.ts",
    "services/worker/src/queue.ts",
  ];

  it("InlineSensitiveJobNameLiterals = 0 in converged transport clients", () => {
    const offenders: string[] = [];
    for (const rel of CONVERGED_TRANSPORT_MODULES) {
      const body = read(rel);
      for (const name of Object.values(JOB_NAMES)) {
        if (body.includes(`"${name}"`)) offenders.push(`${rel}: "${name}"`);
      }
      for (const name of Object.values(QUEUE_NAMES)) {
        if (body.includes(`"${name}"`)) offenders.push(`${rel}: "${name}"`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("converged transport clients delegate to the one enqueue authority", () => {
    for (const rel of CONVERGED_TRANSPORT_MODULES) {
      const body = read(rel);
      // Either the shared helper directly, or the api's transport client which
      // is itself asserted (below) to delegate to it. There is no third path.
      expect(
        /enqueueCanonicalJob|enqueueCanonicalWork/.test(body),
        `${rel} must reach the shared enqueue authority`,
      ).toBe(true);
      // A converged client must not re-implement collapse-or-replace: the state
      // ladder belongs to the shared helper alone.
      expect(body, rel).not.toMatch(/state === "waiting"/);
    }
    // The api's transport client is the only module allowed to sit between a
    // producer and the shared helper, and it must actually call it.
    expect(read("services/api/src/queue/canonical-queue-client.ts")).toContain(
      "enqueueCanonicalJob",
    );
  });

  it("WorkerTenantPayloadTrust = 0 and NOT_YET_CONVERGED = []", () => {
    // The pattern this catches is `const { teamId } = job.data` — a workspace
    // destructured off the wire and then used in a WHERE clause. Converged
    // processors derive the tenant from a loaded row instead.
    //
    // This assertion used to carry a NOT_YET_CONVERGED allowlist naming three
    // processors (derived-assets, media-intelligence, mi-embed). The list is
    // GONE, not emptied-by-convention: all three now load their durable row and
    // read the workspace off it, so there is nothing left to exempt. A gate
    // that can name an exemption can report green while production is not.
    const offenders: string[] = [];
    for (const file of walkTs("services/worker/src")) {
      const body = readFileSync(file, "utf8");
      if (!/\bjob\.data\b/.test(body)) continue;
      if (/const\s*\{[^}]*\bteamId\b[^}]*\}\s*=\s*job\.data/.test(body)) {
        offenders.push(file.replace(REPO, "").replace(/\\/g, "/").slice(1));
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("PayloadTrustedTenantAuthorities = 0 — no processor reads a tenant off job.data", () => {
    // Broader than the destructuring form above: this catches
    // `job.data.teamId`, `job.data.workspaceId`, `job.data.organizationId` and
    // `job.data.orgId` in any position, which is how the same trust
    // reintroduces itself once the destructuring pattern is guarded.
    const offenders: string[] = [];
    for (const file of walkTs("services/worker/src")) {
      const body = readFileSync(file, "utf8");
      const rel = file.replace(REPO, "").replace(/\\/g, "/").slice(1);
      for (const m of body.matchAll(
        /\bjob\.data(?:\?)?\.(teamId|workspaceId|organizationId|orgId)\b/g,
      )) {
        offenders.push(`${rel}: job.data.${m[1]}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("PayloadTrustedPolicyAuthorities = 0 and PayloadStorageTruthFields = 0", () => {
    // `forceRegenerate` is the specific one this phase existed to remove: it is
    // the outcome of an authorization decision (may this run overwrite a
    // finalised artifact?) and it was arriving as a boolean on a message.
    const offenders: string[] = [];
    for (const file of walkTs("services/worker/src")) {
      const body = readFileSync(file, "utf8");
      const rel = file.replace(REPO, "").replace(/\\/g, "/").slice(1);
      for (const m of body.matchAll(
        /\bjob\.data(?:\?)?\.(forceRegenerate|policy|policyVersion|plan|role|storageKey|storageBucket|signedUrl|objectKey|bucket)\b/g,
      )) {
        offenders.push(`${rel}: job.data.${m[1]}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("every registered BullMQ job decodes UNDER ITS OWN WORK NAME", () => {
    // The earlier version of this check asked whether the processor MODULE
    // mentioned a decoder anywhere. That was too coarse and it hid a real
    // break: `processor.ts` owns both the report job and the evidence-purge
    // job, so the module-level check passed on the report path's
    // `decodeCanonicalJob` while `processPurgeDeletedEvidence` was still
    // reading a retired Phase-X.1 envelope through a TOLERANT parser. The
    // purge producer had already been converged, so those two no longer agreed
    // — and for a hard-delete job, tolerance means a tampered payload gets
    // repaired into a runnable destruction command.
    //
    // The check is now per WORK NAME. Each registered job's processor module
    // must BOTH name that job's registry key and call a decoder — the two
    // together are what "this processor is bound to its own contract" means.
    // Naming the key alone would pass a module that resolves an entry and then
    // reads `job.data` directly; calling a decoder alone is the module-level
    // check that let the purge break through.
    const missing: string[] = [];
    for (const entry of getBullMqEntries()) {
      const body = read(entry.canonicalProcessor);
      const key = (Object.keys(JOB_NAMES) as Array<keyof typeof JOB_NAMES>).find(
        (k) => JOB_NAMES[k] === entry.workName,
      );
      const namesOwnWork = new RegExp(`JOB_NAMES\\.${key}\\b`).test(body);
      const decodes = /decode(?:CanonicalJob|JobPayload)\(/.test(body);
      if (!namesOwnWork || !decodes) {
        missing.push(
          `${entry.workName} -> ${entry.canonicalProcessor}` +
            ` (namesOwnWork=${namesOwnWork}, decodes=${decodes})`,
        );
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("the evidence-purge processor decodes STRICTLY, not through a tolerant parser", () => {
    // The specific break the coarse check hid, pinned on its own so it cannot
    // come back quietly. `parseQueueEnvelope` SYNTHESISES whatever the payload
    // is missing; for a hard-delete job that turns a malformed or tampered
    // message into a runnable destruction command.
    const body = read("services/worker/src/processor.ts");
    expect(body).not.toMatch(/parseQueueEnvelope/);
    expect(body).toMatch(
      /decodeCanonicalJob\(JOB_NAMES\.PURGE_DELETED_EVIDENCE, job/,
    );
  });

  it("no module outside the shared authority DECLARES a queue or job name", () => {
    // The registry is single-source only if nothing else can define the same
    // string. What matters is a DECLARATION or a transport CALL — not every
    // appearance of the characters: several processors use the same words as
    // bounded log kinds (`kind: "mi-ocr"`) and span labels, and the word
    // "report" appears in unrelated domain code. Flagging those would make the
    // gate noisy enough to be routed around, which is worse than not having it.
    //
    // So this looks for the three forms that actually create a second
    // definition:
    //
    //   const X = "report"      — a private constant;
    //   new Queue("report"      — a queue declared by literal;
    //   .add("GenerateReport…"  — a job pushed by literal.
    const names = [
      ...Object.values(JOB_NAMES),
      ...Object.values(QUEUE_NAMES),
    ];
    const offenders: string[] = [];
    const scan = [
      ...walkTs("services/worker/src"),
      ...walkTs("services/api/src/queue"),
    ];
    for (const file of scan) {
      const rel = file.replace(REPO, "").replace(/\\/g, "/").slice(1);
      const body = readFileSync(file, "utf8");
      for (const name of names) {
        const lit = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const declaration = new RegExp(
          `(?:const|let|var)\\s+\\w+\\s*(?::[^=]+)?=\\s*"${lit}"`,
        );
        const queueLiteral = new RegExp(`new\\s+Queue\\(\\s*"${lit}"`);
        const addLiteral = new RegExp(`\\.add\\(\\s*"${lit}"`);
        if (declaration.test(body)) offenders.push(`${rel}: const = "${name}"`);
        if (queueLiteral.test(body)) offenders.push(`${rel}: new Queue("${name}")`);
        if (addLiteral.test(body)) offenders.push(`${rel}: .add("${name}")`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the diagnostics projection cannot carry a secret, token or storage URL", () => {
    expect(DIAGNOSTICS_FORBIDDEN_KEYS).toContain("signedUrl");
    expect(DIAGNOSTICS_FORBIDDEN_KEYS).toContain("rawToken");
    expect(DIAGNOSTICS_FORBIDDEN_KEYS).toContain("recipientEmail");
    expect(DIAGNOSTICS_FORBIDDEN_KEYS).toContain("payload");
    // `workspaceId` is the ONE authority-shaped field a diagnostics row may
    // carry, and only for a caller already authorized on that workspace.
    expect(DIAGNOSTICS_FORBIDDEN_KEYS).not.toContain("workspaceId");

    expect(() =>
      assertDiagnosticsSafe({ commandId: "c", workspaceId: "w" }),
    ).not.toThrow();
    expect(() =>
      assertDiagnosticsSafe({ commandId: "c", signedUrl: "https://x" }),
    ).toThrow();
    expect(() => assertDiagnosticsSafe({ commandId: "c", payload: {} })).toThrow();
  });
});

// Type-level assurance that the registry entry shape stays exhaustive: adding a
// required field to WorkRegistryEntry without populating it fails compilation
// here rather than silently producing an unchecked entry.
const _typeCheck: ReadonlyArray<WorkRegistryEntry> = CANONICAL_WORK_REGISTRY;
void _typeCheck;
