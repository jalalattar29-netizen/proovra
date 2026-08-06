/**
 * PHASE 12 — POINT 7: the isolation canary must not depend on the machine.
 *
 * The canary's first check used to conjoin two different claims: "this machine
 * happens to have a live `services/api/.env`" AND "an `.env` cannot override the
 * safe test environment". Only the second is a security property. On a clean
 * checkout — CI, and the release artifact — the first is false, so the check
 * reported FAIL while nothing was wrong, and checks 2-12 quietly ran against a
 * blank slate: they were passing because nothing hostile was left to resist.
 *
 * These tests pin the corrected contract: the hostile environment is the
 * canary's OWN, the override refusal is proved behaviourally, and the fixture
 * that proves it never survives the run or leaks a value.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FIXTURE_PREFIX,
  hostileEnvironment,
  hostilePremiseHolds,
  SENTINEL,
  SENTINEL_HOSTS,
  withEnvFileFixture,
} from "./setup/canary-env-fixture.mjs";

const API_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(API_ROOT, "../..");
const BOOTSTRAP = pathToFileURL(resolve(API_ROOT, "test/setup/test-bootstrap.mjs")).href;

/** Run a probe exactly as the canary does: preload + hostile env + fixture cwd. */
function probeWithFixture(source: string, cwd: string, env: Record<string, string>) {
  const file = join(cwd, "probe.mjs");
  writeFileSync(file, source, "utf8");
  const res = spawnSync(process.execPath, ["--import", BOOTSTRAP, file], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      P7_CANARY_LIVE_ENV: "1",
      P7_PHASE: "canary",
      P7_PROCESS: "canary:selftest",
      P7_NETWORK_LEDGER: join(cwd, "ledger.jsonl"),
      P7_CANARY_LEDGER: join(cwd, "ledger.jsonl"),
    },
    timeout: 180_000,
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(
      (res.stdout ?? "").split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}",
    );
  } catch {
    /* asserted by the caller */
  }
  return { parsed, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const REPORT_PROBE = `
  try { (await import("dotenv")).config(); } catch { /* absent is fine */ }
  const net = await import("node:net");
  const blocked = [];
  for (const host of ${JSON.stringify(SENTINEL_HOSTS)}) {
    try { new net.Socket().connect({ host, port: 443 }); blocked.push(host + ":allowed"); }
    catch (e) { blocked.push(host + (e?.code === "POINT7_OUTBOUND_DENIED" ? ":blocked" : ":other")); }
  }
  console.log(JSON.stringify({
    sentry: process.env.SENTRY_DSN ?? null,
    redisIsLocal: /127\\.0\\.0\\.1|localhost/.test(process.env.REDIS_URL ?? ""),
    dbIsLocal: /127\\.0\\.0\\.1|localhost/.test(process.env.DATABASE_URL ?? ""),
    storageIsLocal: /127\\.0\\.0\\.1|localhost/.test(process.env.S3_ENDPOINT ?? ""),
    nodeEnv: process.env.NODE_ENV,
    bucket: process.env.S3_BUCKET,
    blocked,
  }));
  process.exit(0);`;

describe("PHASE 12 POINT 7 — the canary is self-contained", () => {
  // 1. A clean checkout with no .env still yields a hostile environment.
  it("needs no real .env: the hostile environment is complete with an empty deployment env", () => {
    const env = hostileEnvironment({});

    expect(hostilePremiseHolds(env)).toBe(true);
    for (const key of Object.keys(SENTINEL)) {
      expect(env[key as keyof typeof SENTINEL]).toBe(SENTINEL[key as keyof typeof SENTINEL]);
    }
  });

  it("a real deployment env only ADDS to the hostile set — sentinels stay authoritative", () => {
    const env = hostileEnvironment({
      SENTRY_DSN: "https://someone-elses@sentry.io/9",
      SOME_OTHER_KEY: "kept",
    });

    expect(env.SENTRY_DSN).toBe(SENTINEL.SENTRY_DSN);
    expect(env.SOME_OTHER_KEY).toBe("kept");
  });

  // 2 + 3. Behavioural: the file and the variables are both refused, and the
  //        safe explicit values survive.
  it("a synthetic .env cannot override DB / Redis / storage / observability", () => {
    const out = withEnvFileFixture((dir) =>
      probeWithFixture(REPORT_PROBE, dir, hostileEnvironment({}) as Record<string, string>),
    );

    // None of the hostile values reached the process's effective destinations…
    expect(out.parsed.sentry).toBeNull();
    expect(out.parsed.redisIsLocal).toBe(true);
    expect(out.parsed.dbIsLocal).toBe(true);
    expect(out.parsed.storageIsLocal).toBe(true);

    // …and the safe explicit test values are the ones that survived.
    expect(out.parsed.nodeEnv).toBe("test");
    expect(out.parsed.bucket).toBe("point7-local-bucket");
  });

  it("outbound attempts to every sentinel host are blocked before connecting", () => {
    const out = withEnvFileFixture((dir) =>
      probeWithFixture(REPORT_PROBE, dir, hostileEnvironment({}) as Record<string, string>),
    );

    expect(out.parsed.blocked).toEqual(SENTINEL_HOSTS.map((h) => `${h}:blocked`));
  });

  // 4. A degraded sentinel cannot quietly make the check vacuous.
  it("a sentinel weakened to loopback FAILS the premise — it cannot accidentally pass", () => {
    expect(hostilePremiseHolds({ ...SENTINEL, SENTRY_DSN: "" })).toBe(false);
    expect(hostilePremiseHolds({ ...SENTINEL, SENTRY_DSN: "https://x@localhost/1" })).toBe(false);
    expect(
      hostilePremiseHolds({ ...SENTINEL, REDIS_URL: "redis://127.0.0.1:6379" }),
    ).toBe(false);
    expect(hostilePremiseHolds({})).toBe(false);
  });

  // 5 + 6. The fixture is disposable on BOTH paths.
  it("deletes the fixture after success", () => {
    let seen = "";
    withEnvFileFixture((dir) => {
      seen = dir;
      expect(existsSync(join(dir, ".env"))).toBe(true);
      return null;
    });

    expect(existsSync(seen)).toBe(false);
  });

  it("deletes the fixture after FAILURE", () => {
    let seen = "";

    expect(() =>
      withEnvFileFixture((dir) => {
        seen = dir;
        throw new Error("probe blew up");
      }),
    ).toThrow("probe blew up");

    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });

  it("leaves no fixture directory behind in the temp root", () => {
    withEnvFileFixture(() => null);

    const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX));
    expect(leaked).toEqual([]);
  });

  // 7. Nothing secret-shaped is emitted, and no sentinel is a real credential.
  it("emits no sentinel value in the probe's own output", () => {
    const out = withEnvFileFixture((dir) =>
      probeWithFixture(REPORT_PROBE, dir, hostileEnvironment({}) as Record<string, string>),
    );
    const emitted = `${out.stdout}\n${out.stderr}`;

    for (const value of Object.values(SENTINEL)) {
      if (value.length < 8) continue;
      expect(emitted).not.toContain(value);
    }
  });

  it("the sentinels are fake by construction — unroutable hosts, no live credential", () => {
    // Hosts are RFC 2606 `.invalid` or an all-zero Sentry id; none can resolve.
    for (const host of SENTINEL_HOSTS) {
      expect(host === "o0.ingest.sentry.io" || host.endsWith(".invalid")).toBe(true);
    }
    // Nothing that a scanner would treat as a live provider secret.
    const blob = JSON.stringify(SENTINEL);
    expect(blob).not.toMatch(/sk_live_[A-Za-z0-9]/);
    expect(blob).not.toMatch(/re_[A-Za-z0-9]{20,}/);
    expect(blob).not.toMatch(/whsec_[A-Za-z0-9]/);
    // The Sentry sentinel's public key is all zeros, not a real 32-hex key.
    expect(SENTINEL.SENTRY_DSN).toContain("00000000000000000000000000000000");
    // The AWS sentinel is AWS's own documented example id, so it is still
    // AKIA-shaped — the scrubbing path is genuinely exercised — while no
    // credential scanner has to raise it as a finding for the rest of time.
    expect(SENTINEL.AWS_ACCESS_KEY_ID).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(SENTINEL.AWS_ACCESS_KEY_ID.startsWith("AKIA")).toBe(true);
  });

  it("the fixture writes a real .env FILE — variables alone would not test dotenv", () => {
    withEnvFileFixture((dir) => {
      const body = readFileSync(join(dir, ".env"), "utf8");
      for (const key of Object.keys(SENTINEL)) expect(body).toContain(`${key}=`);
      return null;
    });
  });

  it("the canary script reads its hostile environment from the shared fixture", () => {
    const src = readFileSync(resolve(API_ROOT, "test/setup/isolation-canary.mjs"), "utf8");

    expect(src).toContain("canary-env-fixture.mjs");
    expect(src).toContain("hostileEnvironment(");
    // The old machine-dependent premise must not come back.
    expect(src).not.toContain("canary would be vacuous");
  });

  it("does not write its fixture over the repository's own .env", () => {
    const realEnv = resolve(REPO_ROOT, "services/api/.env");
    const before = existsSync(realEnv) ? readFileSync(realEnv) : null;

    withEnvFileFixture((dir) => {
      expect(resolve(dir).startsWith(resolve(REPO_ROOT))).toBe(false);
      return null;
    });

    const after = existsSync(realEnv) ? readFileSync(realEnv) : null;
    expect(after === null ? null : after.length).toEqual(before === null ? null : before.length);
  });
});
