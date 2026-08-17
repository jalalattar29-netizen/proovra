/**
 * PHASE 13 — THE POINT-7 PROCESS BOUNDARY, PROVEN IN REAL CHILD PROCESSES.
 *
 * Two things the browser layer needs from `test-bootstrap.mjs` are exceptions to
 * rules the bootstrap is otherwise right to enforce, and both are easy to get
 * wrong in a way that looks fine:
 *
 *   1. `WORKFLOW_INTAKE_TOKEN_SECRET` must be scrubbed in every in-process suite
 *      (a harness-supplied secret changes what `hmacForIntake()` returns) and
 *      must SURVIVE in the one long-lived API process the Point-7 runner spawns,
 *      because that process has no in-process seam to mint one through. Without
 *      it `GET /v1/workflow/intake-links` answers 503 `secret_missing`.
 *
 *   2. The RECORDER PATHS belong to the runner. The bootstrap picks the
 *      recording TRANSPORT (never a remote one) but must not silently relocate
 *      where it writes — a caller-supplied path that is quietly replaced is the
 *      exact shape of "the API recorded the code and the fixture read an empty
 *      file".
 *
 * Asserting on the source text would prove nothing about either: the scrub runs
 * as a PRELOAD, its order matters (the generic credential scrub matches
 * `WORKFLOW_INTAKE_TOKEN_SECRET` on both `SECRET` and `TOKEN` before the
 * explicit list is even reached), and the effect is a property of a process. So
 * each case below spawns a real child with the real preload and reads back only
 * whether the key is PRESENT — never its value.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BOOTSTRAP = resolve(__dirname, "setup/test-bootstrap.mjs");

/** A value that is obviously local and is never printed by these tests. */
const LOCAL_TEST_SECRET =
  "p13-boundary-local-disposable-value-000000000000000000";

type Probe = {
  intakeSecretPresent: boolean;
  intakeFlag: string;
  messagingRecorder: string;
  emailRecorder: string;
  messagingTransport: string;
};

/**
 * Run the real preload in a child and report PRESENCE, not content.
 *
 * `--import` is how every Point-7 process loads the bootstrap, so this is the
 * same mechanism under test rather than a re-implementation of it.
 */
function probe(env: Record<string, string | undefined>): Probe {
  const script = [
    "const e = process.env;",
    "process.stdout.write(JSON.stringify({",
    "  intakeSecretPresent: typeof e.WORKFLOW_INTAKE_TOKEN_SECRET === 'string'",
    "    && e.WORKFLOW_INTAKE_TOKEN_SECRET.length > 0,",
    "  intakeFlag: e.WORKFLOW_INTAKE_LINKS_ENABLED ?? '',",
    "  messagingRecorder: e.MESSAGING_RECORDER_FILE ?? '',",
    "  emailRecorder: e.EMAIL_RECORDER_FILE ?? '',",
    "  messagingTransport: e.MESSAGING_TRANSPORT ?? '',",
    "}));",
  ].join("\n");

  const res = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(BOOTSTRAP).href, "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: {
        // A deliberately minimal base: PATH so node runs, plus whatever the case
        // is asserting. Inheriting this vitest worker's env would let the
        // parent's own scrubbed state mask the result.
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...env,
      },
    },
  );
  expect(
    res.status,
    `bootstrap probe child failed: ${res.stderr?.slice(0, 800)}`,
  ).toBe(0);
  return JSON.parse(res.stdout) as Probe;
}

describe("Point-7 process boundary — intake secret", () => {
  it("an ordinary in-process suite has the intake secret removed, even when the machine supplies one", () => {
    const p = probe({ WORKFLOW_INTAKE_TOKEN_SECRET: LOCAL_TEST_SECRET });
    expect(
      p.intakeSecretPresent,
      "a non-Point-7 process must not hold the intake token secret — the " +
        "unit suites' 'feature disabled' assertions depend on its absence",
    ).toBe(false);
  });

  it("a Point-7 process that is NOT the api process also has it removed", () => {
    for (const marker of ["browser", "server-suite", "worker"]) {
      const p = probe({
        P7_PROCESS: marker,
        WORKFLOW_INTAKE_TOKEN_SECRET: LOCAL_TEST_SECRET,
      });
      expect(
        p.intakeSecretPresent,
        `P7_PROCESS=${marker} must not inherit an authority it does not need`,
      ).toBe(false);
    }
  });

  it("the Point-7 API process preserves it — the browser layer has no in-process seam", () => {
    const p = probe({
      P7_PROCESS: "api",
      WORKFLOW_INTAKE_TOKEN_SECRET: LOCAL_TEST_SECRET,
    });
    expect(p.intakeSecretPresent).toBe(true);
  });

  it("the exception carries no value of its own — absent stays absent, so it still fails closed", () => {
    const p = probe({ P7_PROCESS: "api" });
    expect(
      p.intakeSecretPresent,
      "the bootstrap must never MINT this secret; it may only refrain from " +
        "deleting one the runner supplied",
    ).toBe(false);
    expect(
      p.intakeFlag,
      "and it must never enable the feature by default",
    ).toBe("");
  });
});

describe("Point-7 process boundary — recorder paths", () => {
  it("a runner-supplied recorder path survives, for both boundaries", () => {
    const messaging = resolve(__dirname, "../../../.p7tmp/probe-messages.jsonl");
    const email = resolve(__dirname, "../../../.p7tmp/probe-emails.jsonl");
    const p = probe({
      P7_PROCESS: "api",
      MESSAGING_RECORDER_FILE: messaging,
      EMAIL_RECORDER_FILE: email,
    });
    expect(p.messagingRecorder).toBe(messaging);
    expect(p.emailRecorder).toBe(email);
  });

  it("the default still applies when the runner supplies nothing", () => {
    const p = probe({});
    // Only the MESSAGING recorder has a bootstrap default (`LOCAL_FAKES`); the
    // email one is defaulted by the browser harness itself
    // (`_harness.RECORDED_EMAIL_FILE`), so an unset value here is correct and
    // asserting otherwise would pin a default that does not exist.
    expect(p.messagingRecorder.length).toBeGreaterThan(0);
    expect(p.emailRecorder).toBe("");
  });

  it("the recording TRANSPORT stays non-negotiable — only the destination is the caller's", () => {
    const p = probe({ MESSAGING_TRANSPORT: "twilio" });
    expect(
      p.messagingTransport,
      "a test process must never be able to select a remote messaging provider",
    ).toBe("recording");
  });
});
