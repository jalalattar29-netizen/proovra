/**
 * THE RESPONSE EVIDENCE DETAILS ACTUALLY READS MUST CARRY THE LIFECYCLE VERDICT.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * The convergence attached the canonical projection to `GET /v1/evidence` (list
 * rows) and `GET /v1/evidence/:id` (detail), and a contract test pinned both.
 * Evidence Details reads NEITHER: its `evidence` comes from
 * `workspace?.evidence`, loaded from `GET /v1/evidence/:id/review-workspace`.
 * That response had no projection, so the page's eligibility helper hit its
 * "no projection, no legacy field" branch and reported "Record state is
 * loading. Try again in a moment." — permanently, for a record the Library
 * could trash.
 *
 * Two guards passed the whole time. Both were checking routes the page does not
 * call.
 *
 * WHAT THIS TEST DOES DIFFERENTLY
 * ---------------------------------------------------------------------------
 * It does not assert that a named route carries the projection. It DERIVES the
 * endpoint from the page — the URL whose result is assigned to the workspace
 * state the Details `evidence` is read from — and then requires the handler for
 * THAT endpoint to attach it. Move the page onto a different endpoint tomorrow
 * and this test follows it there.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const DETAILS_PAGE = read("apps/web/app/(app)/evidence/[id]/page.tsx");
const REVIEW_TAB = read(
  "apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx",
);
const ROUTES = read("services/api/src/routes/evidence.routes.ts");

/**
 * The endpoint whose payload becomes the Details page's `evidence`.
 *
 * The page assigns `const evidence = <state>?.evidence ?? null`, and that state
 * is filled from exactly one `apiFetch`. Both halves are read from the source
 * so the answer is the page's, not this test's.
 */
function detailsEvidenceEndpoint(): string {
  const binding = /const evidence = (\w+)\?\.evidence \?\? null/.exec(DETAILS_PAGE);
  expect(
    binding,
    "the Details page must bind its evidence from a single loaded workspace object",
  ).toBeTruthy();
  const stateName = binding![1];

  // The fetch that fills that state. `review-workspace` is the current answer;
  // the pattern is what makes this survive a rename.
  const fetches = [
    ...DETAILS_PAGE.matchAll(/apiFetch\(\s*`\/v1\/evidence\/\$\{evidenceId\}([^`]*)`/g),
  ].map((m) => m[1]);
  const candidate = fetches.find((suffix) =>
    new RegExp(`set${stateName[0].toUpperCase()}${stateName.slice(1)}|${stateName}`).test(
      DETAILS_PAGE,
    ) && suffix.includes("review-workspace"),
  );
  expect(
    candidate,
    `the page binds evidence from "${stateName}" but no /v1/evidence/:id/... fetch fills it`,
  ).toBeTruthy();
  return `/v1/evidence/:id${candidate}`;
}

/** The body of one Fastify handler, by its route literal. */
function handlerFor(routePath: string): string {
  const literal = routePath.replace(":id", ":id");
  const at = ROUTES.indexOf(`"${literal}"`);
  expect(at, `route ${literal} is not registered`).toBeGreaterThan(-1);
  // Generous window: a handler in this file runs to a few thousand lines. Over-
  // reading can only make the check more permissive about WHERE the attachment
  // sits, never about whether it exists in this handler at all — and the
  // following route's registration bounds it.
  const next = ROUTES.indexOf('app.get(\n    "/v1/', at + 10);
  return ROUTES.slice(at, next > at ? next : at + 60_000);
}

describe("Evidence Details reads its lifecycle verdict from the canonical projection", () => {
  it("the page's evidence comes from ONE loaded response", () => {
    expect(DETAILS_PAGE).toMatch(/const evidence = \w+\?\.evidence \?\? null/);
  });

  it("the endpoint that response comes from attaches the projection", () => {
    const endpoint = detailsEvidenceEndpoint();
    const handler = handlerFor(endpoint);
    expect(
      handler,
      `${endpoint} must attach EVIDENCE_LIFECYCLE_RESPONSE_FIELD — without it the ` +
        `page can only report "Record state is loading"`,
    ).toContain("[EVIDENCE_LIFECYCLE_RESPONSE_FIELD]:");
  });

  it("…using the ASYNC projection, so the union hold evaluator is consulted", () => {
    // The sync variant reads the Object Lock column and cannot see a case- or
    // workspace-scoped hold. A list of 50 rows may accept that; a detail page
    // that offers an action must not, or it advertises a click the write path
    // refuses.
    const handler = handlerFor(detailsEvidenceEndpoint());
    expect(handler).toMatch(/await projectEvidenceLifecycle\(/);
    expect(handler).not.toMatch(/projectEvidenceLifecycleSync\(/);
  });

  it("the projection is computed ONCE per response", () => {
    // The legacy `deleteEligibility` is derived from the same object, not from
    // a second lookup that could disagree with the first.
    const handler = handlerFor(detailsEvidenceEndpoint());
    const calls = handler.match(/await projectEvidenceLifecycle\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect(handler).toMatch(/toLegacyDeleteEligibility\(\s*workspaceLifecycleProjection/);
  });

  it("every projection call maps the row through ONE mapper", () => {
    // The fifteen-field mapping was written out longhand at the detail route
    // and simply absent at the review-workspace route. Nothing connected them,
    // so one response got a verdict and the other got nothing. Every call site
    // now passes the shared mapper, and an inline object literal here fails —
    // that literal IS the drift.
    const calls = [...ROUTES.matchAll(/projectEvidenceLifecycle\(\s*([^\s)])/g)];
    expect(calls.length, "the projection must be called somewhere").toBeGreaterThanOrEqual(2);
    const inline = calls.filter((m) => m[1] === "{");
    expect(
      inline.length,
      "pass toEvidenceLifecycleProjectionInput(evidence), not a hand-written literal",
    ).toBe(0);
  });

  it("a record with no team does not fail the read", () => {
    // `teamId ?? ""` made this response a 500 for every legacy personal record:
    // `""` is not a uuid. The Library listed those records; Details could not
    // open them at all.
    const handler = handlerFor(detailsEvidenceEndpoint());
    expect(handler).not.toMatch(/teamId: evidence\.teamId \?\? ""/);
    expect(handler).toMatch(/evidence\.teamId\s*\n?\s*\? await loadEvidenceAnalysisSnapshots/);
  });
});

describe("the Details lifecycle panel decides nothing itself", () => {
  it("all four actions come from the canonical projection", () => {
    for (const capability of [
      "lifecycle?.canArchive",
      "lifecycle?.canUnarchive",
      "lifecycle?.canRestoreFromTrash",
    ]) {
      expect(REVIEW_TAB, `the panel must gate on ${capability}`).toContain(capability);
    }
    // Trash goes through the shared eligibility helper, which reads `canTrash`
    // off the same projection.
    expect(REVIEW_TAB).toMatch(/const eligibility = getEvidenceDeletionEligibility\(evidence\)/);
  });

  it("the panel reads no raw lifecycle column", () => {
    for (const column of [
      "storageObjectLockLegalHoldStatus",
      "storageObjectLockRetainUntilUtc",
      "retentionUntilUtc",
    ]) {
      expect(
        REVIEW_TAB,
        `the panel must not re-derive lifecycle state from ${column}`,
      ).not.toContain(column);
    }
  });

  it("Details mutates through the canonical routes, not a legacy path", () => {
    // Same four routes the Library uses; all of them run
    // `applyEvidenceLifecycleAction`.
    expect(DETAILS_PAGE).toMatch(/apiFetch\(`\/v1\/evidence\/\$\{evidenceId\}`, \{ method: "DELETE" \}\)/);
    expect(DETAILS_PAGE).toMatch(/`\/v1\/evidence\/\$\{evidenceId\}\/restore`/);
    expect(DETAILS_PAGE).toMatch(/`\/v1\/evidence\/\$\{evidenceId\}\/archive`/);
    expect(DETAILS_PAGE).toMatch(/`\/v1\/evidence\/\$\{evidenceId\}\/unarchive`/);
  });

  it("every mutation reloads the workspace, so the panel re-reads the verdict", () => {
    // Without the reload the panel would keep rendering the pre-mutation
    // projection, which is the other way to show a state that is not true.
    const body = DETAILS_PAGE;
    for (const fn of ["moveToTrash", "restoreTrash", "runRecordAction"]) {
      const at = body.indexOf(`const ${fn} = async`);
      expect(at, `${fn} must exist`).toBeGreaterThan(-1);
      expect(
        body.slice(at, at + 1200),
        `${fn} must reload the workspace so the lifecycle verdict is re-read`,
      ).toContain("await loadWorkspace()");
    }
  });
});
