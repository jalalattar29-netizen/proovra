/**
 * Phase 32.8C++++++ — Dashboard Frontend Consumption Completion.
 *
 * Source-contract tests proving the /home Command Center actually
 * renders the durable intelligence added by Phases 32.8C++++ +
 * 32.8C+++++:
 *
 *  PART 1  — frontend types.ts now declares the new contract shapes
 *  PART 2  — backend contract exposes TSA issuer fields in
 *            DeepIntegritySignal + the integrity-snapshot reader
 *  PART 3  — CommandCenter.tsx renders worker heartbeats
 *  PART 4  — CommandCenter.tsx renders queue snapshots
 *  PART 5  — CommandCenter.tsx renders the coordination backlog
 *  PART 6  — CommandCenter.tsx renders TSA issuer fields safely
 *  PART 7  — obsolete unsupportedSignals copy is removed
 *  PART 8  — no fake data / no legal overclaim / no signed URLs
 *  PART 9  — viewer (read-only) behavior preserved
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)), "utf8");
}
const COMMAND_CENTER_TSX = readWeb("components/command-center/CommandCenter.tsx");
const TYPES_TS = readWeb("components/command-center/types.ts");
const COMMAND_CENTER_API = readApi("src/services/dashboard/command-center.service.ts");
const INTEGRITY_SVC = readApi("src/services/dashboard/integrity-snapshot.service.ts");
// =============================================================================
// PART 1 — Frontend types
// =============================================================================
describe("Phase 32.8C++++++ — frontend types.ts contract", () => {
    it("declares QueueTelemetrySnapshotRow type", () => {
        expect(TYPES_TS).toMatch(/export type QueueTelemetrySnapshotRow\s*=/);
        expect(TYPES_TS).toMatch(/queueName:\s*string/);
        expect(TYPES_TS).toMatch(/queueDomain:\s*string/);
        expect(TYPES_TS).toMatch(/source:\s*string/);
    });
    it("declares WorkerTelemetryHeartbeat type", () => {
        expect(TYPES_TS).toMatch(/export type WorkerTelemetryHeartbeat\s*=/);
        expect(TYPES_TS).toMatch(/workerKind:\s*string/);
        expect(TYPES_TS).toMatch(/heartbeatAtUtc:\s*string/);
        expect(TYPES_TS).toMatch(/ageSeconds:\s*number/);
    });
    it("QueueWorkerTelemetryData declares queueSnapshots[] + workerHeartbeats[]", () => {
        expect(TYPES_TS).toMatch(/queueSnapshots:\s*QueueTelemetrySnapshotRow\[\]/);
        expect(TYPES_TS).toMatch(/workerHeartbeats:\s*WorkerTelemetryHeartbeat\[\]/);
    });
    it("CoordinationSignal declares new unresolved signal types", () => {
        for (const t of [
            "annotation_unresolved",
            "reviewer_comment_unresolved",
            "case_comment_unresolved",
        ]) {
            expect(TYPES_TS).toContain(`"${t}"`);
        }
    });
    it("CoordinationBacklog type is declared with bounded count fields", () => {
        expect(TYPES_TS).toMatch(/export type CoordinationBacklog\s*=/);
        expect(TYPES_TS).toMatch(/caseCommentOpenCount:\s*number/);
        expect(TYPES_TS).toMatch(/caseCommentStaleOpenCount:\s*number/);
        expect(TYPES_TS).toMatch(/reviewerCommentOpenCount:\s*number/);
        expect(TYPES_TS).toMatch(/annotationOpenCount:\s*number/);
    });
    it("coordinationSignals section type carries backlog", () => {
        expect(TYPES_TS).toMatch(/coordinationSignals:\s*\{[\s\S]*?backlog:\s*CoordinationBacklog/);
    });
    it("DeepIntegritySignal declares optional TsaTimestampIntelligence", () => {
        expect(TYPES_TS).toMatch(/export type TsaTimestampIntelligence\s*=/);
        expect(TYPES_TS).toMatch(/tsaTimestampIntelligence\?:\s*TsaTimestampIntelligence/);
        expect(TYPES_TS).toMatch(/issuerCommonName:\s*string \| null/);
        expect(TYPES_TS).toMatch(/parseStatus:\s*string \| null/);
    });
    it("CoordinationSignal.entityType includes 'case'", () => {
        expect(TYPES_TS).toMatch(/entityType:\s*"escalation" \| "evidence" \| "review_workflow" \| "case"/);
    });
});
// =============================================================================
// PART 2 — Backend contract exposes TSA issuer fields
// =============================================================================
describe("Phase 32.8C++++++ — backend contract exposes TSA issuer fields", () => {
    it("DeepIntegritySignal carries tsaTimestampIntelligence", () => {
        expect(COMMAND_CENTER_API).toMatch(/tsaTimestampIntelligence\?:\s*\{[\s\S]*?parseStatus:\s*string \| null/);
    });
    it("listWorkspaceIntegritySnapshots selects + returns TSA issuer columns", () => {
        expect(INTEGRITY_SVC).toMatch(/tsaIssuerCommonName:\s*true/);
        expect(INTEGRITY_SVC).toMatch(/tsaIssuerOrganization:\s*true/);
        expect(INTEGRITY_SVC).toMatch(/tsaPolicyOid:\s*true/);
        expect(INTEGRITY_SVC).toMatch(/tsaParseStatus:\s*true/);
        expect(INTEGRITY_SVC).toMatch(/tsaParseErrorCode:\s*true/);
        expect(INTEGRITY_SVC).toMatch(/tsaParsedAtUtc:\s*true/);
    });
    it("runDeepIntegrityWatch populates tsaTimestampIntelligence from snapshot rows", () => {
        expect(COMMAND_CENTER_API).toMatch(/tsaTimestampIntelligence:\s*\{[\s\S]*?parseStatus:\s*s\.tsaParseStatus/);
    });
});
// =============================================================================
// PART 3 — CommandCenter.tsx renders worker heartbeats
// =============================================================================
describe("Phase 32.8C++++++ — worker heartbeats UI", () => {
    it("renders the workerHeartbeats list with data-cc-worker-heartbeats hook", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-worker-heartbeats\b/);
    });
    it("renders workerKind + status + ageSeconds", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-worker-kind/);
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-worker-status/);
        expect(COMMAND_CENTER_TSX).toMatch(/h\.ageSeconds/);
    });
    it("flags stale heartbeats via data-cc-stale when ageSeconds > 300", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/WORKER_HEARTBEAT_STALE_SECONDS\s*=\s*300/);
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-stale=/);
        expect(COMMAND_CENTER_TSX).toMatch(/Heartbeat stale/);
    });
    it("does NOT render raw stack traces or lastErrorMessage longer than 400 chars (bounded by backend)", () => {
        // Backend bounds lastErrorMessage to 400 chars; the UI surfaces only
        // lastErrorCode and the bounded fields. Verify no raw stack-trace
        // rendering hook exists.
        expect(COMMAND_CENTER_TSX).not.toMatch(/lastErrorMessage[^A-Za-z]/);
        expect(COMMAND_CENTER_TSX).not.toMatch(/data-cc-worker-stack/);
    });
    it("renders status chips for CRITICAL/DEGRADED with severe styling", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/workerStatusSeverity/);
    });
});
// =============================================================================
// PART 4 — CommandCenter.tsx renders queue snapshots
// =============================================================================
describe("Phase 32.8C++++++ — queue snapshots UI", () => {
    it("renders the queue snapshots list with data-cc-queue-snapshots hook", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-queue-snapshots\b/);
    });
    it("renders queueName + queueDomain + source label", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-queue-name/);
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-queue-domain/);
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-queue-source/);
    });
    it("renders source labels honestly (BullMQ / DB_DERIVED)", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-queue-source-label/);
    });
    it("renders waiting/active/delayed/failed/stalled counts", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/q\.waitingCount/);
        expect(COMMAND_CENTER_TSX).toMatch(/q\.activeCount/);
        expect(COMMAND_CENTER_TSX).toMatch(/q\.delayedCount/);
        expect(COMMAND_CENTER_TSX).toMatch(/q\.failedCount/);
        expect(COMMAND_CENTER_TSX).toMatch(/q\.stalledCount/);
    });
    it("never renders raw job payloads, storage keys, or signed URLs", () => {
        expect(COMMAND_CENTER_TSX).not.toMatch(/jobPayload/i);
        expect(COMMAND_CENTER_TSX).not.toMatch(/storageKey/i);
        expect(COMMAND_CENTER_TSX).not.toMatch(/signedUrl/i);
    });
});
// =============================================================================
// PART 5 — CommandCenter.tsx renders the coordination backlog
// =============================================================================
describe("Phase 32.8C++++++ — coordination backlog UI", () => {
    it("renders the coordination backlog tile block", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-coordination-backlog\b/);
        expect(COMMAND_CENTER_TSX).toMatch(/CoordinationBacklogTiles/);
    });
    it("renders all five backlog counters", () => {
        for (const tile of [
            "case_comment_open",
            "case_comment_stale",
            "case_comment_resolved",
            "reviewer_comment_open",
            "annotation_open",
        ]) {
            expect(COMMAND_CENTER_TSX).toContain(`data-cc-backlog-tile="${tile}"`);
        }
    });
    it("backlog tiles light up when their count is > 0", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/backlog\.caseCommentOpenCount > 0[\s\S]*?"true"\s*:\s*"false"/);
    });
    it("backlog tiles are visible in BOTH empty-signals state and signal-present state", () => {
        // The component renders <CoordinationBacklogTiles> in both branches.
        const matches = COMMAND_CENTER_TSX.match(/<CoordinationBacklogTiles\s+backlog=/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });
    it("renders the new entity-type=case for unresolved case comments", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-coord-entity-type=/);
    });
});
// =============================================================================
// PART 6 — CommandCenter.tsx renders TSA issuer fields safely
// =============================================================================
describe("Phase 32.8C++++++ — TSA issuer rendering", () => {
    it("renders the TSA intel chip strip with data-cc-tsa-intel", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-tsa-intel\b/);
    });
    it("renders PARSED-state issuer common name + organization", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-tsa-issuer-cn/);
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-tsa-issuer-org/);
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-tsa-policy-oid/);
    });
    it("UNAVAILABLE state renders honest 'TSA issuer parsing not yet available'", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/TSA issuer parsing not yet available/);
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-tsa-unavailable/);
    });
    it("FAILED state renders only the bounded parseErrorCode (no raw exception text)", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/data-cc-tsa-failed/);
        expect(COMMAND_CENTER_TSX).toMatch(/TSA parse failed/);
    });
    it("NEVER fabricates issuer values — null falls back to '—'", () => {
        // The fallback char is the em-dash. Issuer fields render `?? "—"`.
        expect(COMMAND_CENTER_TSX).toMatch(/tsa!\.issuerCommonName \?\? "—"/);
        expect(COMMAND_CENTER_TSX).toMatch(/tsa!\.issuerOrganization \?\? "—"/);
    });
});
// =============================================================================
// PART 7 — Obsolete unsupportedSignals copy removed
// =============================================================================
describe("Phase 32.8C++++++ — obsolete UI copy removed", () => {
    it("does NOT render 'BullMQ infrastructure queue depth is not persisted'", () => {
        expect(COMMAND_CENTER_TSX).not.toMatch(/BullMQ infrastructure queue depth is not persisted/);
    });
    it("does NOT render 'no Case-level comment table' anywhere in UI", () => {
        expect(COMMAND_CENTER_TSX).not.toMatch(/no Case-level comment table/);
    });
    it("does NOT render 'singular caseId' as a frontend caveat", () => {
        expect(COMMAND_CENTER_TSX).not.toMatch(/singular caseId/);
    });
    it("Queue / Worker Telemetry section foot points at WorkerTelemetrySnapshot", () => {
        expect(COMMAND_CENTER_TSX).toMatch(/persisted\s+to\s+WorkerTelemetrySnapshot/);
    });
});
// =============================================================================
// PART 8 — No fake data / no legal overclaim / no secrets exposed
// =============================================================================
describe("Phase 32.8C++++++ — no fake data / no overclaim / no secret leak", () => {
    it("CommandCenter never renders signed URLs / storage keys / file bytes", () => {
        expect(COMMAND_CENTER_TSX).not.toMatch(/signedUrl/i);
        expect(COMMAND_CENTER_TSX).not.toMatch(/storageKey/i);
        expect(COMMAND_CENTER_TSX).not.toMatch(/canonicalBytes/);
        expect(COMMAND_CENTER_TSX).not.toMatch(/fileBytes/);
    });
    it("CommandCenter never uses legal-overclaim language (word-boundary)", () => {
        for (const banned of [
            "admissible",
            "court-ready",
            "proves authenticity",
            "proves integrity",
        ]) {
            expect(COMMAND_CENTER_TSX).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
        }
    });
    it("no fake hardcoded telemetry numbers (worker hearbeat counts etc.)", () => {
        // Search for literal numeric counts that would indicate fabricated
        // telemetry. We allow only stable thresholds (e.g., 300, 60_000) and
        // the bounded slice constants.
        const block = COMMAND_CENTER_TSX.match(/function QueueWorkerTelemetryBoard\([\s\S]*?function CoordinationBacklogTiles/);
        expect(block).not.toBeNull();
        // No tile renders a baked count like 42 / 1337 — every value is from props.
        expect(block[0]).not.toMatch(/ec-tile-value">\d{2,}/);
    });
    it("page-load handlers do not call mutation / generate endpoints", () => {
        // The dashboard remains read-only at page load.
        expect(COMMAND_CENTER_TSX).not.toMatch(/method:\s*"POST"/);
        expect(COMMAND_CENTER_TSX).not.toMatch(/generateReport/);
        expect(COMMAND_CENTER_TSX).not.toMatch(/generatePackage/);
        expect(COMMAND_CENTER_TSX).not.toMatch(/getSignedUrl/);
    });
});
// =============================================================================
// PART 9 — Viewer (read-only) behavior preserved
// =============================================================================
describe("Phase 32.8C++++++ — viewer read-only preserved", () => {
    it("none of the new sections include a write button without permission gating", () => {
        // New subsections are pure read-only. The existing routing queue
        // already gates actions via canCurrentUserAct; our changes are
        // additive UI only.
        const newBlock = COMMAND_CENTER_TSX.match(/function CoordinationBacklogTiles\([\s\S]*?return \([\s\S]*?\);\s*\}/);
        expect(newBlock).not.toBeNull();
        expect(newBlock[0]).not.toMatch(/onClick/);
        expect(newBlock[0]).not.toMatch(/onSubmit/);
    });
    it("worker heartbeat list is a pure read-only ul (no resolve/dismiss buttons)", () => {
        const block = COMMAND_CENTER_TSX.match(/data-cc-worker-heartbeats[\s\S]*?<\/ul>/);
        expect(block).not.toBeNull();
        expect(block[0]).not.toMatch(/<button/);
        expect(block[0]).not.toMatch(/onClick/);
    });
    it("queue snapshots list is a pure read-only ul", () => {
        const block = COMMAND_CENTER_TSX.match(/data-cc-queue-snapshots[\s\S]*?<\/ul>/);
        expect(block).not.toBeNull();
        expect(block[0]).not.toMatch(/<button/);
        expect(block[0]).not.toMatch(/onClick/);
    });
});
