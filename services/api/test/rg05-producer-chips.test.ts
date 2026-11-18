/**
 * PRO-AI1C-03 — producer chips answer for THIS workspace, and the
 * credentials-not-ready case no longer carries the workspace-disabled sentence.
 * At the base SHA a workspace whose policy refused semantic search was told
 * "Automatic extraction is active using local deterministic embeddings".
 *
 * PRO-AI1Z-04 — a spent allowance is folded into the assistance projection.
 */
import { beforeAll, describe, expect, it } from "vitest";

import "../src/register-shared-runtime.js";
import {
  PRODUCER_REASON_COPY,
  registerProbes,
  resolveProducerModeStatuses,
} from "@proovra/shared-runtime/media-intelligence";
import { withAllowance } from "../src/services/ai/ai-assistance-projection.js";
import { _resetEmbeddingProviderForTests } from "../src/services/search/embedding-provider.js";

const prismaStub = { $queryRawUnsafe: async () => [] } as never;
const TEAM = "22222222-2222-4222-8222-222222222222";

beforeAll(() => {
  process.env.SEMANTIC_SEARCH_ENABLED = "true";
  process.env.SEMANTIC_EMBEDDINGS_PROVIDER = "local-deterministic";
  _resetEmbeddingProviderForTests();
  // The deployment-level probes say semantic search is ready (local provider).
  registerProbes({
    probeAzureDocumentIntelligence: async () => ({ state: "NOT_CONFIGURED", reason: "test" }),
    probeDeepgram: async () => ({ state: "NOT_CONFIGURED", reason: "test" }),
    isSemanticReadyAtRuntime: () => true,
    resolveEmbeddingProviderFromEnv: () => ({ name: "local-deterministic" }),
  } as never);
});

describe("PRO-AI1C-03 — workspace-aware producer chips", () => {
  it("deployment-ready semantic search is NOT active for a workspace whose gate refuses it", async () => {
    const statuses = await resolveProducerModeStatuses({
      teamId: TEAM,
      prisma: prismaStub,
      workspaceGate: { ocr: false, transcript: false, semantic_search: false },
    });
    const semantic = statuses.find((s) => s.kind === "semantic_search")!;
    expect(semantic.automatic).toBe(false);
    expect(semantic.reason).toBe(PRODUCER_REASON_COPY.CREDENTIALS_PRESENT_WORKSPACE_DISABLED);
  });

  it("an allowed workspace still sees the active producer", async () => {
    const statuses = await resolveProducerModeStatuses({
      teamId: TEAM,
      prisma: prismaStub,
      workspaceGate: { ocr: true, transcript: true, semantic_search: true },
    });
    expect(statuses.find((s) => s.kind === "semantic_search")!.automatic).toBe(true);
  });

  it("credentials-not-ready has its own reason, distinct from workspace-disabled", () => {
    expect(PRODUCER_REASON_COPY.CREDENTIALS_NOT_READY).not.toBe(
      PRODUCER_REASON_COPY.CREDENTIALS_PRESENT_WORKSPACE_DISABLED,
    );
  });
});

describe("PRO-AI1Z-04 — allowance in the assistance projection", () => {
  it("a spent allowance is not AVAILABLE; it says why and when it resets", () => {
    const out = withAllowance(
      { status: "AVAILABLE", available: true, enabled: true },
      "AI_MONTHLY_LIMIT_REACHED",
      new Date("2028-11-21T10:00:00Z"),
    );
    expect(out).toMatchObject({
      status: "TEMPORARILY_UNAVAILABLE",
      available: false,
      reason: "ALLOWANCE_EXHAUSTED",
      allowanceResetsAtUtc: "2028-12-01T00:00:00.000Z",
    });
  });

  it("no denial leaves the projection unchanged", () => {
    const base = { status: "AVAILABLE" as const, available: true, enabled: true };
    expect(withAllowance(base, null)).toBe(base);
  });
});
