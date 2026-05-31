/**
 * Phase 3B — Enterprise Intelligence Platform contract + runtime test.
 *
 * Pins the bounded surface introduced by Phase 3B:
 *
 *   1. Shared contracts — modalities / record kinds / providers /
 *      confidence bands / record states / correction kinds + states
 *      / adapter operations / cost vocabulary / budget vocabulary /
 *      audit categories / executive metrics shape / activity codes /
 *      manifest entry shapes.
 *   2. Prisma additions + Phase O-Final compliant migration.
 *   3. Provider adapter abstraction + adapters for Azure / Deepgram /
 *      Rekognition / OpenAI.
 *   4. Media intelligence + corrections services.
 *   5. Cost controls (usage + budgets + gate).
 *   6. Executive metrics + audit transparency aggregators.
 *   7. Verification-package manifest writers.
 *   8. HTTP routes (records / corrections / cost / executive /
 *      audit transparency / provider health / run).
 *   9. UI surfaces — executive dashboard, audit & transparency
 *      centre, intelligence platform landing.
 *  10. Runtime helpers — confidence classifier, adapter probes,
 *      provider adapter registry.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUDIT_TRANSPARENCY_CATEGORIES,
  EXECUTIVE_METRICS_LIMITATIONS,
  EXECUTIVE_METRICS_SCHEMA_VERSION,
  INTELLIGENCE_CONFIDENCE_BANDS,
  INTELLIGENCE_PROVENANCE_LIMITATIONS,
  MEDIA_INTELLIGENCE_ACTIVITY_CODES,
  MEDIA_INTELLIGENCE_MODALITIES,
  MEDIA_INTELLIGENCE_PROVIDERS,
  MEDIA_INTELLIGENCE_RECORD_KINDS,
  MEDIA_INTELLIGENCE_RECORD_STATES,
  PROVIDER_ADAPTER_OPERATIONS,
  PROVIDER_ADAPTER_STATES,
  PROVIDER_BUDGET_DECISIONS,
  PROVIDER_BUDGET_PERIODS,
  PROVIDER_BUDGET_SCOPES,
  PROVIDER_COST_UNITS,
  REVIEWER_CORRECTION_KINDS,
  REVIEWER_CORRECTION_STATES,
  classifyIntelligenceConfidence,
} from "@proovra/shared";

// Side-effect adapter imports — registers each on the bounded registry.
import "../src/services/intelligence/providers/azure-document-intelligence-adapter.js";
import "../src/services/intelligence/providers/deepgram-adapter.js";
import "../src/services/intelligence/providers/rekognition-adapter.js";
import "../src/services/intelligence/providers/openai-adapter.js";

import {
  getAdapter,
  listAdapterProbes,
  listAdapters,
} from "../src/services/intelligence/providers/provider-adapter.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SHARED = readSource(
  "../../../packages/shared/src/media-intelligence-platform.ts",
);
const SHARED_INDEX = readSource("../../../packages/shared/src/index.ts");
const SCHEMA = readSource("../../../services/api/prisma/schema.prisma");
const MIGRATION = readSource(
  "../../../services/api/prisma/migrations/20261215000000_phase_3b_intelligence_platform/migration.sql",
);

const ADAPTER_IFACE = readSource(
  "../../../services/api/src/services/intelligence/providers/provider-adapter.ts",
);
const ADAPTER_AZURE = readSource(
  "../../../services/api/src/services/intelligence/providers/azure-document-intelligence-adapter.ts",
);
const ADAPTER_DEEPGRAM = readSource(
  "../../../services/api/src/services/intelligence/providers/deepgram-adapter.ts",
);
const ADAPTER_REK = readSource(
  "../../../services/api/src/services/intelligence/providers/rekognition-adapter.ts",
);
const ADAPTER_OPENAI = readSource(
  "../../../services/api/src/services/intelligence/providers/openai-adapter.ts",
);

const SVC_MEDIA = readSource(
  "../../../services/api/src/services/intelligence/media-intelligence.service.ts",
);
const SVC_CORR = readSource(
  "../../../services/api/src/services/intelligence/reviewer-correction.service.ts",
);
const SVC_USAGE = readSource(
  "../../../services/api/src/services/intelligence/provider-usage.service.ts",
);
const SVC_BUDGET = readSource(
  "../../../services/api/src/services/intelligence/provider-budget.service.ts",
);
const SVC_EXEC = readSource(
  "../../../services/api/src/services/intelligence/executive-metrics.service.ts",
);
const SVC_AUDIT = readSource(
  "../../../services/api/src/services/intelligence/audit-transparency.service.ts",
);
const SVC_MANIFEST = readSource(
  "../../../services/api/src/services/intelligence/intelligence-verification-manifest.service.ts",
);
const ROUTES = readSource(
  "../../../services/api/src/routes/intelligence-platform.routes.ts",
);
const SERVER = readSource("../../../services/api/src/server.ts");
const NAV = readSource(
  "../../../services/api/src/services/platform-context/navigation-registry.ts",
);
const REPORT_SECTION = readSource(
  "../../../services/worker/src/report-v2/sections/intelligence-summary.ts",
);

const UI_EXEC = readSource(
  "../../../apps/web/app/(app)/executive/page.tsx",
);
const UI_AUDIT = readSource(
  "../../../apps/web/app/(app)/audit-transparency/page.tsx",
);
const UI_PLATFORM = readSource(
  "../../../apps/web/app/(app)/intelligence-platform/page.tsx",
);

// ===========================================================================
// 1. Shared contracts
// ===========================================================================

describe("Phase 3B — shared contracts", () => {
  it("modality catalog covers IMAGE / DOCUMENT / PDF / AUDIO / VIDEO", () => {
    for (const m of ["IMAGE", "DOCUMENT", "PDF", "AUDIO", "VIDEO"]) {
      expect(MEDIA_INTELLIGENCE_MODALITIES).toContain(m);
    }
  });

  it("record kinds cover OCR / transcript / image / entity / video", () => {
    for (const k of [
      "DOCUMENT_OCR_TEXT",
      "DOCUMENT_LAYOUT",
      "TRANSCRIPT_SEGMENT",
      "SPEAKER_SEGMENT",
      "IMAGE_FACE",
      "IMAGE_TEXT_BLOCK",
      "IMAGE_OBJECT_LABEL",
      "ENTITY",
      "VIDEO_FRAME_LABEL",
    ]) {
      expect(MEDIA_INTELLIGENCE_RECORD_KINDS).toContain(k);
    }
  });

  it("provider catalog binds Azure / Deepgram / Rekognition / OpenAI", () => {
    for (const p of [
      "AZURE_DOCUMENT_INTELLIGENCE",
      "AWS_REKOGNITION_FACES",
      "AWS_REKOGNITION_TEXT",
      "AWS_REKOGNITION_LABELS",
      "DEEPGRAM_TRANSCRIPT",
      "OPENAI_ENTITY_EXTRACTION",
      "OPENAI_DOCUMENT_SUMMARY",
      "MANUAL_OPERATOR",
    ]) {
      expect(MEDIA_INTELLIGENCE_PROVIDERS).toContain(p);
    }
  });

  it("confidence bands collapse to four labels", () => {
    expect([...INTELLIGENCE_CONFIDENCE_BANDS]).toEqual([
      "LOW",
      "MEDIUM",
      "HIGH",
      "VERY_HIGH",
    ]);
  });

  it("record state machine is bounded to 6 states", () => {
    expect([...MEDIA_INTELLIGENCE_RECORD_STATES].sort()).toEqual(
      [
        "ACCEPTED",
        "CORRECTED",
        "INGESTED",
        "IN_REVIEW",
        "REJECTED",
        "SUPERSEDED",
      ].sort(),
    );
  });

  it("correction kinds + states are bounded", () => {
    for (const k of [
      "OCR_TEXT",
      "OCR_REGION",
      "TRANSCRIPT_TEXT",
      "TRANSCRIPT_TIMING",
      "SPEAKER_LABEL",
      "SPEAKER_DIARIZATION_MERGE",
      "SPEAKER_DIARIZATION_SPLIT",
      "ENTITY_TYPE",
      "ENTITY_VALUE",
      "LAYOUT_BLOCK",
      "VIDEO_LABEL",
    ]) {
      expect(REVIEWER_CORRECTION_KINDS).toContain(k);
    }
    expect([...REVIEWER_CORRECTION_STATES].sort()).toEqual(
      ["ACCEPTED", "DRAFT", "REVERTED"].sort(),
    );
  });

  it("adapter operation / state / cost / budget catalogs are bounded", () => {
    for (const o of [
      "OCR_DOCUMENT",
      "OCR_IMAGE",
      "TRANSCRIBE_AUDIO",
      "TRANSCRIBE_VIDEO_AUDIO_TRACK",
      "DETECT_FACES",
      "DETECT_OBJECTS",
      "DETECT_TEXT_IN_IMAGE",
      "EXTRACT_ENTITIES",
      "SUMMARISE_DOCUMENT",
    ]) {
      expect(PROVIDER_ADAPTER_OPERATIONS).toContain(o);
    }
    for (const s of [
      "READY",
      "NOT_CONFIGURED",
      "DISABLED_BY_POLICY",
      "RATE_LIMITED",
      "BUDGET_EXCEEDED",
      "ERROR",
    ]) {
      expect(PROVIDER_ADAPTER_STATES).toContain(s);
    }
    expect([...PROVIDER_COST_UNITS].sort()).toEqual(
      ["CALL", "IMAGE", "MEGABYTE", "MINUTE", "PAGE", "TOKEN"].sort(),
    );
    expect([...PROVIDER_BUDGET_PERIODS].sort()).toEqual(
      ["ANNUAL", "DAILY", "MONTHLY", "QUARTERLY", "WEEKLY"].sort(),
    );
    expect([...PROVIDER_BUDGET_SCOPES].sort()).toEqual(
      ["CASE", "PROJECT", "PROVIDER", "TEAM", "WORKSPACE"].sort(),
    );
    expect([...PROVIDER_BUDGET_DECISIONS]).toEqual([
      "ALLOW",
      "WARN",
      "BLOCK",
    ]);
  });

  it("audit transparency category catalog is bounded", () => {
    for (const c of [
      "DATA_PROCESSING",
      "DETECTION",
      "REVIEW",
      "APPROVAL",
      "REDACTION",
      "VERIFICATION",
      "AI_PROVIDER",
      "PROVIDER_USAGE",
      "CORRECTION",
      "POLICY",
      "EXPORT",
      "ACCESS",
    ]) {
      expect(AUDIT_TRANSPARENCY_CATEGORIES).toContain(c);
    }
  });

  it("executive metrics schema version pin matches V1 + bounded limitations", () => {
    expect(EXECUTIVE_METRICS_SCHEMA_VERSION).toBe(
      "PROOVRA_EXECUTIVE_METRICS_V1",
    );
    for (const l of [
      "EXECUTIVE_METRICS_ARE_AGGREGATE_ONLY",
      "EXECUTIVE_METRICS_DO_NOT_EXPOSE_PII",
      "EXECUTIVE_METRICS_LAG_BY_UP_TO_5_MIN",
    ]) {
      expect(EXECUTIVE_METRICS_LIMITATIONS).toContain(l);
    }
  });

  it("activity codes cover record / correction / provider / budget lifecycles", () => {
    for (const code of [
      "RECORD_INGESTED",
      "RECORD_ACCEPTED",
      "RECORD_REJECTED",
      "RECORD_SUPERSEDED",
      "CORRECTION_CREATED",
      "CORRECTION_ACCEPTED",
      "CORRECTION_REVERTED",
      "PROVIDER_CALL_STARTED",
      "PROVIDER_CALL_COMPLETED",
      "PROVIDER_CALL_FAILED",
      "PROVIDER_CALL_REFUSED_BUDGET",
      "PROVIDER_CALL_REFUSED_POLICY",
      "BUDGET_CREATED",
      "BUDGET_UPDATED",
      "BUDGET_SOFT_LIMIT_HIT",
      "BUDGET_HARD_LIMIT_HIT",
    ]) {
      expect(MEDIA_INTELLIGENCE_ACTIVITY_CODES).toContain(code);
    }
  });

  it("standing limitations include AI-judgement honesty", () => {
    for (const l of [
      "AI_OUTPUT_IS_NEVER_GROUND_TRUTH",
      "REVIEWER_CORRECTIONS_ARE_HUMAN_JUDGEMENT",
      "FINAL_CONFIDENCE_NEVER_OVERRIDES_HUMAN_DECISION",
    ]) {
      expect(INTELLIGENCE_PROVENANCE_LIMITATIONS).toContain(l);
    }
  });

  it("shared/index re-exports Phase 3B symbols", () => {
    expect(SHARED_INDEX).toMatch(/MEDIA_INTELLIGENCE_PROVIDERS/);
    expect(SHARED_INDEX).toMatch(/PROVIDER_ADAPTER_OPERATIONS/);
    expect(SHARED_INDEX).toMatch(/EXECUTIVE_METRICS_SCHEMA_VERSION/);
    expect(SHARED_INDEX).toMatch(/AUDIT_TRANSPARENCY_CATEGORIES/);
    expect(SHARED_INDEX).toMatch(/MediaIntelligenceRecordProjection/);
    expect(SHARED_INDEX).toMatch(/ExecutiveMetricsProjection/);
    expect(SHARED_INDEX).toMatch(/ProviderBudgetGateResult/);
  });

  it("shared file ships the bounded manifest entry shapes", () => {
    expect(SHARED).toMatch(/DocumentIntelligenceManifestEntry/);
    expect(SHARED).toMatch(/TranscriptIntelligenceManifestEntry/);
    expect(SHARED).toMatch(/ProviderManifestEntry/);
    expect(SHARED).toMatch(/ConfidenceManifestEntry/);
    expect(SHARED).toMatch(/CorrectionHistoryManifestEntry/);
  });
});

// ===========================================================================
// 2. Prisma + migration
// ===========================================================================

describe("Phase 3B — Prisma + migration", () => {
  it("declares the six new Phase 3B models", () => {
    for (const m of [
      "model MediaIntelligenceRecord",
      "model MediaIntelligenceEntity",
      "model ReviewerCorrection",
      "model ProviderUsageEvent",
      "model ProviderBudget",
      "model ProviderBudgetAlert",
    ]) {
      expect(SCHEMA).toMatch(new RegExp(m));
    }
  });

  it("record table is uniquely keyed per (team, evidence, provider, providerRecordKey)", () => {
    expect(SCHEMA).toMatch(
      /@@unique\(\[teamId, evidenceId, provider, providerRecordKey\]\)/,
    );
  });

  it("corrections cascade off records; entities cascade off records", () => {
    expect(SCHEMA).toMatch(
      /record\s+MediaIntelligenceRecord\s+@relation\([^)]+onDelete: Cascade\)/,
    );
  });

  it("Phase O-Final compliant migration", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE "media_intelligence_records"/);
    expect(MIGRATION).not.toMatch(
      /CREATE TABLE IF NOT EXISTS "media_intelligence_records"/,
    );
    expect(MIGRATION).toMatch(/information_schema\.columns/);
    expect(MIGRATION).toMatch(
      /REFERENCES "media_intelligence_records"[\s\S]+CASCADE/,
    );
  });
});

// ===========================================================================
// 3. Provider adapter abstraction + adapters
// ===========================================================================

describe("Phase 3B — provider adapter abstraction", () => {
  it("adapter interface exposes probe + bounded operation methods", () => {
    expect(ADAPTER_IFACE).toMatch(/export type ProviderAdapter/);
    expect(ADAPTER_IFACE).toMatch(/registerAdapter/);
    expect(ADAPTER_IFACE).toMatch(/listAdapters/);
    expect(ADAPTER_IFACE).toMatch(/listAdapterProbes/);
    expect(ADAPTER_IFACE).toMatch(/IntelligenceProviderResult/);
    expect(ADAPTER_IFACE).toMatch(/IntelligenceProviderUsage/);
  });

  it("Azure adapter wraps the redaction client + bills pages", () => {
    expect(ADAPTER_AZURE).toMatch(/azureDocumentIntelligenceAdapter/);
    expect(ADAPTER_AZURE).toMatch(/registerAdapter/);
    expect(ADAPTER_AZURE).toMatch(/COST_PER_PAGE_USD_MICROS/);
    expect(ADAPTER_AZURE).toMatch(/analyzeDocumentLayout/);
  });

  it("Deepgram adapter wraps the redaction client + bills minutes", () => {
    expect(ADAPTER_DEEPGRAM).toMatch(/deepgramAdapter/);
    expect(ADAPTER_DEEPGRAM).toMatch(/registerAdapter/);
    expect(ADAPTER_DEEPGRAM).toMatch(/COST_PER_MINUTE_USD_MICROS/);
    expect(ADAPTER_DEEPGRAM).toMatch(/transcribeAndScan/);
    // Builds SPEAKER_SEGMENT rows in addition to TRANSCRIPT_SEGMENT.
    expect(ADAPTER_DEEPGRAM).toMatch(/"TRANSCRIPT_SEGMENT"/);
    expect(ADAPTER_DEEPGRAM).toMatch(/"SPEAKER_SEGMENT"/);
  });

  it("Rekognition adapter binds faces / text / labels", () => {
    expect(ADAPTER_REK).toMatch(/rekognitionFacesAdapter/);
    expect(ADAPTER_REK).toMatch(/rekognitionTextAdapter/);
    expect(ADAPTER_REK).toMatch(/rekognitionLabelsAdapter/);
    expect(ADAPTER_REK).toMatch(/IMAGE_FACE/);
    expect(ADAPTER_REK).toMatch(/IMAGE_TEXT_BLOCK/);
    expect(ADAPTER_REK).toMatch(/IMAGE_OBJECT_LABEL/);
  });

  it("OpenAI adapter binds entity extraction + summary; bounded REGEX_PII fallback", () => {
    expect(ADAPTER_OPENAI).toMatch(/openaiEntityExtractionAdapter/);
    expect(ADAPTER_OPENAI).toMatch(/openaiDocumentSummaryAdapter/);
    expect(ADAPTER_OPENAI).toMatch(/regexPiiDetectorRun/);
    expect(ADAPTER_OPENAI).toMatch(/probeOpenAI/);
  });

  it("registry produces at least 7 bounded adapters after side-effect imports", () => {
    const probes = listAdapterProbes();
    expect(probes.length).toBeGreaterThanOrEqual(7);
    for (const probe of probes) {
      expect(MEDIA_INTELLIGENCE_PROVIDERS).toContain(probe.provider);
      expect(PROVIDER_ADAPTER_STATES).toContain(probe.state);
    }
    const all = listAdapters();
    expect(all.length).toBe(probes.length);
    const azure = getAdapter("AZURE_DOCUMENT_INTELLIGENCE");
    expect(azure).not.toBeNull();
    expect(azure?.supportedOperations).toContain("OCR_DOCUMENT");
    const deepgram = getAdapter("DEEPGRAM_TRANSCRIPT");
    expect(deepgram?.supportedOperations).toContain("TRANSCRIBE_AUDIO");
  });
});

// ===========================================================================
// 4. Services — media intelligence + corrections
// ===========================================================================

describe("Phase 3B — media intelligence + corrections services", () => {
  it("media intelligence service exposes ingest + run + projection", () => {
    for (const fn of [
      "export async function ingestProviderResult",
      "export async function runProviderOperation",
      "export async function listRecordsForEvidence",
      "export async function getRecordWithCorrections",
    ]) {
      expect(SVC_MEDIA).toMatch(new RegExp(fn));
    }
  });

  it("media intelligence dedups via providerRecordKey upsert", () => {
    expect(SVC_MEDIA).toMatch(/upsert/);
    expect(SVC_MEDIA).toMatch(/teamId_evidenceId_provider_providerRecordKey/);
  });

  it("media intelligence refuses BLOCK + records bounded refusal", () => {
    expect(SVC_MEDIA).toMatch(/decision === "BLOCK"/);
    expect(SVC_MEDIA).toMatch(/decision: "BLOCK"/);
  });

  it("reviewer correction service is append-only + bumps record state", () => {
    expect(SVC_CORR).toMatch(/state: "CORRECTED"/);
    expect(SVC_CORR).toMatch(/state: "DRAFT"/);
    expect(SVC_CORR).toMatch(/state: "ACCEPTED"/);
    expect(SVC_CORR).toMatch(/state: "REVERTED"/);
    expect(SVC_CORR).toMatch(/finalConfidenceBand: finalBand/);
  });
});

// ===========================================================================
// 5. Cost controls
// ===========================================================================

describe("Phase 3B — cost controls", () => {
  it("usage service records bounded usage events", () => {
    expect(SVC_USAGE).toMatch(/export async function recordProviderUsage/);
    expect(SVC_USAGE).toMatch(/PROVIDER_BUDGET_DECISIONS/);
    expect(SVC_USAGE).toMatch(/PROVIDER_COST_UNITS/);
  });

  it("budget service computes soft / hard limits + writes bounded alerts", () => {
    expect(SVC_BUDGET).toMatch(/export async function createBudget/);
    expect(SVC_BUDGET).toMatch(/export async function decideBudgetGate/);
    expect(SVC_BUDGET).toMatch(/threshold: "HARD"/);
    expect(SVC_BUDGET).toMatch(/threshold: "SOFT"/);
    expect(SVC_BUDGET).toMatch(/"BLOCK"/);
    expect(SVC_BUDGET).toMatch(/periodStart/);
  });
});

// ===========================================================================
// 6. Executive + Audit aggregators
// ===========================================================================

describe("Phase 3B — executive + audit aggregators", () => {
  it("executive metrics service aggregates cross-domain counts", () => {
    expect(SVC_EXEC).toMatch(/export async function projectExecutiveMetrics/);
    expect(SVC_EXEC).toMatch(/EXECUTIVE_METRICS_SCHEMA_VERSION/);
    expect(SVC_EXEC).toMatch(/byMimeFamily/);
    // bounded SLA / capture / verification / AI / review sections
    for (const k of ["capture:", "review:", "evidence:", "verification:", "ai:", "sla:"]) {
      expect(SVC_EXEC).toMatch(new RegExp(k));
    }
  });

  it("audit transparency aggregator federates 6 activity sources", () => {
    expect(SVC_AUDIT).toMatch(/providerUsageEvent\.findMany/);
    expect(SVC_AUDIT).toMatch(/reviewerCorrection\.findMany/);
    expect(SVC_AUDIT).toMatch(/redactionActivity\.findMany/);
    expect(SVC_AUDIT).toMatch(/redactionPolicyAudit\.findMany/);
    expect(SVC_AUDIT).toMatch(/videoTimelineEvent\.findMany/);
    expect(SVC_AUDIT).toMatch(/externalReviewActivity\.findMany/);
  });
});

// ===========================================================================
// 7. Verification manifest writers
// ===========================================================================

describe("Phase 3B — verification manifest writers", () => {
  it("ships document + transcript + provider + confidence + correction writers", () => {
    for (const fn of [
      "buildDocumentIntelligenceManifestEntry",
      "buildTranscriptIntelligenceManifestEntry",
      "buildProviderManifestEntries",
      "buildConfidenceManifestEntry",
      "buildCorrectionHistoryManifestEntry",
    ]) {
      expect(SVC_MANIFEST).toMatch(new RegExp(`export async function ${fn}`));
    }
  });

  it("manifests never include raw payloads", () => {
    expect(SVC_MANIFEST).not.toMatch(/payload:\s*r\.payload/);
  });
});

// ===========================================================================
// 8. HTTP routes
// ===========================================================================

describe("Phase 3B — HTTP routes", () => {
  it("mounts the full Phase 3B surface", () => {
    for (const path of [
      "/v1/intelligence/evidence/:evidenceId/records",
      "/v1/intelligence/records/:id",
      "/v1/intelligence/evidence/:evidenceId/run/bytes",
      "/v1/intelligence/evidence/:evidenceId/run/text",
      "/v1/intelligence/corrections",
      "/v1/intelligence/corrections/:id/accept",
      "/v1/intelligence/corrections/:id/revert",
      "/v1/intelligence/records/:id/corrections",
      "/v1/intelligence/evidence/:evidenceId/corrections",
      "/v1/intelligence/providers/usage",
      "/v1/intelligence/providers/budgets",
      "/v1/intelligence/providers/health",
      "/v1/executive/metrics",
      "/v1/audit-transparency",
    ]) {
      expect(ROUTES).toMatch(new RegExp(path.replace(/\//g, "\\/")));
    }
  });

  it("server.ts registers intelligencePlatformRoutes", () => {
    expect(SERVER).toMatch(/import \{ intelligencePlatformRoutes \}/);
    expect(SERVER).toMatch(/app\.register\(intelligencePlatformRoutes\)/);
  });
});

// ===========================================================================
// 9. UI surfaces + nav
// ===========================================================================

describe("Phase 3B — UI + nav", () => {
  it("executive dashboard renders the 6 bounded sections", () => {
    expect(UI_EXEC).toMatch(/data-executive-dashboard/);
    for (const s of [
      "data-executive-capture",
      "data-executive-review",
      "data-executive-evidence",
      "data-executive-verification",
      "data-executive-ai",
      "data-executive-sla",
    ]) {
      expect(UI_EXEC).toMatch(new RegExp(s));
    }
  });

  it("audit & transparency center renders bounded filter + federated table", () => {
    expect(UI_AUDIT).toMatch(/data-audit-transparency-center/);
    expect(UI_AUDIT).toMatch(/data-audit-transparency-table/);
    expect(UI_AUDIT).toMatch(/data-audit-transparency-category/);
    expect(UI_AUDIT).toMatch(/data-audit-transparency-row/);
  });

  it("intelligence platform landing renders provider health + cost summary + quick run", () => {
    expect(UI_PLATFORM).toMatch(/data-intelligence-platform-page/);
    expect(UI_PLATFORM).toMatch(/data-intelligence-provider-health/);
    expect(UI_PLATFORM).toMatch(/data-intelligence-cost-summary/);
    expect(UI_PLATFORM).toMatch(/data-intelligence-budgets/);
    expect(UI_PLATFORM).toMatch(/data-intelligence-run-submit/);
  });

  it("navigation registry binds the 3 new Phase 3B nav entries", () => {
    expect(NAV).toMatch(/id:\s*"workspace\.intelligence_platform"/);
    expect(NAV).toMatch(/id:\s*"workspace\.executive"/);
    expect(NAV).toMatch(/id:\s*"workspace\.audit_transparency"/);
  });

  it("report builder ships an intelligence-summary section module", () => {
    expect(REPORT_SECTION).toMatch(/renderIntelligenceSummarySection/);
    expect(REPORT_SECTION).toMatch(/AI-assisted intelligence/);
    expect(REPORT_SECTION).toMatch(/NEVER raw OCR/i);
  });
});

// ===========================================================================
// 10. Runtime helpers
// ===========================================================================

describe("Phase 3B — runtime helpers", () => {
  it("classifyIntelligenceConfidence collapses to bounded bands", () => {
    expect(classifyIntelligenceConfidence(0.96)).toBe("VERY_HIGH");
    expect(classifyIntelligenceConfidence(0.85)).toBe("HIGH");
    expect(classifyIntelligenceConfidence(0.6)).toBe("MEDIUM");
    expect(classifyIntelligenceConfidence(0.4)).toBe("LOW");
    expect(classifyIntelligenceConfidence(0)).toBe("LOW");
  });

  it("adapter registry surfaces probes for every registered provider", () => {
    const probes = listAdapterProbes();
    const providers = new Set(probes.map((p) => p.provider));
    for (const expected of [
      "AZURE_DOCUMENT_INTELLIGENCE",
      "DEEPGRAM_TRANSCRIPT",
      "AWS_REKOGNITION_FACES",
      "AWS_REKOGNITION_TEXT",
      "AWS_REKOGNITION_LABELS",
      "OPENAI_ENTITY_EXTRACTION",
      "OPENAI_DOCUMENT_SUMMARY",
    ]) {
      expect(providers.has(expected as never)).toBe(true);
    }
  });
});
