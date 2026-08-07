/**
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION — ARCH-005, THE TOPOLOGY GATE.
 *
 * The runtime proof lives in `phase-12-arch-005-automation-runtime.integration`
 * and drives real rows. This file answers the questions a runtime proof cannot:
 * whether a SECOND authority exists, whether the queue registration is real,
 * and whether the one security exemption this pass added can be reached
 * anywhere but a test.
 *
 * It emits the five counters the mandate names, and each is DERIVED from the
 * tree rather than asserted as a literal:
 *
 *   DisconnectedAutomationRuntime      = 0
 *   AutomationDuplicateAuthorities     = 0
 *   AutomationOrphanQueues             = 0
 *   AutomationUnfencedTerminalWrites   = 0
 *
 * (`AutomationStuckRuns = 0` is a DATABASE fact and is measured by case 24 of
 * the runtime suite, against real rows. Asserting it here from source would be
 * counting a source scan as runtime proof, which is the thing this programme
 * keeps refusing to do — so it is deliberately absent.)
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SWEEP_NAMES,
  CANONICAL_WORK_REGISTRY,
  getWorkEntryOrThrow,
} from "@proovra/shared";

import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_TYPES,
} from "../src/services/automation/automation.service.js";
import { isLocalWebhookTestingEnabled } from "../src/services/automation/automation-webhook.service.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(API_ROOT, "../..");

const readRepo = (rel: string): string =>
  readFileSync(path.join(REPO, rel), "utf8");
const readApi = (rel: string): string =>
  readFileSync(path.join(API_ROOT, rel), "utf8");

const AUTOMATION_DIR = "src/services/automation";
const OUTBOX = readApi(`${AUTOMATION_DIR}/automation-outbox.service.ts`);
const PROCESSOR = readApi(`${AUTOMATION_DIR}/automation-dispatch-runtime.service.ts`);
const DELIVERY = readApi(`${AUTOMATION_DIR}/automation-delivery-runtime.service.ts`);
const TRIGGERS = readApi(`${AUTOMATION_DIR}/automation-triggers.ts`);
const DISPATCHER = readApi(`${AUTOMATION_DIR}/automation-dispatcher.service.ts`);
const ACTIONS = readApi(`${AUTOMATION_DIR}/automation-actions.service.ts`);
const ROUTES = readApi("src/routes/automation.routes.ts");
const WORKER_INDEX = readRepo("services/worker/src/index.ts");
const WORKER_SWEEP = readRepo("services/worker/src/automation-dispatch.ts");

describe("§2 — ARCH-005 topology: one authority, one registration, one exemption", () => {
  // =========================================================================
  // DisconnectedAutomationRuntime = 0
  // =========================================================================

  it("DisconnectedAutomationRuntime = 0 — producer → row → sweep → worker is whole", () => {
    const breaks: string[] = [];

    // 1. A producer exists and is CALLED by real source sites.
    if (!/export async function enqueueAutomationTrigger/.test(OUTBOX)) {
      breaks.push("no producer");
    }
    const emitters = [
      "triggerEvidenceCreated",
      "triggerEvidenceFinalized",
      "triggerEvidenceReported",
      "triggerReviewAssigned",
      "triggerEscalationCreated",
      "triggerLegalHoldCreated",
    ];
    // Each emitter must be imported by at least one PRODUCTION module outside
    // the automation directory — the exact property the old dispatcher failed.
    const PRODUCTION_CALLERS = [
      "services/api/src/services/evidence.service.ts",
      "services/api/src/services/governance-lifecycle/lifecycle-orchestrator.service.ts",
      "services/api/src/services/reports/report-generation-authority.service.ts",
      "services/api/src/services/review-operations/review-operations.service.ts",
      "services/api/src/services/reviewer-ops/escalation-engine.service.ts",
      "services/api/src/services/governance/legal-hold.service.ts",
    ];
    const callerSources = PRODUCTION_CALLERS.map((p) => {
      if (!existsSync(path.join(REPO, p))) breaks.push(`missing caller module ${p}`);
      return existsSync(path.join(REPO, p)) ? readRepo(p) : "";
    }).join("\n");
    for (const e of emitters) {
      if (!new RegExp(`\\b${e}\\s*\\(`).test(callerSources)) {
        breaks.push(`${e} has no production caller`);
      }
    }

    // 2. A processor exists and is reachable from the machine route.
    if (!/export async function runAutomationDispatchSweep/.test(PROCESSOR)) {
      breaks.push("no processor");
    }
    if (!/runAutomationDispatchSweep\(/.test(ROUTES)) breaks.push("route does not call the sweep");
    if (!/sweepDueDeliveries\(/.test(ROUTES)) breaks.push("route does not sweep deliveries");
    if (!/detectTimeBasedAutomationTriggers\(/.test(ROUTES)) {
      breaks.push("route does not run the time-based detectors");
    }
    if (!/requireIntegrationCronSecret\(/.test(ROUTES)) {
      breaks.push("the machine route is not cron-secret guarded");
    }

    // 3. The worker actually SCHEDULES it.
    if (!/startAutomationDispatchScheduler\(\)/.test(WORKER_INDEX)) {
      breaks.push("worker never starts the scheduler");
    }
    if (!/setInterval\(/.test(WORKER_INDEX.slice(WORKER_INDEX.indexOf("function startAutomationDispatchScheduler")))) {
      breaks.push("scheduler has no interval");
    }
    if (!/withCronLock\("automation-dispatch-sweep"/.test(WORKER_INDEX)) {
      breaks.push("sweep is not cron-locked across replicas");
    }
    if (!/runAutomationDispatchSweepTick/.test(WORKER_SWEEP)) {
      breaks.push("worker tick module does not export its tick");
    }

    expect(breaks, breaks.join("\n")).toEqual([]);
  });

  it("every allowlisted trigger has a source, and no trigger was invented", () => {
    const missing = AUTOMATION_TRIGGER_TYPES.filter(
      (t) => !TRIGGERS.includes(`"${t}"`),
    );
    expect(missing, `triggers with no source: ${missing.join(", ")}`).toEqual([]);

    // The converse: the trigger module must not introduce a trigger the
    // database CHECK would reject.
    const named = [...TRIGGERS.matchAll(/triggerType:\s*"([A-Z_]+)"/g)].map((m) => m[1]!);
    const invented = [...new Set(named)].filter(
      (t) => !(AUTOMATION_TRIGGER_TYPES as readonly string[]).includes(t),
    );
    expect(invented, `invented triggers: ${invented.join(", ")}`).toEqual([]);
  });

  it("every allowlisted action still has exactly one handler", () => {
    for (const a of AUTOMATION_ACTION_TYPES) {
      expect(ACTIONS.includes(`case "${a}":`), `${a} has no handler`).toBe(true);
    }
  });

  // =========================================================================
  // AutomationDuplicateAuthorities = 0
  // =========================================================================

  it("AutomationDuplicateAuthorities = 0 — one producer, one processor, one terminal writer", () => {
    const duplicates: string[] = [];

    // Only the producer writes an AutomationRun into existence.
    const creators = [OUTBOX, PROCESSOR, DELIVERY, TRIGGERS, DISPATCHER, ACTIONS, ROUTES]
      .map((src, i) => ({ src, i }))
      .filter(({ src }) => /automationRun\.create(Many)?\(/.test(src));
    if (creators.length !== 1) {
      duplicates.push(`${creators.length} modules create AutomationRun rows (expected 1)`);
    }
    if (!/automationRun\.createMany\(/.test(OUTBOX)) {
      duplicates.push("the producer is not the creator");
    }

    // Only the processor writes a terminal state.
    for (const [name, src] of [
      ["dispatcher", DISPATCHER],
      ["delivery", DELIVERY],
      ["triggers", TRIGGERS],
      ["actions", ACTIONS],
      ["routes", ROUTES],
      ["outbox", OUTBOX],
    ] as const) {
      if (/automationRun\.(update|updateMany)\(/.test(src)) {
        duplicates.push(`${name} writes AutomationRun state`);
      }
    }

    // No alternate in-memory execution anywhere in the automation directory.
    for (const [name, src] of [
      ["outbox", OUTBOX],
      ["processor", PROCESSOR],
      ["delivery", DELIVERY],
      ["triggers", TRIGGERS],
      ["dispatcher", DISPATCHER],
      ["actions", ACTIONS],
    ] as const) {
      if (/\bsetImmediate\s*\(|\bsetTimeout\s*\(|from\s+["']node:timers["']/.test(src)) {
        duplicates.push(`${name} schedules work in process`);
      }
    }

    expect(duplicates, duplicates.join("\n")).toEqual([]);
  });

  // =========================================================================
  // AutomationOrphanQueues = 0
  // =========================================================================

  it("AutomationOrphanQueues = 0 — the sweep is registered and every path exists", () => {
    expect(Object.values(SWEEP_NAMES) as string[]).toContain("AutomationDispatchSweep");
    const entry = getWorkEntryOrThrow(SWEEP_NAMES.AUTOMATION_DISPATCH);

    expect(entry.implementation).toBe("CURRENT_RUNTIME");
    expect(entry.transport).toBe("db_outbox_sweep");
    expect(entry.durableAuthority.model).toBe("AutomationRun");
    // The tenant comes off the durable row, never off a payload.
    expect(entry.durableAuthority.tenantSource).toBe("AutomationRun.teamId");
    expect(entry.durableAuthority.createdBySynchronousPath).toBe(true);
    // A claim with a lease, and a reconciler that owns the expired ones.
    expect(entry.claim?.mechanism).toBe("conditional_update_many");
    expect(entry.claim?.leaseField).toBe("leaseExpiresAtUtc");
    expect(entry.claim?.leaseMs ?? 0).toBeGreaterThan(0);
    expect(entry.reconciler).toBeTruthy();

    // Every path the registry names must actually exist on disk — the check
    // that stops a registry entry from describing an intention.
    for (const p of [
      entry.canonicalProducer,
      entry.canonicalProcessor,
      entry.terminalWriter,
      entry.reconciler,
      entry.workerRegistration,
    ]) {
      expect(existsSync(path.join(REPO, p!)), `${p} does not exist`).toBe(true);
    }

    // And no OTHER registry entry claims the same durable model, which is how
    // a second sweep for the same rows would appear.
    const sameModel = CANONICAL_WORK_REGISTRY.filter(
      (e) => e.durableAuthority.model === "AutomationRun",
    );
    expect(sameModel).toHaveLength(1);
  });

  // =========================================================================
  // AutomationUnfencedTerminalWrites = 0
  // =========================================================================

  it("AutomationUnfencedTerminalWrites = 0 — no terminal write escapes the fence", () => {
    // `fencedUpdate` is the only writer, and its precondition carries both the
    // status and the generation.
    const idx = PROCESSOR.indexOf("async function fencedUpdate");
    expect(idx).toBeGreaterThan(-1);
    const fence = PROCESSOR.slice(idx, idx + 900);
    expect(fence).toMatch(/status:\s*"RUNNING"/);
    expect(fence).toMatch(/claimGeneration:\s*generation/);

    // Every `updateMany` on automationRun in the processor must name a
    // generation. Three exist: the claim, the fenced terminal write, and the
    // reconciler.
    //
    // Each call site is WINDOWED rather than matched to its closing brace: the
    // reconciler's `data` is a nested ternary, and a brace-matching regex that
    // failed on it would silently check FEWER sites than exist — which is the
    // shape of an audit with a blind spot, and the shape NEW-014 was.
    const sites = [...PROCESSOR.matchAll(/automationRun\.updateMany\(\{/g)].map((m) =>
      PROCESSOR.slice(m.index!, m.index! + 900),
    );
    expect(
      sites.length,
      "expected the claim, the fenced terminal write and the reconciler",
    ).toBeGreaterThanOrEqual(3);
    for (const site of sites) {
      expect(
        site,
        `an updateMany without a generation precondition:\n${site.slice(0, 300)}`,
      ).toMatch(/claimGeneration/);
    }

    // And nothing anywhere uses the unconditional single-row update.
    expect(PROCESSOR).not.toMatch(/automationRun\.update\(/);
  });

  it("the delivery outbox is fenced on the same terms", () => {
    const sites = [
      ...DELIVERY.matchAll(/automationWebhookDelivery\.updateMany\(\{/g),
    ].map((m) => DELIVERY.slice(m.index!, m.index! + 900));
    expect(sites.length, "expected the claim and the reconciler").toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      expect(
        site,
        `an unfenced delivery updateMany:\n${site.slice(0, 300)}`,
      ).toMatch(/claimGeneration/);
    }
  });

  // =========================================================================
  // THE ONE SECURITY EXEMPTION THIS PASS ADDED
  // =========================================================================

  it("the loopback exemption is unreachable outside NODE_ENV=test", () => {
    const priorEnv = process.env.NODE_ENV;
    const priorFlag = process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
    try {
      // The flag alone is not enough in ANY non-test environment — including
      // "development" and "staging", not merely production. There is no
      // deployment in which a misplaced variable opens this.
      process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = "1";
      for (const env of ["production", "staging", "development", undefined]) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        expect(
          isLocalWebhookTestingEnabled(),
          `loopback must be refused with NODE_ENV=${String(env)}`,
        ).toBe(false);
      }
      // And in test it requires the flag to be exactly "1".
      process.env.NODE_ENV = "test";
      for (const v of ["", "0", "true", "yes"]) {
        process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = v;
        expect(isLocalWebhookTestingEnabled(), `flag "${v}" must not enable it`).toBe(false);
      }
      process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = "1";
      expect(isLocalWebhookTestingEnabled()).toBe(true);
    } finally {
      if (priorEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorEnv;
      if (priorFlag === undefined) delete process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK;
      else process.env.AUTOMATION_WEBHOOK_ALLOW_LOOPBACK = priorFlag;
    }
  });

  it("the exemption widens LOOPBACK only — private, link-local and metadata stay refused", () => {
    // Read as source rather than driven here, because the DRIVEN proof is case
    // 18 of the runtime suite (six targets, with the flag on, counting the
    // receiver's hits to show nothing left the process). This case exists to
    // pin that the code path cannot be broadened without the diff being
    // obvious: the exemption must test for the two loopback literals and
    // nothing else.
    const src = readApi(`${AUTOMATION_DIR}/automation-webhook.service.ts`);
    const idx = src.indexOf("if (allowLoopback) {");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, src.indexOf("}", src.indexOf("// Anything else falls through")));
    expect(block).toMatch(/h === "127\.0\.0\.1" \|\| h === "::1"/);
    expect(block).not.toMatch(/10\.|172\.|192\.168|169\.254|fd00/);
  });

  // =========================================================================
  // BOUNDS
  // =========================================================================

  it("every bound is a constant, not a caller-supplied parameter", () => {
    for (const c of [
      "AUTOMATION_LEASE_MS",
      "AUTOMATION_MAX_ATTEMPTS",
      "AUTOMATION_RETRY_BACKOFF_SECONDS",
      "AUTOMATION_SWEEP_LIMIT",
      "AUTOMATION_FAILURE_CODES",
    ]) {
      expect(PROCESSOR, `${c} must be an exported constant`).toMatch(
        new RegExp(`export const ${c}`),
      );
    }
    // The sweep's limit is clamped, so a caller cannot raise it.
    expect(PROCESSOR).toMatch(/Math\.min\(Math\.max\([\s\S]{0,80}?\), 100\)/);
    // The failure code set is bounded and carries no free text.
    expect(PROCESSOR).toMatch(/failureCode:\s*(failure\.code|code|"[a-z_]+"|null)/);
  });
});
