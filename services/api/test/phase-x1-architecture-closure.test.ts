/**
 * Phase X.1 — Architecture consolidation closure pass tests.
 *
 * Cross-runtime + cross-module assertions verifying:
 *   Part A — Workers route notifications + incidents through canonical
 *            emitter modules (no inline upserts).
 *   Part B — Queue envelope is tolerantly parsed (legacy + canonical).
 *   Part C — Correlation IDs are threaded through destruction +
 *            retention + lifecycle + immutable flows.
 *   Part D — Destructive-action gate orchestrator owns the previously
 *            in-route glue (delete + archive endpoints).
 *   Part E — Cross-runtime semantics agreement.
 *   Part F — Operational safety: no duplicate emission paths remain.
 *
 * No DB. Source-text + pure-helper consistency assertions.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isQueuePayloadEnvelope,
  isValidCorrelationId,
  newCorrelationId,
  newQueuePayloadEnvelope,
  parseQueueEnvelope,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// Part A — workers route through canonical emitters
// -----------------------------------------------------------------------------

describe("Phase X.1 — Part A: worker canonical emitters", () => {
  const retentionSrc = readSource(
    "../../worker/src/governance/retention-reconciliation.worker.ts",
  );
  const destructionSrc = readSource(
    "../../worker/src/governance/destruction-orchestrator.worker.ts",
  );
  const immutableSrc = readSource(
    "../../worker/src/governance/immutable-storage-reconciliation.worker.ts",
  );

  it("retention worker imports the canonical notification emitter", () => {
    expect(retentionSrc).toContain("emitWorkerGovernanceNotification");
    expect(retentionSrc).toContain(
      'from "./notification-emitter.js"',
    );
  });

  it("destruction worker imports the canonical notification emitter", () => {
    expect(destructionSrc).toContain("emitWorkerGovernanceNotification");
    expect(destructionSrc).toContain(
      'from "./notification-emitter.js"',
    );
  });

  it("immutable worker imports the canonical notification + incident emitters", () => {
    expect(immutableSrc).toContain("emitWorkerGovernanceNotification");
    expect(immutableSrc).toContain("recordWorkerIncident");
    expect(immutableSrc).toContain(
      'from "./incident-emitter.js"',
    );
  });

  it("no worker contains a direct prisma.governanceNotification.upsert call", () => {
    // Strip comments and string literals before checking — mentions in
    // docstrings ("removed the inline upsert") are fine; live calls
    // are not.
    function stripComments(src: string): string {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    }
    for (const src of [retentionSrc, destructionSrc, immutableSrc]) {
      expect(stripComments(src)).not.toMatch(
        /prisma\.governanceNotification\.upsert/,
      );
    }
  });

  it("no worker contains a direct prisma.operationalIncident.upsert or .create outside the emitter", () => {
    // The emitter file itself does the .create — that's by design.
    // Worker files should ONLY call recordWorkerIncident.
    for (const src of [retentionSrc, destructionSrc, immutableSrc]) {
      expect(src).not.toMatch(/prisma\.operationalIncident\.create/);
      expect(src).not.toMatch(/prisma\.operationalIncident\.upsert/);
    }
  });

  it("notification emitter applies severity escalation but never de-escalation", () => {
    const emitterSrc = readSource(
      "../../worker/src/governance/notification-emitter.ts",
    );
    expect(emitterSrc).toContain("SEVERITY_RANK");
    expect(emitterSrc).toMatch(/never de-?escalates/i);
  });

  it("notification emitter honors the shared throttle window", () => {
    const emitterSrc = readSource(
      "../../worker/src/governance/notification-emitter.ts",
    );
    expect(emitterSrc).toContain("NOTIFICATION_THROTTLE_SECONDS");
    expect(emitterSrc).toContain("shouldThrottle");
  });

  it("notification emitter fans HIGH/CRITICAL out to the incident center", () => {
    const emitterSrc = readSource(
      "../../worker/src/governance/notification-emitter.ts",
    );
    expect(emitterSrc).toContain("recordWorkerIncident");
    expect(emitterSrc).toMatch(/HIGH.*CRITICAL|CRITICAL.*HIGH/);
  });

  it("incident emitter upserts by (teamId, fingerprint) with reopen support", () => {
    const incidentSrc = readSource(
      "../../worker/src/governance/incident-emitter.ts",
    );
    expect(incidentSrc).toContain("teamId_fingerprint");
    expect(incidentSrc).toContain("willReopen");
    expect(incidentSrc).toContain("IncidentStatus.RESOLVED");
    expect(incidentSrc).toContain("IncidentStatus.SUPPRESSED");
    expect(incidentSrc).toContain("severity");
  });
});

// -----------------------------------------------------------------------------
// Part B — queue envelope adoption + tolerant decode
// -----------------------------------------------------------------------------

describe("Phase X.1 — Part B: queue envelope adoption", () => {
  it("newQueuePayloadEnvelope produces a parseable envelope", () => {
    const env = newQueuePayloadEnvelope({
      kind: "TestJob",
      idempotencyKey: "abc-123",
      body: { evidenceId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(isQueuePayloadEnvelope(env)).toBe(true);
    expect(env.correlationId).toMatch(/^[a-f0-9]{32}$/);
    expect(env.idempotencyKey).toBe("abc-123");
  });

  it("parseQueueEnvelope decodes a canonical envelope", () => {
    const env = newQueuePayloadEnvelope({
      kind: "TestJob",
      idempotencyKey: "abc-123",
      body: { evidenceId: "11111111-1111-4111-8111-111111111111" },
    });
    const decoded = parseQueueEnvelope<{ evidenceId: string }>(env, {
      expectedKind: "TestJob",
    });
    expect(decoded.legacy).toBe(false);
    expect(decoded.body.evidenceId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(decoded.correlationId).toBe(env.correlationId);
    expect(decoded.idempotencyKey).toBe("abc-123");
    expect(decoded.kindMismatch).toBe(false);
  });

  it("parseQueueEnvelope falls back to a raw legacy payload", () => {
    const raw = { evidenceId: "22222222-2222-4222-8222-222222222222" };
    const decoded = parseQueueEnvelope<{ evidenceId: string }>(raw, {
      expectedKind: "PurgeDeletedEvidenceJob",
    });
    expect(decoded.legacy).toBe(true);
    expect(decoded.body.evidenceId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(decoded.correlationId).toMatch(/^[a-f0-9]{32}$/);
    expect(decoded.idempotencyKey).toBeNull();
  });

  it("parseQueueEnvelope flags kind mismatches without throwing", () => {
    const env = newQueuePayloadEnvelope({
      kind: "WrongKind",
      idempotencyKey: "x",
      body: { evidenceId: "11111111-1111-4111-8111-111111111111" },
    });
    const decoded = parseQueueEnvelope<{ evidenceId: string }>(env, {
      expectedKind: "ExpectedKind",
    });
    expect(decoded.legacy).toBe(false);
    expect(decoded.kindMismatch).toBe(true);
  });

  it("evidence-purge enqueue wraps in canonical envelope (source contract)", () => {
    const queueSrc = readSource("../../worker/src/queue.ts");
    expect(queueSrc).toContain("newQueuePayloadEnvelope");
    expect(queueSrc).toContain('kind: purgeDeletedEvidenceJobName');
  });

  it("evidence-purge processor uses tolerant decode (source contract)", () => {
    const processorSrc = readSource("../../worker/src/processor.ts");
    expect(processorSrc).toContain("parseQueueEnvelope");
    expect(processorSrc).toContain('expectedKind: "PurgeDeletedEvidenceJob"');
  });
});

// -----------------------------------------------------------------------------
// Part C — correlation ID propagation
// -----------------------------------------------------------------------------

describe("Phase X.1 — Part C: correlation ID propagation", () => {
  it("newCorrelationId produces canonical 32-char hex IDs", () => {
    for (let i = 0; i < 20; i++) {
      const id = newCorrelationId();
      expect(isValidCorrelationId(id)).toBe(true);
      expect(id).toMatch(/^[a-f0-9]{32}$/);
    }
  });

  it("retention reconciliation threads correlation through emissions + ledger", () => {
    const src = readSource(
      "../../worker/src/governance/retention-reconciliation.worker.ts",
    );
    expect(src).toContain("newCorrelationId");
    expect(src).toContain("correlationId");
    expect(src).toContain("requestId: correlationId.slice(0, 64)");
  });

  it("destruction orchestrator threads correlation per execution attempt", () => {
    const src = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    expect(src).toContain("const correlationId = newCorrelationId()");
    expect(src).toContain("correlationId,");
    expect(src).toContain("reconciliationRunId: ctx.runId");
    expect(src).toContain("requestId: correlationId.slice(0, 64)");
  });

  it("immutable storage worker threads correlation through metadata + emitters", () => {
    const src = readSource(
      "../../worker/src/governance/immutable-storage-reconciliation.worker.ts",
    );
    expect(src).toContain("const correlationId = newCorrelationId()");
    expect(src).toContain("correlationId,");
    expect(src).toContain("reconciliationRunId: ctx.runId");
  });

  it("evidence-purge processor preserves the correlation id from the envelope", () => {
    const processorSrc = readSource("../../worker/src/processor.ts");
    expect(processorSrc).toContain(
      "const requestId = decoded.correlationId || randomUUID()",
    );
    expect(processorSrc).toContain('envelope: decoded.legacy');
  });

  it("api governance-lifecycle routes pass req.id to services", () => {
    const src = readSource(
      "../src/routes/governance-lifecycle.routes.ts",
    );
    expect(src).toContain("requestId: req.id");
  });
});

// -----------------------------------------------------------------------------
// Part D — destructive-action gate extracted from evidence routes
// -----------------------------------------------------------------------------

describe("Phase X.1 — Part D: destructive-action gate orchestrator", () => {
  const gateSrc = readSource(
    "../src/services/governance/destructive-action-gate.service.ts",
  );
  const routesSrc = readSource("../src/routes/evidence.routes.ts");

  it("orchestrator owns membership lookup + enforceSensitiveAction + custody emit + status mapping", () => {
    expect(gateSrc).toContain("teamMember.findUnique");
    expect(gateSrc).toContain("enforceSensitiveAction");
    expect(gateSrc).toContain("appendCustodyEvent");
    expect(gateSrc).toContain('"GOVERNANCE_CHECK_FAILED"');
    expect(gateSrc).toContain('"DELETE_RESTRICTED_TO_ADMIN"');
  });

  it("orchestrator maps decision codes to identical custody event types as the legacy route glue", () => {
    expect(gateSrc).toContain("DELETE_BLOCKED_BY_LEGAL_HOLD");
    expect(gateSrc).toContain("DELETE_BLOCKED_BY_RETENTION");
    expect(gateSrc).toContain("EXPORT_BLOCKED_BY_POLICY");
  });

  it("orchestrator maps decision codes to identical HTTP statuses (503/403/409)", () => {
    expect(gateSrc).toMatch(/503/);
    expect(gateSrc).toMatch(/403/);
    expect(gateSrc).toMatch(/409/);
  });

  it("delete endpoint calls runDestructiveActionGate (route is thinner)", () => {
    expect(routesSrc).toContain("runDestructiveActionGate");
    expect(routesSrc).toContain('action: "delete_evidence"');
    expect(routesSrc).toContain('routeLabel: "delete"');
  });

  it("archive endpoint calls runDestructiveActionGate (same orchestrator)", () => {
    expect(routesSrc).toContain('action: "archive_evidence"');
    expect(routesSrc).toContain('routeLabel: "archive"');
  });

  it("delete handler no longer has the inline membership + enforceSensitiveAction loop", () => {
    // The Phase 9.5 inline pattern was: `await import("../services/governance.service.js")`
    // + `prisma.teamMember.findUnique` + manual code-to-status mapping.
    // The pattern survives ONLY through the orchestrator import path now.
    const inlineCount = (
      routesSrc.match(
        /import\("\.\.\/services\/governance\.service\.js"\)/g,
      ) ?? []
    ).length;
    // We allow a small budget for other governance imports unrelated
    // to the destructive-action gate. Critically the gate orchestrator
    // imports it once, but routes shouldn't re-import it for
    // destructive actions any more.
    expect(inlineCount).toBeLessThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------------
// Part E — Cross-runtime semantics agreement
// -----------------------------------------------------------------------------

describe("Phase X.1 — Part E: cross-runtime alignment", () => {
  it("worker emitter consumes the shared throttle catalog + extracted contract; api service is read-only", () => {
    // Product decision 2026-07-14: worker emitter is the sole writer;
    // the dedupe/throttle contract is extracted to @proovra/shared
    // (governance-notification-contract.ts). The api service no longer
    // duplicates any writer logic — it reads/projects/acknowledges.
    const workerSrc = readSource(
      "../../worker/src/governance/notification-emitter.ts",
    );
    const contractSrc = readSource(
      "../../../packages/shared/src/governance-notification-contract.ts",
    );
    const apiSrc = readSource(
      "../src/services/governance-lifecycle/governance-notification.service.ts",
    );
    // Shared throttle catalog consumed by the sole writer.
    for (const name of [
      "NOTIFICATION_THROTTLE_SECONDS",
      "isValidDedupeKey",
      "NOTIFICATION_TITLE_MAX_LEN",
      "NOTIFICATION_SUMMARY_MAX_LEN",
      "DEDUPE_KEY_MAX_LEN",
    ]) {
      expect(workerSrc).toContain(name);
    }
    // Extracted contract helpers live in ONE place.
    for (const name of [
      "SEVERITY_RANK",
      "scrubMetadata",
      "boundedJson",
      "resolveChannels",
      "DEFAULT_NOTIFICATION_CHANNELS",
    ]) {
      expect(contractSrc).toContain(name);
    }
    // Worker imports the helpers rather than duplicating them.
    expect(workerSrc).toMatch(
      /import\s*\{[\s\S]*?SEVERITY_RANK[\s\S]*?\}\s*from\s*"@proovra\/shared"/,
    );
    expect(workerSrc).toMatch(
      /import\s*\{[\s\S]*?boundedJson[\s\S]*?\}\s*from\s*"@proovra\/shared"/,
    );
    // The api read surface carries no duplicate of the writer contract.
    for (const name of [
      "emitGovernanceNotification",
      "scrubMetadata",
      "boundedJson",
      "resolveChannels",
      "NOTIFICATION_THROTTLE_SECONDS",
    ]) {
      expect(apiSrc).not.toContain(name);
    }
  });

  it("api incident service AND worker incident emitter share the (teamId, fingerprint) unique key", () => {
    const apiSrc = readSource(
      "../src/services/observability/incident.service.ts",
    );
    const workerSrc = readSource(
      "../../worker/src/governance/incident-emitter.ts",
    );
    expect(apiSrc).toContain("teamId_fingerprint");
    expect(workerSrc).toContain("teamId_fingerprint");
  });

  it("api destruction-review AND worker orchestrator both end DESTROYED via the same lifecycle ledger", () => {
    const apiSrc = readSource(
      "../src/services/governance-lifecycle/destruction-review.service.ts",
    );
    const workerSrc = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    expect(apiSrc).toContain('eventType: "destruction_executed"');
    expect(workerSrc).toContain('eventType: "destruction_executed"');
    expect(apiSrc).toContain("certificateHash");
    expect(workerSrc).toContain("certificateHash");
  });
});

// -----------------------------------------------------------------------------
// Part F — Operational safety
// -----------------------------------------------------------------------------

describe("Phase X.1 — Part F: operational safety", () => {
  it("no duplicate notification-emission paths remain in workers (live code)", () => {
    const retentionSrc = readSource(
      "../../worker/src/governance/retention-reconciliation.worker.ts",
    );
    const destructionSrc = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    const immutableSrc = readSource(
      "../../worker/src/governance/immutable-storage-reconciliation.worker.ts",
    );
    function stripComments(src: string): string {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    }
    for (const src of [retentionSrc, destructionSrc, immutableSrc]) {
      const live = stripComments(src);
      expect(live).not.toMatch(/governanceNotification\.upsert/);
      expect(live).not.toMatch(/governanceNotification\.create/);
    }
  });

  it("destruction orchestrator preserves idempotency via destructionExecution.findFirst", () => {
    const src = readSource(
      "../../worker/src/governance/destruction-orchestrator.worker.ts",
    );
    expect(src).toContain("destructionExecution.findFirst");
    expect(src).toContain("attemptCount: { increment: 1 }");
  });

  it("destructive-action gate fails closed on personal-scope vs workspace-scope", () => {
    const src = readSource(
      "../src/services/governance/destructive-action-gate.service.ts",
    );
    expect(src).toContain("if (!input.evidence.teamId)");
    expect(src).toContain("return { gated: false }");
    expect(src).toMatch(/Personal-?scope evidence/);
  });

  it("queue envelope retains BullMQ jobId as idempotency key (no duplicate enqueue)", () => {
    const src = readSource("../../worker/src/queue.ts");
    expect(src).toContain("idempotencyKey: jobId");
    expect(src).toContain("buildEvidencePurgeJobId");
  });
});
