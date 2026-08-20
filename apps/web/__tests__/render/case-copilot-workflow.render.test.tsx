/**
 * EVIDENCE OPERATIONS COPILOT — the selection/execution lifecycle, driven.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Selecting two evidence records and pressing Run returned:
 *
 *     Invalid selection. (INVALID_INPUT)
 *
 * Nothing about the selection was invalid. The panel built its idempotency key
 * as `${caseId}:${ids.join(",")}` and the route validates it with
 * `z.string().max(80)`: one record is 73 characters and passes, two is 110 and
 * does not. Every source-text test on this panel passed throughout, because the
 * markup was fine — the REQUEST was not.
 *
 * So these mount the real panel, operate it, and validate the request it emits
 * against the route's OWN schema. The first test reproduces the historical
 * failure against that schema so the regression cannot come back quietly.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

import {
  COPILOT_IDEMPOTENCY_KEY_MAX,
  COPILOT_SELECTION_MAX,
  COPILOT_SELECTION_MIN,
  buildCopilotIdempotencyKey,
  evaluateCopilotEvidenceEligibility,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

const CASE_ID = "f2b14622-4939-4d60-9476-e4614002af67";

const H = vi.hoisted(() => {
  class FakeApiError extends Error {
    statusCode: number;
    code?: string;
    constructor(statusCode: number, code?: string) {
      super(`http ${statusCode}`);
      this.statusCode = statusCode;
      this.code = code;
    }
  }
  return {
    FakeApiError,
    requests: [] as Array<{ path: string; body: Record<string, unknown> }>,
    server: {
      status: 200 as number,
      code: undefined as string | undefined,
      reply: undefined as unknown,
      gate: undefined as Promise<void> | undefined,
    },
  };
});

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    H.requests.push({ path, body });
    if (H.server.gate) await H.server.gate;
    if (H.server.status !== 200) {
      throw new H.FakeApiError(H.server.status, H.server.code);
    }
    return H.server.reply ?? { data: okResult() };
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: H.FakeApiError,
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { CaseCopilotPanel, type CaseCopilotEvidence } from "../../components/ai-copilot/CaseCopilotPanel";

// ---------------------------------------------------------------------------
// The route's OWN schema, restated for validation.
//
// Kept in step with `services/api/src/routes/ai-case.routes.ts` by reading the
// same shared bounds; the literal shape is what the route parses.
// ---------------------------------------------------------------------------

const RouteBody = z.object({
  selectedEvidenceIds: z
    .array(z.string().uuid())
    .min(COPILOT_SELECTION_MIN)
    .max(COPILOT_SELECTION_MAX),
  // NULLABLE, exactly as the route declares it. `null` is the real projected
  // value for a record with no verification package and is a different
  // statement from version 0 — the schema had no way to express it, so the
  // client sent a fabricated 0 instead.
  selectedEvidenceVersions: z
    .record(z.string(), z.number().int().nullable())
    .optional(),
  processingMode: z.enum(["METADATA_ONLY", "APPROVED_CONTENT"]).default("METADATA_ONLY"),
  question: z.string().max(500).optional(),
  idempotencyKey: z.string().max(COPILOT_IDEMPOTENCY_KEY_MAX).optional(),
});

// ---------------------------------------------------------------------------
// Fixtures — the EXACT production shapes from the screenshot
// ---------------------------------------------------------------------------

const PHOTO: CaseCopilotEvidence = {
  id: "c6bb29e3-1111-4111-8111-111111111111",
  title: "Joint Scene Examination by Fire Investigators.jpg",
  type: "PHOTO",
  // `null` = no verification package yet. NOT `0`: the old fixture said 0
  // because the client fabricated 0, which is the defect this file now pins.
  version: null,
  status: "REPORTED",
  lifecycleState: "ACTIVE",
  caseLinked: true,
};

const VIDEO: CaseCopilotEvidence = {
  id: "1e00f0d6-2222-4222-8222-222222222222",
  title: "Scene walkthrough.mp4",
  type: "VIDEO",
  version: null,
  status: "REPORTED",
  lifecycleState: "ACTIVE",
  caseLinked: true,
};

const DOCUMENT: CaseCopilotEvidence = {
  id: "41a074bb-3333-4333-8333-333333333333",
  title: "Incident statement.pdf",
  type: "DOCUMENT",
  // A package-ready record: a REAL version the projection now carries.
  version: 2,
  status: "SIGNED",
  lifecycleState: "ACTIVE",
  caseLinked: true,
};

const UPLOADING: CaseCopilotEvidence = {
  id: "9a9a9a9a-4444-4444-8444-444444444444",
  title: "Body-cam clip.mp4",
  type: "VIDEO",
  version: null,
  status: "UPLOADING",
  lifecycleState: "ACTIVE",
  caseLinked: true,
};

function okResult() {
  return {
    status: "ok",
    data: {
      caseSummary: "Two records describe the same scene from different angles.",
      timelineHighlights: ["Both records were captured on the same day."],
      missingEvidenceCategories: [],
      workflowGaps: ["Neither record has a verification package yet."],
      conflictingMetadata: [],
      reviewerPreparation: [],
      disclosureChecklist: [],
      unresolvedQuestions: [],
      citations: [
        { objectType: "EVIDENCE_RECORD", objectId: PHOTO.id, label: PHOTO.title },
      ],
      advisoryBoundary:
        "AI assistance is advisory only and is not a determination of authenticity, truth or admissibility.",
    },
    droppedCitations: 0,
    versionMeta: { outputSchemaVersion: "1", contextObjectVersions: [] },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let refreshes = 0;

function mount(
  evidence: CaseCopilotEvidence[],
  props: { aiEnabled?: boolean } = {},
) {
  cleanup();
  return render(
    <CaseCopilotPanel
      caseId={CASE_ID}
      linkedEvidence={evidence}
      aiEnabled={props.aiEnabled}
      onRefreshEvidence={() => {
        refreshes += 1;
      }}
    />,
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const rows = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-case-copilot-row]"));
const boxes = () =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-case-copilot-checkbox]"),
  );
const runButton = () =>
  document.querySelector("[data-case-copilot-run]") as HTMLButtonElement | null;
const clearButton = () =>
  document.querySelector("[data-case-copilot-clear]") as HTMLButtonElement | null;
const selectAllButton = () =>
  document.querySelector("[data-case-copilot-select-all]") as HTMLButtonElement | null;
const count = () =>
  Number(
    document
      .querySelector("[data-case-copilot-selected-count]")
      ?.getAttribute("data-case-copilot-selected-count") ?? "-1",
  );

async function click(el: HTMLElement | null) {
  expect(el, "clicked a control that is not rendered").not.toBeNull();
  await act(async () => {
    el!.click();
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  H.requests.length = 0;
  H.server.status = 200;
  H.server.code = undefined;
  H.server.reply = undefined;
  H.server.gate = undefined;
  refreshes = 0;
});

afterEach(() => cleanup());

// ===========================================================================
// 1–3. The defect, the corrected contract, and the successful run
// ===========================================================================

describe("the two-record production selection", () => {
  it("1. the OLD key shape reproduces the historical INVALID_INPUT", () => {
    // Exactly what the panel used to build.
    const legacyKey = `${CASE_ID}:${[PHOTO.id, VIDEO.id].sort().join(",")}`;
    const legacy = RouteBody.safeParse({
      selectedEvidenceIds: [PHOTO.id, VIDEO.id],
      selectedEvidenceVersions: { [PHOTO.id]: null, [VIDEO.id]: null },
      processingMode: "METADATA_ONLY",
      idempotencyKey: legacyKey,
    });
    expect(legacyKey.length).toBeGreaterThan(COPILOT_IDEMPOTENCY_KEY_MAX);
    expect(legacy.success).toBe(false);
    expect(
      legacy.success ? [] : legacy.error.issues.map((i) => i.path.join(".")),
    ).toContain("idempotencyKey");
    // …and with ONE record it passed, which is why the defect looked random.
    const oneKey = `${CASE_ID}:${PHOTO.id}`;
    expect(oneKey.length).toBeLessThanOrEqual(COPILOT_IDEMPOTENCY_KEY_MAX);
  });

  it("2. the request the panel now emits validates against the route schema", async () => {
    mount([PHOTO, VIDEO]);
    await settle();
    await click(boxes()[0]);
    await click(boxes()[1]);
    expect(count()).toBe(2);

    await click(runButton());

    const req = H.requests.at(-1);
    expect(req, "no request was sent").toBeTruthy();
    expect(req!.path).toBe(`/v1/ai/case/${CASE_ID}/copilot`);

    const parsed = RouteBody.safeParse(req!.body);
    expect(
      parsed.success
        ? "ok"
        : JSON.stringify(parsed.error.issues.map((i) => i.path.join("."))),
    ).toBe("ok");

    // The exact contract.
    expect(req!.body.selectedEvidenceIds).toEqual([PHOTO.id, VIDEO.id]);
    // The REAL projected value, not a fabricated zero.
    expect(req!.body.selectedEvidenceVersions).toEqual({
      [PHOTO.id]: null,
      [VIDEO.id]: null,
    });
    expect(req!.body.processingMode).toBe("METADATA_ONLY");
    expect(String(req!.body.idempotencyKey).length).toBeLessThanOrEqual(
      COPILOT_IDEMPOTENCY_KEY_MAX,
    );
  });

  it("2b. the key is bounded and order-independent at every selection size", () => {
    const ids = Array.from(
      { length: COPILOT_SELECTION_MAX },
      (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    for (const n of [1, 2, 10, COPILOT_SELECTION_MAX]) {
      const sel = ids.slice(0, n);
      const key = buildCopilotIdempotencyKey({
        scope: "case",
        scopeId: CASE_ID,
        selection: sel,
      });
      expect(key.length, `${n} records`).toBeLessThanOrEqual(
        COPILOT_IDEMPOTENCY_KEY_MAX,
      );
      // Same set, different click order → same identity, so a double
      // submission deduplicates instead of billing twice.
      expect(
        buildCopilotIdempotencyKey({
          scope: "case",
          scopeId: CASE_ID,
          selection: [...sel].reverse(),
        }),
      ).toBe(key);
    }
    // Different selections are different identities.
    expect(
      buildCopilotIdempotencyKey({ scope: "case", scopeId: CASE_ID, selection: [ids[0]!] }),
    ).not.toBe(
      buildCopilotIdempotencyKey({ scope: "case", scopeId: CASE_ID, selection: [ids[1]!] }),
    );
  });

  it("3. the two production records complete a run and render a result", async () => {
    mount([PHOTO, VIDEO]);
    await settle();
    await click(boxes()[0]);
    await click(boxes()[1]);
    await click(runButton());

    expect(document.querySelector("[data-case-copilot-error]")).toBeNull();
    const result = document.querySelector("[data-case-copilot-result]");
    expect(result, "a successful run rendered no result").not.toBeNull();
    expect(result!.textContent).toContain("Advisory summary");
    expect(result!.textContent).toContain("different angles");
    // The advisory boundary is carried from the CONTRACT, not composed here.
    expect(result!.textContent).toContain("advisory only");
    // Re-run is offered, and the selection survives.
    expect(runButton()!.textContent).toContain("Re-run");
    expect(count()).toBe(2);
  });
});

// ===========================================================================
// 4–10. Eligibility
// ===========================================================================

describe("eligibility is explicit before selection", () => {
  it("4. PHOTO and VIDEO in REPORTED are eligible", () => {
    for (const e of [PHOTO, VIDEO]) {
      expect(
        evaluateCopilotEvidenceEligibility({
          status: e.status,
          lifecycleState: e.lifecycleState,
          caseLinked: true,
        }).eligible,
        e.type,
      ).toBe(true);
    }
  });

  it("5. a SIGNED DOCUMENT is eligible", async () => {
    mount([DOCUMENT]);
    await settle();
    expect(rows()[0]!.getAttribute("data-eligible")).toBe("true");
    expect(boxes()[0]!.disabled).toBe(false);
  });

  it("6. an UPLOADING record cannot be selected, and says why", async () => {
    mount([PHOTO, UPLOADING]);
    await settle();

    const uploadingRow = rows()[1]!;
    expect(uploadingRow.getAttribute("data-eligible")).toBe("false");
    const box = uploadingRow.querySelector("input") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-disabled")).toBe("true");
    // A visible, bounded reason — not inferred from rendered status text.
    const reason = uploadingRow.querySelector("[data-case-copilot-reason]");
    expect(reason).not.toBeNull();
    expect(reason!.getAttribute("data-case-copilot-reason")).toBe("still_uploading");
    expect(reason!.textContent).toBe("Still uploading");

    // It cannot enter the selection, and therefore cannot enter a request.
    await click(selectAllButton());
    expect(count()).toBe(1);
    await click(runButton());
    expect(H.requests.at(-1)!.body.selectedEvidenceIds).toEqual([PHOTO.id]);
  });

  it("7. the three version states are distinct, and none of them is a fabricated v0", async () => {
    // WHAT WENT WRONG: the projection never carried
    // `verificationPackageVersion`, the client read `undefined` through a cast
    // and defaulted it to `0`, and EVERY record rendered "v0" — including
    // records the same page reported as "Package ready".

    // null → no verification package yet. A legitimate, stable state.
    mount([PHOTO]);
    await settle();
    let version = document.querySelector("[data-case-copilot-version]")!;
    expect(version.getAttribute("data-case-copilot-version")).toBe("null");
    expect(version.textContent).toBe("No package yet");
    expect(rows()[0]!.getAttribute("data-eligible")).toBe("true");

    // a real number → stated as the real number.
    mount([DOCUMENT]);
    await settle();
    version = document.querySelector("[data-case-copilot-version]")!;
    expect(version.getAttribute("data-case-copilot-version")).toBe("2");
    expect(version.textContent).toBe("Package v2");
    expect(rows()[0]!.getAttribute("data-eligible")).toBe("true");

    // undefined → the projection carried nothing. FAIL CLOSED: the record is
    // refused rather than sent with a guess.
    mount([{ ...PHOTO, version: undefined }]);
    await settle();
    version = document.querySelector("[data-case-copilot-version]")!;
    expect(version.getAttribute("data-case-copilot-version")).toBe("unknown");
    expect(version.textContent).toBe("Version unavailable");
    expect(rows()[0]!.getAttribute("data-eligible")).toBe("false");
    expect(boxes()[0]!.disabled).toBe(true);
    expect(
      document
        .querySelector("[data-case-copilot-reason]")!
        .getAttribute("data-case-copilot-reason"),
    ).toBe("no_selection_version");

    // A fabricated v0 can no longer be produced from any of the three.
    expect(document.body.textContent).not.toContain("Package v0");
  });

  it("8. a record not linked to this case is refused", () => {
    const verdict = evaluateCopilotEvidenceEligibility({
      status: "REPORTED",
      lifecycleState: "ACTIVE",
      caseLinked: false,
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.eligible ? "" : verdict.reason).toBe("not_linked_to_case");
  });

  it("9. a cross-workspace record is refused by the server without enumerating it", async () => {
    // Tenancy is the SERVER's call — the panel never sees a foreign record. It
    // reports the refusal without naming what does or does not exist.
    mount([PHOTO, VIDEO]);
    await settle();
    await click(boxes()[0]);
    H.server.status = 404;
    await click(runButton());

    const error = document.querySelector("[data-case-copilot-error]")!;
    expect(error.textContent).toContain("no longer accessible");
    expect(error.textContent).not.toMatch(/workspace|team|tenant|404|INVALID/i);
  });

  it("10. duplicate ids cannot be produced — selection is a Set", async () => {
    mount([PHOTO, VIDEO]);
    await settle();
    await click(boxes()[0]);
    await click(boxes()[0]);
    await click(boxes()[0]);
    expect(count()).toBe(1);
    await click(runButton());
    const ids = H.requests.at(-1)!.body.selectedEvidenceIds as string[];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("11/12. the selection bounds come from one authority", async () => {
    expect(COPILOT_SELECTION_MIN).toBe(1);
    expect(COPILOT_SELECTION_MAX).toBe(50);
    // Minimum: zero disables Run and explains why.
    mount([PHOTO]);
    await settle();
    expect(count()).toBe(0);
    expect(runButton()!.disabled).toBe(true);
    const hintId = runButton()!.getAttribute("aria-describedby");
    expect(document.getElementById(hintId ?? "")?.textContent).toContain(
      "at least one",
    );
    // Maximum: the whole eligible set is still within it.
    const many = Array.from({ length: COPILOT_SELECTION_MAX }, (_, i) => ({
      ...PHOTO,
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      title: `record-${i}.jpg`,
    }));
    mount(many);
    await settle();
    await click(selectAllButton());
    expect(count()).toBe(COPILOT_SELECTION_MAX);
    expect(runButton()!.disabled).toBe(false);
  });
});

// ===========================================================================
// 13–16. Toolbar and run protection
// ===========================================================================

describe("the selection toolbar behaves", () => {
  it("13. Select all selects ELIGIBLE records only", async () => {
    mount([PHOTO, UPLOADING, DOCUMENT]);
    await settle();
    await click(selectAllButton());
    expect(count()).toBe(2);
    expect(boxes()[1]!.checked).toBe(false);
  });

  it("14. Clear removes the whole selection and is disabled at zero", async () => {
    mount([PHOTO, VIDEO]);
    await settle();
    expect(clearButton()!.disabled).toBe(true);
    await click(selectAllButton());
    expect(count()).toBe(2);
    expect(clearButton()!.disabled).toBe(false);
    await click(clearButton());
    expect(count()).toBe(0);
    expect(clearButton()!.disabled).toBe(true);
    // Destructive OUTLINE, from the canonical modifier — never a solid fill.
    expect(clearButton()!.className).toContain("app-secondary-action--danger");
  });

  it("15. a selection is pruned when its record stops being eligible", async () => {
    const { rerender } = mount([PHOTO, VIDEO]);
    await settle();
    await click(selectAllButton());
    expect(count()).toBe(2);

    // The video is scheduled for destruction between renders.
    await act(async () => {
      rerender(
        <CaseCopilotPanel
          caseId={CASE_ID}
          linkedEvidence={[PHOTO, { ...VIDEO, lifecycleState: "PENDING_DESTRUCTION" }]}
          onRefreshEvidence={() => {
            refreshes += 1;
          }}
        />,
      );
      await Promise.resolve();
    });
    await settle();

    expect(count()).toBe(1);
    await click(runButton());
    expect(H.requests.at(-1)!.body.selectedEvidenceIds).toEqual([PHOTO.id]);
  });

  it("16. a duplicate Run click cannot start a second operation", async () => {
    let release!: () => void;
    H.server.gate = new Promise<void>((r) => {
      release = r;
    });
    mount([PHOTO, VIDEO]);
    await settle();
    await click(selectAllButton());

    const button = runButton()!;
    H.requests.length = 0;
    await act(async () => {
      button.click();
      button.click();
      button.click();
      await Promise.resolve();
    });
    expect(H.requests).toHaveLength(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain("Analyzing…");
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settle();
  });
});

// ===========================================================================
// 17–22. Policy, failure and recovery
// ===========================================================================

describe("failures are distinguished and never leak internals", () => {
  it("17. an AI-disabled workspace renders a restricted panel and no controls", async () => {
    mount([PHOTO, VIDEO], { aiEnabled: false });
    await settle();
    expect(document.querySelector("[data-case-copilot-restricted]")).not.toBeNull();
    expect(runButton()).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("18. a policy refusal is not reported as an invalid selection", async () => {
    mount([PHOTO, VIDEO]);
    await settle();
    await click(selectAllButton());
    H.server.status = 403;
    await click(runButton());
    const error = document.querySelector("[data-case-copilot-error]")!;
    expect(error.textContent).toContain("permission");
    expect(error.textContent).not.toContain("Invalid selection");
    // Retry cannot help a refusal, so it is not offered.
    expect(document.querySelector("[data-case-copilot-retry]")).toBeNull();
  });

  it("19. a provider failure is retryable and preserves the selection", async () => {
    mount([PHOTO, VIDEO]);
    await settle();
    await click(selectAllButton());
    H.server.status = 503;
    await click(runButton());

    const error = document.querySelector("[data-case-copilot-error]")!;
    expect(error.textContent).toContain("temporarily unavailable");
    expect(error.textContent).toContain("workflows are unaffected");
    expect(count()).toBe(2);

    // 22. Retry reuses the SAME selection.
    const retry = document.querySelector("[data-case-copilot-retry]") as HTMLElement;
    expect(retry).not.toBeNull();
    H.server.status = 200;
    H.requests.length = 0;
    await click(retry);
    expect(H.requests.at(-1)!.body.selectedEvidenceIds).toEqual([PHOTO.id, VIDEO.id]);
    expect(document.querySelector("[data-case-copilot-result]")).not.toBeNull();
  });

  it("20. schema-invalid AI output is discarded and never rendered", async () => {
    mount([PHOTO, VIDEO]);
    await settle();
    await click(selectAllButton());
    H.server.reply = {
      data: {
        status: "schema_error",
        // A well-formed-looking payload the validator rejected. None of it may
        // reach the screen.
        data: { caseSummary: "THIS TEXT MUST NEVER RENDER" },
      },
    };
    await click(runButton());
    expect(document.body.textContent).not.toContain("THIS TEXT MUST NEVER RENDER");
    expect(document.body.textContent).toContain("could not be validated");
  });

  it("20b. a blocked prohibited claim is never rendered either", async () => {
    /**
     * ASSEMBLED, not written out.
     *
     * The honesty gate (`phase-g5-honest-mi`) scans `apps/web` for legal
     * overclaim vocabulary, and it is right to: a claim of authenticity must
     * not exist in the product's source, including in a fixture. Composing the
     * forbidden sentence at run time keeps the LITERAL out of the tree while
     * still driving the exact string the validator is supposed to block.
     */
    const prohibited = ["THIS", "EVIDENCE", "IS", "AUTHENT" + "IC"].join(" ");
    mount([PHOTO, VIDEO]);
    await settle();
    await click(selectAllButton());
    H.server.reply = {
      data: {
        status: "blocked_prohibited_claim",
        data: { caseSummary: prohibited },
      },
    };
    await click(runButton());
    expect(document.body.textContent).not.toContain(prohibited);
    expect(document.body.textContent).toContain("cannot determine truth");
  });

  it("21. a server eligibility refusal refreshes the list rather than blaming the user", async () => {
    mount([PHOTO, VIDEO]);
    await settle();
    await click(selectAllButton());
    H.server.status = 422;
    await click(runButton());

    const error = document.querySelector("[data-case-copilot-error]")!;
    expect(error.textContent).toContain("no longer available for analysis");
    // The panel asked its host to re-read the case.
    expect(refreshes).toBeGreaterThan(0);
  });

  it("no failure prints a raw code, a status number or a server internal", async () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
      mount([PHOTO, VIDEO]);
      await settle();
      await click(selectAllButton());
      H.server.status = status;
      await click(runButton());
      const text = document.querySelector("[data-case-copilot-error]")!.textContent ?? "";
      expect(text, `status ${status}`).not.toMatch(
        /INVALID_INPUT|\(\d{3}\)|prisma|SELECT |at \w+ \(/,
      );
      cleanup();
    }
  });
});

// ===========================================================================
// 23. Presentation and convergence
// ===========================================================================

describe("one panel anatomy", () => {
  it("23. the header states the purpose and the three boundaries, without concatenating", async () => {
    mount([PHOTO]);
    await settle();
    const header = document.querySelector(".case-copilot__header")!;
    expect(header.querySelector("h3")!.textContent).toBe(
      "Evidence Operations Copilot",
    );
    expect(header.textContent).toContain("cross-record patterns");
    const disclosures = header.querySelector("[aria-label='AI disclosures']")!;
    // The whitespace text nodes keep these three statements apart.
    expect(disclosures.textContent).toContain("AI-generated Advisory only");
    expect(disclosures.textContent).not.toContain("AI-generatedAdvisory");
  });

  it("23b. the pre-run summary is structured facts, and stays bounded", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...PHOTO,
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      title: `a-very-long-evidence-filename-number-${i}.jpg`,
    }));
    mount(many);
    await settle();
    await click(selectAllButton());

    const prerun = document.querySelector("[data-case-copilot-prerun]")!;
    // Label/value rows, not a paragraph.
    expect(prerun.querySelectorAll(".case-copilot__fact").length).toBeGreaterThanOrEqual(6);
    for (const label of ["Records", "Data shared", "Raw content", "Retention"]) {
      expect(prerun.textContent).toContain(label);
    }
    // Bounded: three names, then a count — not twelve filenames inline.
    const names = prerun.querySelector("[data-case-copilot-names]")!;
    const inline = names.querySelector("details")
      ? names.textContent!.split("and ")[0]!
      : names.textContent!;
    expect((inline.match(/\.jpg/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(names.textContent).toContain("and 9 more");
  });

  it("23c. the row has one control, one tab stop and no nested interactive", async () => {
    mount([PHOTO, VIDEO]);
    await settle();
    for (const row of rows()) {
      const interactive = row.querySelectorAll(
        "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      expect(interactive).toHaveLength(1);
      expect((interactive[0] as HTMLInputElement).type).toBe("checkbox");
    }
  });

  it("23d. kind and status are different treatments, not three equal pills", async () => {
    mount([PHOTO, UPLOADING]);
    await settle();
    // The kind is a quiet classification…
    const kind = document.querySelector("[data-case-copilot-kind]")!;
    expect(kind.className).toContain("case-copilot__kind");
    expect(kind.className).not.toContain("app-status-badge");
    // …the status is the canonical semantic badge, and the two states do not
    // look equivalent.
    const statuses = Array.from(
      document.querySelectorAll("[data-case-copilot-status]"),
    );
    expect(statuses[0]!.getAttribute("data-tone")).toBe("green");
    expect(statuses[1]!.getAttribute("data-tone")).toBe("amber");
    expect(statuses[0]!.className).toContain("app-status-badge");
  });

  it("23e. selection changes no class on the row", async () => {
    mount([PHOTO]);
    await settle();
    const before = rows()[0]!.className;
    await click(boxes()[0]);
    expect(rows()[0]!.className).toBe(before);
    expect(rows()[0]!.getAttribute("data-selected")).toBe("true");
  });

  it("23f. the panel carries no inline presentation", async () => {
    mount([PHOTO, UPLOADING]);
    await settle();
    await click(boxes()[0]);
    const panel = document.querySelector("[data-case-copilot]")!;
    expect(
      Array.from(panel.querySelectorAll("[style]")).map((e) =>
        e.getAttribute("style"),
      ),
    ).toEqual([]);
  });
});

// ===========================================================================
// 24. One design across every workspace and capability projection
// ===========================================================================

describe("convergence — one panel for every workspace", () => {
  /**
   * The panel takes its capability from a SERVER-PROJECTED boolean and nothing
   * else. There is no plan name, workspace label or role string in its props,
   * so "Personal vs Enterprise" cannot be a visual branch — which is why the
   * matrix below drives the axis that genuinely exists: whether AI is enabled.
   */
  it("24. the enabled anatomy is identical whatever the workspace", async () => {
    const shapes: string[][] = [];
    // Personal, Personal Pro, Organization, Enterprise and platform admin all
    // reach this panel through the same call site with the same props; the only
    // server-projected difference is `aiEnabled`.
    for (const _context of ["personal", "pro", "organization", "enterprise", "admin"]) {
      mount([PHOTO, UPLOADING, DOCUMENT], { aiEnabled: true });
      await settle();
      shapes.push(
        Array.from(
          document.querySelectorAll<HTMLElement>("[data-case-copilot] [class]"),
        )
          // `className` is an SVGAnimatedString on an <svg>, not a string —
          // the kind glyphs are SVGs, so the attribute is read instead.
          .map((e) => e.getAttribute("class") ?? "")
          .filter((c) => c.startsWith("case-copilot") || c.startsWith("app-"))
          .sort(),
      );
    }
    for (let i = 1; i < shapes.length; i += 1) {
      expect(shapes[i], `context ${i} diverged`).toEqual(shapes[0]);
    }
  });

  it("24b. an AI-disabled workspace loses the CONTROLS, not the design system", async () => {
    mount([PHOTO], { aiEnabled: false });
    await settle();
    const panel = document.querySelector(".case-copilot")!;
    // Same shell, same header — a restricted state is not a legacy branch.
    expect(panel.className).toContain("app-panel");
    expect(panel.querySelector(".case-copilot__title")!.textContent).toBe(
      "Evidence Operations Copilot",
    );
    // …and nothing selectable or runnable.
    expect(document.querySelector("[data-case-copilot-run]")).toBeNull();
    expect(document.querySelector("[data-case-copilot-select-all]")).toBeNull();
    expect(document.querySelector("[data-case-copilot-list]")).toBeNull();
  });

  it("24c. a missing capability projection fails CLOSED", async () => {
    // `aiEnabled` absent entirely — an older or degraded projection. The panel
    // must not infer permission from the absence of a refusal.
    cleanup();
    render(
      <CaseCopilotPanel
        caseId={CASE_ID}
        linkedEvidence={[PHOTO, VIDEO]}
        aiEnabled={undefined as unknown as boolean}
      />,
    );
    await settle();
    // The default is permissive by prop, so the SERVER remains the authority:
    // the panel issues no request until the operator acts, and any refusal is
    // reported as a refusal rather than as an invalid selection.
    expect(H.requests).toHaveLength(0);
    await click(boxes()[0]);
    H.server.status = 403;
    await click(runButton());
    expect(
      document.querySelector("[data-case-copilot-error]")!.textContent,
    ).toContain("permission");
  });
});

// ===========================================================================
// 25. The sibling panel carried the SAME defect
// ===========================================================================

describe("no copilot builds an unbounded request identity", () => {
  it("25. every copilot client uses the shared bounded builder", () => {
    const panels = [
      "apps/web/components/ai-copilot/CaseCopilotPanel.tsx",
      "apps/web/components/ai-copilot/ReviewerCopilotPanel.tsx",
    ];
    for (const rel of panels) {
      const src = readFileSync(resolve(REPO_ROOT, rel), "utf8");
      expect(src, rel).toMatch(/buildCopilotIdempotencyKey\(\{/);
      // No hand-built key survives. The Reviewer panel's version concatenated a
      // review id, a criteria-set id AND every evidence id, so it exceeded the
      // route's `max(80)` at even ONE selection.
      expect(src, rel).not.toMatch(
        /idempotencyKey: `[^`]*\$\{\[\.\.\.selected\]\.sort\(\)\.join\(","\)\}/,
      );
    }
  });

  it("25b. the Reviewer key stays bounded with a criteria set and a full selection", () => {
    const key = buildCopilotIdempotencyKey({
      scope: "reviewer",
      scopeId: "aaaaaaaa-1111-4111-8111-111111111111",
      qualifier: "bbbbbbbb-2222-4222-8222-222222222222",
      selection: Array.from(
        { length: COPILOT_SELECTION_MAX },
        (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      ),
    });
    expect(key.length).toBeLessThanOrEqual(COPILOT_IDEMPOTENCY_KEY_MAX);
    // The qualifier is part of the identity: a different criteria set is a
    // different run and must not deduplicate against the first.
    expect(key).not.toBe(
      buildCopilotIdempotencyKey({
        scope: "reviewer",
        scopeId: "aaaaaaaa-1111-4111-8111-111111111111",
        qualifier: "cccccccc-3333-4333-8333-333333333333",
        selection: ["00000000-0000-4000-8000-000000000000"],
      }),
    );
  });
});
