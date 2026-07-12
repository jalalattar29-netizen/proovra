/**
 * Phase A1 — AI Disclosure truthfulness.
 *
 * The AI disclosure surface must reflect ACTUAL runtime status, not the
 * mere existence of a provider adapter. The `OPENAI_ENTITY_EXTRACTION`
 * and `OPENAI_DOCUMENT_SUMMARY` adapters do NOT make a live OpenAI call
 * (there is no `callOpenAI` seam); they always run a bounded LOCAL
 * fallback. Therefore:
 *   1. Their probe must report NOT_CONFIGURED even when OPENAI_API_KEY is
 *      bound (never a falsely-operational READY).
 *   2. The Trust Center disclosure prose must not present them as an
 *      operational OpenAI capability; OpenAI's only live path is opt-in
 *      embeddings.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Side-effect import registers the OpenAI entity/summary adapters.
import "../src/services/intelligence/providers/openai-adapter.js";
import { listAdapterProbes } from "../src/services/intelligence/providers/provider-adapter.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const TRUST_CENTER = readSource(
  "../../../services/api/src/services/trust/trust-center.service.ts",
);

describe("Phase A1 — OpenAI entity/summary probe is honestly NOT_CONFIGURED", () => {
  const priorKey = process.env.OPENAI_API_KEY;
  beforeAll(() => {
    // Even WITH a key bound, these operations never call OpenAI, so the
    // probe must not flip to a falsely-operational READY.
    process.env.OPENAI_API_KEY = "sk-test-fake-key-not-actually-used";
  });
  afterAll(() => {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  });

  it("reports NOT_CONFIGURED (never READY) with a local-fallback reason", () => {
    const probes = listAdapterProbes();
    // Phase F-8 — the local-fallback adapters carry the honest LOCAL_* labels.
    const entity = probes.find((p) => p.provider === "LOCAL_ENTITY_EXTRACTION");
    const summary = probes.find((p) => p.provider === "LOCAL_DOCUMENT_SUMMARY");

    expect(entity, "entity adapter must be registered").toBeDefined();
    expect(summary, "summary adapter must be registered").toBeDefined();

    expect(entity?.state).toBe("NOT_CONFIGURED");
    expect(summary?.state).toBe("NOT_CONFIGURED");
    expect(entity?.state).not.toBe("READY");
    expect(summary?.state).not.toBe("READY");

    expect(entity?.reason ?? "").toMatch(/local|fallback/i);
    expect(summary?.reason ?? "").toMatch(/local|fallback/i);
  });
});

describe("Phase A1 — Trust Center prose no longer overstates OpenAI", () => {
  it("removes the false 'OpenAI receives OCR/transcript text' extraction claim", () => {
    expect(TRUST_CENTER).not.toMatch(
      /OpenAI entity-extraction receives the OCR or transcript text/,
    );
    expect(TRUST_CENTER).not.toMatch(
      /OpenAI \(entity extraction \/ document summary \/ text embeddings/,
    );
  });

  it("states OpenAI's only live path is opt-in embeddings; entity/summary are local", () => {
    expect(TRUST_CENTER).toMatch(/no live OpenAI call/i);
    expect(TRUST_CENTER).toMatch(/local[^.]*fallback|LOCAL[^.]*fallback|local REGEX_PII/i);
    expect(TRUST_CENTER).toMatch(/embeddings/i);
  });
});
