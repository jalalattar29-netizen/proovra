/**
 * PHASE 12 — POINT 8 PART B: the Staging deployment guard's refusals.
 *
 * The only deployment automation this repository has publishes `:latest` to
 * GHCR on every push to `main`. A staging workflow written by copying it is one
 * typo away from a production release, and Part A established that such a typo
 * survives here — every check ran against a developer's working tree, none
 * against what actually ships.
 *
 * So each of the eight conditions the mandate requires the staging path to
 * refuse is proved by handing the guard a request that is wrong in exactly that
 * one way. The eighth proves a clean staging configuration is ACCEPTED, without
 * which the other seven would be satisfied by a guard that refuses everything.
 *
 * The guard is pure: no socket, no secret, no ambient environment.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  validateStagingDeploy,
  validateStagingWorkflowSource,
  PRODUCTION_SECRET_NAMES,
  type StagingDeployRequest,
} from "../scripts/staging-deploy-guard.mjs";
import { REQUIRED_STAGING_INPUTS, runPreflight, selectionFromEnv } from "../scripts/staging-preflight-cli.mjs";
import { syntheticStripeLiveSecret, syntheticStripeTestSecret } from "./point8/synthetic-credentials.js";

const REPO = resolve(import.meta.dirname, "../../..");

/** A request that should be accepted. Every case below breaks exactly one thing. */
const CLEAN = {
  ref: "refs/heads/release-candidate/p8",
  environment: "staging",
  imageTags: ["ghcr.io/owner/proovra-api:sha-1e57ae8"],
  secretRefs: { STAGING_DATABASE_URL: "secrets.STAGING_DATABASE_URL" },
  wave: "A_B",
  contractRehearsalApproved: false,
  preflightPassed: true,
  buildIds: { api: "rc-abc", worker: "rc-abc", web: "rc-abc" },
};

const rules = (r: ReturnType<typeof validateStagingDeploy>) => r.refusals.map((f) => f.rule);

describe("PHASE 12 — POINT 8 B2: the staging deploy guard refuses each unsafe request", () => {
  it("8 — a clean staging configuration is ACCEPTED (without this the rest is vacuous)", () => {
    const r = validateStagingDeploy(CLEAN);
    expect(r.refusals).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("1 — a `main` target is refused", () => {
    for (const branch of ["main", "master", "production", "release"]) {
      const r = validateStagingDeploy({ ...CLEAN, ref: `refs/heads/${branch}` });
      expect(rules(r), branch).toContain("PRODUCTION_TRIGGER_BRANCH");
      expect(r.ok).toBe(false);
    }
  });

  it("2 — a production environment is refused", () => {
    for (const env of ["production", "prod", "live"]) {
      expect(rules(validateStagingDeploy({ ...CLEAN, environment: env }))).toContain("PRODUCTION_ENVIRONMENT");
    }
    // And an environment that is merely not staging is refused too, so a typo
    // does not silently deploy into an unnamed environment.
    expect(rules(validateStagingDeploy({ ...CLEAN, environment: "stagng" }))).toContain(
      "NON_STAGING_ENVIRONMENT",
    );
  });

  it("3 — a production secret name or reference is refused", () => {
    const byName = validateStagingDeploy({
      ...CLEAN,
      secretRefs: { DATABASE_URL: "secrets.DATABASE_URL" },
    });
    expect(rules(byName)).toContain("PRODUCTION_SECRET_NAME");

    const byReference = validateStagingDeploy({
      ...CLEAN,
      secretRefs: { STAGING_DATABASE_URL: "secrets.PROD_DATABASE_URL" },
    });
    expect(rules(byReference)).toContain("PRODUCTION_SECRET_REFERENCE");

    // Every production secret name is covered, not just the one tested above.
    for (const name of PRODUCTION_SECRET_NAMES) {
      const r = validateStagingDeploy({ ...CLEAN, secretRefs: { [name]: `secrets.${name}` } });
      expect(rules(r), name).toContain("PRODUCTION_SECRET_NAME");
    }
  });

  it("4 — a mutable image tag is refused, and so is naming none", () => {
    expect(rules(validateStagingDeploy({ ...CLEAN, imageTags: ["ghcr.io/o/proovra-api:latest"] }))).toContain(
      "MUTABLE_IMAGE_TAG",
    );
    expect(rules(validateStagingDeploy({ ...CLEAN, imageTags: [] }))).toContain("NO_IMAGE_TAG");
  });

  it("5 — a deploy without a green preflight is refused", () => {
    expect(rules(validateStagingDeploy({ ...CLEAN, preflightPassed: false }))).toContain(
      "PREFLIGHT_NOT_PASSED",
    );
    // Absent is not the same as true.
    expect(rules(validateStagingDeploy({ ...CLEAN, preflightPassed: undefined }))).toContain(
      "PREFLIGHT_NOT_PASSED",
    );
  });

  it("6 — a deferred Contract/Drop wave is refused unless the rehearsal is explicitly approved", () => {
    expect(rules(validateStagingDeploy({ ...CLEAN, wave: "D" }))).toContain("DEFERRED_CONTRACT_WAVE");
    // The Point-6 runbook DOES assign Release D to an isolated Staging
    // rehearsal, so an explicit opt-in is allowed — and only then.
    const approved = validateStagingDeploy({ ...CLEAN, wave: "D", contractRehearsalApproved: true });
    expect(approved.refusals).toEqual([]);
    // An unknown wave is refused whatever the flag says.
    expect(
      rules(validateStagingDeploy({ ...CLEAN, wave: "E", contractRehearsalApproved: true })),
    ).toContain("DEFERRED_CONTRACT_WAVE");
  });

  it("7 — mixed or missing build ids are refused", () => {
    expect(
      rules(validateStagingDeploy({ ...CLEAN, buildIds: { api: "rc-abc", worker: "rc-def", web: "rc-abc" } })),
    ).toContain("MIXED_BUILD_IDS");
    expect(
      rules(validateStagingDeploy({ ...CLEAN, buildIds: { api: "rc-abc", worker: "", web: "rc-abc" } })),
    ).toContain("MISSING_BUILD_ID");
  });

  it("every refusal rule is reachable — none is dead code", () => {
    const reached = new Set<string>();
    // Annotated: each case overrides a different key, and TypeScript otherwise
    // unions the literal shapes into something no longer assignable.
    const cases: Array<Partial<StagingDeployRequest>> = [
      { ...CLEAN, ref: "refs/heads/main" },
      { ...CLEAN, environment: "production" },
      { ...CLEAN, environment: "nope" },
      { ...CLEAN, secretRefs: { DATABASE_URL: "secrets.DATABASE_URL" } },
      { ...CLEAN, secretRefs: { STAGING_X: "secrets.PRODUCTION_X" } },
      { ...CLEAN, imageTags: ["x:latest"] },
      { ...CLEAN, imageTags: [] },
      { ...CLEAN, preflightPassed: false },
      { ...CLEAN, wave: "D" },
      { ...CLEAN, buildIds: { api: "a", worker: "b", web: "c" } },
      { ...CLEAN, buildIds: { api: "a", worker: "", web: "c" } },
    ];
    for (const c of cases) for (const f of validateStagingDeploy(c).refusals) reached.add(f.rule);
    expect([...reached].sort()).toEqual([
      "MISSING_BUILD_ID",
      "MIXED_BUILD_IDS",
      "MUTABLE_IMAGE_TAG",
      "NON_STAGING_ENVIRONMENT",
      "NO_IMAGE_TAG",
      "PREFLIGHT_NOT_PASSED",
      "PRODUCTION_ENVIRONMENT",
      "PRODUCTION_SECRET_NAME",
      "PRODUCTION_SECRET_REFERENCE",
      "PRODUCTION_TRIGGER_BRANCH",
      "DEFERRED_CONTRACT_WAVE",
    ].sort());
  });
});

describe("PHASE 12 — POINT 8 B2: the committed staging workflow satisfies its own guard", () => {
  const source = readFileSync(resolve(REPO, ".github/workflows/deploy-staging.yml"), "utf8");
  /**
   * The workflow's header explains what it refuses, so it NAMES `latest`,
   * `main` and `prisma migrate deploy` in prose. Asserting over the raw text
   * would fail on the explanation rather than on the configuration — the same
   * trap `stripSqlComments` exists for on the migration side.
   */
  const code = source
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s#.*$/, "")))
    .join("\n");

  it("the workflow file passes the source guard", () => {
    const r = validateStagingWorkflowSource(source);
    expect(r.refusals).toEqual([]);
  });

  it("it is manual only — no push trigger on any branch", () => {
    expect(code).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(code).not.toMatch(/^\s{2}push:/m);
  });

  it("it deploys through the wave selector, never a bare migrate deploy", () => {
    expect(code).toMatch(/release-deploy\.mjs .*--wave/);
    expect(code).not.toMatch(/prisma migrate deploy/);
  });

  it("it runs the credential preflight before it applies anything", () => {
    const preflightAt = code.indexOf("staging-preflight-cli.mjs");
    const migrateAt = code.indexOf("Apply the selected wave");
    expect(preflightAt).toBeGreaterThan(-1);
    expect(migrateAt).toBeGreaterThan(preflightAt);
  });

  it("the PRODUCTION workflow is untouched and still the only main-triggered one", () => {
    const prod = readFileSync(resolve(REPO, ".github/workflows/deploy-images.yml"), "utf8");
    expect(prod).toMatch(/branches: \[main\]/);
    // The staging path must not have acquired a main trigger.
    expect(code).not.toMatch(/branches:/);
  });

  it("the source guard REFUSES a workflow that reaches production", () => {
    // Without this the source guard could be vacuous.
    const bad = source
      .replace("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch_disabled:")
      .replace("environment: staging", "environment: production");
    const r = validateStagingWorkflowSource(bad);
    expect(r.ok).toBe(false);
    expect(r.refusals.map((f) => f.rule)).toEqual(
      expect.arrayContaining(["PRODUCTION_BRANCH_TRIGGER", "PRODUCTION_ENVIRONMENT"]),
    );
  });
});

describe("PHASE 12 — POINT 8 C3: the staging preflight command", () => {
  it("reports every required STAGING_* input as missing on a machine with none", () => {
    const r = runPreflight({});
    expect(r.missing).toEqual(REQUIRED_STAGING_INPUTS);
    expect(r.green).toBe(false);
  });

  it("never reads an unprefixed production variable", () => {
    // The ambient environment on the development machine carries production
    // values under these exact names. The selection must ignore them.
    const selection = selectionFromEnv({
      DATABASE_URL: "postgresql://u:p@production-host/app",
      REDIS_URL: "rediss://u:p@production-host:6379",
      STRIPE_SECRET_KEY: syntheticStripeLiveSecret(),
    });
    expect(selection).toEqual({});
  });

  it("is green only once every required input is supplied and none is production", () => {
    const env: Record<string, string> = {
      STAGING_DATABASE_URL: "postgresql://u:p@db.staging.example-staging.net:5432/app",
      STAGING_REDIS_URL: "rediss://u:p@cache.staging.example-staging.net:6379",
      STAGING_S3_ENDPOINT: "https://objects.staging.example-staging.net",
      STAGING_S3_BUCKET: "p8-staging-evidence",
      STAGING_S3_ACCESS_KEY: "staging-scoped-key",
      STAGING_S3_SECRET_KEY: "staging-scoped-secret",
      STAGING_STRIPE_SECRET_KEY: syntheticStripeTestSecret(),
      STAGING_PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
      STAGING_EMAIL_TRANSPORT: "recording",
      STAGING_TEST_MAILBOX: "p8@test.example-staging.net",
      STAGING_WEBHOOK_RECEIVER: "https://hooks.staging.example-staging.net/p8",
    };
    expect(runPreflight(env).green).toBe(true);

    // One production value anywhere and it is not green.
    expect(runPreflight({ ...env, STAGING_STRIPE_SECRET_KEY: syntheticStripeLiveSecret() }).green).toBe(false);
    expect(runPreflight({ ...env, STAGING_PAYPAL_API_BASE: "https://api-m.paypal.com" }).green).toBe(false);
  });
});
