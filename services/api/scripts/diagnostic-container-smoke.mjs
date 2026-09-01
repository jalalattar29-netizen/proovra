#!/usr/bin/env node
/**
 * CONTAINER SMOKE FOR THE PRODUCTION DIAGNOSTIC.
 *
 * =============================================================================
 * THE REGRESSION THIS EXISTS TO CATCH
 * =============================================================================
 * The runbook told an operator to `docker cp` the diagnostic to `/tmp` and run
 * `node /tmp/proovra-diagnostic.cjs`. Inside the real image that failed, every
 * time:
 *
 *     Error: Cannot find module '@prisma/client'
 *     Require stack:
 *     - /tmp/proovra-diagnostic.cjs
 *
 * CommonJS resolves a bare specifier by walking up from the directory of the
 * requiring FILE, not from the working directory. The image installs hoisted
 * into `/app/node_modules` and sets WORKDIR to `/app/services/api`, so the walk
 * from `/tmp` reached `/node_modules` and stopped. The correct working
 * directory did not help, because cwd plays no part in the walk.
 *
 * No unit test can catch that. It is a property of the built image's layout,
 * and it only appears when the file sits outside the application tree. So this
 * runs the documented commands against a real container and asserts on what
 * actually happens.
 *
 * =============================================================================
 * WHAT IT ASSERTS
 * =============================================================================
 *   1. the script runs from `/tmp` — the documented location;
 *   2. it runs from inside the app tree too, so neither placement is required;
 *   3. it runs with a working directory outside the app tree, given
 *      `--require-base`, which is the read-only-rootfs escape hatch;
 *   4. it needs no NODE_PATH, and none is set in the image;
 *   5. it needs no repository checkout and no particular cwd;
 *   6. stdout is valid JSON even when a section fails;
 *   7. the summary reader runs from stdin and prints no identifier;
 *   8. a wrong `--expect-database` REFUSES and reads nothing;
 *   9. a missing `--expect-database` refuses rather than defaulting.
 *
 * =============================================================================
 * USAGE
 * =============================================================================
 *   node services/api/scripts/diagnostic-container-smoke.mjs \
 *     --image=proovra-api:hardened \
 *     --database-url="postgresql://user:pw@host.docker.internal:5432/dbname" \
 *     --expect-database=dbname
 *
 * The database must be reachable FROM A CONTAINER, so `localhost` in the URL
 * means the container itself. Use `host.docker.internal` for a host-published
 * port; the script adds the host-gateway mapping.
 *
 * Exits 0 when every check passes, 1 on the first failure, 2 on bad usage.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIAGNOSTIC = join(HERE, "proovra-diagnostic.cjs");
const SUMMARY = join(HERE, "proovra-diagnostic-summary.cjs");

const CONTAINER = "proovra-diagnostic-smoke";
/** Where the image keeps the API package. Both the app tree and the WORKDIR. */
const APP_DIR = "/app/services/api";

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const IMAGE = arg("image");
const DATABASE_URL = arg("database-url");
const EXPECT_DB = arg("expect-database");

if (!IMAGE || !DATABASE_URL || !EXPECT_DB) {
  console.error(
    "usage: --image=<tag> --database-url=<url reachable from a container> --expect-database=<name>",
  );
  process.exit(2);
}
for (const f of [DIAGNOSTIC, SUMMARY]) {
  if (!existsSync(f)) {
    console.error(`missing ${f}`);
    process.exit(2);
  }
}

// -----------------------------------------------------------------------------
// Harness.
// -----------------------------------------------------------------------------

/**
 * `spawnSync` blocks the event loop, so a timeout option cannot fire while the
 * child runs — assert the child RAN before asserting anything about what it
 * said, or a spawn failure reads as an empty success.
 */
function sh(args, input) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    throw new Error(`docker ${args[0]} did not run: ${r.error.message}`);
  }
  if (typeof r.status !== "number") {
    throw new Error(`docker ${args[0]} produced no exit code`);
  }
  return r;
}

let failures = 0;
let checks = 0;

function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// -----------------------------------------------------------------------------
// Container lifecycle.
// -----------------------------------------------------------------------------

function boot() {
  spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
  const r = sh([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "--add-host=host.docker.internal:host-gateway",
    "-e",
    `DATABASE_URL=${DATABASE_URL}`,
    "-e",
    "NODE_ENV=production",
    "--entrypoint",
    "sh",
    IMAGE,
    "-c",
    "sleep 900",
  ]);
  if (r.status !== 0) {
    throw new Error(`could not start ${IMAGE}: ${r.stderr.trim()}`);
  }
}

function teardown() {
  spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
}

/** `docker exec`, optionally with a working directory and stdin. */
function inContainer(argv, opts = {}) {
  const pre = ["exec"];
  if (opts.cwd) pre.push("-w", opts.cwd);
  if (opts.stdin !== undefined) pre.push("-i");
  for (const [k, v] of Object.entries(opts.env ?? {})) pre.push("-e", `${k}=${v}`);
  return sh([...pre, CONTAINER, ...argv], opts.stdin);
}

function copyIn(hostPath, containerPath) {
  const r = sh(["cp", hostPath, `${CONTAINER}:${containerPath}`]);
  if (r.status !== 0) {
    throw new Error(`docker cp ${containerPath} failed: ${r.stderr.trim()}`);
  }
}

// -----------------------------------------------------------------------------
// Run.
// -----------------------------------------------------------------------------

console.log(`diagnostic container smoke — image ${IMAGE}`);
boot();

try {
  // The documented placement, and an in-tree placement, so neither is required.
  copyIn(DIAGNOSTIC, "/tmp/proovra-diagnostic.cjs");
  copyIn(SUMMARY, "/tmp/proovra-diagnostic-summary.cjs");

  // ---------------------------------------------------------------------------
  check("the image sets no NODE_PATH", () => {
    const r = inContainer(["sh", "-c", "echo [${NODE_PATH-unset}]"]);
    assert(
      r.stdout.trim() === "[unset]",
      `NODE_PATH is ${r.stdout.trim()} — the diagnostic must not depend on it, ` +
        `and a smoke that passes because of it proves nothing`,
    );
  });

  check("the image carries no repository checkout to fall back on", () => {
    const r = inContainer(["sh", "-c", "test -d /app/.git && echo yes || echo no"]);
    assert(r.stdout.trim() === "no", "the image contains a .git directory");
  });

  // ---------------------------------------------------------------------------
  // 1 — the documented command, from /tmp.
  // ---------------------------------------------------------------------------
  let documentedJson = "";
  check("runs from /tmp — the documented location", () => {
    const r = inContainer([
      "node",
      "/tmp/proovra-diagnostic.cjs",
      `--expect-database=${EXPECT_DB}`,
    ]);
    assert(
      !/Cannot find module '@prisma\/client'/.test(r.stderr),
      "REGRESSION: @prisma/client does not resolve from /tmp. " +
        "This is the exact failure the runbook used to produce.",
    );
    assert(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 400)}`);
    assert(r.stdout.length > 0, "no JSON on stdout");
    documentedJson = r.stdout;
  });

  check("says which base it resolved the runtime from", () => {
    const r = inContainer([
      "node",
      "/tmp/proovra-diagnostic.cjs",
      `--expect-database=${EXPECT_DB}`,
    ]);
    // Not decoration: when this eventually breaks again, the operator's
    // transcript should say where it looked.
    assert(
      /runtime resolved from /.test(r.stderr),
      "the script does not report its resolution base",
    );
  });

  // ---------------------------------------------------------------------------
  // 2 — inside the app tree.
  // ---------------------------------------------------------------------------
  check("runs from inside the application tree", () => {
    copyIn(DIAGNOSTIC, `${APP_DIR}/scripts/proovra-diagnostic.cjs`);
    const r = inContainer([
      "node",
      `${APP_DIR}/scripts/proovra-diagnostic.cjs`,
      `--expect-database=${EXPECT_DB}`,
    ]);
    assert(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 300)}`);
  });

  // ---------------------------------------------------------------------------
  // 3, 5 — cwd independence.
  // ---------------------------------------------------------------------------
  check("survives a stray -w outside the application tree", () => {
    // `-w /tmp` reads like harmless tidying and puts BOTH honest bases outside
    // the tree: the script is in /tmp and so is the working directory. The
    // conventional-roots fallback is what makes this work rather than puzzle.
    for (const cwd of ["/tmp", "/", "/var"]) {
      const r = inContainer(
        ["node", "/tmp/proovra-diagnostic.cjs", `--expect-database=${EXPECT_DB}`],
        { cwd },
      );
      assert(r.status === 0, `cwd=${cwd}: exit ${r.status} — ${r.stderr.slice(0, 200)}`);
      assert(
        /runtime resolved from /.test(r.stderr),
        `cwd=${cwd}: it did not report which base won`,
      );
    }
  });

  check("fails LOUDLY when no base can reach the runtime", () => {
    // Proven by removing every conventional root from consideration: an
    // explicit --require-base that cannot work. This must not hang, must not
    // half-run, and must say what it tried.
    const r = inContainer(
      [
        "node",
        "/tmp/proovra-diagnostic.cjs",
        "--require-base=/nonexistent-base",
        `--expect-database=${EXPECT_DB}`,
      ],
      { cwd: "/tmp", env: { PROOVRA_DIAGNOSTIC_NO_FALLBACK: "1" } },
    );
    assert(r.status !== 0, "it should have refused");
    assert(/tried: /.test(r.stderr), "the failure does not list the bases it tried");
    assert(
      /--require-base/.test(r.stderr),
      "the failure does not tell the operator how to fix it",
    );
    assert(r.stdout === "", "it wrote JSON despite failing to load the runtime");
  });

  check("--require-base rescues the worst case", () => {
    const r = inContainer(
      [
        "node",
        "/tmp/proovra-diagnostic.cjs",
        `--require-base=${APP_DIR}`,
        `--expect-database=${EXPECT_DB}`,
      ],
      { cwd: "/" },
    );
    assert(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 300)}`);
  });

  check("needs no NODE_PATH even when one is explicitly empty", () => {
    const r = inContainer(
      ["node", "/tmp/proovra-diagnostic.cjs", `--expect-database=${EXPECT_DB}`],
      { env: { NODE_PATH: "" } },
    );
    assert(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 300)}`);
  });

  // ---------------------------------------------------------------------------
  // 6 — valid JSON, including when a section fails.
  // ---------------------------------------------------------------------------
  let parsed = null;
  check("stdout is valid JSON", () => {
    parsed = JSON.parse(documentedJson);
    assert(parsed.diagnostic?.name === "proovra-diagnostic", "wrong document");
    assert(parsed.diagnostic?.readOnly === true, "readOnly is not true");
    assert(typeof parsed.sections === "object", "no sections");
  });

  check("a failed section is recorded as failed, never as zero", () => {
    // Whether any section actually failed depends on the database, so this
    // asserts the SHAPE: every section says ok true or false, and a false one
    // carries a reason rather than an empty object.
    for (const [name, s] of Object.entries(parsed.sections)) {
      assert(typeof s.ok === "boolean", `${name} has no ok flag`);
      if (s.ok === false) {
        assert(typeof s.error === "string" && s.error.length > 0, `${name} failed with no reason`);
        assert(
          !s.error.includes("\n"),
          `${name}'s error is multi-line — it will wreck the summary`,
        );
      }
    }
  });

  check("the diagnostic reports its own source hash", () => {
    const onDisk = spawnSync(process.execPath, [
      "-e",
      `const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(${JSON.stringify(DIAGNOSTIC)})).digest("hex"))`,
    ], { encoding: "utf8" });
    assert(
      parsed.diagnostic.sourceSha256 === onDisk.stdout,
      `reported ${parsed.diagnostic.sourceSha256}, file is ${onDisk.stdout} — ` +
        `the output does not attest to the script that produced it`,
    );
  });

  // ---------------------------------------------------------------------------
  // 7 — the summary reader.
  // ---------------------------------------------------------------------------
  check("the summary reader runs from stdin inside the container", () => {
    const r = inContainer(["node", "/tmp/proovra-diagnostic-summary.cjs"], {
      stdin: documentedJson,
    });
    assert(
      r.status === 0 || r.status === 1,
      `unexpected exit ${r.status}: ${r.stderr.slice(0, 300)}`,
    );
    assert(/PROOVRA PRODUCTION DIAGNOSTIC/.test(r.stdout), "no summary printed");
    assert(
      /omits every identifier/.test(r.stdout),
      "the summary does not state its own omission",
    );
  });

  check("the summary refuses a truncated capture and prints nothing", () => {
    const r = inContainer(["node", "/tmp/proovra-diagnostic-summary.cjs"], {
      stdin: documentedJson.slice(0, Math.floor(documentedJson.length * 0.6)),
    });
    assert(r.status === 2, `expected exit 2, got ${r.status}`);
    assert(r.stdout === "", "it printed numbers from a truncated document");
    assert(/truncated/i.test(r.stderr), "it did not say the capture looks truncated");
  });

  // ---------------------------------------------------------------------------
  // 8, 9 — the database guard.
  // ---------------------------------------------------------------------------
  check("REFUSES a wrong --expect-database and reads nothing", () => {
    const r = inContainer([
      "node",
      "/tmp/proovra-diagnostic.cjs",
      "--expect-database=definitely-not-this-database",
    ]);
    assert(r.status !== 0, "it did not refuse");
    assert(/REFUSED/.test(r.stderr), "the refusal is not stated");
    assert(r.stdout === "", "it emitted output despite refusing");
  });

  check("refuses a missing --expect-database rather than defaulting", () => {
    const r = inContainer(["node", "/tmp/proovra-diagnostic.cjs"]);
    assert(r.status !== 0, "it ran without being told which database to expect");
    assert(/--expect-database=<name> is required/.test(r.stderr), "unclear refusal");
    assert(r.stdout === "", "it emitted output");
  });

  // ---------------------------------------------------------------------------
  // Read-only: the claim the whole exercise rests on.
  // ---------------------------------------------------------------------------
  check("the script contains no write of any kind", () => {
    // Comments stripped. The header DECLARES that there is no `$executeRaw`
    // anywhere in the file; a check that cannot tell a declaration from a call
    // forbids writing the declaration down, which is the opposite of what a
    // read-only guarantee needs.
    const src = readFileSync(DIAGNOSTIC, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Anchored on `prisma.<model>.`, because `createHash().update(...)` is a
    // hash and `.create(` appears in plenty of harmless shapes. A pattern
    // broad enough to catch those is a pattern that gets suppressed.
    for (const forbidden of [
      /\$executeRaw/,
      /prisma\.[A-Za-z]+\.create(Many)?\(/,
      /prisma\.[A-Za-z]+\.update(Many)?\(/,
      /prisma\.[A-Za-z]+\.delete(Many)?\(/,
      /prisma\.[A-Za-z]+\.upsert\(/,
      /prisma\.\$transaction\(/,
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bDROP\s+/i,
      /\bALTER\s+/i,
    ]) {
      assert(!forbidden.test(src), `the diagnostic contains ${forbidden}`);
    }
  });
} catch (err) {
  failures += 1;
  console.log(`  FAIL  harness: ${err.message}`);
} finally {
  teardown();
}

console.log(
  failures === 0
    ? `\nOK — ${checks}/${checks} checks passed against ${IMAGE}.`
    : `\nFAILED — ${failures} of ${checks} checks failed against ${IMAGE}.`,
);
process.exit(failures === 0 ? 0 : 1);
