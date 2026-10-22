/**
 * An ordinary integration run leaves the tracked tree clean; only an explicit
 * regeneration writes a tracked artifact.
 *
 * The integration project used to write Point-5 proof records into the tracked
 * `docs/architecture/point5-family-proven-cases.json` on every run, racing the
 * unit project's proof gate and the audit engine that read it. These prove the
 * three parts of the fix: the guard really fails a run that dirties the tree
 * (against a real git repository), the proof writer is routed to `.p7tmp/` by
 * default, and the integration config wires both.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  changesMadeByRun,
  permittedRegenerationPaths,
  trackedChanges,
} from "./setup/tracked-tree-guard.mjs";
import guardSetup from "./setup/tracked-tree-guard.mjs";
import { PROVEN_CASES_ARTIFACT, provenCasesOutputPath } from "./point5/family-coverage-manifest.js";

const API_ROOT = resolve(import.meta.dirname, "..");
const REPO = resolve(API_ROOT, "../..");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function repoWithOneTrackedFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracked-guard-"));
  temps.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "artifact.json"), "{}\n");
  writeFileSync(join(dir, "other.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return dir;
}

describe("changesMadeByRun (real git repository)", () => {
  it("a tracked file the run modified is reported", () => {
    const dir = repoWithOneTrackedFile();
    const before = trackedChanges(dir);
    writeFileSync(join(dir, "artifact.json"), '{"rewritten":true}\n');
    expect(changesMadeByRun(before, trackedChanges(dir))).toEqual(["artifact.json"]);
  });

  it("a file already dirty BEFORE the run and edited again by it is reported; untouched ones are not", () => {
    const dir = repoWithOneTrackedFile();
    writeFileSync(join(dir, "other.txt"), "developer edit\n");
    writeFileSync(join(dir, "artifact.json"), "developer edit\n");
    const before = trackedChanges(dir);
    writeFileSync(join(dir, "artifact.json"), "run edit\n");
    expect(changesMadeByRun(before, trackedChanges(dir))).toEqual(["artifact.json"]);
  });

  it("a clean run reports nothing, and new untracked output is not a tracked change", () => {
    const dir = repoWithOneTrackedFile();
    const before = trackedChanges(dir);
    writeFileSync(join(dir, "scratch.json"), "untracked\n");
    expect(changesMadeByRun(before, trackedChanges(dir))).toEqual([]);
  });

  it("only the path an explicit regeneration names is permitted", () => {
    const dir = repoWithOneTrackedFile();
    const before = trackedChanges(dir);
    writeFileSync(join(dir, "artifact.json"), "regenerated\n");
    writeFileSync(join(dir, "other.txt"), "collateral\n");
    expect(changesMadeByRun(before, trackedChanges(dir), new Set(["artifact.json"]))).toEqual(["other.txt"]);
  });
});

describe("the guard as registered", () => {
  it("its teardown passes on the untouched checkout", () => {
    const teardown = guardSetup();
    expect(() => teardown()).not.toThrow();
  });

  it("an explicit regeneration permits exactly the canonical artifact", () => {
    const permitted = permittedRegenerationPaths({ POINT5_PROOF_OUT: "../../docs/architecture/point5-family-proven-cases.json" });
    expect([...permitted]).toEqual([PROVEN_CASES_ARTIFACT]);
    expect(permittedRegenerationPaths({}).size).toBe(0);
  });
});

describe("Point-5 proof output routing", () => {
  it("nothing is written when no proof run is in progress", () => {
    expect(provenCasesOutputPath(API_ROOT, {})).toBeNull();
    expect(provenCasesOutputPath(API_ROOT, { POINT5_PROOF_OUT: "  " })).toBeNull();
  });

  it("the integration config's default output is run-scoped, under .p7tmp, and git-ignored", () => {
    const config = readFileSync(resolve(API_ROOT, "vitest.integration.config.ts"), "utf8");
    expect(config).toMatch(
      /POINT5_PROOF_OUT:\s*\n\s*process\.env\.POINT5_PROOF_OUT \?\? `\.\.\/\.\.\/\.p7tmp\/point5-family-proven-cases\.\$\{POINT5_RUN_ID\}\.json`/,
    );
    const path = provenCasesOutputPath(API_ROOT, { POINT5_PROOF_OUT: "../../.p7tmp/point5-family-proven-cases.run-1.json" })!;
    const rel = relative(REPO, path).split("\\").join("/");
    expect(rel).toBe(".p7tmp/point5-family-proven-cases.run-1.json");
    expect(git(REPO, "check-ignore", rel).trim()).toBe(rel);
  });

  it("the integration project registers the tracked-tree guard", () => {
    const config = readFileSync(resolve(API_ROOT, "vitest.integration.config.ts"), "utf8");
    // (F-14 closure: the stale-shared-build guard runs beside it.)
    expect(config).toMatch(/globalSetup: \["\.\/test\/setup\/tracked-tree-guard\.mjs"(, "[^"]+")*\]/);
  });

  it("only the explicit regeneration script names the tracked artifact as output", () => {
    const script = readFileSync(resolve(API_ROOT, "scripts/point5-record-proof.mjs"), "utf8");
    expect(script).toContain('const ARTIFACT = "../../docs/architecture/point5-family-proven-cases.json"');
    expect(script).toContain("POINT5_PROOF_OUT: ARTIFACT");
    expect(relative(REPO, resolve(API_ROOT, "../../docs/architecture/point5-family-proven-cases.json")).split("\\").join("/"))
      .toBe(PROVEN_CASES_ARTIFACT);
  });
});
