/**
 * TEST-STACK ISOLATION — regression gate for the 2026-10-22 incident.
 *
 * A local E2E stack inherited the developer's repo-root `.env` (a LIVE Resend
 * key among ~350 values), `EMAIL_TRANSPORT` was unset — which meant "resend" —
 * and every E2E registration emailed a real `@example.test` verification
 * message through PROOVRA's Resend account, burning most of a day's quota.
 *
 * Every assertion here runs offline: `fetch` is a spy that fails the test if it
 * is ever reached, files are written to a fresh temp directory, and the
 * process-level outbound guard of the test bootstrap stays installed.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIsolationFacts,
  declaredSecretsMode,
  presentLiveCredentialNames,
  resolveTestStackIsolation,
} from "@proovra/shared-runtime";
import {
  deliverEmail,
  recordedEmails,
  resetRecordingEmailProvider,
  resolveEmailTransportProvider,
} from "@proovra/shared-runtime/notifications";

import { loadEnvFiles } from "../src/env.js";
import { buildTestStackIsolationReport } from "../src/ops/test-stack-isolation-report.js";
import { loadWorkerEnvFiles } from "../../worker/src/env-loader.js";
import { isolationProblems } from "../../../e2e/helpers/stack-isolation.js";

const REPO = resolve(__dirname, "../../..");
const BYPASS = "e2e-bypass-do-not-use-in-prod-7f2c3a91b4d9e8f10c2b3a4d5e6f70819";
// Shaped like a real key so nothing can pass by refusing an obviously fake one.
const LIVE_LOOKING_KEY = "re_AbCdEfGh_1234567890abcdefghijklmnopq";

const MARKERS = ["E2E_AUTH_BYPASS_SECRET", "PROOVRA_TEST_STACK", "PROOVRA_ENV", "APP_ENV", "DEPLOY_ENV", "EMAIL_TRANSPORT", "AWS_SECRETS_MODE", "AWS_SECRETS_ENABLED", "RESEND_API_KEY", "NODE_ENV"];

/** Start every test from no marker at all; vi.stubEnv("x", undefined) deletes. */
function clearMarkers() {
  for (const name of MARKERS) vi.stubEnv(name, undefined as unknown as string);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetRecordingEmailProvider();
});

describe("isolation is decided by test-stack markers, and only by them", () => {
  beforeEach(clearMarkers);

  it.each([
    ["E2E_AUTH_BYPASS_SECRET", BYPASS],
    ["PROOVRA_TEST_STACK", "1"],
    ["PROOVRA_ENV", "test"],
  ])("%s isolates the process", (name, value) => {
    expect(resolveTestStackIsolation({ [name]: value })).toEqual({ isolated: true, reasons: [expect.any(String)] });
  });

  it("no marker, development or production, is not isolated", () => {
    expect(resolveTestStackIsolation({}).isolated).toBe(false);
    expect(resolveTestStackIsolation({ NODE_ENV: "development" }).isolated).toBe(false);
    expect(resolveTestStackIsolation({ NODE_ENV: "production" }).isolated).toBe(false);
  });

  it("NODE_ENV=test alone is not a stack marker (unit processes are sealed by their bootstrap)", () => {
    expect(resolveTestStackIsolation({ NODE_ENV: "test" }).isolated).toBe(false);
  });

  it("names present live credentials without ever returning a value", () => {
    const names = presentLiveCredentialNames({ RESEND_API_KEY: LIVE_LOOKING_KEY, TSA_PASSWORD: "x", OPENAI_API_KEY: "", UNRELATED: "y" });
    expect(names).toEqual(["RESEND_API_KEY", "TSA_PASSWORD"]);
    expect(JSON.stringify(names)).not.toContain(LIVE_LOOKING_KEY);
  });
});

describe("an isolated stack can NOT reach Resend — whatever it is handed", () => {
  beforeEach(clearMarkers);

  it("records even when told EMAIL_TRANSPORT=resend and given a live-looking key", async () => {
    vi.stubEnv("E2E_AUTH_BYPASS_SECRET", BYPASS);
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", LIVE_LOOKING_KEY);
    const network = vi.fn(async () => {
      throw new Error("an isolated stack reached the network");
    });
    vi.stubGlobal("fetch", network);

    expect(resolveEmailTransportProvider()).toBe("recording");
    const outcome = await deliverEmail({
      from: "PROOVRA <no-reply@proovra.com>",
      to: "e2e-1-1-1@example.test",
      subject: "Verify your email",
      html: "<p>code</p>",
      text: "code",
      idempotencyKey: "isolation-regression-0001",
    });

    expect(network).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("acknowledged");
    expect(recordedEmails()).toHaveLength(1);
  });

  it.each([["PROOVRA_TEST_STACK", "1"], ["PROOVRA_ENV", "test"]])("%s locks the transport too", (name, value) => {
    vi.stubEnv(name, value);
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    expect(resolveEmailTransportProvider()).toBe("recording");
  });
});

describe("an UNSET transport is live only where the process is deployed", () => {
  beforeEach(clearMarkers);

  it("production keeps resend — no deployment changes by omission", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(resolveEmailTransportProvider()).toBe("resend");
  });

  it("staging keeps resend", () => {
    vi.stubEnv("PROOVRA_ENV", "staging");
    expect(resolveEmailTransportProvider()).toBe("resend");
  });

  it("a development machine records — 'unset means live' is how the incident happened", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveEmailTransportProvider()).toBe("recording");
  });

  it("an explicit choice outside a test stack is still honoured", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    expect(resolveEmailTransportProvider()).toBe("resend");
  });
});

describe("an isolated stack never asks AWS Secrets Manager (it outranks the environment)", () => {
  beforeEach(clearMarkers);

  it("is disabled even when the stack is told the authority is required", () => {
    vi.stubEnv("PROOVRA_TEST_STACK", "1");
    vi.stubEnv("AWS_SECRETS_MODE", "required");
    expect(declaredSecretsMode()).toBe("disabled");
  });

  it("is disabled even with the legacy switch on", () => {
    vi.stubEnv("E2E_AUTH_BYPASS_SECRET", BYPASS);
    vi.stubEnv("AWS_SECRETS_ENABLED", "true");
    expect(declaredSecretsMode()).toBe("disabled");
  });

  it("control: without a marker the legacy switch still means optional", () => {
    vi.stubEnv("AWS_SECRETS_ENABLED", "true");
    expect(declaredSecretsMode()).toBe("optional");
  });
});

describe("an isolated stack reads no .env file — the incident's door", () => {
  // <tmp>/.env is the "repo-root" file; the API runs from <tmp>/services/api.
  function fakeCheckout() {
    const root = mkdtempSync(join(tmpdir(), "isolation-"));
    writeFileSync(join(root, ".env"), `RESEND_API_KEY=${LIVE_LOOKING_KEY}\nTSA_URL=https://tsa.example\n`);
    const api = join(root, "services", "api");
    mkdirSync(api, { recursive: true });
    const worker = join(root, "services", "worker");
    mkdirSync(worker, { recursive: true });
    writeFileSync(join(worker, ".env"), `RESEND_API_KEY=${LIVE_LOOKING_KEY}\n`);
    return { root, api, worker };
  }

  it("API: a marked stack loads nothing", () => {
    const { api } = fakeCheckout();
    for (const marker of [{ E2E_AUTH_BYPASS_SECRET: BYPASS }, { PROOVRA_TEST_STACK: "1" }, { PROOVRA_ENV: "test" }]) {
      const env: Record<string, string | undefined> = { ...marker };
      expect(loadEnvFiles(api, env)).toEqual({ loaded: [], skipped: "isolated-test-stack", emailLiveRefused: null });
      expect(env.RESEND_API_KEY).toBeUndefined();
      expect(env.TSA_URL).toBeUndefined();
    }
  });

  it("API control: an unmarked process still loads the repo-root file (the test can fail)", () => {
    const { api } = fakeCheckout();
    const env: Record<string, string | undefined> = {};
    expect(loadEnvFiles(api, env).loaded).toHaveLength(1);
    expect(env.RESEND_API_KEY).toBe(LIVE_LOOKING_KEY);
  });

  it("worker: a marked stack loads nothing; unmarked still does", () => {
    const { worker } = fakeCheckout();
    const marked: Record<string, string | undefined> = { PROOVRA_TEST_STACK: "1" };
    expect(loadWorkerEnvFiles(worker, marked)).toEqual({ loaded: [], emailLiveRefused: null });
    expect(marked.RESEND_API_KEY).toBeUndefined();
    const unmarked: Record<string, string | undefined> = {};
    expect(loadWorkerEnvFiles(worker, unmarked).loaded).toHaveLength(1);
  });
});

describe("a .env FILE never turns live email on — even for an unmarked process", () => {
  beforeEach(clearMarkers);

  // The machine's real shape: the repo-root `.env` declares production and
  // carries a live key, and an unmarked process is started FROM the root.
  function repoRootCheckout() {
    const root = mkdtempSync(join(tmpdir(), "rootstart-"));
    writeFileSync(join(root, ".env"), `NODE_ENV=production\nRESEND_API_KEY=${LIVE_LOOKING_KEY}\n`);
    mkdirSync(join(root, "services", "api"), { recursive: true });
    mkdirSync(join(root, "services", "worker"), { recursive: true });
    return root;
  }

  it("API started from the repo root: the file says production + key, the process records", () => {
    const env: Record<string, string | undefined> = {};
    const load = loadEnvFiles(repoRootCheckout(), env);
    expect(load.loaded).toHaveLength(1);
    expect(env.NODE_ENV).toBe("production");
    expect(env.EMAIL_TRANSPORT).toBe("recording");
    expect(load.emailLiveRefused).toMatch(/RESEND_API_KEY.*NODE_ENV|NODE_ENV.*RESEND_API_KEY/);
    expect(load.emailLiveRefused).not.toContain(LIVE_LOOKING_KEY);
    // …and the transport, reading that environment, records.
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
    expect(resolveEmailTransportProvider()).toBe("recording");
  });

  it("worker started from the repo root records too", () => {
    const env: Record<string, string | undefined> = {};
    const load = loadWorkerEnvFiles(repoRootCheckout(), env);
    expect(load.loaded).toHaveLength(1);
    expect(env.EMAIL_TRANSPORT).toBe("recording");
    expect(load.emailLiveRefused).not.toBeNull();
  });

  it("a file cannot opt itself back in: EMAIL_TRANSPORT=resend in the file is overridden", () => {
    const root = repoRootCheckout();
    writeFileSync(join(root, ".env"), `NODE_ENV=production\nEMAIL_TRANSPORT=resend\nRESEND_API_KEY=${LIVE_LOOKING_KEY}\n`);
    const env: Record<string, string | undefined> = {};
    loadEnvFiles(root, env);
    expect(env.EMAIL_TRANSPORT).toBe("recording");
  });

  it("only the REAL environment can ask for live email", () => {
    const env: Record<string, string | undefined> = { EMAIL_TRANSPORT: "resend" };
    const load = loadEnvFiles(repoRootCheckout(), env);
    expect(load.emailLiveRefused).toBeNull();
    expect(env.EMAIL_TRANSPORT).toBe("resend");
  });

  it("control: a deployed process — real env, no file — is untouched", () => {
    const empty = mkdtempSync(join(tmpdir(), "deployed-"));
    mkdirSync(join(empty, "services", "api"), { recursive: true });
    const env: Record<string, string | undefined> = { NODE_ENV: "production", RESEND_API_KEY: LIVE_LOOKING_KEY };
    expect(loadEnvFiles(join(empty, "services", "api"), env)).toEqual({ loaded: [], skipped: null, emailLiveRefused: null });
    expect(env.EMAIL_TRANSPORT).toBeUndefined();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
    expect(resolveEmailTransportProvider()).toBe("resend");
  });

  it("control: a file with nothing that decides email changes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "unrelated-"));
    writeFileSync(join(root, ".env"), "LOG_LEVEL=debug\n");
    const env: Record<string, string | undefined> = {};
    expect(loadEnvFiles(root, env).emailLiveRefused).toBeNull();
    expect(env.EMAIL_TRANSPORT).toBeUndefined();
  });
});

describe("/health states the isolation of the API AND its workers; the preflight refuses anything less", () => {
  beforeEach(clearMarkers);

  const facts = {
    isolated: true,
    markers: ["PROOVRA_TEST_STACK"],
    emailTransport: "recording",
    secretsMode: "disabled",
    envFilesLoaded: 0,
    liveCredentialNames: [] as string[],
  };

  it("a deployed process reports nothing new (and asks for no workers)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const liveWorkers = vi.fn(async () => []);
    expect(await buildTestStackIsolationReport({ NODE_ENV: "production" }, { liveWorkers })).toBeNull();
    expect(liveWorkers).not.toHaveBeenCalled();
  });

  it("an isolated stack reports itself, names live credentials, and lists its live workers", async () => {
    vi.stubEnv("PROOVRA_TEST_STACK", "1");
    const workers = [{ workerId: "w-1", isolation: { ...facts } as never }];
    const report = await buildTestStackIsolationReport(
      { PROOVRA_TEST_STACK: "1", RESEND_API_KEY: LIVE_LOOKING_KEY },
      { liveWorkers: async () => workers },
    );
    expect(report).toMatchObject({ isolated: true, emailTransport: "recording", secretsMode: "disabled", workers });
    expect(report!.liveCredentialNames).toEqual(["RESEND_API_KEY"]);
    expect(JSON.stringify(report)).not.toContain(LIVE_LOOKING_KEY);
  });

  it("the worker heartbeat carries the same facts, built by the same function", () => {
    vi.stubEnv("PROOVRA_TEST_STACK", "1");
    expect(buildIsolationFacts({ env: { PROOVRA_TEST_STACK: "1" }, envFilesLoaded: 0 })).toEqual(facts);
    expect(buildIsolationFacts({ env: {}, envFilesLoaded: 2 })).toBeNull();
    const telemetry = readFileSync(join(REPO, "services/worker/src/telemetry.ts"), "utf8");
    expect(telemetry).toMatch(/buildIsolationFacts\(\{ envFilesLoaded: getWorkerEnvFileLoad\(\)\.loaded\.length \}\)/);
    expect(telemetry).toMatch(/\.\.\.\(isolation \? \{ isolation \} : \{\}\)/);
  });

  it("the preflight accepts only an isolated API with isolated live workers", () => {
    const clean = { ...facts, workers: [{ workerId: "w-1", isolation: { ...facts } }] };
    expect(isolationProblems(clean)).toEqual([]);
    expect(isolationProblems(undefined)).toHaveLength(1);
    // The API itself.
    expect(isolationProblems({ ...clean, emailTransport: "resend" })).toHaveLength(1);
    expect(isolationProblems({ ...clean, secretsMode: "optional" })).toHaveLength(1);
    expect(isolationProblems({ ...clean, envFilesLoaded: 1 })).toHaveLength(1);
    expect(isolationProblems({ ...clean, liveCredentialNames: ["RESEND_API_KEY"] })).toHaveLength(1);
    // Its workers.
    expect(isolationProblems({ ...facts })).toEqual(["the API does not report its workers' isolation"]);
    expect(isolationProblems({ ...clean, workers: [] })[0]).toMatch(/no live worker/);
    expect(isolationProblems({ ...clean, workers: [{ workerId: "w-2", isolation: null }] })[0]).toMatch(/worker w-2 reports no test-stack isolation/);
    expect(isolationProblems({ ...clean, workers: [{ workerId: "w-3", isolation: { ...facts, emailTransport: "resend" } }] })[0]).toMatch(/worker w-3: email transport/);
    expect(
      isolationProblems({ ...clean, workers: [{ workerId: "ok", isolation: { ...facts } }, { workerId: "w-4", isolation: { ...facts, liveCredentialNames: ["TSA_PASSWORD"] } }] }),
    ).toHaveLength(1);
  });
});

describe("the suite and CI are wired to the contract", () => {
  it("createGuestSession proves isolation BEFORE it registers an account", () => {
    const src = readFileSync(join(REPO, "e2e/helpers/api-client.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function createGuestSession"));
    const guard = body.indexOf("await assertIsolatedStack()");
    const register = body.indexOf('"/v1/auth/email/register"');
    expect(guard).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(guard);
  });

  it.each(["playwright-e2e.yml", "updated-report-journey.yml"])("%s declares the isolated test stack", (file) => {
    const yml = readFileSync(join(REPO, ".github/workflows", file), "utf8");
    expect(yml).toMatch(/^\s+PROOVRA_TEST_STACK: "1"$/m);
    expect(yml).toMatch(/^\s+EMAIL_TRANSPORT: recording$/m);
    expect(yml).not.toMatch(/RESEND_API_KEY|AWS_SECRETS_(ENABLED|MODE): /);
  });
});
