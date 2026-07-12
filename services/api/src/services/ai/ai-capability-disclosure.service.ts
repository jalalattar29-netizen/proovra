/**
 * Phase A1 (remainder) — Runtime-derived AI capability disclosure.
 *
 * Produces the per-capability disclosure the Trust Center / AI Disclosure
 * page renders, computed from ACTUAL runtime state — never inferred from key
 * presence alone. Every capability resolves to one of the bounded statuses and
 * carries the required disclosure fields (provider, purpose, data category,
 * raw-vs-derived, default state, workspace opt-in, global state, workspace
 * policy state, operational status, region, transfer, training/retention mode,
 * last verified). A stub is NEVER presented as live.
 */
import {
  isOpenAiAdvisoryConfigured,
  isPlatformAiGloballyEnabled,
  resolveWorkspaceAiPolicy,
  type ResolvedWorkspaceAiPolicy,
} from "./workspace-ai-policy.service.js";
// Side-effect: register the media-intelligence provider adapters so their
// real probe state is available for disclosure.
import "../intelligence/providers/azure-document-intelligence-adapter.js";
import "../intelligence/providers/deepgram-adapter.js";
import "../intelligence/providers/rekognition-adapter.js";
import "../intelligence/providers/openai-adapter.js";
import { listAdapterProbes } from "../intelligence/providers/provider-adapter.js";

export type AiCapabilityStatus =
  | "AVAILABLE"
  | "CONFIGURED"
  | "ENABLED_FOR_THIS_WORKSPACE"
  | "DISABLED_BY_WORKSPACE_POLICY"
  | "DISABLED_BY_PLATFORM_CONFIGURATION"
  | "NOT_CONFIGURED"
  | "PREVIEW"
  | "PLANNED"
  | "STUB_NOT_OPERATIONAL"
  | "RETIRED";

export type AiDataCategory = "METADATA_ONLY" | "DERIVED_TEXT" | "RAW_BYTES" | "NONE";

export type AiCapabilityDisclosure = {
  capability: string;
  provider: string;
  purpose: string;
  dataCategory: AiDataCategory;
  rawContent: boolean;
  defaultState: "ON" | "OFF";
  workspaceOptInRequired: boolean;
  globalConfigured: boolean;
  workspacePolicyState: "ENABLED" | "DISABLED" | "NOT_APPLICABLE";
  operationalStatus: AiCapabilityStatus;
  region: string;
  transferMechanism: string;
  trainingMode: string;
  retentionMode: string;
  lastVerifiedAtUtc: string;
  note: string;
};

type StatusInputs = {
  globalAiEnabled: boolean;
  openaiConfigured: boolean;
  semanticGloballyEnabled: boolean;
  semanticOutboundEnabled: boolean;
  policy: ResolvedWorkspaceAiPolicy;
};

/**
 * PURE status computation for the advisory OpenAI family (chat / capture /
 * categorization). Ordered exactly like the policy evaluator so disclosure
 * and enforcement never disagree.
 */
export function computeAdvisoryCapabilityStatus(
  featureEnabledInPolicy: boolean,
  inputs: Pick<StatusInputs, "globalAiEnabled" | "openaiConfigured" | "policy">,
): AiCapabilityStatus {
  if (!inputs.globalAiEnabled && !inputs.openaiConfigured) {
    return "DISABLED_BY_PLATFORM_CONFIGURATION";
  }
  if (!inputs.openaiConfigured) return "NOT_CONFIGURED";
  if (!inputs.globalAiEnabled) return "DISABLED_BY_PLATFORM_CONFIGURATION";
  if (!inputs.policy.aiEnabled) return "DISABLED_BY_WORKSPACE_POLICY";
  if (!featureEnabledInPolicy) return "DISABLED_BY_WORKSPACE_POLICY";
  return "ENABLED_FOR_THIS_WORKSPACE";
}

/** PURE status computation for the opt-in OpenAI embeddings path. */
export function computeEmbeddingsCapabilityStatus(
  inputs: StatusInputs,
): AiCapabilityStatus {
  if (!inputs.openaiConfigured) return "NOT_CONFIGURED";
  if (!inputs.semanticGloballyEnabled) return "DISABLED_BY_PLATFORM_CONFIGURATION";
  if (!inputs.semanticOutboundEnabled) return "DISABLED_BY_PLATFORM_CONFIGURATION";
  if (!inputs.policy.semanticSearchEnabled) return "DISABLED_BY_WORKSPACE_POLICY";
  return "ENABLED_FOR_THIS_WORKSPACE";
}

/** PURE status for a key-gated media subprocessor (Azure / Deepgram / AWS). */
export function computeSubprocessorCapabilityStatus(
  probeReady: boolean,
  contentIntelligenceEnabled: boolean,
): AiCapabilityStatus {
  if (!probeReady) return "NOT_CONFIGURED";
  // Key present but the workspace has not opted into content intelligence:
  // available at the platform level, not active for this workspace.
  return contentIntelligenceEnabled ? "ENABLED_FOR_THIS_WORKSPACE" : "CONFIGURED";
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resolve the complete capability disclosure for a workspace from live state.
 */
export async function resolveAiCapabilityDisclosure(
  teamId: string | null,
): Promise<AiCapabilityDisclosure[]> {
  const policy = await resolveWorkspaceAiPolicy(teamId);
  const globalAiEnabled = isPlatformAiGloballyEnabled();
  const openaiConfigured = isOpenAiAdvisoryConfigured();
  const semanticGloballyEnabled = process.env.SEMANTIC_SEARCH_ENABLED === "true";
  const semanticOutboundEnabled =
    process.env.SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND === "true";
  const inputs: StatusInputs = {
    globalAiEnabled,
    openaiConfigured,
    semanticGloballyEnabled,
    semanticOutboundEnabled,
    policy,
  };
  const probes = listAdapterProbes();
  const probeReady = (provider: string): boolean =>
    probes.some((p) => p.provider === provider && p.state === "READY");
  const ts = nowIso();

  const advisory = (
    capability: string,
    purpose: string,
    featureEnabled: boolean,
  ): AiCapabilityDisclosure => ({
    capability,
    provider: "OpenAI",
    purpose,
    dataCategory: "METADATA_ONLY",
    rawContent: false,
    defaultState: "ON",
    workspaceOptInRequired: false,
    globalConfigured: openaiConfigured && globalAiEnabled,
    workspacePolicyState: featureEnabled && policy.aiEnabled ? "ENABLED" : "DISABLED",
    operationalStatus: computeAdvisoryCapabilityStatus(featureEnabled, inputs),
    region: "OpenAI global (US) per subprocessor disclosure",
    transferMechanism: "SCC / DPA (see Subprocessors)",
    trainingMode: "No training on customer data (see A3 provider privacy config)",
    retentionMode: "Advisory output only; not persisted for chat (stateless)",
    lastVerifiedAtUtc: ts,
    note: "Metadata-only payload; the LLM never receives raw evidence.",
  });

  const subprocessor = (
    capability: string,
    provider: string,
    purpose: string,
    probeProvider: string,
    region: string,
  ): AiCapabilityDisclosure => ({
    capability,
    provider,
    purpose,
    dataCategory: "RAW_BYTES",
    rawContent: true,
    defaultState: "OFF",
    workspaceOptInRequired: true,
    globalConfigured: probeReady(probeProvider),
    workspacePolicyState: policy.contentIntelligenceEnabled ? "ENABLED" : "DISABLED",
    operationalStatus: computeSubprocessorCapabilityStatus(
      probeReady(probeProvider),
      policy.contentIntelligenceEnabled,
    ),
    region,
    transferMechanism: "SCC / DPA (see Subprocessors)",
    trainingMode: "No training (provider contract)",
    retentionMode: "Derived text stored as evidence metadata; subject to retention policy",
    lastVerifiedAtUtc: ts,
    note: "Raw bytes sent to a purpose-specific extractor only when configured AND the workspace opts into content intelligence.",
  });

  return [
    advisory("Support chat", "Product + evidence-operations assistance", policy.supportChatEnabled),
    advisory("Capture assistance", "Metadata-completeness advisory review", policy.captureAssistanceEnabled),
    advisory("Evidence categorization", "Bounded metadata categorization", policy.evidenceCategorizationEnabled),
    {
      capability: "Semantic search (OpenAI embeddings)",
      provider: "OpenAI",
      purpose: "Vector embeddings for similarity retrieval",
      dataCategory: "DERIVED_TEXT",
      rawContent: false,
      defaultState: "OFF",
      workspaceOptInRequired: true,
      globalConfigured: openaiConfigured && semanticGloballyEnabled && semanticOutboundEnabled,
      workspacePolicyState: policy.semanticSearchEnabled ? "ENABLED" : "DISABLED",
      operationalStatus: computeEmbeddingsCapabilityStatus(inputs),
      region: "OpenAI global (US)",
      transferMechanism: "SCC / DPA",
      trainingMode: "No training on customer data",
      retentionMode: "Chunk text embedded; vectors stored tenant-scoped",
      lastVerifiedAtUtc: ts,
      note: "Dual-gated + default-off; only derived chunk text (never raw files) leaves the platform, and only on explicit opt-in.",
    },
    subprocessor("Document OCR", "Azure Document Intelligence", "OCR / layout / tables", "AZURE_DOCUMENT_INTELLIGENCE", "Azure region-pinned"),
    subprocessor("Audio/video transcription", "Deepgram", "ASR / diarisation", "DEEPGRAM_TRANSCRIPT", "Deepgram US"),
    subprocessor("Image analysis", "AWS Rekognition", "Faces / text / labels", "AWS_REKOGNITION_TEXT", "AWS region-pinned"),
    {
      capability: "OpenAI entity-extraction / document-summary",
      provider: "OpenAI (named adapter)",
      purpose: "Entity extraction / summary",
      dataCategory: "NONE",
      rawContent: false,
      defaultState: "OFF",
      workspaceOptInRequired: false,
      globalConfigured: false,
      workspacePolicyState: "NOT_APPLICABLE",
      operationalStatus: "STUB_NOT_OPERATIONAL",
      region: "n/a (no outbound)",
      transferMechanism: "n/a",
      trainingMode: "n/a",
      retentionMode: "n/a",
      lastVerifiedAtUtc: ts,
      note: "NOT wired to a live OpenAI call — runs a bounded LOCAL REGEX_PII / truncation fallback. Presented as a stub, never as operational OpenAI.",
    },
    {
      capability: "Reviewer Copilot",
      provider: "OpenAI (planned)",
      purpose: "Source-grounded reviewer assistance",
      dataCategory: "METADATA_ONLY",
      rawContent: false,
      defaultState: "OFF",
      workspaceOptInRequired: true,
      globalConfigured: false,
      workspacePolicyState: policy.reviewerCopilotEnabled ? "ENABLED" : "DISABLED",
      operationalStatus: "PREVIEW",
      region: "n/a",
      transferMechanism: "n/a",
      trainingMode: "n/a",
      retentionMode: "n/a",
      lastVerifiedAtUtc: ts,
      note: "Preview / not operational — returns a safe refusal in production until the real Reviewer Copilot (D3) ships.",
    },
    {
      capability: "Case Copilot",
      provider: "OpenAI (planned)",
      purpose: "Case-preparation assistance",
      dataCategory: "METADATA_ONLY",
      rawContent: false,
      defaultState: "OFF",
      workspaceOptInRequired: true,
      globalConfigured: false,
      workspacePolicyState: policy.caseCopilotEnabled ? "ENABLED" : "DISABLED",
      operationalStatus: "PLANNED",
      region: "n/a",
      transferMechanism: "n/a",
      trainingMode: "n/a",
      retentionMode: "n/a",
      lastVerifiedAtUtc: ts,
      note: "Planned — not built (D1).",
    },
    {
      capability: "Local EXIF / perceptual-hash / technical metadata",
      provider: "Local (in-process)",
      purpose: "Technical metadata extraction",
      dataCategory: "NONE",
      rawContent: false,
      defaultState: "ON",
      workspaceOptInRequired: false,
      globalConfigured: true,
      workspacePolicyState: "NOT_APPLICABLE",
      operationalStatus: "AVAILABLE",
      region: "In-platform (no outbound)",
      transferMechanism: "n/a",
      trainingMode: "n/a",
      retentionMode: "Metadata stored with evidence",
      lastVerifiedAtUtc: ts,
      note: "Computed locally; nothing leaves the platform; precise GPS not stored.",
    },
    {
      capability: "Deterministic readiness scoring",
      provider: "Local (in-process)",
      purpose: "Review-preparation completeness",
      dataCategory: "NONE",
      rawContent: false,
      defaultState: "ON",
      workspaceOptInRequired: false,
      globalConfigured: true,
      workspacePolicyState: "NOT_APPLICABLE",
      operationalStatus: "AVAILABLE",
      region: "In-platform",
      transferMechanism: "n/a",
      trainingMode: "n/a (no LLM)",
      retentionMode: "Advisory metadata",
      lastVerifiedAtUtc: ts,
      note: "Pure arithmetic; no LLM. Measures preparation completeness only, not truth/authenticity/admissibility.",
    },
  ];
}
