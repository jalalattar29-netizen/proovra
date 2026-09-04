/**
 * HOME'S "WHAT NEEDS ATTENTION" CARD MUST NAME THE RIGHT REFUSAL.
 *
 * The card said "Operations status incomplete — not every source could be
 * read" for every refusal of the all-clear. Reproduced against the local
 * fixture, FREE personal workspace with one evidence record:
 * `GET /v1/ops/summary` answered `readiness: READY`, `complete: true`,
 * `failedSources: []`, `truncatedSources: []`, all ten required sources
 * successful — and `clearRefusalReason: UNRESOLVED_CONDITIONS`, because the
 * sweep had found three open worker-level conditions.
 *
 * Every source WAS read. The sentence was false, and it was the one sentence a
 * reader would use to decide whether to trust the page.
 *
 * What these tests protect is the distinction, not the wording: the nine
 * bounded reasons the server produces must not collapse back into one
 * sentence, and the read-failure sentence must stay attached to the three
 * reasons that are actually read failures.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mayAssertOperationsClear } from "@proovra/shared-runtime";

const WEB = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps/web",
);
const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");

const CARD = read("components/home-experience/HomeDashboardSections.tsx");
const VIEW_MODEL = read("components/home-experience/home-view-model.ts");

/** Every reason the server's gate can return. */
const ALL_REASONS = [
  "NEVER_RUN",
  "RUNNING",
  "STALE",
  "FAILED",
  "STALLED",
  "PARTIAL_SOURCES",
  "TRUNCATED_SOURCE",
  "INCIDENT_READ_INCOMPLETE",
  "UNRESOLVED_CONDITIONS",
] as const;

/** The three that genuinely mean "a source could not be read completely". */
const READ_FAILURE_REASONS = [
  "PARTIAL_SOURCES",
  "TRUNCATED_SOURCE",
  "INCIDENT_READ_INCOMPLETE",
] as const;

describe("the refusal reason reaches Home", () => {
  it("the view model carries it instead of dropping it", () => {
    /*
     * `/v1/ops/summary` has always sent `clearRefusalReason`; the Home input
     * type simply had no field for it, so it was discarded at the boundary and
     * the card had nothing to render but a guess.
     */
    expect(VIEW_MODEL).toContain("clearRefusalReason: HomeClearRefusalReason | null;");
    expect(VIEW_MODEL).toContain(
      "clearRefusalReason:\n          inputs.operationsSummary.clearRefusalReason ?? null,",
    );
  });

  it("is typed as the bounded union, not a string", () => {
    // A new server reason must break the build rather than fall through the UI
    // as an unhandled case.
    for (const reason of ALL_REASONS) {
      expect(VIEW_MODEL, `${reason} missing from the mirrored union`).toContain(
        `| "${reason}"`,
      );
    }
    expect(VIEW_MODEL).not.toContain("clearRefusalReason: string");
  });

  it("an unavailable summary carries no verdict", () => {
    // `available: false` is already the fact to render there; inventing a
    // reason for a summary that never loaded would be a second guess.
    expect(VIEW_MODEL).toContain(
      "        // No summary means no verdict to carry; `available: false` is the",
    );
  });
});

describe("the card renders the reason it was given", () => {
  it("does not attribute every refusal to a read failure", () => {
    /*
     * The exact defect. `UNRESOLVED_CONDITIONS` is the OPPOSITE of a read
     * failure — the sweep completed and found open conditions — so it must not
     * produce the read-failure sentence.
     */
    const branch = CARD.slice(
      CARD.indexOf('case "UNRESOLVED_CONDITIONS":'),
      CARD.indexOf('case "NEVER_RUN":'),
    );
    expect(branch).not.toContain("Not every source could be read");
    expect(branch).not.toContain("Operations status incomplete");
  });

  it("keeps the read-failure sentence on the three read failures", () => {
    /*
     * The fix is a classification, not a deletion. Where a source genuinely
     * could not be read completely, the original sentence is the correct one
     * and must survive.
     */
    for (const reason of READ_FAILURE_REASONS) {
      expect(CARD, `${reason} must keep the read-failure copy`).toContain(
        `case "${reason}":`,
      );
    }
    const tail = CARD.slice(CARD.indexOf('case "PARTIAL_SOURCES":'));
    expect(tail).toContain("Operations status incomplete");
    expect(tail).toContain("Not every source could be read");
  });

  it("handles every reason the server can produce", () => {
    for (const reason of ALL_REASONS) {
      expect(CARD, `${reason} has no branch`).toContain(`case "${reason}":`);
    }
  });

  it("still never says 'All clear' while the all-clear is refused", () => {
    /*
     * The contract this card exists for. Naming the refusal correctly must not
     * become a way of softening it: the reassuring branch is still reachable
     * only when `mayAssertAllClear` is true.
     */
    expect(CARD).toContain("top.length === 0 && !mayAssertAllClear ? (");
    const refusalBlock = CARD.slice(
      CARD.indexOf("const refusalCopy = (("),
      CARD.indexOf("return ("),
    );
    expect(refusalBlock).not.toContain("All clear");
  });

  it("exposes the reason to a probe, so a test can tell the states apart", () => {
    expect(CARD).toContain("data-priorities-refusal");
  });
});

describe("the server gate this mirrors", () => {
  it("UNRESOLVED_CONDITIONS is returned when the read was complete", () => {
    /*
     * Pinned against the real gate rather than restated: a run that is READY
     * with no failed or truncated source and a complete incident read still
     * refuses the all-clear when it found conditions — and the reason it gives
     * is the one the card now keys on.
     */
    const verdict = mayAssertOperationsClear({
      run: {
        readiness: "READY",
        startedAtUtc: new Date().toISOString(),
        completedAtUtc: new Date().toISOString(),
        leaseExpiresAtUtc: null,
        sourceSnapshotAtUtc: new Date().toISOString(),
        sources: {
          requiredSources: [],
          attemptedSources: [],
          successfulSources: [],
          failedSources: [],
          truncatedSources: [],
          sourceFailures: [],
        },
        safeFailureCategory: null,
        recorded: 0,
      } as never,
      incidentReadComplete: true,
      unresolvedCount: 3,
    });
    expect(verdict.clear).toBe(false);
    expect(verdict.clear === false && verdict.reason).toBe("UNRESOLVED_CONDITIONS");
  });

  it("a failed source is still PARTIAL_SOURCES, and still a read failure", () => {
    const verdict = mayAssertOperationsClear({
      run: {
        readiness: "READY",
        startedAtUtc: new Date().toISOString(),
        completedAtUtc: new Date().toISOString(),
        leaseExpiresAtUtc: null,
        sourceSnapshotAtUtc: new Date().toISOString(),
        sources: {
          requiredSources: [],
          attemptedSources: [],
          successfulSources: [],
          failedSources: ["pipeline.report_backlog"],
          truncatedSources: [],
          sourceFailures: [],
        },
        safeFailureCategory: null,
        recorded: 0,
      } as never,
      incidentReadComplete: true,
      unresolvedCount: 0,
    });
    expect(verdict.clear === false && verdict.reason).toBe("PARTIAL_SOURCES");
  });
});
