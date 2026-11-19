/**
 * RG-05 (PRO-AI1-02 / PRO-AI1-03) — AI spend follows SERVER-authored
 * transport facts, never the model-written status.
 *
 * Drives the real OpenAiProvider and the real structured copilot call with the
 * `openai` SDK transport replaced. At the base SHA:
 *   - a model that answered with `status: "blocked"` produced a non-ok result,
 *     which every route refunded on both meters while returning the answer;
 *   - every thrown/timed-out call was refunded although it may have been
 *     generated and billed, and the SDK retried underneath the app's retry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  impl: (async () => ({})) as (req: unknown) => Promise<unknown>,
  calls: 0,
  clientOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
  class OpenAI {
    responses = {
      create: async (req: unknown) => {
        H.calls += 1;
        return H.impl(req);
      },
    };
    constructor(opts: Record<string, unknown>) {
      H.clientOptions.push(opts);
    }
  }
  return { default: OpenAI, OpenAI };
});

import { OpenAiProvider } from "../src/services/ai/openai-provider.js";
import { AiTask } from "../src/services/ai/ai-types.js";
import {
  aiResultSpends,
  classifyProviderError,
  providerOutcomeOf,
  withoutProviderOutcome,
} from "../src/services/ai/ai-provider-outcome.js";
import { buildStructuredCopilotCall, buildCopilotJsonSchema } from "../src/services/ai/structured-copilot-provider.js";

function modelAnswer(body: Record<string, unknown>) {
  return {
    output_text: JSON.stringify({
      status: "ok",
      summary: "Capture the scene from two angles.",
      warnings: [],
      suggestions: [],
      flags: [],
      legalDisclaimer: "AI assistance is advisory and does not determine factual truth, authorship, or legal admissibility.",
      ...body,
    }),
    usage: { input_tokens: 1000, output_tokens: 500 },
  };
}

function providerError(status: number) {
  return Object.assign(new Error(`provider ${status}`), { status });
}

const provider = () =>
  new OpenAiProvider({ apiKey: "sk-test-not-real", chatModel: "m", captureModel: "m", evidenceCategorizationModel: "m" });

beforeEach(() => {
  H.calls = 0;
  H.clientOptions = [];
});

describe("RG-05 — transport outcome, not model status", () => {
  it("PRO-AI1-02: a model that writes status 'blocked' is ANSWERED spend and its status is server-authored", async () => {
    H.impl = async () => modelAnswer({ status: "blocked" });
    const result = await provider().run(AiTask.SUPPORT_CHAT, { messages: [] });
    expect(providerOutcomeOf(result)).toBe("ANSWERED");
    expect(aiResultSpends(result)).toBe(true);
    // The server's own filters found nothing: the answer is "ok".
    expect(result.status).toBe("ok");
  });

  it("PRO-AI1-02: content blocked by the server's prohibited-claims filter still spends and returns no model text", async () => {
    H.impl = async () => modelAnswer({ summary: "This evidence is authentic and admissible in court." });
    const result = await provider().run(AiTask.SUPPORT_CHAT, { messages: [] });
    expect(result.status).toBe("blocked");
    expect(aiResultSpends(result)).toBe(true);
    expect(result.summary).not.toContain("authentic and admissible");
  });

  it("PRO-AI1-03: a pre-generation refusal (401) is NOT_SENT and releases", async () => {
    H.impl = async () => {
      throw providerError(401);
    };
    const result = await provider().run(AiTask.SUPPORT_CHAT, { messages: [] });
    expect(providerOutcomeOf(result)).toBe("NOT_SENT");
    expect(aiResultSpends(result)).toBe(false);
  });

  it("PRO-AI1-03: a timeout or 5xx is SENT_UNKNOWN and keeps the operation (bounded rule)", async () => {
    for (const err of [
      Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }),
      providerError(502),
    ]) {
      H.impl = async () => {
        throw err;
      };
      const result = await provider().run(AiTask.SUPPORT_CHAT, { messages: [] });
      expect(providerOutcomeOf(result)).toBe("SENT_UNKNOWN");
      expect(aiResultSpends(result)).toBe(true);
    }
  });

  it("PRO-AI1-03: the advisory client is built with no SDK retries and a bounded timeout", () => {
    provider();
    expect(H.clientOptions[0]).toMatchObject({ maxRetries: 0 });
    expect(typeof H.clientOptions[0]?.timeout).toBe("number");
    expect(H.clientOptions[0]!.timeout as number).toBeLessThan(30_000);
  });

  it("the meter fact never leaves the API", async () => {
    H.impl = async () => modelAnswer({});
    const result = await provider().run(AiTask.SUPPORT_CHAT, { messages: [] });
    const wire = withoutProviderOutcome(result);
    expect(Object.keys(wire)).not.toContain("providerOutcome");
    expect(Object.keys(wire)).not.toContain("providerCostUsdMicros");
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it("classifies transport errors conservatively", () => {
    expect(classifyProviderError(providerError(429))).toBe("NOT_SENT");
    expect(classifyProviderError(providerError(500))).toBe("SENT_UNKNOWN");
    expect(classifyProviderError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("NOT_SENT");
    expect(classifyProviderError(new Error("socket hang up"))).toBe("SENT_UNKNOWN");
  });
});

describe("RG-05 — copilot spend across attempts (PRO-AI1-03)", () => {
  const schema = buildCopilotJsonSchema("rg05_schema", "summary", ["items"]);

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test-not-real";
    process.env.OPENAI_AI_ENABLED = "true";
  });

  it("an answered attempt keeps its spend even when a later attempt in the same request throws", async () => {
    const call = buildStructuredCopilotCall({ modelEnvVar: "X_MODEL", jsonSchema: schema, system: "s" });
    H.impl = async () => ({ output_text: "not json", usage: { input_tokens: 10, output_tokens: 10 } });
    await call({});
    H.impl = async () => {
      throw providerError(400);
    };
    await expect(call({})).rejects.toThrow();
    expect(call.spend.outcome).toBe("ANSWERED");
    expect(call.spend.actualCostUsdMicros).not.toBeNull();
  });

  it("a 5xx is not re-sent and is SENT_UNKNOWN; a 429 is retried once", async () => {
    const call = buildStructuredCopilotCall({ modelEnvVar: "X_MODEL", jsonSchema: schema, system: "s" });
    H.impl = async () => {
      throw providerError(503);
    };
    await expect(call({})).rejects.toThrow();
    expect(H.calls).toBe(1);
    expect(call.spend.outcome).toBe("SENT_UNKNOWN");
    expect(H.clientOptions.at(-1)).toMatchObject({ maxRetries: 0 });
  });

  it("nothing sent (provider not configured) is NOT_SENT", async () => {
    process.env.OPENAI_AI_ENABLED = "false";
    const call = buildStructuredCopilotCall({ modelEnvVar: "X_MODEL", jsonSchema: schema, system: "s" });
    await expect(call({})).rejects.toThrow();
    expect(call.spend.outcome).toBe("NOT_SENT");
  });
});
