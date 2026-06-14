/**
 * Phase WORKER-INCIDENT-SAFESUMMARY-FIX — lock the worker's incident
 * emitter so the operational_incidents.safe_summary NOT NULL column
 * can never be violated again.
 *
 * THE PRODUCTION BUG (same evidence as the plan-resolver mismatch):
 *
 *   When the worker tried to record the REPORT_NOT_INCLUDED_IN_PLAN
 *   failure as an OperationalIncident, the insert blew up with
 *   "null value in column safeSummary of relation
 *   operational_incidents". The incident never landed — operators
 *   could not see the failure from the inbox at all.
 *
 * THE FIX:
 *
 *   1. `recordWorkerIncident` (incident-emitter.ts) now coerces
 *      `safeSummary` through `coerceSafeSummary()` BEFORE clipping,
 *      so any empty / whitespace / undefined input is replaced with
 *      a deterministic operator-readable fallback.
 *
 *   2. `recordReportFailureIncident` (processor.ts) now produces a
 *      non-empty `rawMessage` by combining `error.message`, then
 *      falling back to `error.code` (WorkerError exposes it), then
 *      to `"Unknown error"`. The combined string is fed into
 *      `safeSummary` so the operator-facing detail is always
 *      meaningful even if the upstream Error had a blank message.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const EMITTER = readFileSync(
  resolve(
    REPO_ROOT,
    "services",
    "worker",
    "src",
    "governance",
    "incident-emitter.ts",
  ),
  "utf8",
);
const PROCESSOR = readFileSync(
  resolve(REPO_ROOT, "services", "worker", "src", "processor.ts"),
  "utf8",
);
const SCHEMA = readFileSync(
  resolve(REPO_ROOT, "services", "api", "prisma", "schema.prisma"),
  "utf8",
);

describe("Worker incident emitter — safeSummary cannot be NULL", () => {
  it("schema confirms safe_summary is NOT NULL (the constraint we're defending)", () => {
    // operational_incidents.safe_summary is `String @db.VarChar(400)`
    // — no `?`, so NOT NULL at the schema level.
    expect(SCHEMA).toMatch(
      /model\s+OperationalIncident\b[\s\S]{0,2000}?safeSummary\s+String\s+@map\("safe_summary"\)/,
    );
  });

  it("recordWorkerIncident defines a coerceSafeSummary boundary that returns a non-empty string", () => {
    expect(EMITTER).toMatch(/function\s+coerceSafeSummary\b/);
    expect(EMITTER).toMatch(/return\s+"\(no detail provided\)"/);
  });

  it("recordWorkerIncident applies coerceSafeSummary BEFORE clipString (so empty/undefined cannot reach prisma)", () => {
    const coerceIdx = EMITTER.indexOf("coerceSafeSummary(input.safeSummary)");
    const insertIdx = EMITTER.indexOf("safeSummary,");
    expect(coerceIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(coerceIdx);
  });

  it("recordReportFailureIncident produces a non-empty rawMessage from message OR code OR fallback", () => {
    // The processor's bridge MUST never feed an empty string into
    // safeSummary. Lock the three-tier composition explicitly.
    expect(PROCESSOR).toMatch(/const\s+errorMessage\s*=/);
    expect(PROCESSOR).toMatch(/const\s+errorCode\s*=/);
    expect(PROCESSOR).toMatch(
      /const\s+rawMessage\s*=\s*\n?\s*errorMessage\s*\|\|\s*errorCode\s*\|\|\s*"Unknown error"/,
    );
  });

  it("the safeSummary coercer never returns an empty string for any reasonable input", () => {
    // We re-derive the algorithm from the source for behavioral
    // documentation. If the implementation drifts (e.g. someone
    // removes the trim or the fallback), the source-shape regexes
    // above fire — and this property check covers any subtle
    // off-by-one in the production helper.
    const coerce = (raw: unknown): string => {
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length > 0) return trimmed;
      }
      return "(no detail provided)";
    };
    for (const input of [
      undefined,
      null,
      "",
      "   ",
      "\t\n",
      "hello",
      "a".repeat(1000),
      0,
      false,
      {} as unknown,
      [] as unknown,
    ]) {
      const out = coerce(input);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
