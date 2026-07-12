/**
 * FINAL ENTERPRISE COMPLETION — Phase 4: canonical provider factory
 * retry policy + bounded telemetry.
 *
 *   - 429 / 5xx transport errors → exactly ONE retry.
 *   - 4xx (non-429) → NO retry, error propagates.
 *   - Malformed model output → NO retry (model failure, not transport),
 *     safe { _malformed: true } fallback.
 *   - Telemetry lines are structured JSON with schema/latency/attempt/outcome
 *     and NEVER contain the payload or the model's text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  impl: (async () => ({})) as () => Promise<unknown>,
  calls: 0,
}));

vi.mock("openai", () => ({
  default: class OpenAIStub {
    responses = {
      create: async () => {
        H.calls += 1;
        return H.impl();
      },
    };
  },
}));
vi.mock("../src/config/runtime-secrets.js", () => ({
  getSecret: (name: string) => (name === "OPENAI_API_KEY" ? "test-key" : null),
}));

import {
  buildCopilotJsonSchema,
  buildStructuredCopilotCall,
} from "../src/services/ai/structured-copilot-provider.js";

const SCHEMA = buildCopilotJsonSchema("test_schema", "summary", []);
const call = buildStructuredCopilotCall({ modelEnvVar: "TEST_MODEL", jsonSchema: SCHEMA, system: "sys" });

const OK_RESPONSE = {
  output_text: JSON.stringify({ summary: "ok", citations: [], advisoryBoundary: "x" }),
  usage: { input_tokens: 10, output_tokens: 5 },
};

function providerError(status: number): Error & { status: number } {
  return Object.assign(new Error(`provider ${status}`), { status });
}

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.OPENAI_AI_ENABLED = "true";
  H.calls = 0;
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  infoSpy.mockRestore();
  delete process.env.OPENAI_AI_ENABLED;
});

describe("Phase 4 — provider factory retry policy + telemetry", () => {
  it("429 → exactly one retry, then success", async () => {
    let first = true;
    H.impl = async () => {
      if (first) {
        first = false;
        throw providerError(429);
      }
      return OK_RESPONSE;
    };
    const out = (await call({ q: 1 })) as { summary: string };
    expect(out.summary).toBe("ok");
    expect(H.calls).toBe(2);
  });

  it("5xx → exactly one retry; a second 5xx propagates (bounded, never a loop)", async () => {
    H.impl = async () => {
      throw providerError(503);
    };
    await expect(call({})).rejects.toThrow("provider 503");
    expect(H.calls).toBe(2);
  });

  it("non-429 4xx → NO retry, error propagates immediately", async () => {
    H.impl = async () => {
      throw providerError(400);
    };
    await expect(call({})).rejects.toThrow("provider 400");
    expect(H.calls).toBe(1);
  });

  it("malformed model output → NO retry, safe fallback (never raw text)", async () => {
    H.impl = async () => ({ output_text: "not json {{", usage: {} });
    const out = (await call({})) as { _malformed?: boolean };
    expect(out._malformed).toBe(true);
    expect(H.calls).toBe(1);
  });

  it("telemetry is structured JSON with outcome/latency/tokens and NEVER the payload or model text", async () => {
    H.impl = async () => OK_RESPONSE;
    await call({ secretPayload: "do-not-log-me" });
    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    const telemetry = lines.map((l) => JSON.parse(l)).filter((j) => j.kind === "ai.copilot_provider");
    expect(telemetry.length).toBe(1);
    expect(telemetry[0]).toMatchObject({
      schema: "test_schema", outcome: "ok", attempt: 1,
      inputTokens: 10, outputTokens: 5,
    });
    expect(typeof telemetry[0].latencyMs).toBe("number");
    const all = lines.join("\n");
    expect(all).not.toContain("do-not-log-me");
    expect(all).not.toContain("\"summary\":\"ok\"");
  });
});
