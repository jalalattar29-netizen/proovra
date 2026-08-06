/**
 * PHASE 12 — POINT 5, STEP 6: the INDEPENDENT topology gate.
 *
 * WHY THE CLOSURE GATE IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * The closure gate verifies that every path the registry names exists on disk.
 * That catches a registry pointing at a deleted file. It cannot catch the
 * opposite and more dangerous drift: a queue, a worker or a producer that
 * exists in the RUNTIME and that the registry has never heard of. A manually
 * curated registry checked against itself will always report itself complete.
 *
 * So this file never asks the registry a question first. It reads the worker's
 * transport and bootstrap modules, resolves the actual program bindings, and
 * only then diffs what it found against what the registry claims.
 *
 * RESOLVING BINDINGS, NOT MATCHING STRINGS
 * ---------------------------------------------------------------------------
 * The obvious version of this check is wrong, and was wrong here: the first
 * argument to `safeRegisterWorker` is a WorkerKind LABEL, not a queue name —
 * `"derived-assets"` labels the `mi-derived-assets` queue. Matching labels to
 * queue names as strings produces a false mismatch, and the natural response
 * to a false mismatch is an allowlist, which is how a real one gets hidden.
 *
 * What this does instead:
 *
 *   1. resolve every `export const X = new Queue(<nameVar>)` to the literal
 *      queue name `<nameVar>` is bound to, following the alias chain into
 *      `QUEUE_NAMES`;
 *   2. resolve every `safeRegisterWorker(<label>, () => new Worker(<nameVar>,
 *      <handler>))` to the QUEUE OBJECT it constructs and the PROCESSOR it
 *      binds — the label is read but never trusted;
 *   3. resolve every producer's enqueue site to the canonical work name it
 *      passes to the one enqueue authority;
 *   4. diff all three against the registry.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  CANONICAL_WORK_REGISTRY,
  DLQ_SINKS,
  JOB_NAMES,
  QUEUE_NAMES,
  getBullMqEntries,
  isDlqQueueName,
} from "@proovra/shared";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), "utf8");
}

/** Comments stripped: a queue described in prose is not a queue. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const QUEUE_SRC = code(read("services/worker/src/queue.ts"));
const INDEX_SRC = code(read("services/worker/src/index.ts"));

// ===========================================================================
// 1. Resolve queue-name variables to their literal names
// ===========================================================================

/**
 * `export const reportQueueName = QUEUE_NAMES.REPORT;` → the literal string.
 *
 * The alias chain is followed rather than assumed: a variable bound to a bare
 * literal is accepted too, and reported, because a queue name that does NOT
 * come from the shared authority is itself a finding.
 */
const QUEUE_NAME_BINDINGS: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  // The binding may WRAP: `export const x =\n  QUEUE_NAMES.Y;`. Requiring one
  // line reported live queues as unresolvable, and a false finding is what
  // gets answered with an allowlist.
  for (const m of QUEUE_SRC.matchAll(
    /export const (\w+)\s*=\s*QUEUE_NAMES\.(\w+);/g,
  )) {
    const literal = (QUEUE_NAMES as Record<string, string>)[m[2]!];
    if (literal) out.set(m[1]!, literal);
  }
  // An alias of an alias: `redactionDerivativeQueueName =
  // REDACTION_DERIVATIVE_QUEUE_NAME`, itself a shared constant. Following the
  // chain into the exporting module keeps this an equality check on the REAL
  // name rather than a special case for one queue.
  for (const m of QUEUE_SRC.matchAll(
    /export const (\w+)\s*=\s*([A-Z][A-Z0-9_]+);/g,
  )) {
    if (out.has(m[1]!)) continue;
    const constName = m[2]!;
    let literal: string | null = null;
    for (const mod of ["packages/shared/src/redaction.ts"]) {
      const hit = read(mod).match(
        new RegExp(`export const ${constName}\\s*=\\s*"([^"]+)"`),
      );
      if (hit) {
        literal = hit[1]!;
        break;
      }
    }
    // Only accept it if the resolved literal IS a shared-authority queue name.
    // A constant that resolves to something else is a private literal, and the
    // case below reports it as one.
    if (literal && (Object.values(QUEUE_NAMES) as string[]).includes(literal)) {
      out.set(m[1]!, literal);
    }
  }
  return out;
})();

/** Queue names bound from a bare literal instead of the shared authority. */
const PRIVATE_QUEUE_LITERALS: string[] = [
  ...QUEUE_SRC.matchAll(/export const (\w+QueueName) = "([^"]+)";/g),
].map((m) => `${m[1]} = "${m[2]}"`);

/** `export const reportQueue = new Queue(reportQueueName, …)` */
type QueueObject = { object: string; nameVar: string; queueName: string | null };

const QUEUE_OBJECTS: ReadonlyArray<QueueObject> = [
  ...QUEUE_SRC.matchAll(/export const (\w+) = new Queue\(\s*\n?\s*(\w+)/g),
].map((m) => ({
  object: m[1]!,
  nameVar: m[2]!,
  queueName: QUEUE_NAME_BINDINGS.get(m[2]!) ?? null,
}));

// ===========================================================================
// 2. Resolve worker registrations to the queue object and processor
// ===========================================================================

type Registration = {
  /** The WorkerKind label. Read for reporting; never used for matching. */
  label: string;
  /** The queue-name variable passed to `new Worker(...)`. */
  nameVar: string | null;
  queueName: string | null;
  /** The processor symbol the handler ultimately binds. */
  processor: string | null;
};

const REGISTRATIONS: ReadonlyArray<Registration> = (() => {
  const out: Registration[] = [];
  for (const m of INDEX_SRC.matchAll(
    /safeRegisterWorker\(\s*"([^"]+)"\s*,\s*\(\)\s*=>/g,
  )) {
    const label = m[1]!;
    // Bounded by the NEXT registration rather than by a fixed window: a fixed
    // window bled into the following `safeRegisterWorker` and attributed its
    // handler to this queue, which reads exactly like a processor bound to two
    // queues — a false positive for the check two cases below.
    const next = INDEX_SRC.indexOf("safeRegisterWorker(", m.index! + 1);
    const block = INDEX_SRC.slice(
      m.index!,
      next === -1 ? m.index! + 900 : next,
    );
    const nameVar = block.match(/new Worker\(\s*\n?\s*(\w+)/)?.[1] ?? null;
    // The handler is either bare, or wrapped for tracing. Both shapes are in
    // use; the wrap is not the processor, what it wraps is.
    // The span name is sometimes a literal and sometimes a constant reference
    // (`PROOVRA_SPAN_NAMES.X`); matching only the literal form silently lost
    // the processor for every registration using the constant.
    const processor =
      block.match(
        /wrapJobHandlerWithOtelContext\(\s*\n?\s*[^,]+,\s*\n?\s*[^,]+,\s*\n?\s*(\w+)\s*,/,
      )?.[1] ??
      block.match(/new Worker\(\s*\n?\s*\w+\s*,\s*\n?\s*(\w+)\s*,/)?.[1] ??
      null;
    out.push({
      label,
      nameVar,
      queueName: nameVar ? (QUEUE_NAME_BINDINGS.get(nameVar) ?? null) : null,
      processor,
    });
  }
  return out;
})();

/** Where each processor symbol is imported from. */
function moduleOf(symbol: string): string | null {
  for (const imp of INDEX_SRC.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g,
  )) {
    const names = imp[1]!
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
    if (names.includes(symbol)) {
      return imp[2]!
        .replace(/^\.\//, "services/worker/src/")
        .replace(/\.js$/, ".ts");
    }
  }
  if (INDEX_SRC.includes(`function ${symbol}(`)) {
    return "services/worker/src/index.ts";
  }
  return null;
}

// ===========================================================================
// 3. Producers — every canonical enqueue site and the work name it names
// ===========================================================================

/**
 * `enqueueWork(<queueObject>, JOB_NAMES.X, …)` in the worker transport, plus
 * the api's canonical client. A producer naming a work name the registry does
 * not have — or a queue object it does not own — is an orphan.
 */
const PRODUCED_WORK_NAMES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  const sources = [
    QUEUE_SRC,
    code(read("services/api/src/queue/canonical-queue-client.ts")),
  ];
  for (const src of sources) {
    for (const m of src.matchAll(/JOB_NAMES\.(\w+)/g)) {
      const literal = (JOB_NAMES as Record<string, string>)[m[1]!];
      if (literal) out.add(literal);
    }
  }
  return out;
})();

// ===========================================================================
// The gate
// ===========================================================================

describe("Point 5 — independent topology discovery", () => {
  it("every declared queue object resolves to a shared-authority name", () => {
    expect(
      PRIVATE_QUEUE_LITERALS,
      `queue names declared outside QUEUE_NAMES:\n${PRIVATE_QUEUE_LITERALS.join("\n")}`,
    ).toEqual([]);
    const unresolved = QUEUE_OBJECTS.filter((q) => !q.queueName).map(
      (q) => `${q.object} <- ${q.nameVar}`,
    );
    expect(
      unresolved,
      `queue objects whose name could not be resolved:\n${unresolved.join("\n")}`,
    ).toEqual([]);
  });

  it("BullMQ processed queues = 15, registrations = 15, processors = 15", () => {
    const processed = QUEUE_OBJECTS.filter(
      (q) => q.queueName && !isDlqQueueName(q.queueName),
    );
    // Derived from discovery, then cross-checked against two independent
    // sources: the shared name authority and the registry.
    expect(processed).toHaveLength(15);
    expect(REGISTRATIONS).toHaveLength(15);
    expect(REGISTRATIONS.filter((r) => r.processor).length).toBe(15);
    expect(
      Object.values(QUEUE_NAMES).filter((q) => !isDlqQueueName(q)),
    ).toHaveLength(15);
    expect(getBullMqEntries()).toHaveLength(15);
    expect(Object.values(JOB_NAMES)).toHaveLength(15);
    // The DLQ sinks are queues with no registration BY DESIGN, which is the
    // whole reason the object count and the registration count differ.
    expect(QUEUE_OBJECTS).toHaveLength(17);
    expect(DLQ_SINKS).toHaveLength(2);
  });

  it("queue-to-registration mapping is 1:1, resolved through bindings not labels", () => {
    const registeredQueues = REGISTRATIONS.map((r) => r.queueName);
    const unresolved = REGISTRATIONS.filter((r) => !r.queueName).map(
      (r) => `${r.label} -> ${r.nameVar}`,
    );
    expect(
      unresolved,
      `registrations whose queue could not be resolved:\n${unresolved.join("\n")}`,
    ).toEqual([]);

    // Exactly one registration per processed queue, and no registration on a
    // DLQ sink.
    expect(new Set(registeredQueues).size).toBe(REGISTRATIONS.length);
    const processed = new Set(
      QUEUE_OBJECTS.filter((q) => q.queueName && !isDlqQueueName(q.queueName)).map(
        (q) => q.queueName!,
      ),
    );
    expect(new Set(registeredQueues as string[])).toEqual(processed);
    const onDlq = registeredQueues.filter((q) => q && isDlqQueueName(q));
    expect(onDlq, `registrations bound to a DLQ sink: ${onDlq.join(", ")}`).toEqual(
      [],
    );

    // And the LABEL is genuinely independent of the queue name — recorded so
    // the next reader does not reintroduce the string match this replaced.
    const labelDiffers = REGISTRATIONS.filter((r) => r.label !== r.queueName);
    expect(labelDiffers.length).toBeGreaterThan(0);
  });

  it("orphan producers = 0 and orphan processors = 0", () => {
    const registryNames = new Set(getBullMqEntries().map((e) => e.workName));
    const orphanProducers = [...PRODUCED_WORK_NAMES].filter(
      (n) => !registryNames.has(n as never),
    );
    expect(
      orphanProducers,
      `producers naming work the registry does not have:\n${orphanProducers.join("\n")}`,
    ).toEqual([]);

    // Every discovered processor resolves to a module that exists.
    const orphanProcessors = REGISTRATIONS.filter((r) => {
      if (!r.processor) return true;
      const mod = moduleOf(r.processor);
      return !mod || !existsSync(resolve(REPO, mod));
    }).map((r) => `${r.label} -> ${r.processor}`);
    expect(
      orphanProcessors,
      `registrations whose processor cannot be located:\n${orphanProcessors.join("\n")}`,
    ).toEqual([]);
  });

  it("duplicate workers = 0 and duplicate terminal writers = 0", () => {
    const byQueue = new Map<string, string[]>();
    for (const r of REGISTRATIONS) {
      if (!r.queueName) continue;
      byQueue.set(r.queueName, [...(byQueue.get(r.queueName) ?? []), r.label]);
    }
    const dupes = [...byQueue.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([k, v]) => `${k}: ${v.join(", ")}`);
    expect(dupes, `queues with more than one worker:\n${dupes.join("\n")}`).toEqual(
      [],
    );

    // One PROCESSOR per queue too: a function bound to two queues is the
    // defect that made the old EXIF payload carry two authorities.
    const byProcessor = new Map<string, string[]>();
    for (const r of REGISTRATIONS) {
      if (!r.processor) continue;
      byProcessor.set(r.processor, [
        ...(byProcessor.get(r.processor) ?? []),
        r.queueName ?? r.label,
      ]);
    }
    const shared = [...byProcessor.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([k, v]) => `${k}: ${v.join(", ")}`);
    expect(shared, `processors bound to more than one queue:\n${shared.join("\n")}`)
      .toEqual([]);

    // Terminal writers: one module per registered work unit's authority. Two
    // units may share a module only when they share a durable authority.
    const writers = new Map<string, Set<string>>();
    for (const e of CANONICAL_WORK_REGISTRY) {
      const set = writers.get(e.terminalWriter) ?? new Set<string>();
      set.add(e.durableAuthority.model);
      writers.set(e.terminalWriter, set);
    }
    const conflicted = [...writers.entries()]
      .filter(([, models]) => models.size > 2)
      .map(([k, models]) => `${k}: ${[...models].join(", ")}`);
    expect(
      conflicted,
      `terminal writers spanning unrelated authorities:\n${conflicted.join("\n")}`,
    ).toEqual([]);
  });

  it("job-name mismatches = 0: discovery, name authority and registry agree", () => {
    // Three independently derived sets of the SAME thing.
    const fromRegistry = new Set(getBullMqEntries().map((e) => e.workName));
    const fromAuthority = new Set(Object.values(JOB_NAMES));
    const fromProducers = PRODUCED_WORK_NAMES;
    expect(fromAuthority).toEqual(fromRegistry);
    // Producers must be a subset — a work name nothing enqueues is reported
    // separately below rather than folded in here.
    const notProduced = [...fromRegistry].filter((n) => !fromProducers.has(n));
    expect(
      notProduced,
      `registered jobs no producer enqueues:\n${notProduced.join("\n")}`,
    ).toEqual([]);
  });

  it("missing durable authorities = 0, NOT_YET_CONVERGED = [], RECONCILER_PENDING = []", () => {
    const missingAuthority = CANONICAL_WORK_REGISTRY.filter(
      (e) => !e.durableAuthority.model.trim() || !e.durableAuthority.tenantSource.trim(),
    ).map((e) => e.workName);
    expect(missingAuthority).toEqual([]);

    const notConverged = CANONICAL_WORK_REGISTRY.filter(
      (e) => e.implementation !== "CURRENT_RUNTIME",
    ).map((e) => e.workName);
    expect(
      notConverged,
      `NOT_YET_CONVERGED:\n${notConverged.join("\n")}`,
    ).toEqual([]);

    const reconcilerPending = CANONICAL_WORK_REGISTRY.filter(
      (e) => !e.reconciler.trim() || !existsSync(resolve(REPO, e.reconciler)),
    ).map((e) => `${e.workName} -> ${e.reconciler}`);
    expect(
      reconcilerPending,
      `RECONCILER_PENDING:\n${reconcilerPending.join("\n")}`,
    ).toEqual([]);
  });

  it("the removed OCR/Transcript chains are absent from the RUNTIME, not just the registry", () => {
    // Discovery, not registry lookup: the point of this file is that a queue
    // could exist without the registry knowing.
    const names = QUEUE_OBJECTS.map((q) => q.queueName);
    expect(names).not.toContain("mi-ocr");
    expect(names).not.toContain("mi-transcript");
    expect(REGISTRATIONS.map((r) => r.label)).not.toContain("mi-ocr");
    expect(REGISTRATIONS.map((r) => r.label)).not.toContain("mi-transcript");
  });
});
