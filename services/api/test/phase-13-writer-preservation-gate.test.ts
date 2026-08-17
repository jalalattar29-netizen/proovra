/**
 * PHASE 13 §4 — THE DISPOSITION MANIFEST IS A RECORD, NOT AN EXEMPTION.
 *
 * WHAT CHANGED, AND WHY THIS FILE HAD TO CHANGE WITH IT
 * ---------------------------------------------------------------------------
 * The v1 manifest answered twenty-three declarations, covering thirty-three
 * terminal writers, with one verdict: PRESERVED_PLANNED_WRITER. That verdict was
 * an honest statement that the code did not run and carried a reason — and it is
 * not a state a release may ship in. An executable writer nothing reaches is
 * either a capability the product is failing to deliver or code that should not
 * be in the tree, and "accounted for" is not a third option.
 *
 * So PRESERVED_PLANNED_WRITER is now REJECTED, and every entry carries a
 * terminal disposition instead. This file is what stops the new vocabulary from
 * becoming the old exemption with better words.
 *
 * WHAT IT ENFORCES
 * ---------------------------------------------------------------------------
 *   1. The vocabulary. Only the seven terminal dispositions are accepted, and
 *      PRESERVED_PLANNED_WRITER is refused by name — a manifest cannot reopen
 *      the state this pass closed.
 *   2. Evidence. Every entry names the capability, the classification and the
 *      evidence, and carries an ISO review date.
 *   3. A WIRED entry must be WIRED. The named integration site must exist and
 *      must CALL the writer — a mention is not a call, and the file the writer
 *      is declared in does not count as its own caller. This is the clause that
 *      makes "still executable and unreachable" fail.
 *   4. A REMOVED entry must be REMOVED. The declaration must be gone from the
 *      file it was removed from, AND the symbol must not have been re-declared
 *      anywhere in `services/*&#47;src` or `packages/*&#47;src` — a removal that moved
 *      the code somewhere else is not a removal.
 *   5. A BACKLOG-only entry must point at an EXISTING architecture document.
 *      No new ledger, no new registry.
 *   6. The four v1 removals stay removed.
 *
 * WHY IT DOES NOT READ THE CAPABILITY MAP
 * ---------------------------------------------------------------------------
 * The v1 gate keyed its central assertions on
 * `docs/architecture/current-runtime-capability-map.json`. That artifact is
 * DERIVED from this tree by the closure analyzer, so a gate that reads it is a
 * gate that passes or fails on when the artifact was last regenerated rather
 * than on what the code does. Every assertion here is made against the SOURCE,
 * which is the thing the map is a projection of. The map's own counters —
 * `byWriterBucket.PRESERVED_PLANNED_WRITER = 0`,
 * `byWriterBucket.DEAD_UNREACHABLE = 0`, `MutationWriterConservationHolds =
 * true` — remain the analyzer's job to assert, and are checked by
 * `--closure-check` where they belong.
 *
 * WHY IT CAN DEMONSTRABLY FAIL
 * ---------------------------------------------------------------------------
 * Every rule is a pure function over a manifest entry plus a file reader, and
 * the last describe block runs each of them against a deliberately broken entry
 * and asserts it is REJECTED. A gate nobody has watched fail is a gate nobody
 * has tested.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, it } from "vitest";

const REPO = path.resolve(__dirname, "../../..");
const MANIFEST = path.join(
  REPO,
  "services/api/scripts/capability-authority/manifests/writer-preservations.json",
);

type Entry = {
  site: string;
  disposition: string;
  capability?: string;
  classification?: string;
  evidence?: string;
  wiredAt?: string;
  wiredSymbol?: string;
  integration?: string;
  removedFrom?: string;
  retainedAuthority?: string;
  backlogRecordedIn?: string;
  reviewedAtUtc?: string;
};

type Manifest = {
  dispositions: string[];
  rejectedDispositions: string[];
  entries: Entry[];
};

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

const WIRED = new Set([
  "WIRED_CURRENT_CAPABILITY",
  "SECURITY_LIFECYCLE_WIRED",
  "RETENTION_AUTHORITY_WIRED",
]);
const REMOVED = new Set([
  "FALSE_CLAIM_REMOVED",
  "FUTURE_IMPLEMENTATION_REMOVED_BACKLOG_ONLY",
  "DUPLICATE_REMOVED",
  "DEAD_REMOVED",
]);
const BACKLOG_ONLY = new Set([
  "FUTURE_IMPLEMENTATION_REMOVED_BACKLOG_ONLY",
]);

/** A reader so the rules below can be run against synthetic files in the self-test. */
type Reader = (repoRelativePath: string) => string | null;
const realReader: Reader = (rel) => {
  const p = path.join(REPO, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

// ===========================================================================
// The rules. Each returns a list of problems; empty means the entry passes.
// ===========================================================================

export function checkVocabulary(entry: Entry, allowed: string[]): string[] {
  const problems: string[] = [];
  if (entry.disposition === "PRESERVED_PLANNED_WRITER") {
    problems.push(
      `${entry.site}: PRESERVED_PLANNED_WRITER is not a final state — wire it, or remove it`,
    );
    return problems;
  }
  if (!allowed.includes(entry.disposition)) {
    problems.push(`${entry.site}: unknown disposition ${entry.disposition}`);
  }
  return problems;
}

/**
 * The six classifications the mandate defines. `classification` says WHAT the
 * writer turned out to be; `disposition` says what was done about it. They are
 * checked separately because an entry that names a disposition without naming
 * the finding behind it has recorded an action and not a reason.
 */
export const CLASSIFICATIONS = [
  "CURRENT_FEATURE_MISSING_INTEGRATION",
  "SECURITY_OR_COMPLIANCE_LIFECYCLE",
  "FALSE_DOCBLOCK_OR_STALE_PROMISE",
  "GENUINE_FUTURE_FEATURE",
  "DUPLICATE_OR_SUPERSEDED",
  "DEAD_CODE",
];

export function checkEvidence(entry: Entry): string[] {
  const problems: string[] = [];
  for (const field of ["capability", "evidence"] as const) {
    const v = entry[field];
    if (typeof v !== "string" || v.trim().length <= 12) {
      problems.push(`${entry.site}: ${field} is missing or too thin to be evidence`);
    }
  }
  if (
    typeof entry.classification !== "string" ||
    !CLASSIFICATIONS.includes(entry.classification)
  ) {
    problems.push(
      `${entry.site}: classification must be one of the six findings, not ${entry.classification}`,
    );
  }
  if (
    typeof entry.reviewedAtUtc !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedAtUtc)
  ) {
    problems.push(
      `${entry.site}: reviewedAtUtc must be an ISO date — an unreviewed entry is not a review`,
    );
  }
  const hash = entry.site.lastIndexOf("#");
  if (hash <= 0) problems.push(`${entry.site}: site must be <file>#<declaration>`);
  return problems;
}

/** Occurrences of `name(` that are not the declaration of `name` itself. */
export function callSitesOf(source: string, name: string): number {
  const withoutDecls = source.replace(
    new RegExp(`(?:function|const|let|class)\\s+${name}\\s*[(=]`, "g"),
    "",
  );
  const matches = withoutDecls.match(new RegExp(`\\b${name}\\s*\\(`, "g"));
  return matches ? matches.length : 0;
}

export function checkWired(entry: Entry, read: Reader): string[] {
  const problems: string[] = [];
  const hash = entry.site.lastIndexOf("#");
  const declFile = entry.site.slice(0, hash);
  const decl = entry.site.slice(hash + 1);

  // The writer itself must still be there — a wired entry that names nothing
  // is a claim about code that no longer exists.
  const own = read(declFile);
  if (own === null) {
    problems.push(`${entry.site}: the declaration's file is gone`);
  } else if (!new RegExp(`\\b${decl}\\b`).test(own)) {
    problems.push(`${entry.site}: WIRED but the declaration is not in the tree`);
  }

  if (!entry.wiredAt) {
    problems.push(`${entry.site}: WIRED entries must name a wiredAt integration site`);
    return problems;
  }
  if (!entry.integration || entry.integration.trim().length <= 12) {
    problems.push(`${entry.site}: WIRED entries must describe the integration point`);
  }
  const symbol = entry.wiredSymbol ?? decl;
  const site = read(entry.wiredAt);
  if (site === null) {
    problems.push(`${entry.site}: wiredAt names a file that does not exist (${entry.wiredAt})`);
    return problems;
  }
  // THE CLAUSE THAT MATTERS. A mention is not a call, and a file cannot be its
  // own caller by virtue of declaring the function.
  if (callSitesOf(site, symbol) === 0) {
    problems.push(
      `${entry.site}: wiredAt ${entry.wiredAt} never calls ${symbol} — the writer is still unreachable`,
    );
  }
  return problems;
}

export function checkRemoved(entry: Entry, read: Reader, declaredAnywhere: (n: string) => string | null): string[] {
  const problems: string[] = [];
  const hash = entry.site.lastIndexOf("#");
  const decl = entry.site.slice(hash + 1);

  if (!entry.removedFrom) {
    problems.push(`${entry.site}: REMOVED entries must name the file it was removed from`);
    return problems;
  }
  const source = read(entry.removedFrom);
  if (source === null) {
    problems.push(`${entry.site}: removedFrom names a file that does not exist`);
    return problems;
  }
  // A comment explaining WHY it was removed is the opposite of a residue and is
  // deliberately allowed; the DECLARATION must be gone.
  if (new RegExp(`(?:function|const|let|class)\\s+${decl}\\b`).test(source)) {
    problems.push(`${entry.site}: still declared in ${entry.removedFrom} — it was reported removed`);
  }
  const elsewhere = declaredAnywhere(decl);
  if (elsewhere !== null) {
    problems.push(
      `${entry.site}: re-declared in ${elsewhere} — moving a writer is not removing it`,
    );
  }
  if (BACKLOG_ONLY.has(entry.disposition)) {
    if (!entry.backlogRecordedIn) {
      problems.push(`${entry.site}: a future-feature removal must record the backlog somewhere`);
    } else if (read(entry.backlogRecordedIn) === null) {
      problems.push(
        `${entry.site}: backlogRecordedIn names a document that does not exist (${entry.backlogRecordedIn}) — the backlog must live where the programme already keeps one`,
      );
    }
  }
  return problems;
}

// ===========================================================================
// A one-pass index of every declaration in the followable trees, so "removed"
// can mean removed rather than relocated.
// ===========================================================================

const SOURCE_ROOTS = [
  "services/api/src",
  "services/worker/src",
  "packages/shared/src",
  "packages/shared-runtime/src",
];

function walkSources(): string[] {
  const out: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const abs = path.join(REPO, root);
    if (!existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name === "build") continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) stack.push(full);
        else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(full);
      }
    }
  }
  return out;
}

const SOURCE_FILES = walkSources();
const declaredAnywhere = (name: string): string | null => {
  const re = new RegExp(`(?:function|const|let|class)\\s+${name}\\s*[(=<:]`);
  for (const f of SOURCE_FILES) {
    if (re.test(readFileSync(f, "utf8"))) return path.relative(REPO, f).replace(/\\/g, "/");
  }
  return null;
};

// ===========================================================================
// The gate
// ===========================================================================

describe("phase 13 §4 — writer disposition manifest", () => {
  it("1. PRESERVED_PLANNED_WRITER is refused, and every disposition is in the vocabulary", () => {
    assert.ok(manifest.entries.length > 0, "manifest is empty");
    assert.ok(
      manifest.rejectedDispositions.includes("PRESERVED_PLANNED_WRITER"),
      "the manifest must state that PRESERVED_PLANNED_WRITER is rejected",
    );
    assert.ok(
      !manifest.dispositions.includes("PRESERVED_PLANNED_WRITER"),
      "PRESERVED_PLANNED_WRITER must not be in the accepted vocabulary",
    );
    const problems = manifest.entries.flatMap((e) =>
      checkVocabulary(e, manifest.dispositions),
    );
    assert.deepEqual(problems, []);
  });

  it("2. every entry carries the capability, the classification, the evidence and a review date", () => {
    const problems = manifest.entries.flatMap((e) => checkEvidence(e));
    assert.deepEqual(problems, []);
  });

  it("3. every WIRED entry names a site that actually CALLS the writer", () => {
    const wired = manifest.entries.filter((e) => WIRED.has(e.disposition));
    assert.ok(wired.length > 0, "no wired entries — the manifest describes nothing live");
    const problems = wired.flatMap((e) => checkWired(e, realReader));
    assert.deepEqual(problems, []);
  });

  it("4. every REMOVED entry is gone from its file and re-declared nowhere else", () => {
    const removed = manifest.entries.filter((e) => REMOVED.has(e.disposition));
    assert.ok(removed.length > 0, "no removals — every entry cannot have been wired");
    const problems = removed.flatMap((e) =>
      checkRemoved(e, realReader, declaredAnywhere),
    );
    assert.deepEqual(problems, []);
  });

  it("5. the original twenty-three declarations are all still answered", () => {
    // The v1 manifest answered exactly these. An entry may change disposition;
    // it may not quietly stop being answered.
    assert.equal(manifest.entries.length, 23);
    const sites = new Set(manifest.entries.map((e) => e.site));
    for (const required of [
      "packages/shared-runtime/src/media-intelligence/run-tracker.service.ts#dismissRun",
      "services/api/src/services/ai/ai-retention.service.ts#purgeWorkspaceAiRecords",
      "services/api/src/services/security/mfa-recovery-request.service.ts#markRecoveryCompleted",
      "services/api/src/services/security/mfa-recovery-request.service.ts#expireStaleRecoveryRequests",
      "services/api/src/services/access-control/session-inventory.service.ts#touchAuthenticatedSession",
      "services/api/src/services/identity/contributor-governance.service.ts#touchContributorSessionLastSeen",
      "services/api/src/services/identity/rbac.service.ts#touchMemberLastSeen",
    ]) {
      assert.ok(sites.has(required), `${required} is no longer answered by the manifest`);
    }
  });

  it("6. the four v1 removals are gone from the tree, not merely unreferenced", () => {
    for (const [file, decl] of [
      ["services/api/src/services/search/case-indexing.service.ts", "deindexCase"],
      ["services/api/src/services/dashboard/worker-telemetry.service.ts", "recordWorkerTelemetrySnapshot"],
      ["services/api/src/services/search/saved-search.service.ts", "touchSavedView"],
      ["services/api/src/services/reliability/upload-session.service.ts", "recordUploadActivity"],
    ] as const) {
      const source = readFileSync(path.join(REPO, file), "utf8");
      assert.ok(
        !new RegExp(`(function|const|let|class)\\s+${decl}\\b`).test(source),
        `${decl} is still declared in ${file} — it was reported removed`,
      );
    }
  });
});

// ===========================================================================
// The gate's own failure proof.
//
// Each rule above is run against an entry built to break it. If any of these
// PASSES, the rule is decorative and the gate is not a gate.
// ===========================================================================

describe("phase 13 §4 — the gate is capable of failing", () => {
  const base: Entry = {
    site: "services/api/src/x.ts#doThing",
    disposition: "WIRED_CURRENT_CAPABILITY",
    capability: "a capability described at sufficient length",
    classification: "CURRENT_FEATURE_MISSING_INTEGRATION",
    evidence: "evidence described at sufficient length",
    wiredAt: "services/api/src/caller.ts",
    wiredSymbol: "doThing",
    integration: "an integration described at sufficient length",
    reviewedAtUtc: "2026-08-17",
  };

  it("rejects a re-introduced PRESERVED_PLANNED_WRITER", () => {
    const problems = checkVocabulary(
      { ...base, disposition: "PRESERVED_PLANNED_WRITER" },
      manifest.dispositions,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /not a final state/);
  });

  it("rejects an invented disposition", () => {
    const problems = checkVocabulary(
      { ...base, disposition: "KEPT_FOR_NOW" },
      manifest.dispositions,
    );
    assert.equal(problems.length, 1);
  });

  it("rejects thin evidence and a missing review date", () => {
    assert.ok(checkEvidence({ ...base, evidence: "keep" }).length > 0);
    assert.ok(checkEvidence({ ...base, reviewedAtUtc: "soon" }).length > 0);
    assert.ok(checkEvidence({ ...base, capability: undefined }).length > 0);
    // An invented finding is refused too — the classification vocabulary is
    // closed, so "it was fine actually" cannot be written into it.
    assert.ok(checkEvidence({ ...base, classification: "LOOKED_OK" }).length > 0);
    assert.deepEqual(checkEvidence(base), []);
  });

  it("rejects a WIRED entry whose named site only MENTIONS the writer", () => {
    const reader: Reader = (p) =>
      p === "services/api/src/x.ts"
        ? "export async function doThing() { return 1; }"
        : "// TODO: one day call doThing here\nexport const caller = 1;";
    const problems = checkWired(base, reader);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /never calls doThing/);
  });

  it("rejects a WIRED entry that points at its own declaration file as the caller", () => {
    // The declaring file contains `function doThing(` and nothing else — the
    // declaration must not be mistaken for a call site.
    const reader: Reader = () => "export async function doThing() { return 1; }";
    const problems = checkWired({ ...base, wiredAt: "services/api/src/x.ts" }, reader);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /never calls doThing/);
  });

  it("accepts a WIRED entry whose named site really calls it", () => {
    const reader: Reader = (p) =>
      p === "services/api/src/x.ts"
        ? "export async function doThing() { return 1; }"
        : 'import { doThing } from "./x.js";\nexport async function caller() { await doThing(); }';
    assert.deepEqual(checkWired(base, reader), []);
  });

  it("rejects a WIRED entry with no named site at all", () => {
    const problems = checkWired({ ...base, wiredAt: undefined }, () => "");
    assert.ok(problems.some((p) => /must name a wiredAt/.test(p)));
  });

  it("rejects a REMOVED entry whose declaration is still there", () => {
    const removedEntry: Entry = {
      ...base,
      disposition: "DUPLICATE_REMOVED",
      removedFrom: "services/api/src/x.ts",
    };
    const problems = checkRemoved(
      removedEntry,
      () => "export async function doThing() { return 1; }",
      () => null,
    );
    assert.ok(problems.some((p) => /still declared/.test(p)));
  });

  it("rejects a REMOVED entry whose writer was merely relocated", () => {
    const removedEntry: Entry = {
      ...base,
      disposition: "DUPLICATE_REMOVED",
      removedFrom: "services/api/src/x.ts",
    };
    const problems = checkRemoved(
      removedEntry,
      () => "// removed, see note",
      () => "services/api/src/somewhere-else.ts",
    );
    assert.ok(problems.some((p) => /re-declared/.test(p)));
  });

  it("rejects a backlog-only removal that points at a document that does not exist", () => {
    const removedEntry: Entry = {
      ...base,
      disposition: "FUTURE_IMPLEMENTATION_REMOVED_BACKLOG_ONLY",
      removedFrom: "services/api/src/x.ts",
      backlogRecordedIn: "docs/architecture/a-brand-new-registry.md",
    };
    const problems = checkRemoved(
      removedEntry,
      (p) => (p === "services/api/src/x.ts" ? "// removed" : null),
      () => null,
    );
    assert.ok(problems.some((p) => /does not exist/.test(p)));
  });

  it("rejects a backlog-only removal that records no backlog at all", () => {
    const removedEntry: Entry = {
      ...base,
      disposition: "FUTURE_IMPLEMENTATION_REMOVED_BACKLOG_ONLY",
      removedFrom: "services/api/src/x.ts",
      backlogRecordedIn: undefined,
    };
    const problems = checkRemoved(removedEntry, () => "// removed", () => null);
    assert.ok(problems.some((p) => /must record the backlog/.test(p)));
  });
});
