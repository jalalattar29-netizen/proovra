#!/usr/bin/env node
/**
 * RUN THE WEB APP AGAINST THE LOCAL ADMIN FIXTURE.
 *
 * =============================================================================
 * THE PROBLEM THIS SOLVES
 * =============================================================================
 * `apps/web/.env.local` points at Production. That is a developer's own file
 * and this script does not touch it — but it means `next dev` talks to
 * Production by default, which is why browser verification of the admin console
 * kept being deferred.
 *
 * `NEXT_PUBLIC_API_BASE` is INLINED AT COMPILE TIME. In `next dev` compilation
 * happens per request, so a value present in the process environment when the
 * server starts is the value the client bundle gets. Next's env loader does not
 * overwrite variables already set in `process.env`, so setting it here wins
 * over `.env.local` without editing it.
 *
 * =============================================================================
 * WHAT IT WILL NOT DO
 * =============================================================================
 * It refuses to start if the API base it was given is not localhost. The entire
 * point is to keep this process away from Production, and a typo in an override
 * would otherwise produce a browser session against real customer data while
 * looking exactly like a local one.
 *
 * It writes nothing. No .env file is created, modified or read for secrets.
 *
 * =============================================================================
 * USAGE
 * =============================================================================
 *   1. start Postgres and Redis, migrate and seed:
 *        docker exec <pg> psql -U <u> -d postgres -c 'CREATE DATABASE proovra_admin_fixture;'
 *        DATABASE_URL=…/proovra_admin_fixture pnpm --filter proovra-api exec prisma migrate deploy
 *        NODE_ENV=development DATABASE_URL=…/proovra_admin_fixture \
 *          pnpm --filter proovra-api exec tsx scripts/seed-admin-fixture.ts
 *
 *   2. start the API on 8081 with that DATABASE_URL.
 *
 *   3. node apps/web/scripts/dev-admin-fixture.mjs
 *
 * Override with `--api=http://localhost:PORT` and `--port=PORT`.
 *
 * =============================================================================
 * TWO MODES, AND WHY PRODUCTION IS THE DEFAULT (ADM-P2-004)
 * =============================================================================
 * `--mode=production` (default) builds once and serves with `next start`.
 * `--mode=dev` keeps the old `next dev` behaviour for interactive work.
 *
 * The admin control-plane suite ran against `next dev` and could not be
 * asserted green. The failure moved across unrelated routes run to run, every
 * failing route passed when re-run alone, and the server answered the stalled
 * route in tens of milliseconds — while the session logged 3,363 on-demand
 * compiles for 47 routes, individual compiles up to 23.3s. A navigation's chunk
 * requests queue behind an unrelated route's compilation, and a 90s
 * `domcontentloaded` budget loses. That is a property of compiling on demand,
 * not of the pages, and no retry or raised timeout would have made it a real
 * result.
 *
 * A production build compiles everything once, before the suite starts, so
 * every navigation is served from finished output. It is also what the other
 * layout projects in `playwright.config.ts` already do, for the neighbouring
 * reason that `next dev` differs from the shipped bundle in stylesheet order,
 * cascade and class hashing.
 *
 *   --mode=production --build-only   build, then exit (run once, before the suite)
 *   --mode=production                serve an existing build with `next start`
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLocalFixtureEnv,
  LOCAL_FIXTURE_DEFAULTS,
} from "../../../scripts/local-fixture-env/index.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/*
 * CLI FLAG, THEN ENVIRONMENT, THEN DEFAULT — AND THE ENVIRONMENT MATTERS.
 *
 * `--api=` was the only way in. The Playwright config reads
 * `PROOVRA_FIXTURE_API_BASE` to build the `--api=` it passes to the SERVER, but
 * the BUILD is a separate invocation (`--build-only`) that got no flag, so it
 * silently used the default port while the server used the requested one.
 *
 * `NEXT_PUBLIC_API_BASE` is inlined at compile time, so those two disagreeing
 * means the browser posts to a port nothing is serving: the page renders, the
 * login form submits, and every spec times out at `waitForURL`. The refusal
 * further down caught it and named both ports — but a guard that fires on a
 * configuration nobody could satisfy is a design to fix, not a safety net to
 * rely on.
 *
 * Honouring the same environment variable in both invocations makes one value
 * reach the build and the server by construction.
 */
const API_PORT = arg("api-port", LOCAL_FIXTURE_DEFAULTS.apiPort);
const API_BASE = arg(
  "api",
  process.env.PROOVRA_FIXTURE_API_BASE ?? `http://localhost:${API_PORT}`,
);
const PORT = arg(
  "port",
  process.env.PROOVRA_FIXTURE_WEB_PORT ?? LOCAL_FIXTURE_DEFAULTS.webPort,
);
// Inside node_modules ON PURPOSE.
//
// The first attempt used ".next-admin-fixture" at the app root. It worked, and
// it broke five governance gates: 28 test files walk apps/web looking for
// source patterns and each one hardcodes its own skip list containing the
// literal ".next". A sibling directory is not that string, so a compiled
// webpack chunk containing `window.confirm(` was read as application source
// and reported as a banned call.
//
// The fix is not a 29th exclusion. node_modules is skipped by every one of
// those scanners already, and by git, so putting the build there reuses a
// convention that is universally observed instead of racing to update the
// places that observe it.
const MODE = arg("mode", "production");
if (!["production", "dev"].includes(MODE)) {
  console.error(`dev-admin-fixture: --mode must be "production" or "dev", got "${MODE}".`);
  process.exit(2);
}
const BUILD_ONLY = process.argv.includes("--build-only");

/*
 * A SEPARATE DIRECTORY PER MODE, AND IT IS PURGED BEFORE A BUILD.
 *
 * The dev and production outputs are not interchangeable, and a stale one is
 * not a theoretical risk — a run of this suite was served a build manifest
 * compiled 27 minutes before the fix under test existed and half an hour
 * before a rebase, which produced ChunkLoadError, "Invalid or unexpected
 * token" and 404s that looked like product defects for a full run.
 *
 * So: production writes somewhere dev never touches, and `--build-only`
 * removes the directory first. Nothing can be inherited from a previous
 * fixture build, another worktree, or a dev cache.
 */
const DIST_DIR = arg(
  "dist",
  MODE === "production"
    ? "node_modules/.cache/admin-fixture-next-prod"
    : "node_modules/.cache/admin-fixture-next",
);

let host;
try {
  host = new URL(API_BASE).hostname;
} catch {
  console.error(`dev-admin-fixture: --api=${API_BASE} is not a URL.`);
  process.exit(2);
}

if (!["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
  // The whole purpose is to stay away from Production. A typo here would put a
  // browser session on real customer data while looking local.
  console.error(
    `dev-admin-fixture: REFUSED — the API base must be localhost, got "${host}".`,
  );
  process.exit(2);
}

console.log(
  [
    "dev-admin-fixture",
    `  mode ${MODE}${BUILD_ONLY ? " (build only)" : ""}`,
    `  web  http://localhost:${PORT}`,
    `  api  ${API_BASE}`,
    `  build ${DIST_DIR}  (isolated from a concurrent next build)`,
    "",
    "  .env.local is neither read for this override nor modified.",
    "",
  ].join("\n"),
);

/**
 * Put tsconfig.json back when we exit.
 *
 * `next dev` REWRITES apps/web/tsconfig.json on startup: it reformats the whole
 * file, and appends a types glob under the dist directory to `include`. That
 * file is TRACKED, so a verification run left the working tree dirty with a
 * change nobody made, naming a build directory that exists only during the run
 * — and in a checkout where another session is working, an unexplained diff in
 * a shared config is worse than the inconvenience it saves.
 *
 * IT IS NOT A GUARANTEE. This restores on a normal exit and on SIGINT /
 * SIGTERM / SIGHUP. A hard kill runs no handler at all — on Windows,
 * `Stop-Process -Force` is exactly that, and it was how this was first
 * tested: the file stayed modified and the guard looked broken when it had
 * simply never been given the chance to run. If tsconfig.json is dirty after
 * a run that was killed, `git checkout -- apps/web/tsconfig.json` is the fix
 * and nothing is lost.
 */
// BOTH files, not just tsconfig. next-env.d.ts carries a
// `/// <reference path="./<distDir>/types/routes.d.ts" />` line that Next
// rewrites the same way, and it was missed on the first pass precisely
// because tsconfig.json was the one that had been noticed.
const GUARDED = ["tsconfig.json", "next-env.d.ts"].map((name) => ({
  name,
  path: resolve(WEB_ROOT, name),
  before: readFileSync(resolve(WEB_ROOT, name), "utf8"),
}));
let guardedRestored = false;
function restoreTsconfig() {
  if (guardedRestored) return;
  guardedRestored = true;
  for (const g of GUARDED) {
    try {
      if (readFileSync(g.path, "utf8") !== g.before) {
        writeFileSync(g.path, g.before, "utf8");
        console.log(`\ndev-admin-fixture: restored apps/web/${g.name}`);
      }
    } catch {
      /* nothing useful to do while exiting */
    }
  }
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restoreTsconfig();
    process.exit(0);
  });
}
process.on("exit", restoreTsconfig);

/**
 * The child environment, built ONCE from the canonical allowlist.
 *
 * Hoisted out of the spawn call because the build and the server must get
 * byte-identical environments. `NEXT_PUBLIC_*` is inlined at COMPILE time, so
 * a build with one API base and a server started with another would serve a
 * bundle pointing somewhere nobody asked for — and in production mode the
 * build is the only chance to get it right.
 */
const CHILD_ENV = {
  ...buildLocalFixtureEnv({
    apiPort: new URL(API_BASE).port || API_PORT,
    webPort: PORT,
    databaseUrl: arg("database-url", LOCAL_FIXTURE_DEFAULTS.databaseUrl),
    redisUrl: arg("redis-url", LOCAL_FIXTURE_DEFAULTS.redisUrl),
  }),
  // next.config.js honours this; see the DIST_DIR note above.
  NEXT_DIST_DIR: DIST_DIR,
  /*
   * `next start` CANNOT SERVE A STANDALONE BUILD, AND SAYS SO IN A WARNING.
   *
   * `next.config.js` defaults `output` to "standalone" for the deployed image.
   * The first production run of this suite built that way, `next start` printed
   *
   *   ⚠ "next start" does not work with "output: standalone" configuration.
   *
   * and then served pages that looked right and did nothing: every spec failed
   * at `page.waitForURL` after submitting the login form, because the client
   * bundle never wired up. Ten tests, one cause, and a symptom ("sign-in hangs")
   * that points nowhere near the config.
   *
   * `NEXT_STANDALONE=false` is the escape hatch next.config.js already carries.
   * It selects an ordinary build — the one `next start` is designed to serve —
   * and changes nothing about the application: the deployed image still builds
   * standalone, because nothing else sets this.
   *
   * It is set for BOTH the build and the server. `output` is a build-time
   * decision, so a server started with it while the build was made without it
   * would be the same mismatch wearing a different hat.
   */
  NEXT_STANDALONE: "false",
};

if (MODE === "production" && BUILD_ONLY) {
  // Purge first. See the DIST_DIR note: a reused output directory is how a
  // whole verification run was served a bundle that predated the fix it was
  // meant to prove.
  rmSync(resolve(WEB_ROOT, DIST_DIR), { recursive: true, force: true });
  console.log(`  purged ${DIST_DIR}, building…`);
  const built = spawnSync("npx", ["next", "build"], {
    cwd: WEB_ROOT,
    shell: true,
    stdio: "inherit",
    env: { ...CHILD_ENV, NODE_ENV: "production" },
  });
  restoreTsconfig();
  if (built.status !== 0) {
    console.error(`dev-admin-fixture: next build failed (exit ${built.status}).`);
    process.exit(built.status ?? 1);
  }
  console.log("dev-admin-fixture: build complete.");
  process.exit(0);
}

if (MODE === "production") {
  // A server with no build behind it would 404 every route and read as a
  // product failure. Say which command is missing instead.
  try {
    readFileSync(resolve(WEB_ROOT, DIST_DIR, "BUILD_ID"), "utf8");
  } catch {
    console.error(
      `dev-admin-fixture: no build at ${DIST_DIR}. Run with --build-only first.`,
    );
    process.exit(2);
  }
}

// `shell: true` because on Windows the resolved binary is `npx.cmd`, and
// spawning a .cmd without a shell fails with EINVAL.
const child = spawn("npx", MODE === "production"
  ? ["next", "start", "-p", PORT, "-H", "127.0.0.1"]
  : ["next", "dev", "-p", PORT], {
  cwd: WEB_ROOT,
  shell: true,
  stdio: "inherit",
  /**
   * The environment comes from the ONE canonical builder, not from this file.
   *
   * An earlier version assembled it here: spread `process.env`, then override
   * a handful of NEXT_PUBLIC_* values. That inherits every credential in the
   * developer's shell and in any .env dotenv has already loaded, which is the
   * hole `scripts/local-fixture-env` exists to close. The web server is not
   * exempt from it just because it is "only" a dev server: it is the process
   * that renders pages holding real tokens.
   */
  env:
    MODE === "production"
      ? { ...CHILD_ENV, NODE_ENV: "production" }
      : CHILD_ENV,
});

/**
 * PROVE the served bundle talks to the local API before anyone signs in.
 *
 * The refusal above checks the value we PASS. It cannot check the value the
 * bundle ENDS UP with, and those came apart once: a `next build` run with the
 * same variables on its command line produced chunks containing
 * `api.proovra.com`, because `NEXT_PUBLIC_*` is inlined at compile time and
 * `.env.local` won. The browser then sent fixture credentials to Production's
 * login endpoint — rejected, nothing read or written, and entirely avoidable.
 *
 * So this asks the running server what it actually serves. It fetches the login
 * page, reads the API origin out of it, and KILLS the server if that origin is
 * not the one we asked for. A verification run that silently points at
 * Production is worse than no verification run.
 */
async function assertServedBaseIsLocal() {
  const deadline = Date.now() + 180_000;
  let html = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/login`);
      if (res.ok) {
        html = await res.text();
        break;
      }
    } catch {
      /* still compiling */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (html === null) {
    console.error("dev-admin-fixture: server never became ready; cannot verify its API base.");
    child.kill();
    process.exit(2);
  }

  // The origin is inlined into the JS CHUNKS, not into the HTML.
  //
  // Two earlier versions of this check passed vacuously. Scanning the HTML
  // found nothing because the value is not there. Scanning only the script
  // tags on the login page found nothing either, because in dev the page's own
  // chunk compiles lazily and is not in that list.
  //
  // So it scans the compiled chunks ON DISK. That is exactly the check that
  // caught the bad production build — `grep api.proovra.com .next/static` —
  // and it sees whatever has actually been compiled, which after a `/login`
  // request includes the module that carries the base.
  const CHUNK_DIR = resolve(WEB_ROOT, `${DIST_DIR}/static/chunks`);
  const origins = new Set();

  const scan = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        scan(p);
        continue;
      }
      if (!e.name.endsWith(".js")) continue;
      let js;
      try {
        js = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      for (const m of js.matchAll(/https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?=\/v1\/|["'`])/g)) {
        // Only origins that could be an API base. The bundle also references
        // fonts and schema URLs, and flagging those makes a guard noisy enough
        // that somebody switches it off.
        if (/(^|\/\/)(api\.|localhost|127\.0\.0\.1)/i.test(m[0])) origins.add(m[0]);
      }
    }
  };
  scan(CHUNK_DIR);
  const foreign = [...origins].filter((o) => {
    try {
      return !["localhost", "127.0.0.1", "::1"].includes(new URL(o).hostname);
    } catch {
      return true;
    }
  });

  if (foreign.length > 0) {
    console.error(
      `dev-admin-fixture: REFUSED — the served page references ${foreign.join(", ")}. ` +
        `NEXT_PUBLIC_API_BASE did not reach the compile. Not serving.`,
    );
    child.kill();
    process.exit(2);
  }

  if (origins.size > 0) {
    console.log(`  verified: compiled chunks reference ${[...origins].join(", ")}\n`);

    /*
     * THE BUILD BAKED AN API BASE. IT HAD BETTER BE THE ONE WE ARE SERVING.
     *
     * `NEXT_PUBLIC_API_BASE` is inlined at COMPILE time, so a build made with
     * one API port and a server started with another produces a bundle that
     * posts to a port nothing is listening on. The page renders, the form
     * submits, and nothing happens.
     *
     * That is not hypothetical: the first corrected production run of this
     * suite built with the default 8191 and ran against an API on 8291, and
     * all ten specs failed at `page.waitForURL` after the login submit. The
     * banner above had already printed the mismatch — it just was not being
     * compared to anything.
     *
     * Comparing it turns an hour of "sign-in hangs" into one line naming both
     * ports. The check is deliberately narrow: only origins that look like an
     * API base are considered, and the web origin itself is ignored.
     */
    const wanted = new URL(API_BASE).port || (new URL(API_BASE).protocol === "https:" ? "443" : "80");
    const apiish = [...origins].filter((o) => {
      try {
        const u = new URL(o);
        return (u.port || "") !== String(PORT);
      } catch {
        return false;
      }
    });
    const wrong = apiish.filter((o) => {
      try {
        return (new URL(o).port || "") !== wanted;
      } catch {
        return true;
      }
    });
    if (wrong.length > 0) {
      console.error(
        `dev-admin-fixture: REFUSED — the build baked ${wrong.join(", ")} but this ` +
          `server was told --api=${API_BASE}. NEXT_PUBLIC_API_BASE is inlined at ` +
          `build time, so the browser would post to a port nothing is serving. ` +
          `Rebuild with the same --api.`,
      );
      child.kill();
      process.exit(2);
    }
    return;
  }

  /*
   * IN PRODUCTION MODE THIS IS A REFUSAL, NOT A NOTE.
   *
   * The dev caveat below is real: chunks compile lazily, so an early scan can
   * legitimately find nothing. A production build has no such excuse — every
   * chunk exists on disk before the server starts, so finding no API origin at
   * all means the scan is not looking at what is served, and a guard that
   * cannot see its subject must not report a pass.
   */
  if (MODE === "production") {
    console.error(
      "dev-admin-fixture: REFUSED — no API origin found in a COMPLETED " +
        `production build at ${DIST_DIR}. The scan cannot see what is being ` +
        "served, so the localhost guarantee is unproven. Not serving.",
    );
    child.kill();
    process.exit(2);
  }

  // INCONCLUSIVE, and it says so.
  //
  // In dev the page chunks compile lazily, so a scan run seconds after boot can
  // legitimately find nothing yet. Reporting that as "verified" is what a first
  // version did, and a guard that passes when it has seen nothing is worse than
  // no guard: it converts an unknown into a reassurance.
  //
  // The browser-side check is the authoritative one — read
  // `performance.getEntriesByType("resource")` and confirm every /v1 call goes
  // to localhost before trusting a verification run.
  console.log(
    "  INCONCLUSIVE: no API origin found in the compiled chunks yet (dev compiles\n" +
      "  lazily). Confirm in the browser that every /v1 request goes to localhost\n" +
      "  before trusting this session.\n",
  );
}

void assertServedBaseIsLocal();

child.on("exit", (code) => {
  restoreTsconfig();
  process.exit(code ?? 0);
});
