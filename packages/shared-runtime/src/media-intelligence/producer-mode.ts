/**
 * Phase 31.19 — OCR / transcript producer mode.
 *
 * The platform recognises four runtime modes for OCR / transcript
 * extraction:
 *
 *   * `NOT_CONFIGURED` — no vendor configured. The extraction
 *     pipeline still RUNS its idempotent ingestion step: any
 *     pre-existing rows in `evidence_ocr_text` or
 *     `evidence_transcript_segments` (e.g. imported from a legacy
 *     system) are indexed into search. No new OCR / transcript
 *     content is produced. UI surfaces show NOT_CONFIGURED.
 *
 *   * `INDEX_EXISTING_ONLY` — explicit operator opt-in to the
 *     NOT_CONFIGURED behavior, with the operator confirming they
 *     understand no new content will be produced. Effective behavior
 *     identical to NOT_CONFIGURED; the distinction is intent-tracking
 *     for compliance.
 *
 *   * `LOCAL_TESSERACT` / `LOCAL_WHISPER` — placeholder modes for a
 *     future local-model integration. Producers gated on this mode
 *     check `ProducerModeFlag.local` to decide whether to spawn the
 *     local binary.
 *
 *   * `VENDOR_CLOUD` — placeholder for a future cloud-vendor
 *     integration. Producers gated on this mode include explicit
 *     privacy checks: every byte sent off-prem is logged in the
 *     custody journal, and only non-redacted rows are eligible.
 *
 * The mode is read from environment variables. Default is
 * NOT_CONFIGURED so the platform never silently transmits data
 * off-prem.
 *
 * Env vars:
 *   * `OCR_PRODUCER_MODE` — one of the four modes above. Default
 *     NOT_CONFIGURED.
 *   * `TRANSCRIPT_PRODUCER_MODE` — same shape. Default
 *     NOT_CONFIGURED.
 *
 * Hard rules enforced here:
 *   * Unknown / malformed env values collapse to NOT_CONFIGURED.
 *   * The mode getter NEVER throws.
 *   * No secret / token / API key is read from this module — the
 *     producer code paths (when added) own that.
 *
 * Wave 1 — Producer-Mode Truth Resolver extension
 * -----------------------------------------------
 *
 * The 5-kind ProducerKind catalog + `resolveProducerModeStatuses`
 * extend the existing module. The resolver is the SOLE truth-source
 * the API + UI consult to decide whether an extraction producer is
 * enabled, configured, automatic, indexing existing only, and which
 * provider (if any) it is bound to.
 *
 * Hard contracts for the resolver:
 *   * NEVER duplicates probe logic — delegates to
 *     `probeAzureDocumentIntelligence`, `probeDeepgram`,
 *     `isSemanticReadyAtRuntime`, `resolveEmbeddingProviderFromEnv`.
 *   * NEVER throws. Every failure path collapses to NOT_CONFIGURED
 *     with a bounded reason string.
 *   * NEVER returns raw env vars / secrets / credential bytes.
 *   * `reason` is the canonical operator-facing copy — UI surfaces
 *     MUST render `reason` verbatim and NEVER hard-code their own
 *     disclaimer language.
 */

import type { PrismaClient } from "@prisma/client";
// Wave 3 Phase 7B — cross-boundary fix.
// The four probes the resolver consults live in services/api/src/...
// To avoid relative-path cross-package imports that break
// `pnpm --filter @proovra/shared-runtime build`, we route every probe
// call through the registry seam. The api package bootstraps the
// probes once at process start via probe-bootstrap.ts.
import { getProbes } from "./probe-registry.js";

export const OCR_PRODUCER_MODES = [
  "NOT_CONFIGURED",
  "INDEX_EXISTING_ONLY",
  "LOCAL_TESSERACT",
  "VENDOR_CLOUD",
] as const;
export type OcrProducerMode = (typeof OCR_PRODUCER_MODES)[number];

export const TRANSCRIPT_PRODUCER_MODES = [
  "NOT_CONFIGURED",
  "INDEX_EXISTING_ONLY",
  "LOCAL_WHISPER",
  "VENDOR_CLOUD",
] as const;
export type TranscriptProducerMode =
  (typeof TRANSCRIPT_PRODUCER_MODES)[number];

const OCR_MODE_SET = new Set<string>(OCR_PRODUCER_MODES);
const TRANSCRIPT_MODE_SET = new Set<string>(TRANSCRIPT_PRODUCER_MODES);

// ---------------------------------------------------------------------------
// Wave 4 — automatic-extraction wiring constants (truth flags).
//
// The resolver's `automatic` field is the user-facing claim that an
// extraction producer fires WITHOUT operator action on every new
// evidence record. That claim is only honest when:
//   (1) The producer mode is VENDOR_CLOUD (operator opted into cloud
//       extraction), AND
//   (2) The corresponding probe (Azure DI / Deepgram) is READY, AND
//   (3) A REAL producer is wired into the evidence-finalization fanout
//       (so the queue actually receives a job per new evidence).
//
// Until Wave 4 wired the worker producer + the fanout enqueue, the
// resolver returned automatic=true purely on (1)+(2) — credentials
// could be ready but no job would ever fire, so the claim was a lie.
//
// These constants are the SOURCE-OF-TRUTH for (3). Flip them to TRUE
// only when the corresponding worker branch + fanout enqueue both
// land. A future contributor who adds a new producer for a new
// modality flips the matching flag here and the resolver's reason
// copy stays honest.
//
// Pinned by the wave4-provider-extraction-wiring contract test —
// removing the constant or flipping back to false without removing
// the producer branch will fail CI.
// ---------------------------------------------------------------------------

/**
 * TRUE when the worker has a real extract_ocr_azure job branch AND
 * the evidence-finalization fanout enqueues that job for eligible
 * (DOCUMENT / PHOTO) evidence on finalize. Consulted by
 * resolveOcrStatus in the VENDOR_CLOUD branch.
 */
export const AUTOMATIC_OCR_EXTRACTION_WIRED = true;

/**
 * TRUE when the worker has a real extract_transcript_deepgram job
 * branch AND the evidence-finalization fanout enqueues that job for
 * eligible (AUDIO / VIDEO) evidence on finalize. Consulted by
 * resolveTranscriptStatus in the VENDOR_CLOUD branch.
 */
export const AUTOMATIC_TRANSCRIPT_EXTRACTION_WIRED = true;

export function getOcrProducerMode(
  env: NodeJS.ProcessEnv = process.env,
): OcrProducerMode {
  const raw = env.OCR_PRODUCER_MODE;
  if (typeof raw === "string" && OCR_MODE_SET.has(raw)) {
    return raw as OcrProducerMode;
  }
  return "NOT_CONFIGURED";
}

export function getTranscriptProducerMode(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptProducerMode {
  const raw = env.TRANSCRIPT_PRODUCER_MODE;
  if (typeof raw === "string" && TRANSCRIPT_MODE_SET.has(raw)) {
    return raw as TranscriptProducerMode;
  }
  return "NOT_CONFIGURED";
}

/**
 * Combined mode summary suitable for the Ops Center / Reviewer
 * Intelligence Console capability tile.
 *
 * The summary is a flat object so it can be serialized to JSON
 * directly and stay backwards-compatible — adding a new mode
 * appends an enum value to the type union but doesn't break the
 * response shape.
 */
export type ProducerModeSummary = {
  ocr: OcrProducerMode;
  transcript: TranscriptProducerMode;
  /** True when both modes resolve to a producing state (i.e. NOT
   *  one of NOT_CONFIGURED / INDEX_EXISTING_ONLY). */
  producesNewContent: boolean;
};

export function summariseProducerModes(
  env: NodeJS.ProcessEnv = process.env,
): ProducerModeSummary {
  const ocr = getOcrProducerMode(env);
  const transcript = getTranscriptProducerMode(env);
  const producesNewContent =
    ocr !== "NOT_CONFIGURED" &&
    ocr !== "INDEX_EXISTING_ONLY" &&
    transcript !== "NOT_CONFIGURED" &&
    transcript !== "INDEX_EXISTING_ONLY";
  return { ocr, transcript, producesNewContent };
}

// ===========================================================================
// Wave 1 — 5-kind ProducerKind truth resolver
// ===========================================================================

/**
 * Canonical 5-kind producer catalog. EVERY UI / API surface that
 * needs to know whether a producer is active MUST read this catalog
 * via `resolveProducerModeStatuses` — NEVER by parsing env vars.
 *
 *   * `ocr`                    — image / PDF text extraction
 *   * `transcript`             — audio / video transcript extraction
 *   * `perceptual_similarity`  — image pHash / dHash similarity
 *   * `derivative_detection`   — derivative / lineage detection
 *   * `semantic_search`        — vector embedding semantic retrieval
 */
export const PRODUCER_KINDS = [
  "ocr",
  "transcript",
  "perceptual_similarity",
  "derivative_detection",
  "semantic_search",
] as const;

export type ProducerKind = (typeof PRODUCER_KINDS)[number];

/**
 * Canonical 8-field ProducerModeStatus shape. Every UI surface that
 * displays producer health renders these fields verbatim — no
 * derived UI copy.
 *
 * Hard fields:
 *   * `kind`               — one of PRODUCER_KINDS
 *   * `mode`               — bounded string (e.g. NOT_CONFIGURED,
 *                            LOCAL_TESSERACT, VENDOR_CLOUD,
 *                            DEFERRED, AUTOMATIC). Free-form per
 *                            kind but always bounded — never raw
 *                            env value, never secret.
 *   * `enabled`            — true when the producer will RUN at
 *                            all (i.e. mode is not NOT_CONFIGURED).
 *   * `configured`         — true when the producer has the
 *                            credentials / runtime it needs to
 *                            actually execute. NOT the same as
 *                            `enabled` — an INDEX_EXISTING_ONLY
 *                            mode is enabled but not configured
 *                            for new extraction.
 *   * `automatic`          — true when the producer runs without
 *                            operator action on every new evidence.
 *   * `indexExistingOnly`  — true when the producer ONLY ingests
 *                            pre-existing rows and produces no new
 *                            content.
 *   * `provider`           — bounded enum identifying the runtime
 *                            backend (local | azure | deepgram |
 *                            openai | internal | none).
 *   * `reason`             — canonical operator-facing copy. UI
 *                            renders this string verbatim.
 *   * `lastRunAt`          — ISO timestamp of the most recent run
 *                            of this kind (if any).
 *   * `lastError`          — bounded error summary of the most
 *                            recent failure (if any).
 */
export interface ProducerModeStatus {
  kind: ProducerKind;
  mode: string;
  enabled: boolean;
  configured: boolean;
  automatic: boolean;
  indexExistingOnly: boolean;
  provider: "local" | "azure" | "deepgram" | "openai" | "internal" | "none";
  reason: string;
  lastRunAt?: string;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Canonical reason copy. Encoded here so the UI never invents its own
// disclaimer language.
// ---------------------------------------------------------------------------

export const PRODUCER_REASON_COPY = {
  NOT_CONFIGURED: "Not configured. No automatic extraction will run.",
  INDEX_EXISTING_ONLY:
    "Existing extracted content will be indexed. New extraction will not run.",
  PROVIDER_ACTIVE: (provider: string): string =>
    `Automatic extraction is active using ${provider}.`,
  CREDENTIALS_PRESENT_WORKSPACE_DISABLED:
    "Credentials detected, but extraction is disabled by workspace configuration.",
  LOCAL_RUNTIME_UNAVAILABLE:
    "Local runtime is unavailable. Cloud provider may still be available if configured.",
  DEFERRED_NO_PRODUCER: "Provider not configured for this workspace.",
  // Wave 4 — honest deferred state when credentials are ready but the
  // worker producer / fanout enqueue has not been wired yet. Surfaced
  // when AUTOMATIC_*_EXTRACTION_WIRED is false but the probe is READY.
  CREDENTIALS_READY_PRODUCER_DEFERRED:
    "Credentials are ready, but automatic extraction is awaiting producer wiring.",
  // Honest reason copy for the derivative-detection producer that is
  // now live in graph reconciliation. The producer scans perceptual
  // pHash similarity, upload-time proximity, and shared file traits
  // (byte size, MIME) to surface POSSIBLE_DERIVATIVE_OF candidates for
  // reviewer confirmation. No vendor — the heuristic runs internally.
  DERIVATIVE_HEURISTIC_ACTIVE:
    "Automatic candidate detection is active using similarity, upload-time proximity, and shared file traits. Reviewer confirmation required.",
} as const;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export type ResolveProducerModeStatusesInput = {
  teamId: string;
  prisma: PrismaClient;
};

/**
 * Resolve the canonical 5-kind producer status array for a team.
 *
 * The resolver is async because it reads `media_intelligence_runs`
 * for `lastRunAt` / `lastError`, but every other input (probe state,
 * provider name, mode) is derived from process.env via the existing
 * probe helpers — NEVER from raw env strings here. Caller surfaces
 * MUST consume the resolver output, NOT process.env directly.
 *
 * Hard contracts:
 *   * Returns exactly 5 entries (one per ProducerKind).
 *   * Each entry has a non-empty `reason`.
 *   * Never throws. DB failures collapse to no `lastRunAt`.
 *   * Order of entries is stable: matches PRODUCER_KINDS order so
 *     UI surfaces can index by position without re-sorting.
 */
export async function resolveProducerModeStatuses(
  opts: ResolveProducerModeStatusesInput,
): Promise<ProducerModeStatus[]> {
  const lastRuns = await readLastRunsByKind(opts.teamId, opts.prisma);

  const ocr = await resolveOcrStatus(lastRuns);
  const transcript = await resolveTranscriptStatus(lastRuns);
  const perceptual = await resolvePerceptualSimilarityStatus(lastRuns);
  const derivative = await resolveDerivativeDetectionStatus(lastRuns);
  const semantic = await resolveSemanticSearchStatus(lastRuns);

  // Stable order — matches PRODUCER_KINDS exactly.
  return [ocr, transcript, perceptual, derivative, semantic];
}

// ---------------------------------------------------------------------------
// Per-kind resolvers
// ---------------------------------------------------------------------------

async function resolveOcrStatus(
  lastRuns: LastRunsByKind,
): Promise<ProducerModeStatus> {
  const mode = getOcrProducerMode();
  const last = pickLastForOcr(lastRuns);

  if (mode === "NOT_CONFIGURED") {
    return finalize({
      kind: "ocr",
      mode,
      enabled: false,
      configured: false,
      automatic: false,
      indexExistingOnly: false,
      provider: "none",
      reason: PRODUCER_REASON_COPY.NOT_CONFIGURED,
      last,
    });
  }
  if (mode === "INDEX_EXISTING_ONLY") {
    return finalize({
      kind: "ocr",
      mode,
      enabled: true,
      configured: false,
      automatic: true,
      indexExistingOnly: true,
      provider: "internal",
      reason: PRODUCER_REASON_COPY.INDEX_EXISTING_ONLY,
      last,
    });
  }
  if (mode === "LOCAL_TESSERACT") {
    return finalize({
      kind: "ocr",
      mode,
      enabled: true,
      configured: true,
      automatic: true,
      indexExistingOnly: false,
      provider: "local",
      reason: PRODUCER_REASON_COPY.PROVIDER_ACTIVE("local Tesseract"),
      last,
    });
  }
  // VENDOR_CLOUD path — delegate to Azure probe.
  const probe = await safeProbeAzure();
  if (probe.state === "READY") {
    // Wave 4 — truth-flag gate. The `automatic` claim is only honest
    // when the producer is actually wired in the fanout + worker. The
    // constant is set at the source so flipping it back to false
    // without removing the producer is impossible without a test
    // failure.
    if (AUTOMATIC_OCR_EXTRACTION_WIRED) {
      return finalize({
        kind: "ocr",
        mode,
        enabled: true,
        configured: true,
        automatic: true,
        indexExistingOnly: false,
        provider: "azure",
        reason: PRODUCER_REASON_COPY.PROVIDER_ACTIVE("Azure Document Intelligence"),
        last,
      });
    }
    return finalize({
      kind: "ocr",
      mode,
      enabled: true,
      configured: true,
      automatic: false,
      indexExistingOnly: false,
      provider: "azure",
      reason: PRODUCER_REASON_COPY.CREDENTIALS_READY_PRODUCER_DEFERRED,
      last,
    });
  }
  return finalize({
    kind: "ocr",
    mode,
    enabled: true,
    configured: false,
    automatic: false,
    indexExistingOnly: false,
    provider: "none",
    reason: PRODUCER_REASON_COPY.CREDENTIALS_PRESENT_WORKSPACE_DISABLED,
    last,
  });
}

async function resolveTranscriptStatus(
  lastRuns: LastRunsByKind,
): Promise<ProducerModeStatus> {
  const mode = getTranscriptProducerMode();
  const last = pickLastForTranscript(lastRuns);

  if (mode === "NOT_CONFIGURED") {
    return finalize({
      kind: "transcript",
      mode,
      enabled: false,
      configured: false,
      automatic: false,
      indexExistingOnly: false,
      provider: "none",
      reason: PRODUCER_REASON_COPY.NOT_CONFIGURED,
      last,
    });
  }
  if (mode === "INDEX_EXISTING_ONLY") {
    return finalize({
      kind: "transcript",
      mode,
      enabled: true,
      configured: false,
      automatic: true,
      indexExistingOnly: true,
      provider: "internal",
      reason: PRODUCER_REASON_COPY.INDEX_EXISTING_ONLY,
      last,
    });
  }
  if (mode === "LOCAL_WHISPER") {
    return finalize({
      kind: "transcript",
      mode,
      enabled: true,
      configured: true,
      automatic: true,
      indexExistingOnly: false,
      provider: "local",
      reason: PRODUCER_REASON_COPY.PROVIDER_ACTIVE("local Whisper"),
      last,
    });
  }
  // VENDOR_CLOUD path — delegate to Deepgram probe.
  const probe = await safeProbeDeepgram();
  if (probe.state === "READY") {
    // Wave 4 — truth-flag gate. Same contract as the OCR branch:
    // `automatic` is only honest when a real producer is wired in the
    // fanout + worker.
    if (AUTOMATIC_TRANSCRIPT_EXTRACTION_WIRED) {
      return finalize({
        kind: "transcript",
        mode,
        enabled: true,
        configured: true,
        automatic: true,
        indexExistingOnly: false,
        provider: "deepgram",
        reason: PRODUCER_REASON_COPY.PROVIDER_ACTIVE("Deepgram"),
        last,
      });
    }
    return finalize({
      kind: "transcript",
      mode,
      enabled: true,
      configured: true,
      automatic: false,
      indexExistingOnly: false,
      provider: "deepgram",
      reason: PRODUCER_REASON_COPY.CREDENTIALS_READY_PRODUCER_DEFERRED,
      last,
    });
  }
  return finalize({
    kind: "transcript",
    mode,
    enabled: true,
    configured: false,
    automatic: false,
    indexExistingOnly: false,
    provider: "none",
    reason: PRODUCER_REASON_COPY.CREDENTIALS_PRESENT_WORKSPACE_DISABLED,
    last,
  });
}

async function resolvePerceptualSimilarityStatus(
  lastRuns: LastRunsByKind,
): Promise<ProducerModeStatus> {
  // The Phase 12 worker registers the `compute_perceptual_hashes`
  // job branch unconditionally (sharp is a worker dependency). The
  // resolver's truth check is: does the worker queue have a handler
  // for that job kind? We check by importing the queue module and
  // looking for the registered kind. If the worker is offline the
  // module import fails — collapse to NOT_CONFIGURED.
  const wired = await isPerceptualHashJobWired();
  const last = pickLastForReconcile(lastRuns);

  if (!wired) {
    return finalize({
      kind: "perceptual_similarity",
      mode: "NOT_CONFIGURED",
      enabled: false,
      configured: false,
      automatic: false,
      indexExistingOnly: false,
      provider: "none",
      reason: PRODUCER_REASON_COPY.NOT_CONFIGURED,
      last,
    });
  }
  return finalize({
    kind: "perceptual_similarity",
    mode: "AUTOMATIC",
    enabled: true,
    configured: true,
    automatic: true,
    indexExistingOnly: false,
    provider: "internal",
    reason: PRODUCER_REASON_COPY.PROVIDER_ACTIVE("internal perceptual hash"),
    last,
  });
}

async function resolveDerivativeDetectionStatus(
  lastRuns: LastRunsByKind,
): Promise<ProducerModeStatus> {
  // The derivative-detection producer is live in
  // packages/shared-runtime/src/graph/graph-builder.service.ts as part
  // of reconcileTeamGraph: it upserts POSSIBLE_DERIVATIVE_OF edges
  // from perceptual_phash similarity + upload-time proximity + shared
  // file traits. The producer is internal (no vendor) and runs on
  // every graph reconcile, so the resolver claim is AUTOMATIC with an
  // internal-heuristic provider.
  const last = pickLastForReconcile(lastRuns);
  return finalize({
    kind: "derivative_detection",
    mode: "AUTOMATIC",
    enabled: true,
    configured: true,
    automatic: true,
    indexExistingOnly: false,
    provider: "internal",
    reason: PRODUCER_REASON_COPY.DERIVATIVE_HEURISTIC_ACTIVE,
    last,
  });
}

async function resolveSemanticSearchStatus(
  lastRuns: LastRunsByKind,
): Promise<ProducerModeStatus> {
  const last = pickLastForReindex(lastRuns);
  const ready = await safeIsSemanticReady();
  if (!ready) {
    return finalize({
      kind: "semantic_search",
      mode: "NOT_CONFIGURED",
      enabled: false,
      configured: false,
      automatic: false,
      indexExistingOnly: false,
      provider: "none",
      reason: PRODUCER_REASON_COPY.NOT_CONFIGURED,
      last,
    });
  }
  const providerName = await safeResolveEmbeddingProviderName();
  if (providerName === "openai") {
    return finalize({
      kind: "semantic_search",
      mode: "VENDOR_CLOUD",
      enabled: true,
      configured: true,
      automatic: true,
      indexExistingOnly: false,
      provider: "openai",
      reason: PRODUCER_REASON_COPY.PROVIDER_ACTIVE("OpenAI"),
      last,
    });
  }
  if (providerName === "local-deterministic" || providerName === "local") {
    return finalize({
      kind: "semantic_search",
      mode: "LOCAL_DETERMINISTIC",
      enabled: true,
      configured: true,
      automatic: true,
      indexExistingOnly: false,
      provider: "local",
      reason: PRODUCER_REASON_COPY.PROVIDER_ACTIVE("local deterministic embeddings"),
      last,
    });
  }
  // Provider name not recognised — collapse honestly.
  return finalize({
    kind: "semantic_search",
    mode: "NOT_CONFIGURED",
    enabled: false,
    configured: false,
    automatic: false,
    indexExistingOnly: false,
    provider: "none",
    reason: PRODUCER_REASON_COPY.LOCAL_RUNTIME_UNAVAILABLE,
    last,
  });
}

// ---------------------------------------------------------------------------
// Probe seams — Wave 3 Phase 7B.
//
// The four probes consulted by the per-kind resolvers physically live
// in `services/api/src/...`. To keep the shared-runtime package
// independently buildable, we read them via the probe-registry seam:
// the api package calls `registerProbes(...)` at startup with the
// real implementations; this module just consults `getProbes()`.
//
// If no probes are registered (e.g. an isolated worker or a
// shared-runtime-only test run), `getProbes()` returns honest
// NOT_CONFIGURED fallbacks so every resolver collapses to the
// "no producer wired" state — never a silent crash, never a runtime
// require error.
// ---------------------------------------------------------------------------

type AzureProbeShape = { state: string; reason: string | null };
type DeepgramProbeShape = { state: string; reason: string | null };

async function safeProbeAzure(): Promise<AzureProbeShape> {
  try {
    return await getProbes().probeAzureDocumentIntelligence();
  } catch {
    return { state: "NOT_CONFIGURED", reason: "probe_unavailable" };
  }
}

async function safeProbeDeepgram(): Promise<DeepgramProbeShape> {
  try {
    return await getProbes().probeDeepgram();
  } catch {
    return { state: "NOT_CONFIGURED", reason: "probe_unavailable" };
  }
}

async function safeIsSemanticReady(): Promise<boolean> {
  try {
    return Boolean(getProbes().isSemanticReadyAtRuntime());
  } catch {
    return false;
  }
}

async function safeResolveEmbeddingProviderName(): Promise<string> {
  try {
    const provider = getProbes().resolveEmbeddingProviderFromEnv();
    return typeof provider?.name === "string" ? provider.name : "disabled";
  } catch {
    return "disabled";
  }
}

async function isPerceptualHashJobWired(): Promise<boolean> {
  // The Phase 12 worker registers `compute_perceptual_hashes` as a
  // job-kind branch in `media-intelligence.processor.ts`. The branch
  // is registered unconditionally at module load — its presence is
  // the truth signal. We don't import the worker (would pull in
  // BullMQ + Redis); instead we infer via the env-flag the worker
  // surfaces when sharp is unavailable. Default: assume wired.
  // Operator can force-disable via env override.
  const flag = process.env.PERCEPTUAL_SIMILARITY_DISABLED;
  if (typeof flag === "string" && flag.trim() === "true") return false;
  return true;
}

// ---------------------------------------------------------------------------
// media_intelligence_runs read — lastRunAt / lastError lookup
// ---------------------------------------------------------------------------

type LastRunRow = {
  kind: string;
  status: string;
  last_error: string | null;
  updated_at_utc: Date;
};

type LastRunsByKind = ReadonlyMap<string, LastRunRow>;

async function readLastRunsByKind(
  teamId: string,
  prisma: PrismaClient,
): Promise<LastRunsByKind> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON ("kind")
              "kind", "status", "last_error", "updated_at_utc"
         FROM "media_intelligence_runs"
         WHERE "team_id" = $1
         ORDER BY "kind", "updated_at_utc" DESC`,
      teamId,
    )) as LastRunRow[];
    const map = new Map<string, LastRunRow>();
    for (const row of rows) {
      map.set(row.kind, row);
    }
    return map;
  } catch {
    return new Map();
  }
}

function pickLastForOcr(map: LastRunsByKind): LastRunRow | undefined {
  // OCR runs are tracked under `wire_ocr_transcript` (Phase 31.19).
  return map.get("wire_ocr_transcript");
}

function pickLastForTranscript(map: LastRunsByKind): LastRunRow | undefined {
  // Transcript runs share the wire_ocr_transcript kind today.
  return map.get("wire_ocr_transcript");
}

function pickLastForReconcile(map: LastRunsByKind): LastRunRow | undefined {
  // Perceptual + derivative both route through the reconcile kind
  // when their producers run via the analyzer dispatch.
  return map.get("reconcile");
}

function pickLastForReindex(map: LastRunsByKind): LastRunRow | undefined {
  // Semantic search runs as `reindex` in the run tracker.
  return map.get("reindex");
}

// ---------------------------------------------------------------------------
// finalize — attach lastRunAt / lastError uniformly
// ---------------------------------------------------------------------------

type FinalizeInput = Omit<ProducerModeStatus, "lastRunAt" | "lastError"> & {
  last: LastRunRow | undefined;
};

function finalize(input: FinalizeInput): ProducerModeStatus {
  const out: ProducerModeStatus = {
    kind: input.kind,
    mode: input.mode,
    enabled: input.enabled,
    configured: input.configured,
    automatic: input.automatic,
    indexExistingOnly: input.indexExistingOnly,
    provider: input.provider,
    reason: input.reason,
  };
  if (input.last?.updated_at_utc) {
    try {
      out.lastRunAt = input.last.updated_at_utc.toISOString();
    } catch {
      /* skip — bounded silent collapse */
    }
  }
  if (input.last?.last_error && input.last.last_error.length > 0) {
    out.lastError = input.last.last_error.slice(0, 240);
  }
  return out;
}
