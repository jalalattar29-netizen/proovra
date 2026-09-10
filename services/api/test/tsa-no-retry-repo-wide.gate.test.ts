/**
 * =============================================================================
 * THE TSA NO-RETRY GATE — REPO-WIDE, EXECUTABLE, ALLOWLISTED TO ONE CALL SITE.
 * =============================================================================
 *
 * -----------------------------------------------------------------------------
 * THE INVARIANT
 * -----------------------------------------------------------------------------
 * A trusted timestamp asserts that a digest existed at a moment. Re-contacting
 * the authority after the fact mints a token whose `genTime` is LATER than the
 * evidence it certifies, and presenting that as the record's timestamp asserts
 * something untrue. So the provider is contacted exactly once, inside the
 * evidence finalization claim, and never again — not by a retry, not by a
 * regeneration, not by an operator, not by a reconciler, not by the Copilot.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS FILE REPLACES WHAT WAS THERE
 * -----------------------------------------------------------------------------
 * The invariant was guarded by two assertions inside
 * `commercial-output-journeys.test.ts`:
 *
 *     expect(strip(worker("processor.ts"))).not.toMatch(/enqueueTsa|tsaRetry|TSA_RETRY/i)
 *     expect(script).toMatch(/Never re-contacts the TSA provider/)
 *
 * The first is a regex over ONE file, and the invariant is repo-wide: a new TSA
 * call in an admin route, a script, a reconciler or a second worker module
 * passed it untouched. The second asserts that a SENTENCE EXISTS in a comment,
 * which proves a comment and not a behaviour.
 *
 * This gate instead enumerates every executable reference to the timestamping
 * authority across `services/**` and `packages/**` and compares the set against
 * a one-entry allowlist. Adding a call anywhere else fails, by name, with the
 * file that did it.
 *
 * -----------------------------------------------------------------------------
 * WHAT COUNTS AS AN EXECUTABLE CALL
 * -----------------------------------------------------------------------------
 * The scan strips line comments, block comments and string literals before it
 * looks. So a docblock that discusses `createEvidenceTimestamp`, a type that
 * names it, and a bounded reason code that mentions TSA are all invisible to it
 * — which is deliberate: this file is about what the process DOES, and the
 * codebase explains this invariant in prose in a dozen places that must stay
 * free to do so.
 *
 * Test files are excluded from the scan. A test may legitimately import the
 * authority to assert its shape (`phase-12-point4-canonical-module-integrity`
 * does exactly that), and a test does not run in production.
 *
 * -----------------------------------------------------------------------------
 * NEGATIVE CONTROL
 * -----------------------------------------------------------------------------
 * The final test proves the gate can FAIL. It runs the same detector over
 * synthetic sources — a fake admin route and a fake worker module, each with a
 * real call — and asserts they are detected, and that the comment/string forms
 * are NOT. A gate that has never been shown to fail is a gate nobody has
 * tested.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");

/** The roots the invariant covers. Named explicitly, never a bare repo walk. */
const SCANNED_ROOTS = ["services", "packages"] as const;

/**
 * Directories that are never product source.
 *
 * `dist` is excluded because it is a BUILD OUTPUT of the sources already
 * scanned — including it would report the same call twice and make the
 * allowlist depend on whether someone had run a build.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "generated",
  "prisma",
]);

/** A file that does not ship. */
function isTestFile(rel: string): boolean {
  return (
    rel.includes("/test/") ||
    rel.includes("/__tests__/") ||
    /\.test\.[cm]?tsx?$/.test(rel) ||
    /\.spec\.[cm]?tsx?$/.test(rel) ||
    /\.contract\.test\./.test(rel) ||
    /\.gate\.test\./.test(rel)
  );
}

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Remove comments and string literals.
 *
 * Order matters: strings first would swallow the `//` inside a URL, and
 * comments first would swallow a `/* *\/` sequence inside a string. Both are
 * handled in ONE left-to-right pass over the characters, which is the only way
 * to get the interaction right without a parser.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // line comment
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    // block comment
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    // string / template literal
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      // Replaced by a space so two adjacent identifiers do not fuse.
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * THE DETECTOR.
 *
 * `createEvidenceTimestamp` is the ONE exported function that contacts the
 * timestamping authority. Both its definition and every call to it are matched,
 * because either appearing outside the allowlisted file is a defect: a second
 * definition is a second authority, and a call is a second caller.
 *
 * The pattern requires an identifier boundary, so `createEvidenceTimestampInner`
 * — the private implementation inside the authority module itself — does not
 * produce a phantom hit from a substring.
 */
const TSA_AUTHORITY = /\bcreateEvidenceTimestamp\b/;

/**
 * The files permitted to reference the authority in executable code.
 *
 * TWO ENTRIES, AND BOTH ARE STRUCTURAL RATHER THAN A CONVENIENCE:
 *
 *   timestamp.service.ts      DEFINES the authority. It is the module that
 *                             contacts the provider.
 *   evidence-complete.service.ts
 *                             the SOLE caller, inside the finalization claim.
 *                             This is the "once, at finalize" half of the
 *                             invariant.
 *
 * Exact repo-relative paths, never directory prefixes: a prefix would let a
 * sibling file in the same folder inherit the permission, and the whole point
 * is that the permission belongs to two named files.
 */
const TSA_CALL_ALLOWLIST: readonly string[] = [
  "services/api/src/services/timestamp.service.ts",
  "services/api/src/services/evidence-complete.service.ts",
];

/**
 * Remove comments but KEEP string literals.
 *
 * Needed because one of the checks below is about a written VALUE
 * (`tsaStatus: "STAMPED"`), and the full strip erases the very literal it is
 * looking for. That was a real bug in the first draft of this gate: the
 * assertion passed by finding nothing, which is the worst way for a gate to
 * pass.
 */
function stripCommentsOnly(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    // Skip over a string literal WITHOUT dropping it, so an unbalanced quote
    // inside a comment cannot desynchronise the rest of the file.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

type ScannedFile = { rel: string; executable: string; withStrings: string };

const SCANNED: ScannedFile[] = SCANNED_ROOTS.flatMap((root) => {
  const abs = resolve(REPO, root);
  try {
    if (!statSync(abs).isDirectory()) return [];
  } catch {
    return [];
  }
  return walk(abs).map((full) => {
    const body = readFileSync(full, "utf8");
    return {
      rel: full.slice(REPO.length + 1).split("\\").join("/"),
      executable: stripCommentsAndStrings(body),
      withStrings: stripCommentsOnly(body),
    };
  });
}).filter((f) => !isTestFile(f.rel));

describe("TSA no-retry — repo-wide executable gate", () => {
  it("the scan actually covered the tree (guards against a silently empty walk)", () => {
    // A gate whose corpus is empty passes every assertion below. This is the
    // assertion that makes the others mean something.
    expect(SCANNED.length).toBeGreaterThan(500);
    expect(
      SCANNED.some(
        (f) => f.rel === "services/api/src/services/timestamp.service.ts",
      ),
    ).toBe(true);
    expect(
      SCANNED.some((f) => f.rel === "services/worker/src/processor.ts"),
    ).toBe(true);
  });

  it("every executable reference to the timestamping authority is allowlisted", () => {
    const referencing = SCANNED.filter((f) => TSA_AUTHORITY.test(f.executable))
      .map((f) => f.rel)
      .sort();
    expect(referencing).toEqual([...TSA_CALL_ALLOWLIST].sort());
  });

  it("the report/package pipeline does not reference it at all", () => {
    // Stated separately from the allowlist because these are the modules a
    // future change is most likely to reach from: they are where "the report
    // needs a timestamp" feels true and is not.
    const pipeline = [
      "services/worker/src/processor.ts",
      "services/worker/src/report-generation-authority.ts",
      "services/worker/src/verification-package.ts",
      "services/worker/src/ots-upgrade.processor.ts",
      "services/worker/src/lifecycle-recovery.ts",
      "services/api/src/services/reports/report-generation-authority.service.ts",
      "packages/shared-runtime/src/reports/report-generation-request.ts",
    ];
    for (const rel of pipeline) {
      const file = SCANNED.find((f) => f.rel === rel);
      expect(file, `${rel} was not scanned`).toBeTruthy();
      expect(TSA_AUTHORITY.test(file!.executable), rel).toBe(false);
    }
  });

  it("no TSA queue, job name, sweep or retry PRODUCER exists", () => {
    /*
     * The absence of a call is one half; the absence of a way to SCHEDULE one
     * is the other. A work name would be the first thing a retry needed.
     *
     * SHAPED AS A PRODUCER, NOT AS A WORD. The first draft matched a bare
     * case-insensitive "tsaRetry" word pattern, and it flagged
     * `services/api/src/services/admin/evidence-health-cohorts.service.ts` —
     * whose `const tsaRetryable = tsa?.disposition === "DIRECT_REMEDIATION"`
     * is the code that REPORTS the absence of a remediation (the registry
     * gives `tsa_failure` the disposition `NO_SAFE_REMEDIATION_AUTHORITY`, so
     * it is always false). Flagging the code that tells an operator "there is
     * no safe retry" as a retry is the gate misreading the product.
     *
     * So the patterns are producer- and work-name-shaped: an enqueue helper, a
     * call-shaped retry, or a SCREAMING_SNAKE work name. Work names in this
     * codebase are uppercase, which is why those three are case-SENSITIVE.
     */
    const PRODUCER_SHAPES = [
      /\benqueueTsa\w*\s*\(/i,
      /\bretryTsa\w*\s*\(/i,
      /\btsaRetry(Job|Queue|Producer|Sweep)\b/i,
      /\bTSA_RETRY\w*\b/,
      /\bRETRY_TSA\w*\b/,
      /\bREQUEST_TSA\w*\b/,
      /\bSTAMP_TSA\w*\b/,
    ];
    const offenders = SCANNED.filter((f) =>
      PRODUCER_SHAPES.some((re) => re.test(f.executable)),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("nothing outside the finalize path writes tsaStatus to a positive value", () => {
    /*
     * The subtler bypass: not calling the provider, but PROMOTING a row's
     * timestamp columns as though it had. `repair-tsa-failed-with-token.ts`
     * legitimately writes STAMPED — it re-parses a token the provider already
     * returned and that is already stored — so it is named here rather than
     * excluded by a pattern that would also hide a real offender.
     */
    const writers = SCANNED.filter((f) =>
      /tsaStatus\s*:\s*"(STAMPED|GRANTED|VERIFIED|SUCCEEDED)"/.test(
        /*
         * `withStrings`, NOT `executable`: the value being looked for IS a
         * string literal, and the full strip erases it. The first draft of
         * this gate used `executable` and therefore passed by finding
         * nothing — which is the worst way for a gate to pass, and is why
         * the two corpora are kept separately rather than one being derived
         * from the other at the call site.
         */
        f.withStrings,
      ),
    )
      .map((f) => f.rel)
      .sort();
    expect(writers).toEqual([
      "services/api/src/scripts/repair-tsa-failed-with-token.ts",
    ]);
  });

  it("the stored-token repair never contacts the provider", () => {
    // Behavioural, not a comment match: the script must not reference the
    // authority in executable code, which is what "re-parses the stored token"
    // means in practice.
    const script = SCANNED.find(
      (f) => f.rel === "services/api/src/scripts/repair-tsa-failed-with-token.ts",
    );
    expect(script).toBeTruthy();
    expect(TSA_AUTHORITY.test(script!.executable)).toBe(false);
  });

  // ==========================================================================
  // NEGATIVE CONTROLS — the gate must be able to fail.
  // ==========================================================================

  it("NEGATIVE CONTROL: the detector catches a call planted in a new module", () => {
    const fakeAdminRoute = `
      import { createEvidenceTimestamp } from "../services/timestamp.service.js";
      export async function restamp(id: string) {
        return createEvidenceTimestamp({ digestHex: id });
      }
    `;
    const fakeWorkerModule = `
      export async function repair(digestHex: string) {
        const result = await createEvidenceTimestamp({ digestHex });
        return result;
      }
    `;
    expect(TSA_AUTHORITY.test(stripCommentsAndStrings(fakeAdminRoute))).toBe(
      true,
    );
    expect(TSA_AUTHORITY.test(stripCommentsAndStrings(fakeWorkerModule))).toBe(
      true,
    );
  });

  it("NEGATIVE CONTROL: comments, docblocks and strings are not executable", () => {
    const prose = `
      // createEvidenceTimestamp is called once, at finalize.
      /**
       * See createEvidenceTimestamp in timestamp.service.ts for why this is
       * never retried.
       */
      const note = "createEvidenceTimestamp";
      const template = \`createEvidenceTimestamp\`;
      export const REASON = 'createEvidenceTimestamp';
    `;
    expect(TSA_AUTHORITY.test(stripCommentsAndStrings(prose))).toBe(false);
  });

  it("NEGATIVE CONTROL: the producer detector catches a planted work name and enqueue", () => {
    const plantedName = `export const JOB = { RETRY_TSA: "x" } as const;`;
    expect(/\bRETRY_TSA\w*\b/.test(stripCommentsAndStrings(plantedName))).toBe(
      true,
    );

    const plantedEnqueue = `await enqueueTsaStamp(evidenceId);`;
    expect(
      /\benqueueTsa\w*\s*\(/i.test(stripCommentsAndStrings(plantedEnqueue)),
    ).toBe(true);

    /*
     * AND THE FALSE POSITIVE THE FIRST DRAFT PRODUCED STAYS CLEAN.
     *
     * `tsaRetryable` in the admin cohorts service is the code that REPORTS the
     * absence of a safe remediation, and the first version of this gate flagged
     * it. Pinning it here keeps the narrowing deliberate: if someone widens the
     * patterns back to a bare word match, this fails and says why.
     */
    const reportsAbsence = `const tsaRetryable = tsa?.disposition === "D";`;
    const PRODUCERS = [
      /\benqueueTsa\w*\s*\(/i,
      /\bretryTsa\w*\s*\(/i,
      /\btsaRetry(Job|Queue|Producer|Sweep)\b/i,
      /\bTSA_RETRY\w*\b/,
      /\bRETRY_TSA\w*\b/,
    ];
    expect(
      PRODUCERS.some((re) => re.test(stripCommentsAndStrings(reportsAbsence))),
    ).toBe(false);
  });

  it("NEGATIVE CONTROL: a planted positive tsaStatus write is detected", () => {
    // Proves the corrected corpus choice above actually sees the literal.
    const planted = `await prisma.evidence.update({ data: { tsaStatus: "STAMPED" } });`;
    expect(
      /tsaStatus\s*:\s*"(STAMPED|GRANTED|VERIFIED|SUCCEEDED)"/.test(
        stripCommentsOnly(planted),
      ),
    ).toBe(true);
    // …and that the full strip would NOT have, which is the bug it replaces.
    expect(
      /tsaStatus\s*:\s*"(STAMPED|GRANTED|VERIFIED|SUCCEEDED)"/.test(
        stripCommentsAndStrings(planted),
      ),
    ).toBe(false);
  });
});
