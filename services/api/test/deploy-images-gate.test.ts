/**
 * AUD-008 — Production images publish only for a SHA whose required workflows
 * all succeeded on a push to main, and only while that SHA is still main HEAD.
 *
 * Two halves: the pure policy (`decidePublication`) is driven case by case, and
 * the workflow source is read to prove it actually routes publication through
 * that policy — a correct gate nobody calls proves nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REQUIRED_WORKFLOWS, decidePublication } from "../../../scripts/release/image-publish-gate.mjs";

const REPO = resolve(import.meta.dirname, "../../..");
const WORKFLOW = readFileSync(resolve(REPO, ".github/workflows/deploy-images.yml"), "utf8");
/** The workflow with YAML comment lines removed: prose may name what the code must not use. */
const WORKFLOW_CODE = WORKFLOW.split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

const A = "a".repeat(40);
const B = "b".repeat(40);

type Run = { head_sha: string; event: string; status: string; conclusion: string | null; run_attempt?: number };
const green = (sha: string, extra: Partial<Run> = {}): Run => ({
  head_sha: sha,
  event: "push",
  status: "completed",
  conclusion: "success",
  ...extra,
});
const allGreen = (sha: string) =>
  Object.fromEntries(REQUIRED_WORKFLOWS.map((w) => [w.file, [green(sha)]]));

describe("decidePublication", () => {
  it("publishes and tags latest when every required workflow is green on main HEAD", () => {
    expect(decidePublication({ headSha: A, mainSha: A, runs: allGreen(A) })).toEqual({
      publish: true,
      tagLatest: true,
      reason: "ALL_REQUIRED_WORKFLOWS_SUCCEEDED_ON_MAIN_HEAD",
    });
  });

  it("refuses a SHA whose required workflow failed — no sha tag, no latest", () => {
    const runs = allGreen(A);
    runs["playwright-e2e.yml"] = [green(A, { conclusion: "failure" })];
    const d = decidePublication({ headSha: A, mainSha: A, runs });
    expect(d).toMatchObject({ publish: false, tagLatest: false });
    expect(d.reason).toBe("FAILED:playwright-e2e:failure");
  });

  it("waits while a required workflow is still running or has not started", () => {
    const running = allGreen(A);
    running["ci.yml"] = [green(A, { status: "in_progress", conclusion: null })];
    expect(decidePublication({ headSha: A, mainSha: A, runs: running }).reason).toBe("WAITING_FOR:ci");

    const missing = allGreen(A);
    delete missing["schema-reproducibility.yml"];
    expect(decidePublication({ headSha: A, mainSha: A, runs: missing }).publish).toBe(false);
  });

  it("refuses a stale completion for a superseded commit", () => {
    const d = decidePublication({ headSha: A, mainSha: B, runs: allGreen(A) });
    expect(d).toEqual({ publish: false, tagLatest: false, reason: "SUPERSEDED_BY_NEWER_MAIN" });
  });

  it("does not credit another SHA's or a pull_request run's success", () => {
    const otherSha = allGreen(A);
    otherSha["ci.yml"] = [green(B)];
    expect(decidePublication({ headSha: A, mainSha: A, runs: otherSha }).publish).toBe(false);

    const prRun = allGreen(A);
    prRun["ci.yml"] = [green(A, { event: "pull_request" })];
    expect(decidePublication({ headSha: A, mainSha: A, runs: prRun }).publish).toBe(false);
  });

  it("judges by the newest attempt: a red re-run after a green one blocks", () => {
    const runs = allGreen(A);
    runs["ci.yml"] = [green(A, { run_attempt: 1 }), green(A, { run_attempt: 2, conclusion: "failure" })];
    expect(decidePublication({ headSha: A, mainSha: A, runs }).publish).toBe(false);
    runs["ci.yml"] = [green(A, { run_attempt: 1, conclusion: "failure" }), green(A, { run_attempt: 2 })];
    expect(decidePublication({ headSha: A, mainSha: A, runs }).publish).toBe(true);
  });

  it("refuses malformed SHAs and an empty requirement list", () => {
    expect(decidePublication({ headSha: "main", mainSha: A, runs: allGreen(A) }).publish).toBe(false);
    expect(decidePublication({ headSha: A, mainSha: A, runs: allGreen(A), required: [] }).publish).toBe(false);
  });

  it("requires exactly the workflows that run unfiltered on every push to main", () => {
    expect(REQUIRED_WORKFLOWS.map((w) => w.name).sort()).toEqual(
      ["ci", "playwright-e2e", "schema-reproducibility"],
    );
    for (const w of REQUIRED_WORKFLOWS) {
      const src = readFileSync(resolve(REPO, ".github/workflows", w.file), "utf8");
      expect(src).toMatch(new RegExp(`^name: ${w.name}$`, "m"));
      expect(src).toMatch(/^on:\s*\n\s{2}push:\s*\n/m);
    }
  });
});

describe("deploy-images.yml routes publication through the gate", () => {
  it("is never triggered by a raw push", () => {
    expect(WORKFLOW).not.toMatch(/^\s{2}push:/m);
    expect(WORKFLOW).toMatch(
      /workflow_run:\s*\n\s*workflows: \[ci, playwright-e2e, schema-reproducibility\]\s*\n\s*types: \[completed\]\s*\n\s*branches: \[main\]/,
    );
  });

  it("the build job needs the gate and runs only on its publish decision", () => {
    expect(WORKFLOW).toMatch(/node scripts\/release\/image-publish-gate\.mjs/);
    expect(WORKFLOW).toMatch(/needs: gate\s*\n\s*if: needs\.gate\.outputs\.publish == 'true'/);
  });

  it("tags, label and release build-arg come from the gated SHA, never github.sha", () => {
    expect(WORKFLOW_CODE).not.toMatch(/github\.sha/);
    expect(WORKFLOW_CODE).not.toMatch(/GITHUB_SHA/);
    expect(WORKFLOW_CODE).not.toMatch(/type=sha/);
    expect(WORKFLOW).toMatch(/ref: \$\{\{ needs\.gate\.outputs\.sha \}\}/);
    expect(WORKFLOW).toMatch(/type=raw,value=latest,enable=\$\{\{ needs\.gate\.outputs\.tag_latest == 'true' \}\}/);
    expect(WORKFLOW).toMatch(/org\.opencontainers\.image\.revision=\$\{\{ env\.RELEASE_SHA \}\}/);
  });

  it("is least-privilege, serialized and never cancelled mid-publication", () => {
    expect(WORKFLOW).toMatch(/^permissions: \{\}$/m);
    expect(WORKFLOW).toMatch(/concurrency:\s*\n\s*group: deploy-images-main\s*\n\s*cancel-in-progress: false/);
    expect(WORKFLOW).toMatch(/fail-fast: true/);
    expect(WORKFLOW).toMatch(/environment: production-images/);
  });

  it("the worker image's Bitcoin verifier wiring smoke runs before anything is pushed", () => {
    const smoke = WORKFLOW_CODE.indexOf("node scripts/release/smoke-worker-bitcoin-verifier.mjs proovra-worker:smoke");
    const push = WORKFLOW_CODE.indexOf("- name: Build and push image");
    expect(smoke).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(smoke);
  });

  it("a manual dispatch names a SHA and still goes through the same gate", () => {
    expect(WORKFLOW).toMatch(/workflow_dispatch:\s*\n\s*inputs:\s*\n\s*sha:/);
    expect(WORKFLOW).toMatch(/HEAD_SHA: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.sha \|\| github\.event\.workflow_run\.head_sha \}\}/);
  });
});
