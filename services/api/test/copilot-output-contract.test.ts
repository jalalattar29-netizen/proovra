/**
 * EVIDENCE COPILOT — the output contract the model is GIVEN is the output
 * contract it is MEASURED against.
 *
 * WHAT WAS WRONG IN PRODUCTION
 * ---------------------------------------------------------------------------
 * The copilot answered, and the answer was thrown away. The stage was
 * structured-output validation, and the cause was a drift between two
 * definitions of the same contract:
 *
 *   provider JSON schema        validator (zod)
 *   -------------------------   ------------------------------
 *   { type: "string" }          z.string().max(1000)
 *   { type: "array" }           z.array(z.string().max(600)).max(50)
 *   objectVersion: number       z.number().int()
 *   advisoryBoundary: string    z.literal(<exact sentence>)
 *
 * The model was told "any length, any number", produced a thorough answer that
 * was legal against the schema it had been handed, and the validator then
 * rejected it as SCHEMA_MISMATCH. Nothing was malformed and nothing was
 * prohibited: the two schemas simply disagreed.
 *
 * The fix is one exported set of bounds (`COPILOT_BOUNDS`) applied to BOTH
 * sides, plus one bounded repair attempt for genuine formatting/shape
 * failures. Validation is NOT weakened anywhere: a response that breaks the
 * contract is still discarded, never displayed, and a prohibited claim is
 * never retried into acceptance.
 */
import { describe, expect, it, vi } from "vitest";

import {
  COPILOT_BOUNDS,
  classifyValidationFailure,
  validateCopilotOutput,
} from "../src/services/ai/ai-copilot-schemas.js";
import {
  ADVISORY_BOUNDARY_TEXT,
  buildCopilotJsonSchema,
  CITATION_JSON_ITEMS,
} from "../src/services/ai/structured-copilot-provider.js";
import { runGroundedCopilot } from "../src/services/ai/copilot-orchestrator.js";

// ---------------------------------------------------------------------------
// Fixtures — fictional, non-production.
// ---------------------------------------------------------------------------

const LIST_FIELDS = [
  "missingContext",
  "integritySignalExplanations",
  "custodyObservations",
  "timestampingObservations",
  "reportReadiness",
  "packageReadiness",
  "reviewerPreparation",
  "workflowGaps",
  "suggestedNavigation",
  "suggestedActions",
] as const;

function evidenceOutput(over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    operationalSummary: "The record has a recorded hash and a pending anchor confirmation.",
    citations: [
      {
        type: "EVIDENCE_RECORD",
        objectId: "ev-1",
        displayLabel: "Evidence record",
        route: "/evidence/ev-1",
        objectVersion: 2,
      },
    ],
    advisoryBoundary: ADVISORY_BOUNDARY_TEXT,
  };
  for (const field of LIST_FIELDS) base[field] = ["One bounded observation."];
  return { ...base, ...over };
}

const policyAllowed = { allowed: true, decision: "ALLOWED" } as never;

function orchestrate(
  responses: unknown[],
  over: Partial<Parameters<typeof runGroundedCopilot>[0]> = {},
) {
  let call = 0;
  const callProvider = vi.fn(async () => responses[Math.min(call++, responses.length - 1)]);
  const result = runGroundedCopilot({
    surface: "EVIDENCE",
    teamId: "ws-1",
    selectionRevisions: [{ id: "ev-1", revision: "ear1_" + "x".repeat(43) }],
    requireSelection: true,
    policyDecision: policyAllowed,
    callProvider,
    resolveCitation: async () => ({ objectId: "ev-1", workspaceId: "ws-1", version: 2 }) as never,
    summaryField: "operationalSummary",
    ...over,
  });
  return { result, callProvider };
}

// ---------------------------------------------------------------------------
// The root cause: one contract, both sides.
// ---------------------------------------------------------------------------

describe("Copilot output contract — the provider schema carries the validator's bounds", () => {
  const schema = buildCopilotJsonSchema("evidence_copilot", "operationalSummary", [
    ...LIST_FIELDS,
  ]);
  const props = schema.schema.properties as Record<string, Record<string, unknown>>;

  it("bounds the summary string with the validator's own limit", () => {
    expect(props.operationalSummary.maxLength).toBe(COPILOT_BOUNDS.summaryMaxChars);
  });

  it("bounds every list field with the validator's own item and length limits", () => {
    for (const field of LIST_FIELDS) {
      expect(props[field].maxItems, `${field} item count`).toBe(COPILOT_BOUNDS.listMaxItems);
      expect(
        (props[field].items as Record<string, unknown>).maxLength,
        `${field} item length`,
      ).toBe(COPILOT_BOUNDS.listItemMaxChars);
    }
  });

  it("asks for an INTEGER object version, which is what the validator accepts", () => {
    const version = (CITATION_JSON_ITEMS.items.properties as Record<string, { type: unknown }>)
      .objectVersion;
    expect(version.type).toEqual(["integer", "null"]);
    // The drift this pins: `number` here accepted 2.5, which `z.number().int()`
    // then rejected as a schema mismatch.
    expect(validateCopilotOutput("EVIDENCE", evidenceOutput({
      citations: [
        {
          type: "EVIDENCE_RECORD",
          objectId: "ev-1",
          displayLabel: "Evidence record",
          route: "/evidence/ev-1",
          objectVersion: 2.5,
        },
      ],
    })).ok).toBe(false);
  });

  it("pins the advisory boundary sentence the validator requires verbatim", () => {
    expect(props.advisoryBoundary.enum).toEqual([ADVISORY_BOUNDARY_TEXT]);
  });

  it("accepts a response written to the maximum the schema advertises", () => {
    // THE PRODUCTION CASE: an answer at the schema's declared ceiling is legal
    // and must validate. Before the fix the ceiling was not advertised at all.
    const long = evidenceOutput({
      operationalSummary: "x".repeat(COPILOT_BOUNDS.summaryMaxChars),
      missingContext: Array.from({ length: COPILOT_BOUNDS.listMaxItems }, () =>
        "y".repeat(COPILOT_BOUNDS.listItemMaxChars),
      ),
    });
    expect(validateCopilotOutput("EVIDENCE", long).ok).toBe(true);
  });

  it("still rejects a response that exceeds the contract", () => {
    const over = validateCopilotOutput("EVIDENCE", evidenceOutput({
      operationalSummary: "x".repeat(COPILOT_BOUNDS.summaryMaxChars + 1),
    }));
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.category).toBe("TOO_LONG");
  });
});

// ---------------------------------------------------------------------------
// Failure classification — bounded, safe to log, never model text.
// ---------------------------------------------------------------------------

describe("Copilot validation failures are classified without exposing content", () => {
  const categoryOf = (raw: unknown) => {
    const out = validateCopilotOutput("EVIDENCE", raw);
    return out.ok === false ? out.category : "ok";
  };

  it("names malformed JSON, a missing field, a wrong type and a broken boundary", () => {
    expect(categoryOf({ _malformed: true })).toBe("MALFORMED_JSON");

    const missing = evidenceOutput();
    delete (missing as { operationalSummary?: unknown }).operationalSummary;
    expect(categoryOf(missing)).toBe("MISSING_FIELD");

    expect(categoryOf(evidenceOutput({ missingContext: "not a list" }))).toBe("WRONG_TYPE");
    expect(categoryOf(evidenceOutput({ advisoryBoundary: "Advisory." }))).toBe("BOUNDARY_TEXT");
  });

  it("classifies from issue codes only — no model text reaches the category", () => {
    const category = classifyValidationFailure([
      { code: "too_big", path: ["operationalSummary"], message: "Too big" },
    ] as never);
    expect(category).toBe("TOO_LONG");
  });
});

// ---------------------------------------------------------------------------
// Orchestration — one bounded repair, and nothing invalid ever surfaces.
// ---------------------------------------------------------------------------

describe("Copilot orchestration — bounded repair, fail closed", () => {
  it("returns a valid response on the first call without re-asking", async () => {
    const { result, callProvider } = orchestrate([evidenceOutput()]);
    const out = await result;
    expect(out.status).toBe("ok");
    expect(callProvider).toHaveBeenCalledTimes(1);
  });

  it("re-asks ONCE when the first answer breaks the shape, and accepts the repair", async () => {
    const broken = evidenceOutput({ missingContext: "not a list" });
    const { result, callProvider } = orchestrate([broken, evidenceOutput()]);
    const out = await result;
    expect(out.status).toBe("ok");
    expect(callProvider).toHaveBeenCalledTimes(2);
  });

  it("gives up after the single repair and returns a category, not the output", async () => {
    const broken = evidenceOutput({ missingContext: "not a list" });
    const { result, callProvider } = orchestrate([broken, broken]);
    const out = await result;

    expect(out.status).toBe("schema_error");
    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(out.validationCategory).toBe("WRONG_TYPE");
    // The discarded model output is never carried to the client.
    expect(out.data).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/not a list/);
    // The boundary statement still travels with the failure.
    expect(out.advisoryBoundary).toBe(ADVISORY_BOUNDARY_TEXT);
  });

  it("re-asks once on malformed output, then fails closed", async () => {
    const { result, callProvider } = orchestrate([{ _malformed: true }, { _malformed: true }]);
    const out = await result;
    expect(out.status).toBe("schema_error");
    expect(out.validationCategory).toBe("MALFORMED_JSON");
    expect(callProvider).toHaveBeenCalledTimes(2);
  });

  it("never retries a prohibited claim into acceptance", async () => {
    // Prohibited content is detected AFTER a successful parse, so it is not a
    // repairable formatting failure and must be blocked on the first answer.
    const { result, callProvider } = orchestrate([
      evidenceOutput({
        operationalSummary: "This evidence proves the document is authentic and admissible.",
      }),
    ]);
    const out = await result;
    expect(out.status).toBe("blocked_prohibited_claim");
    expect(callProvider).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(out.data)).not.toMatch(/admissible/i);
  });

  it("lets a provider error surface instead of inventing an answer", async () => {
    const { result } = orchestrate([], {
      callProvider: async () => {
        throw new Error("AI_PROVIDER_UNAVAILABLE");
      },
    });
    await expect(result).rejects.toThrow(/AI_PROVIDER_UNAVAILABLE/);
  });

  it("refuses before calling the provider when policy denies the surface", async () => {
    const { result, callProvider } = orchestrate([evidenceOutput()], {
      policyDecision: { allowed: false, decision: "AI_DISABLED" } as never,
    });
    const out = await result;
    expect(out.status).toBe("policy_denied");
    expect(callProvider).not.toHaveBeenCalled();
  });
});
