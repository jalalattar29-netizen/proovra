/**
 * PROOVRA Phase 3A — Redaction detection orchestrator.
 *
 * Runs the bounded detection providers against a version's source
 * artifact and stores the suggestions. Reviewer decisions live in
 * `redaction-decision.service.ts`; this file is intentionally pure
 * orchestration + suggestion persistence.
 *
 * Hard rules:
 *   * Every detection is a SUGGESTION. The decisionState defaults
 *     to SUGGESTED and only a human action promotes it.
 *   * Provider failures (not_configured, rate_limited, error) emit
 *     a bounded DETECTION_RUN_FAILED event — they NEVER swallow
 *     silently.
 *   * The REGEX_PII + MANUAL providers run in-process; the
 *     AWS_REKOGNITION / AZURE_DOCUMENT_INTELLIGENCE / OCR /
 *     DEEPGRAM providers are bounded stubs that honestly report
 *     `not_configured` until the corresponding worker capability
 *     lights up.
 */

import type { PrismaClient } from "@prisma/client";
import {
  REDACTION_DETECTION_PROVIDERS,
  classifyConfidence,
  type BboxNormalized,
  type RedactionConfidenceBand,
  type RedactionDecisionState,
  type RedactionDenialReason,
  type RedactionDetectionKind,
  type RedactionDetectionProvider,
  type RedactionDetectionProviderState,
  type RedactionMethod,
  type RedactionProviderProbe,
  type RedactionRegionKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitRedactionActivity } from "./redaction-activity.service.js";
import {
  regexPiiDetectorRun,
  type ProviderRunContext,
  type ProviderDetectionRow,
} from "./redaction-detection-providers.service.js";
import { fetchEvidenceBytes } from "./evidence-bytes.service.js";

// Phase 3A Closure — real SDK provider runners.
import {
  detectFaces as rekognitionDetectFaces,
  detectLabels as rekognitionDetectLabels,
  detectText as rekognitionDetectText,
} from "./providers/rekognition-client.js";
import { analyzeDocumentLayout as azureAnalyzeDocumentLayout } from "./providers/azure-document-intelligence-client.js";
import { transcribeAndScan as deepgramTranscribeAndScan } from "./providers/deepgram-client.js";
import { isPolicyAllowed } from "./redaction-policy.service.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RunDetectionInput = {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
  providers: ReadonlyArray<RedactionDetectionProvider>;
  actorUserId: string;
  /**
   * Bounded text the operator wants scanned. When provided, the
   * REGEX_PII provider scans it. Other providers ignore it.
   * Keeping it explicit avoids accidentally scanning the wrong
   * bytes.
   */
  inlineText?: string;
  /**
   * Phase 3A Closure — operator-supplied bytes (for tests + future
   * client-side pre-redaction). When ANY of these is set the
   * orchestrator skips the S3 fetch entirely. Otherwise the
   * orchestrator pulls bytes via `fetchEvidenceBytes` and hands
   * the right slot to each provider.
   */
  imageBytes?: Uint8Array;
  documentBytes?: Uint8Array;
  audioBytes?: Uint8Array;
};

export type RunDetectionResult =
  | {
      ok: true;
      detectionCount: number;
      providerStates: ReadonlyArray<RedactionProviderProbe>;
    }
  | { ok: false; denial: RedactionDenialReason };

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

type ProviderRunFn = (
  ctx: ProviderRunContext,
) => Promise<{
  state: RedactionDetectionProviderState;
  reason: string | null;
  rows: ReadonlyArray<ProviderDetectionRow>;
  /**
   * Phase 3A Closure — optional bounded extracted text the
   * orchestrator can re-run through REGEX_PII without re-fetching
   * the document. Currently produced by AZURE_DOCUMENT_INTELLIGENCE.
   */
  extractedText?: string | null;
}>;

// Phase 3A Closure — real SDK-backed providers. Each runner accepts
// the bounded ProviderRunContext and delegates to the matching SDK
// wrapper. Operators provide bytes via the `imageBytes`,
// `documentBytes`, or `audioBytes` slots (the orchestrator fetches
// from S3 when only an evidence id is supplied — see `runRedactionDetection`).
const PROVIDER_REGISTRY: Readonly<Record<RedactionDetectionProvider, ProviderRunFn>> =
  {
    REGEX_PII: regexPiiDetectorRun,
    MANUAL: async () => ({
      state: "READY",
      reason: null,
      rows: [],
    }),
    POLICY_RULE: async () => ({
      // The policy-rule scanner ships in Phase 3B together with the
      // workspace governance policy editor. Until then it honestly
      // reports DISABLED_BY_POLICY so the operator sees the gap.
      state: "DISABLED_BY_POLICY",
      reason: "policy_rule_provider_ships_in_phase_3b",
      rows: [],
    }),
    AWS_REKOGNITION_FACES: async (ctx) => {
      const res = await rekognitionDetectFaces({
        imageBytes: ctx.imageBytes ?? null,
        s3Object: ctx.s3Object ?? null,
      });
      return { state: res.state, reason: res.reason, rows: res.rows };
    },
    AWS_REKOGNITION_TEXT: async (ctx) => {
      const res = await rekognitionDetectText({
        imageBytes: ctx.imageBytes ?? null,
        s3Object: ctx.s3Object ?? null,
      });
      return { state: res.state, reason: res.reason, rows: res.rows };
    },
    AZURE_DOCUMENT_INTELLIGENCE: async (ctx) => {
      const res = await azureAnalyzeDocumentLayout({
        documentBytes: ctx.documentBytes ?? null,
      });
      return {
        state: res.state,
        reason: res.reason,
        rows: res.rows,
        extractedText: res.extractedText,
      };
    },
    OCR_TEXT_LAYER: async () => ({
      // Local OCR remains INDEX_EXISTING_ONLY in this build. The
      // bound Azure provider above is the canonical document-OCR
      // path; this slot is preserved for future on-premise OCR.
      state: "NOT_CONFIGURED",
      reason: "local OCR capability is INDEX_EXISTING_ONLY in this build",
      rows: [],
    }),
    DEEPGRAM_TRANSCRIPT: async (ctx) => {
      const res = await deepgramTranscribeAndScan({
        audioBytes: ctx.audioBytes ?? null,
      });
      return { state: res.state, reason: res.reason, rows: res.rows };
    },
    CUSTOM_PROVIDER: async () => ({
      state: "DISABLED_BY_POLICY",
      reason: "custom_provider_requires_administrator_binding",
      rows: [],
    }),
  };

// Maps each provider to a bounded "artifact kind" filter — runs are
// silently skipped (with a bounded NOT_CONFIGURED probe) when the
// version's artifact doesn't make sense for the provider (e.g. running
// Rekognition against an audio file).
const PROVIDER_ARTIFACT_GATE: Readonly<
  Record<RedactionDetectionProvider, ReadonlyArray<string>>
> = {
  REGEX_PII: ["IMAGE", "PDF", "VIDEO", "AUDIO"],
  MANUAL: ["IMAGE", "PDF", "VIDEO", "AUDIO"],
  POLICY_RULE: ["IMAGE", "PDF", "VIDEO", "AUDIO"],
  AWS_REKOGNITION_FACES: ["IMAGE", "VIDEO"],
  AWS_REKOGNITION_TEXT: ["IMAGE", "VIDEO"],
  AZURE_DOCUMENT_INTELLIGENCE: ["PDF", "IMAGE"],
  OCR_TEXT_LAYER: ["PDF", "IMAGE"],
  DEEPGRAM_TRANSCRIPT: ["AUDIO", "VIDEO"],
  CUSTOM_PROVIDER: ["IMAGE", "PDF", "VIDEO", "AUDIO"],
};

// Helper used by tests + the orchestrator to override the registry
// (for example to inject SDK fakes). Bounded to additive entries; the
// registry remains the source of truth otherwise.
const PROVIDER_OVERRIDES: Map<RedactionDetectionProvider, ProviderRunFn> =
  new Map();

export function __setProviderRunnerForTests(
  provider: RedactionDetectionProvider,
  runner: ProviderRunFn | null,
): void {
  if (runner) PROVIDER_OVERRIDES.set(provider, runner);
  else PROVIDER_OVERRIDES.delete(provider);
}

function resolveProvider(p: RedactionDetectionProvider): ProviderRunFn {
  return PROVIDER_OVERRIDES.get(p) ?? PROVIDER_REGISTRY[p];
}

// Detect _additionally_-detectable text producers. When Azure runs
// on a PDF / image we feed its extracted text into REGEX_PII without
// re-uploading anything.
const SECONDARY_INLINE_TEXT_FROM: ReadonlyArray<RedactionDetectionProvider> = [
  "AZURE_DOCUMENT_INTELLIGENCE",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runRedactionDetection(
  input: RunDetectionInput,
): Promise<RunDetectionResult> {
  const prisma = input.prisma ?? defaultPrisma;
  for (const p of input.providers) {
    if (!(REDACTION_DETECTION_PROVIDERS as ReadonlyArray<string>).includes(p)) {
      return { ok: false, denial: "PROVIDER_NOT_CONFIGURED" };
    }
  }
  const version = await prisma.redactionVersion.findFirst({
    where: { id: input.versionId, teamId: input.teamId },
    select: {
      id: true,
      state: true,
      projectId: true,
      project: { select: { artifactKind: true, evidenceId: true } },
    },
  });
  if (!version) return { ok: false, denial: "VERSION_NOT_FOUND" };
  if (version.state !== "DRAFT") {
    return { ok: false, denial: "VERSION_LOCKED" };
  }

  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: version.projectId,
    versionId: input.versionId,
    code: "DETECTION_RUN_STARTED",
    actorUserId: input.actorUserId,
    payload: { providers: input.providers },
  });

  // Phase 3A Closure — load the bounded provider bytes ONCE per run.
  // Each provider only sees the slot it needs (imageBytes /
  // documentBytes / audioBytes); the others stay null. When the
  // operator provided inline bytes directly we use those instead.
  const ctxBytes = await loadProviderBytes(
    prisma,
    input.teamId,
    version.project.evidenceId,
    version.project.artifactKind as never,
    input,
  );

  // Phase 3A Closure — workspace-scoped policy gate. Each provider
  // run is bounded by the policy AND the artifact-kind gate.
  const policyAllowed = await isPolicyAllowed({
    prisma,
    teamId: input.teamId,
    providers: input.providers,
  });

  const probes: RedactionProviderProbe[] = [];
  let inserted = 0;

  // Inline text that we will hand to REGEX_PII. Operator-supplied
  // text wins; otherwise we accumulate text producers (Azure layout)
  // and re-run REGEX_PII against the combined corpus.
  let aggregatedInlineText = input.inlineText ?? "";

  for (const provider of input.providers) {
    if (!policyAllowed.has(provider)) {
      probes.push({
        provider,
        state: "DISABLED_BY_POLICY",
        reason: "workspace_policy_disabled_provider",
      });
      await emitRedactionActivity({
        prisma,
        teamId: input.teamId,
        projectId: version.projectId,
        versionId: input.versionId,
        code: "DETECTION_RUN_FAILED",
        actorUserId: input.actorUserId,
        payload: { provider, state: "DISABLED_BY_POLICY" },
      });
      continue;
    }
    if (
      !PROVIDER_ARTIFACT_GATE[provider].includes(
        version.project.artifactKind as string,
      )
    ) {
      probes.push({
        provider,
        state: "DISABLED_BY_POLICY",
        reason: "provider_does_not_apply_to_artifact_kind",
      });
      continue;
    }
    const runner = resolveProvider(provider);
    let probe: RedactionProviderProbe = {
      provider,
      state: "READY",
      reason: null,
    };
    try {
      const out = await runner({
        teamId: input.teamId,
        evidenceId: version.project.evidenceId,
        artifactKind: version.project.artifactKind as never,
        inlineText:
          provider === "REGEX_PII"
            ? aggregatedInlineText || null
            : input.inlineText ?? null,
        imageBytes: ctxBytes.imageBytes,
        documentBytes: ctxBytes.documentBytes,
        audioBytes: ctxBytes.audioBytes,
        s3Object: ctxBytes.s3Object,
      });
      probe = { provider, state: out.state, reason: out.reason };
      probes.push(probe);
      // Accumulate extracted text from upstream producers (Azure)
      // so the REGEX_PII pass that follows them can scan the same
      // bytes without paying a second round trip.
      if (
        SECONDARY_INLINE_TEXT_FROM.includes(provider) &&
        typeof out.extractedText === "string" &&
        out.extractedText.trim().length > 0
      ) {
        aggregatedInlineText =
          (aggregatedInlineText ? aggregatedInlineText + "\n" : "") +
          out.extractedText;
      }
      if (out.state === "READY" && out.rows.length > 0) {
        for (const row of out.rows) {
          await prisma.redactionDetection.create({
            data: {
              teamId: input.teamId,
              versionId: input.versionId,
              kind: row.kind,
              provider,
              confidenceBand: row.confidenceBand,
              rawConfidence: row.rawConfidence,
              suggestedRegionKind: row.suggestedRegionKind,
              suggestedRegionGeometry: row.suggestedRegionGeometry as never,
              suggestedMethod: row.suggestedMethod,
              previewLabel: row.previewLabel?.slice(0, 80) ?? null,
              decisionState: "SUGGESTED",
            },
          });
          inserted++;
        }
        await emitRedactionActivity({
          prisma,
          teamId: input.teamId,
          projectId: version.projectId,
          versionId: input.versionId,
          code: "DETECTION_GENERATED",
          actorUserId: input.actorUserId,
          payload: {
            provider,
            count: out.rows.length,
          },
        });
      } else if (out.state !== "READY") {
        await emitRedactionActivity({
          prisma,
          teamId: input.teamId,
          projectId: version.projectId,
          versionId: input.versionId,
          code: "DETECTION_RUN_FAILED",
          actorUserId: input.actorUserId,
          payload: { provider, state: out.state, reason: out.reason },
        });
      }
    } catch (err) {
      probes.push({
        provider,
        state: "ERROR",
        reason:
          err instanceof Error
            ? err.message.slice(0, 200)
            : "provider_threw",
      });
      await emitRedactionActivity({
        prisma,
        teamId: input.teamId,
        projectId: version.projectId,
        versionId: input.versionId,
        code: "DETECTION_RUN_FAILED",
        actorUserId: input.actorUserId,
        payload: { provider, state: "ERROR" },
      });
    }
  }

  await emitRedactionActivity({
    prisma,
    teamId: input.teamId,
    projectId: version.projectId,
    versionId: input.versionId,
    code: "DETECTION_RUN_COMPLETED",
    actorUserId: input.actorUserId,
    payload: {
      providers: probes.map((p) => ({ p: p.provider, s: p.state })),
      inserted,
    },
  });

  return { ok: true, detectionCount: inserted, providerStates: probes };
}

export async function listRedactionDetectionsForVersion(input: {
  prisma?: PrismaClient;
  teamId: string;
  versionId: string;
  decisionState?: RedactionDecisionState;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  return prisma.redactionDetection.findMany({
    where: {
      teamId: input.teamId,
      versionId: input.versionId,
      ...(input.decisionState
        ? { decisionState: input.decisionState }
        : {}),
    },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Phase 3A Closure — bounded byte loader
//
// The orchestrator fetches the evidence bytes ONCE per run and hands
// the right slot to each provider. Operator-supplied bytes win when
// present (e.g. for tests / in-browser pre-redaction); otherwise we
// pull from S3 via the bounded evidence-bytes helper.
// ---------------------------------------------------------------------------

type ProviderBytes = {
  imageBytes: Uint8Array | null;
  documentBytes: Uint8Array | null;
  audioBytes: Uint8Array | null;
  s3Object: { bucket: string; key: string } | null;
};

async function loadProviderBytes(
  prisma: PrismaClient,
  teamId: string,
  evidenceId: string,
  artifactKind: "IMAGE" | "PDF" | "VIDEO" | "AUDIO",
  input: RunDetectionInput,
): Promise<ProviderBytes> {
  // Operator-supplied bytes win.
  if (input.imageBytes || input.documentBytes || input.audioBytes) {
    return {
      imageBytes: input.imageBytes ?? null,
      documentBytes: input.documentBytes ?? null,
      audioBytes: input.audioBytes ?? null,
      s3Object: null,
    };
  }
  // Only fetch when one of the bound providers will need bytes.
  const needsBytes = input.providers.some((p) =>
    [
      "AWS_REKOGNITION_FACES",
      "AWS_REKOGNITION_TEXT",
      "AZURE_DOCUMENT_INTELLIGENCE",
      "DEEPGRAM_TRANSCRIPT",
    ].includes(p),
  );
  if (!needsBytes) {
    return {
      imageBytes: null,
      documentBytes: null,
      audioBytes: null,
      s3Object: null,
    };
  }
  const fetched = await fetchEvidenceBytes({ prisma, teamId, evidenceId });
  if (!fetched.ok) {
    return {
      imageBytes: null,
      documentBytes: null,
      audioBytes: null,
      s3Object: null,
    };
  }
  const out: ProviderBytes = {
    imageBytes: null,
    documentBytes: null,
    audioBytes: null,
    s3Object: { bucket: fetched.storageBucket, key: fetched.storageKey },
  };
  if (artifactKind === "IMAGE" || artifactKind === "VIDEO") {
    out.imageBytes = fetched.bytes;
  }
  if (artifactKind === "PDF" || artifactKind === "IMAGE") {
    out.documentBytes = fetched.bytes;
  }
  if (artifactKind === "AUDIO" || artifactKind === "VIDEO") {
    out.audioBytes = fetched.bytes;
  }
  return out;
}

// Re-exports used by the runtime tests to validate the orchestrator
// without hand-rolling a fixture provider.
export { classifyConfidence };
export type {
  BboxNormalized,
  RedactionConfidenceBand,
  RedactionDetectionKind,
  RedactionMethod,
  RedactionRegionKind,
};
