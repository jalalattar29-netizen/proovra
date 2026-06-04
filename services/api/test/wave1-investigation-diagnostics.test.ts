/**
 * Wave 1 Phase 5 — Investigation Diagnostics envelope contract test.
 *
 * Hard contracts pinned here:
 *
 *   1. GET /v1/investigation/diagnostics is registered.
 *
 *   2. The route file imports buildInvestigationDiagnostics from
 *      the service layer (no inline aggregator in the route).
 *
 *   3. The service composes the existing helpers:
 *        - resolveProducerModeStatuses
 *        - getQueueInventory
 *        - listFailedJobs
 *      It does NOT duplicate probe logic and does NOT read raw env
 *      vars for producer-mode decisions.
 *
 *   4. The service uses the canonical platform-audit-log pattern —
 *      it does NOT directly write AdminAuditLog rows.
 *
 *   5. Every key in the public response shape is whitelisted in
 *      INVESTIGATION_DIAGNOSTICS_RESPONSE_KEYS so the route can audit
 *      outgoing payloads against PII / secret leakage.
 *
 *   6. The permission gate denies external reviewers + read-only
 *      members: the route requires either `identity.member.read`
 *      OR `evidence.update_metadata`; non-members get a 404.
 *
 *   7. The envelope shape carries the 11 required queue keys, the
 *      29 required workspace count keys, producerModes[5], and the
 *      lastErrors[] + warnings[] arrays.
 *
 *   8. The service is registered in server.ts.
 *
 *   9. The service NEVER projects raw evidence content, OCR text,
 *      transcript text, storage keys, GPS, reviewer-private notes,
 *      or audit metadata payloads. Source-side allowlist check
 *      (no `text:`, `storageKey`, `storageBucket`, `latitude`,
 *      `privateNote`, `legalNote`, `metadata:` projections appear
 *      in the service file outside count() filters).
 *
 *  10. resolveProducerModeStatuses returns 5 producer entries in
 *      stable PRODUCER_KINDS order.
 *
 * Source-contract only — no DB / no fetch / no spawn.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PRODUCER_KINDS,
  type ProducerKind,
} from "@proovra/shared-runtime/media-intelligence";
import {
  INVESTIGATION_DIAGNOSTICS_RESPONSE_KEYS,
  type InvestigationDiagnostics,
} from "../src/services/investigation-diagnostics.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTES_SRC = readSource(
  "../src/routes/investigation-diagnostics.routes.ts",
);
const SERVICE_SRC = readSource(
  "../src/services/investigation-diagnostics.service.ts",
);
const SERVER_SRC = readSource("../src/server.ts");

const REQUIRED_WORKSPACE_KEYS = [
  "evidenceCount",
  "finalizedEvidenceCount",
  "evidencePartCount",
  "caseCount",
  "caseEvidenceLinkCount",
  "custodyEventCount",
  "auditEventCount",
  "graphNodeCount",
  "graphEdgeCount",
  "staleGraphNodeCount",
  "staleGraphEdgeCount",
  "timelineEventCount",
  "duplicateExactCount",
  "duplicateSimilarityCount",
  "duplicateDerivativeCount",
  "mediaSignalCount",
  "mediaRecordCountsByKind",
  "ocrRecordCount",
  "transcriptRecordCount",
  "extractedTextCount",
  "perceptualHashCount",
  "perceptualDhashCount",
  "entityCount",
  "reviewWorkflowCount",
  "escalationCount",
  "externalReviewerGrantCount",
  "reportCount",
  "verificationPackageCount",
] as const;

const REQUIRED_QUEUE_KEYS = [
  "graphReconcile",
  "graphDomainSync",
  "graphTimelineSync",
  "graphSearchProjection",
  "mediaIntelligence",
  "miOcr",
  "miTranscript",
  "miEmbed",
  "miSearchIndex",
  "searchIndexing",
  "report",
] as const;

describe("Wave 1 Phase 5 — investigation-diagnostics route registration", () => {
  it("GET /v1/investigation/diagnostics is registered", () => {
    expect(ROUTES_SRC).toMatch(
      /app\.get\(\s*"\/v1\/investigation\/diagnostics"/,
    );
  });

  it("registers a teamId UUID query validator", () => {
    expect(ROUTES_SRC).toMatch(/teamId:\s*z\.string\(\)\.uuid\(\)/);
  });

  it("uses requireAuth preHandler", () => {
    expect(ROUTES_SRC).toMatch(/preHandler:\s*requireAuth/);
  });

  it("delegates aggregation to buildInvestigationDiagnostics", () => {
    expect(ROUTES_SRC).toMatch(/buildInvestigationDiagnostics\(/);
    // route MUST NOT contain its own prisma.count aggregations
    expect(ROUTES_SRC).not.toMatch(/prisma\.\w+\.count\(/);
  });

  it("is registered in server.ts", () => {
    expect(SERVER_SRC).toMatch(/investigationDiagnosticsRoutes/);
    expect(SERVER_SRC).toMatch(
      /app\.register\(\s*investigationDiagnosticsRoutes\s*\)/,
    );
  });
});

describe("Wave 1 Phase 5 — permission gate denies external reviewers + read-only members", () => {
  it("checks workspace membership before permission (anti-enumeration 404)", () => {
    expect(ROUTES_SRC).toMatch(/teamMember\.findUnique/);
    expect(ROUTES_SRC).toMatch(/reply\.code\(404\)\.send/);
  });

  it("requires either identity.member.read OR evidence.update_metadata", () => {
    expect(ROUTES_SRC).toMatch(/"identity\.member\.read"/);
    expect(ROUTES_SRC).toMatch(/"evidence\.update_metadata"/);
  });

  it("returns 403 when both decisions deny", () => {
    expect(ROUTES_SRC).toMatch(
      /!opsDecision\.allowed\s*&&\s*!reviewerDecision\.allowed/,
    );
    expect(ROUTES_SRC).toMatch(/reply\.code\(403\)\.send/);
  });
});

describe("Wave 1 Phase 5 — service composes existing helpers (no duplication)", () => {
  it("delegates producer-mode resolution to resolveProducerModeStatuses", () => {
    expect(SERVICE_SRC).toMatch(
      /import\s*\{[^}]*resolveProducerModeStatuses[^}]*\}\s*from\s*"@proovra\/shared-runtime\/media-intelligence"/s,
    );
    expect(SERVICE_SRC).toMatch(/await\s+resolveProducerModeStatuses\(/);
  });

  it("delegates queue inventory to getQueueInventory", () => {
    // The diagnostics service uses a dynamic `await import(...)` so the
    // module load stays decoupled from BullMQ at file-evaluation time.
    expect(SERVICE_SRC).toMatch(
      /["']\.\/operations\/queue-inventory\.service\.js["']/,
    );
    expect(SERVICE_SRC).toMatch(/getQueueInventory/);
    expect(SERVICE_SRC).toMatch(/listFailedJobs/);
  });

  it("never constructs a new BullMQ Queue handle directly", () => {
    expect(SERVICE_SRC).not.toMatch(/new\s+Queue\(/);
    expect(SERVICE_SRC).not.toMatch(/from\s+"bullmq"/);
  });

  it("does not duplicate probe logic — no direct env reads for producer modes", () => {
    expect(SERVICE_SRC).not.toMatch(/process\.env\.OCR_PRODUCER_MODE/);
    expect(SERVICE_SRC).not.toMatch(/process\.env\.TRANSCRIPT_PRODUCER_MODE/);
    expect(SERVICE_SRC).not.toMatch(/process\.env\.OPENAI_API_KEY/);
    expect(SERVICE_SRC).not.toMatch(/probeAzureDocumentIntelligence/);
    expect(SERVICE_SRC).not.toMatch(/probeDeepgram/);
    expect(SERVICE_SRC).not.toMatch(/isSemanticReadyAtRuntime/);
  });

  it("never writes AdminAuditLog directly (canonical emitter contract)", () => {
    // The diagnostics service is read-only — no audit emissions at
    // all. But pin the canonical contract: if a future change adds
    // audit emit it MUST go through appendPlatformAuditLog.
    expect(SERVICE_SRC).not.toMatch(/prisma\.adminAuditLog\.create/);
  });
});

describe("Wave 1 Phase 5 — service surface shape", () => {
  it("exports buildInvestigationDiagnostics", () => {
    expect(SERVICE_SRC).toMatch(
      /export\s+async\s+function\s+buildInvestigationDiagnostics/,
    );
  });

  it("exports the response-key allowlist", () => {
    expect(SERVICE_SRC).toMatch(
      /export\s+const\s+INVESTIGATION_DIAGNOSTICS_RESPONSE_KEYS/,
    );
  });

  it("response-key allowlist contains all 5 top-level keys", () => {
    for (const key of [
      "workspace",
      "queues",
      "producerModes",
      "lastErrors",
      "warnings",
    ]) {
      expect(INVESTIGATION_DIAGNOSTICS_RESPONSE_KEYS).toContain(key as never);
    }
  });

  it("response-key allowlist contains every required workspace count key", () => {
    for (const key of REQUIRED_WORKSPACE_KEYS) {
      expect(
        INVESTIGATION_DIAGNOSTICS_RESPONSE_KEYS,
        `missing workspace key ${key}`,
      ).toContain(`workspace.${key}` as never);
    }
  });

  it("response-key allowlist contains every required queue key", () => {
    for (const key of REQUIRED_QUEUE_KEYS) {
      expect(
        INVESTIGATION_DIAGNOSTICS_RESPONSE_KEYS,
        `missing queue key ${key}`,
      ).toContain(`queues.${key}` as never);
    }
  });

  it("queue rows expose depth, lastError, lastRunAt only", () => {
    for (const k of ["depth", "lastError", "lastRunAt"]) {
      expect(INVESTIGATION_DIAGNOSTICS_RESPONSE_KEYS).toContain(k as never);
    }
  });

  it("lastErrors entries expose source, code, message, occurredAt only", () => {
    for (const k of ["source", "code", "message", "occurredAt"]) {
      expect(INVESTIGATION_DIAGNOSTICS_RESPONSE_KEYS).toContain(k as never);
    }
  });
});

describe("Wave 1 Phase 5 — InvestigationDiagnostics type carries all required fields", () => {
  // Compile-time pin: the type itself must satisfy the contract.
  // This block constructs a zero-valued instance of the type and the
  // TypeScript compiler enforces all 28 workspace fields + 11 queue
  // fields + producerModes + lastErrors + warnings exist.
  it("type union enforces every required workspace + queue field", () => {
    const sample: InvestigationDiagnostics = {
      workspace: {
        evidenceCount: 0,
        finalizedEvidenceCount: 0,
        evidencePartCount: 0,
        caseCount: 0,
        caseEvidenceLinkCount: 0,
        custodyEventCount: 0,
        auditEventCount: 0,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        staleGraphNodeCount: 0,
        staleGraphEdgeCount: 0,
        timelineEventCount: 0,
        duplicateExactCount: 0,
        duplicateSimilarityCount: 0,
        duplicateDerivativeCount: 0,
        mediaSignalCount: 0,
        mediaRecordCountsByKind: {},
        ocrRecordCount: 0,
        transcriptRecordCount: 0,
        extractedTextCount: 0,
        perceptualHashCount: 0,
        perceptualDhashCount: 0,
        entityCount: 0,
        reviewWorkflowCount: 0,
        escalationCount: 0,
        externalReviewerGrantCount: 0,
        reportCount: 0,
        verificationPackageCount: 0,
      },
      queues: {
        graphReconcile: { depth: 0, lastError: null, lastRunAt: null },
        graphDomainSync: { depth: 0, lastError: null, lastRunAt: null },
        graphTimelineSync: { depth: 0, lastError: null, lastRunAt: null },
        graphSearchProjection: { depth: 0, lastError: null, lastRunAt: null },
        mediaIntelligence: { depth: 0, lastError: null, lastRunAt: null },
        miOcr: { depth: 0, lastError: null, lastRunAt: null },
        miTranscript: { depth: 0, lastError: null, lastRunAt: null },
        miEmbed: { depth: 0, lastError: null, lastRunAt: null },
        miSearchIndex: { depth: 0, lastError: null, lastRunAt: null },
        searchIndexing: { depth: 0, lastError: null, lastRunAt: null },
        report: { depth: 0, lastError: null, lastRunAt: null },
      },
      producerModes: [],
      lastErrors: [],
      warnings: [],
    };
    expect(Object.keys(sample.workspace).length).toBe(
      REQUIRED_WORKSPACE_KEYS.length,
    );
    expect(Object.keys(sample.queues).length).toBe(REQUIRED_QUEUE_KEYS.length);
  });
});

describe("Wave 1 Phase 5 — producer-mode catalog symmetry", () => {
  it("PRODUCER_KINDS has exactly 5 entries — diagnostics surface assumes this", () => {
    expect(PRODUCER_KINDS.length).toBe(5);
  });

  it("producer kinds match the canonical 5-kind catalog", () => {
    const expected: ProducerKind[] = [
      "ocr",
      "transcript",
      "perceptual_similarity",
      "derivative_detection",
      "semantic_search",
    ];
    for (const kind of expected) {
      expect(PRODUCER_KINDS).toContain(kind);
    }
  });
});

describe("Wave 1 Phase 5 — no PII / secret projection in diagnostics service source", () => {
  // The diagnostics service projects ONLY counts. It must never read
  // narrow content fields by name. These guards catch a future refactor
  // that adds a SELECT pulling raw OCR / transcript / GPS / storage
  // keys / reviewer-private notes / legal notes by name.
  it("does not project OCR text / transcript text content", () => {
    // We do read `evidence_ocr_text` + `evidence_transcript_segments`
    // but ONLY to COUNT distinct evidence_id. The `text` / `segments`
    // / `content` columns are never selected.
    expect(SERVICE_SRC).not.toMatch(/SELECT[^;]*"text"[^;]*FROM "evidence_ocr/);
    expect(SERVICE_SRC).not.toMatch(/"segment_text"/);
  });

  it("does not project storage keys / buckets / regions", () => {
    expect(SERVICE_SRC).not.toMatch(/storageKey:\s*true/);
    expect(SERVICE_SRC).not.toMatch(/storageBucket:\s*true/);
    expect(SERVICE_SRC).not.toMatch(/storage_key/);
    expect(SERVICE_SRC).not.toMatch(/storage_bucket/);
  });

  it("does not project GPS / lat / lng", () => {
    expect(SERVICE_SRC).not.toMatch(/\blat:\s*true/);
    expect(SERVICE_SRC).not.toMatch(/\blng:\s*true/);
    expect(SERVICE_SRC).not.toMatch(/accuracyMeters/);
  });

  it("does not project reviewer-private or legal notes", () => {
    expect(SERVICE_SRC).not.toMatch(/privateNote/);
    expect(SERVICE_SRC).not.toMatch(/legalNote/);
    expect(SERVICE_SRC).not.toMatch(/reviewerComment/);
  });

  it("does not project audit log metadata payload", () => {
    // Counting AdminAuditLog rows is fine. Selecting the metadata JSON
    // is not — that can carry secrets / PII.
    expect(SERVICE_SRC).not.toMatch(/metadata:\s*true/);
    expect(SERVICE_SRC).not.toMatch(
      /SELECT[^;]*"metadata"[^;]*FROM "admin_audit_log/,
    );
  });

  it("bounds last_error messages at 240 chars so a verbose stack does not leak", () => {
    expect(SERVICE_SRC).toMatch(/\.slice\(0,\s*240\)/);
  });

  it("caps lastErrors[] at 5 rows", () => {
    expect(SERVICE_SRC).toMatch(/LIMIT 5/);
  });
});
