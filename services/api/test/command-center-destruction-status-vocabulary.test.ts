/**
 * EVERY STATUS THE DASHBOARD ASKS FOR MUST BE ONE A WRITER CAN WRITE.
 *
 * `DestructionReview.status` is a `VARCHAR(16)`, not a database enum, so a
 * query for a status nothing ever persists is not an error — it is a count of
 * zero, returned instantly, forever. Three command-center counters asked for
 * `PROPOSED` and `PENDING_APPROVAL`, neither of which is in the canonical
 * vocabulary, and so told every workspace it had no destruction reviews
 * pending no matter how many were waiting.
 *
 * Nothing failed, nothing logged, and zero is a perfectly plausible number.
 * This is the guard that would have caught it: the statuses the dashboard
 * reads are compared against the vocabulary that owns them.
 */

import { DESTRUCTION_REVIEW_STATUSES } from "@proovra/shared";
import { describe, expect, it } from "vitest";

import {
  DESTRUCTION_REVIEW_AWAITING_DECISION,
  DESTRUCTION_REVIEW_PROPOSED,
} from "../src/services/dashboard/command-center-counters.js";

describe("COMMAND CENTER — destruction review status vocabulary", () => {
  const canonical = new Set<string>(DESTRUCTION_REVIEW_STATUSES);

  it("every status the dashboard counts is one a writer can persist", () => {
    for (const status of [
      ...DESTRUCTION_REVIEW_AWAITING_DECISION,
      ...DESTRUCTION_REVIEW_PROPOSED,
    ]) {
      expect(
        canonical.has(status),
        `"${status}" is not in DESTRUCTION_REVIEW_STATUSES — a counter on it can only ever be zero`,
      ).toBe(true);
    }
  });

  it("the statuses the counters used to ask for do not exist", () => {
    // The defect itself, pinned. If either is ever added to the vocabulary
    // this fails, and someone has to decide deliberately whether the dashboard
    // should count it — rather than inheriting a guess.
    expect(canonical.has("PROPOSED")).toBe(false);
    expect(canonical.has("PENDING_APPROVAL")).toBe(false);
  });

  it("no command-center source still reads the dead vocabulary", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));

    for (const file of [
      "../src/services/dashboard/command-center.service.ts",
      "../src/services/dashboard/command-center-counters.ts",
    ]) {
      const src = readFileSync(resolve(here, file), "utf8");
      // The comments explaining the defect name the dead values on purpose.
      // The CODE must not.
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(code, file).not.toMatch(/"PROPOSED"/);
      expect(code, file).not.toMatch(/"PENDING_APPROVAL"/);
    }
  });

  it("a deferred review is not counted as waiting on a person", () => {
    // DEFERRED is non-terminal but is waiting on a DATE. Counting it as queue
    // depth tells an operator to act on something already postponed.
    expect(DESTRUCTION_REVIEW_AWAITING_DECISION as readonly string[]).not.toContain(
      "DEFERRED",
    );
    expect(canonical.has("DEFERRED")).toBe(true);
  });

  it("a terminal review is never counted as pending", () => {
    for (const terminal of ["EXECUTED", "CANCELLED", "RESTORED"]) {
      expect(
        DESTRUCTION_REVIEW_AWAITING_DECISION as readonly string[],
      ).not.toContain(terminal);
    }
  });
});
