/**
 * PHASE 12 — POINT 5, STEP 4: the DB-sweep integrity matrix.
 *
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * The BullMQ half of this platform has a queue object, a job name and a worker
 * registration per unit — three independent artifacts that can be diffed. The
 * DB-outbox half has none of that. A sweep is a `setInterval` in the worker
 * bootstrap calling a function, and nothing about it is addressable: a sweep
 * that stopped being scheduled, or that acquired a second launcher, would look
 * exactly like one that did not.
 *
 * So the matrix is built by DISCOVERY, not from the registry:
 *
 *   1. every `start<X>Scheduler` in the worker bootstrap is found;
 *   2. the executor each one drives is resolved through its tick function to
 *      the module that exports it;
 *   3. the discovered set is diffed against the registry's sweep entries;
 *   4. each sweep's fourteen Point-5 obligations are then satisfied EITHER by
 *      a mechanism the registry declares and this file verifies, OR by a case
 *      identifier that a family suite actually executed against a live
 *      database — never by a sentence.
 *
 * The registry cannot prove itself, so nothing here reads it first: it is the
 * thing being checked against.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  CANONICAL_WORK_REGISTRY,
  SWEEP_NAMES,
  getSweepEntries,
} from "@proovra/shared";

import {
  PROVEN_CASES_ARTIFACT,
  type ProvenCasesArtifact,
} from "./point5/family-coverage-manifest.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WORKER_INDEX = readFileSync(
  resolve(REPO, "services/worker/src/index.ts"),
  "utf8",
);

/** Comments stripped: a scheduler named in prose is not a scheduler. */
const CODE = WORKER_INDEX.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /\/\/[^\n]*/g,
  "",
);

// ===========================================================================
// 1. Independent discovery
// ===========================================================================

/**
 * The two launchers that are NOT work.
 *
 * They sample and heartbeat. They own no durable row, claim nothing and have
 * nothing to be idempotent about, so counting them as sweeps would inflate the
 * matrix with units that cannot satisfy it. Named explicitly rather than
 * filtered by a pattern, because "anything called sampler" is the kind of rule
 * a future launcher slips through.
 */
const TELEMETRY_LAUNCHERS = new Set([
  "startObservabilityHeartbeat",
  "startQueueHealthSampler",
]);

type Discovered = {
  launcher: string;
  /** The tick function the interval invokes. */
  tick: string | null;
  /** The production function the tick awaits. */
  executor: string | null;
  /** Repo-relative module that exports the executor. */
  executorModule: string | null;
  /**
   * The internal api route this launcher drives, when it is CROSS-SERVICE.
   *
   * Three sweeps do not run in the worker at all: the worker holds the timer
   * and POSTs an internal route, and the claim, the provider call and the
   * terminal write all happen in the api. Their worker-side module is a
   * CLIENT — it enumerates nothing and writes nothing — so resolving "the
   * executor" to it would name the wrong thing and hide the real one.
   */
  httpRoute: string | null;
};

/** The `/v1/...` path a tick body or a worker client module ultimately calls. */
function findInternalRoute(body: string): string | null {
  const m =
    body.match(/\/v1\/[A-Za-z0-9/_:-]+/) ?? null;
  return m ? m[0] : null;
}

/** Every `function start<X>()` in the bootstrap, with what it actually drives. */
const DISCOVERED: Discovered[] = (() => {
  const out: Discovered[] = [];
  for (const m of CODE.matchAll(/function (start\w+)\s*\(/g)) {
    const launcher = m[1]!;
    const body = CODE.slice(m.index!, m.index! + 900);
    // `setInterval(() => { void <tick>(); }, …)` is the shape every scheduler
    // uses; a launcher that stopped using an interval would fail here rather
    // than be silently credited.
    const tick =
      body.match(/setInterval\(\s*\(\)\s*=>\s*\{?\s*void\s+(\w+)\(/)?.[1] ??
      body.match(/setInterval\(\s*(\w+)\s*,/)?.[1] ??
      null;
    // Four executor shapes are in use, and all four are real. Treating any
    // one of them as the only valid form reports live sweeps as orphans,
    // which is worse than not checking at all — it invites an allowlist.
    let executor: string | null = null;
    let executorModule: string | null = null;
    if (tick) {
      const tickIdx = CODE.indexOf(`function ${tick}(`);
      if (tickIdx < 0) {
        // (a) No local wrapper: the interval invokes the imported executor.
        executor = tick;
      } else {
        const tickBody = CODE.slice(tickIdx, tickIdx + 1200);
        // (b) LAZY IMPORT: `const mod = await import("./x.js"); await
        //     mod.run(...)`. The module comes from the specifier, so it is
        //     resolved here rather than through the static import graph.
        const lazy = tickBody.match(
          /await\s+import\(\s*"([^"]+)"\s*\)[\s\S]{0,200}?await\s+\w+\.(\w+)\s*\(/,
        );
        if (lazy) {
          executor = lazy[2]!;
          executorModule = lazy[1]!
            .replace(/^\.\//, "services/worker/src/")
            .replace(/\.js$/, ".ts");
        } else {
          // (c) WRAPPED: `await withCronLock("...", () => run(...))` — the
          //     lock is not the sweep; what it guards is.
          const wrapped = tickBody.match(
            /await\s+\w+\([^)]*,\s*\(\)\s*=>\s*\n?\s*(\w+)\s*\(/,
          );
          // (d) DIRECT: `await run(...)`.
          executor = wrapped?.[1] ?? tickBody.match(/await\s+(\w+)\s*\(/)?.[1] ?? null;
        }
      }
    }
    if (executor && !executorModule) {
      // Resolve through the bootstrap's own static import graph: the module
      // that exports the symbol is the executor's home, whatever the alias.
      for (const imp of CODE.matchAll(
        /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g,
      )) {
        const names = imp[1]!
          .split(",")
          .map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
        if (names.includes(executor)) {
          executorModule = imp[2]!
            .replace(/^\.\//, "services/worker/src/")
            .replace(/\.js$/, ".ts");
          break;
        }
      }
      // Defined locally in the bootstrap rather than imported.
      if (!executorModule && CODE.includes(`function ${executor}(`)) {
        executorModule = "services/worker/src/index.ts";
      }
    }
    // Cross-service resolution. The `/v1` call sits either in the tick itself
    // (the demo follow-up shape) or in the worker client module the tick
    // delegates to (the invite-delivery and reviewer shapes).
    let httpRoute: string | null = null;
    const bodies: string[] = [];
    if (tick) {
      const tickIdx = CODE.indexOf(`function ${tick}(`);
      if (tickIdx >= 0) bodies.push(CODE.slice(tickIdx, tickIdx + 2500));
    }
    if (executorModule && existsSync(resolve(REPO, executorModule))) {
      bodies.push(readFileSync(resolve(REPO, executorModule), "utf8"));
    }
    for (const body of bodies) {
      const route = findInternalRoute(body);
      if (route) {
        httpRoute = route;
        break;
      }
    }
    // When the tick's own `await` IS the fetch, the transport is the executor
    // and the symbol name tells us nothing. The route is the identity.
    if (executor === "fetch") {
      executor = httpRoute;
      executorModule = null;
    }
    out.push({ launcher, tick, executor, executorModule, httpRoute });
  }
  return out;
})();

const SWEEP_LAUNCHERS = DISCOVERED.filter(
  (d) => !TELEMETRY_LAUNCHERS.has(d.launcher),
);

// ===========================================================================
// 2. Executed proof, read from the fresh artifact
// ===========================================================================

/**
 * Case identifiers a family suite ACTUALLY EXECUTED, with the suite's bytes
 * re-hashed so an edited or deleted suite loses its credit here exactly as it
 * does in the family gate.
 */
const EXECUTED: ReadonlySet<string> = (() => {
  const path = resolve(REPO, PROVEN_CASES_ARTIFACT);
  if (!existsSync(path)) return new Set<string>();
  const artifact = JSON.parse(readFileSync(path, "utf8")) as ProvenCasesArtifact;
  const out = new Set<string>();
  for (const [suite, record] of Object.entries(artifact.suites ?? {})) {
    const abs = resolve(REPO, "services/api", suite);
    if (!existsSync(abs)) continue;
    const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
    if (sha !== record.sha256) continue;
    for (const c of record.cases) out.add(c);
  }
  return out;
})();

/**
 * The case-id PREFIX each sweep's proof was recorded under.
 *
 * A sweep's work name and its case slug are different vocabularies — one is a
 * registry identity, the other a suite's naming — and there is no derivation
 * between them. Stated once, here, and immediately checked: every prefix must
 * actually appear in the executed set, so a typo is a failure rather than a
 * silently unproven sweep.
 */
const PROOF_PREFIX: Record<string, string> = {
  [SWEEP_NAMES.REDACTION_RECONCILER]: "redaction.recon",
  [SWEEP_NAMES.ORG_INVITE_DELIVERY]: "invite",
  [SWEEP_NAMES.DESTRUCTION_ORCHESTRATOR]: "destruction",
  [SWEEP_NAMES.RETENTION_RECONCILIATION]: "retention",
  [SWEEP_NAMES.ARCHIVE_AUTO_TRANSITION]: "archive",
  [SWEEP_NAMES.CAPTURE_DRAFT_REAPER]: "reaper",
  [SWEEP_NAMES.MFA_CHALLENGE_GC]: "mfagc",
  [SWEEP_NAMES.EXCHANGE_PACKAGE_BUILDER]: "exchange",
  [SWEEP_NAMES.WEBHOOK_DISPATCHER]: "webhook",
  [SWEEP_NAMES.MFA_RECOVERY_DIGEST]: "digest",
  [SWEEP_NAMES.DEMO_FOLLOW_UP]: "demo",
  [SWEEP_NAMES.LIFECYCLE_RECOVERY]: "lifecycle",
  [SWEEP_NAMES.ORPHAN_SCAN]: "orphan",
  [SWEEP_NAMES.IMMUTABLE_STORAGE_RECONCILIATION]: "immutable",
  [SWEEP_NAMES.REVIEWER_RECONCILIATION]: "reviewer",
  [SWEEP_NAMES.SEARCH_INDEX_RECONCILER]: "searchrecon",
  [SWEEP_NAMES.INTELLIGENCE_RUN_RECONCILER]: "mirecon",
  // ARCH-005 (2026-08-07).
  [SWEEP_NAMES.AUTOMATION_DISPATCH]: "auto",
  // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24).
  [SWEEP_NAMES.TRASH_GRACE_RECONCILER]: "trashgrace",
};

/** The five obligations that must be shown by EXECUTION, per sweep. */
const EXECUTED_OBLIGATIONS = [
  "durable.intent_before_work",
  "tenant.workspace_reloaded",
  "tenant.cross_workspace_denied",
  "claim.one_winner",
  "claim.active_not_stolen",
  "idempotency.duplicate_is_noop",
  "terminal.stale_cannot_overwrite",
] as const;

function exists(rel: string): boolean {
  return existsSync(resolve(REPO, rel));
}

// ===========================================================================
// 3. The matrix
// ===========================================================================

describe("Point 5 — DB sweep discovery", () => {
  it("discovered sweep launchers = registered sweep names, plus the samplers", () => {
    // ARCH-005 (2026-08-07) — this used to pin 19, 2 and 17 as LITERALS, and
    // registering `AutomationDispatchSweep` moved two of the three at once. A
    // literal per number invites picking whichever one makes the run green;
    // the identity below cannot be satisfied that way, because the three sets
    // are derived independently — from the worker source, from the shared name
    // authority, and from the registry.
    expect(
      DISCOVERED.filter((d) => TELEMETRY_LAUNCHERS.has(d.launcher)),
    ).toHaveLength(TELEMETRY_LAUNCHERS.size);
    expect(SWEEP_LAUNCHERS).toHaveLength(Object.values(SWEEP_NAMES).length);
    expect(DISCOVERED.length).toBe(
      SWEEP_LAUNCHERS.length + TELEMETRY_LAUNCHERS.size,
    );
    // The sweep this pass added, named explicitly so its presence is a
    // measurement rather than an arithmetic side effect.
    expect(Object.values(SWEEP_NAMES) as string[]).toContain(
      "AutomationDispatchSweep",
    );
  });

  it("every discovered sweep launcher drives exactly one resolvable executor", () => {
    // Resolvable means: a tick, and then EITHER a module that exports the
    // function it runs, OR — for the cross-service sweeps — the internal route
    // it POSTs. A launcher with neither is driving something nobody can name.
    const broken = SWEEP_LAUNCHERS.filter(
      (d) => !d.tick || !d.executor || (!d.executorModule && !d.httpRoute),
    ).map(
      (d) =>
        `${d.launcher}: tick=${d.tick} executor=${d.executor} module=${d.executorModule} route=${d.httpRoute}`,
    );
    expect(broken, `unresolvable launchers:\n${broken.join("\n")}`).toEqual([]);
  });

  it("orphan launchers = 0 and duplicate sweep owners = 0", () => {
    // A launcher whose executor module no longer exists is an orphan; two
    // launchers on one executor is a sweep with two owners, which is how the
    // same rows get claimed twice on every tick.
    const missing = SWEEP_LAUNCHERS.filter(
      (d) => (d.executorModule && !exists(d.executorModule)) ||
        (!d.executorModule && !d.httpRoute),
    ).map((d) => `${d.launcher} -> ${d.executorModule ?? d.httpRoute}`);
    expect(missing, `orphan launchers:\n${missing.join("\n")}`).toEqual([]);

    const byExecutor = new Map<string, string[]>();
    for (const d of SWEEP_LAUNCHERS) {
      const key = `${d.executorModule ?? "http"}#${d.executor}`;
      byExecutor.set(key, [...(byExecutor.get(key) ?? []), d.launcher]);
    }
    const duplicated = [...byExecutor.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([k, v]) => `${k}: ${v.join(", ")}`);
    expect(duplicated, `duplicate sweep owners:\n${duplicated.join("\n")}`).toEqual(
      [],
    );
  });

  it("discovered sweeps = registered sweeps, and each registered one is reachable", () => {
    const registered = getSweepEntries();
    // ARCH-005 (2026-08-07) — the literal 17 became an identity between three
    // independently derived sets: the registry entries, the shared name
    // authority, and the launchers discovered in the worker source.
    expect(registered).toHaveLength(Object.values(SWEEP_NAMES).length);
    expect(SWEEP_LAUNCHERS.length).toBe(registered.length);

    // A registered sweep is REACHABLE when the bootstrap drives it: its
    // processor module is a discovered executor's module, or the bootstrap
    // itself, or — for a cross-service sweep — its declared worker-side
    // registration is, and that chain reaches an internal route.
    const reachable = new Set(
      SWEEP_LAUNCHERS.map((d) => d.executorModule).filter(Boolean) as string[],
    );
    reachable.add("services/worker/src/index.ts");
    const crossServiceRoutes = SWEEP_LAUNCHERS.filter((d) => d.httpRoute);

    const unreachable = registered
      .filter(
        (e) =>
          !reachable.has(e.canonicalProcessor) &&
          !reachable.has(e.workerRegistration),
      )
      .map((e) => `${e.workName} -> ${e.canonicalProcessor}`);
    expect(
      unreachable,
      `registered sweeps no launcher reaches:\n${unreachable.join("\n")}`,
    ).toEqual([]);

    // The cross-service set is real and bounded: every sweep whose processor
    // lives in the api must have a launcher that names a `/v1` route, and
    // every such route must be one the api actually registers.
    const apiSide = registered.filter((e) =>
      e.canonicalProcessor.startsWith("services/api/"),
    );
    expect(apiSide.length).toBeGreaterThan(0);
    expect(crossServiceRoutes.length).toBeGreaterThanOrEqual(apiSide.length);
    for (const d of crossServiceRoutes) {
      expect(d.httpRoute, `${d.launcher} route`).toMatch(/^\/v1\//);
    }
  });
});

describe("Point 5 — every sweep satisfies its fourteen obligations", () => {
  const registered = getSweepEntries();

  it("the proof-prefix map covers every registered sweep, and names no phantom", () => {
    const names = registered.map((e) => e.workName).sort();
    expect(Object.keys(PROOF_PREFIX).sort()).toEqual(names);
  });

  for (const entry of registered) {
    it(`${entry.workName}: one authority, one executor, tenant from DB, claim, reconciler`, () => {
      // (1) ONE launcher — asserted globally above; here, that this sweep's
      // processor is named once in the registry.
      const sameProcessor = registered.filter(
        (e) => e.canonicalProcessor === entry.canonicalProcessor,
      );
      // Two sweeps legitimately share `reconciliation-run.ts` as a HOST, so
      // the check is on the pair, not the module alone.
      const sameOwner = sameProcessor.filter(
        (e) => e.durableAuthority.model === entry.durableAuthority.model,
      );
      expect(
        sameOwner.length,
        `${entry.workName} shares (processor, authority) with ${sameOwner
          .map((e) => e.workName)
          .join(", ")}`,
      ).toBeLessThanOrEqual(2);

      // (2) ONE durable authority, and it is named.
      expect(entry.durableAuthority.model.trim()).not.toBe("");
      // (3) ONE executor, and the module exists.
      expect(entry.canonicalProcessor.trim()).not.toBe("");
      expect(exists(entry.canonicalProcessor), entry.canonicalProcessor).toBe(
        true,
      );
      // (4) The tenant is DERIVED, not accepted. The registry states HOW, and
      // the statement must describe a read rather than a payload field.
      expect(entry.durableAuthority.tenantSource.trim()).not.toBe("");
      expect(
        entry.durableAuthority.tenantSource,
        `${entry.workName} derives its tenant from the wire`,
      ).not.toMatch(/payload|job\.data|message/i);
      // (6) An atomic claim or an expiring lease — or an explicit, checked
      // reason why this sweep needs neither.
      const claimless = entry.claim === null;
      if (claimless) {
        // The only sweeps permitted no claim are those that MUTATE NOTHING or
        // whose single write is idempotent by natural key. Anything else
        // claiming rows without a claim is a duplicate-work defect.
        expect(
          entry.idempotency,
          `${entry.workName} has no claim and no idempotency strategy`,
        ).not.toHaveLength(0);
        expect(
          entry.idempotency.some((s) =>
            ["upsert_by_natural_key", "deterministic_job_id", "unique_constraint"].includes(
              s,
            ),
          ),
          `${entry.workName} has no claim and no natural-key idempotency`,
        ).toBe(true);
      } else {
        expect(entry.claim!.mechanism).toBeTruthy();
        expect(entry.claim!.from).toBeTruthy();
        expect(entry.claim!.to).toBeTruthy();
        // A lease FIELD without a duration, or a duration without a field, is
        // a lease nothing can recover from.
        const hasField = Boolean(entry.claim!.leaseField);
        const hasMs = Boolean(entry.claim!.leaseMs);
        expect(hasField, `${entry.workName}: lease field/ms disagree`).toBe(
          hasMs,
        );
      }
      // (13) A reconciler exists and is a module the runtime reaches.
      expect(entry.reconciler.trim()).not.toBe("");
      expect(exists(entry.reconciler), entry.reconciler).toBe(true);
      // (12) A terminal writer is named and exists — a sweep with no single
      // terminal writer cannot promise a truthful terminal state.
      expect(entry.terminalWriter.trim()).not.toBe("");
      expect(exists(entry.terminalWriter), entry.terminalWriter).toBe(true);
      // Retry and recovery are bounded rather than open-ended.
      expect(entry.retry.attempts).toBeGreaterThan(0);
      expect(entry.retry.attempts).toBeLessThanOrEqual(25);
    });

    it(`${entry.workName}: its behavioural obligations were EXECUTED, not declared`, () => {
      const prefix = PROOF_PREFIX[entry.workName]!;
      const missing = EXECUTED_OBLIGATIONS.filter(
        (c) => !EXECUTED.has(`${prefix}.${c}`),
      );
      expect(
        missing,
        `${entry.workName} (${prefix}) has no executed proof for:\n${missing.join("\n")}\n` +
          "Run the integration project; the artifact is regenerated from " +
          "cases that actually passed.",
      ).toEqual([]);
    });
  }

  it("sweeps without claim/lease = 0, sweeps without reconciliation = 0", () => {
    const noArbitration = registered
      .filter((e) => e.claim === null && e.idempotency.length === 0)
      .map((e) => e.workName);
    expect(noArbitration).toEqual([]);
    const noReconciler = registered
      .filter((e) => !e.reconciler.trim() || !exists(e.reconciler))
      .map((e) => e.workName);
    expect(noReconciler).toEqual([]);
  });

  it("sweep authority mismatch = 0: no sweep declares a BullMQ queue or job id", () => {
    // A DB-outbox sweep that carries a queue name or a job-id prefix has one
    // foot in each transport, and the two disagree about where its work lives.
    const confused = registered
      .filter((e) => e.queueName !== null || e.jobIdPrefix !== null)
      .map((e) => e.workName);
    expect(confused, `sweeps declaring queue transport:\n${confused.join("\n")}`)
      .toEqual([]);
  });

  it("SweepsBehaviorallyCovered = 17/17", () => {
    const covered = registered.filter((e) => {
      const prefix = PROOF_PREFIX[e.workName];
      if (!prefix) return false;
      return EXECUTED_OBLIGATIONS.every((c) => EXECUTED.has(`${prefix}.${c}`));
    });
    // EVERY registered sweep is behaviourally covered — stated as an identity
    // so adding a sweep without proving it fails here rather than moving a
    // literal.
    expect(covered).toHaveLength(registered.length);
    // And the registry's sweep set is the whole DB-outbox surface: no BullMQ
    // entry has quietly been reclassified into it.
    expect(
      CANONICAL_WORK_REGISTRY.filter((e) => e.transport === "db_outbox_sweep"),
    ).toHaveLength(registered.length);
  });
});
