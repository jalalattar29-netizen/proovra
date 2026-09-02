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
 */

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const API_BASE = arg("api", "http://localhost:8081");
const PORT = arg("port", "3200");
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
const DIST_DIR = arg("dist", "node_modules/.cache/admin-fixture-next");

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

// `shell: true` because on Windows the resolved binary is `npx.cmd`, and
// spawning a .cmd without a shell fails with EINVAL.
const child = spawn("npx", ["next", "dev", "-p", PORT], {
  cwd: WEB_ROOT,
  shell: true,
  stdio: "inherit",
  env: {
      ...process.env,
      NODE_ENV: "development",
      // Both spellings: the web reads NEXT_PUBLIC_API_BASE, and some server
      // paths read API_BASE_URL. Setting one and not the other produces a page
      // whose server half and client half disagree about where the API is.
      NEXT_PUBLIC_API_BASE: API_BASE,
      API_BASE_URL: API_BASE,
      NEXT_PUBLIC_WEB_BASE: `http://localhost:${PORT}`,
      NEXT_PUBLIC_APP_BASE: `http://localhost:${PORT}`,
      // Its OWN build directory.
      //
      // A `next build` in the same checkout writes `.next` too. When one ran
      // beside this server it replaced routes-manifest.json mid-flight and
      // every page started answering 500 — an ENOENT naming a file nobody had
      // touched, which reads as a broken app rather than as two processes
      // sharing a directory. next.config.js honours NEXT_DIST_DIR.
      NEXT_DIST_DIR: DIST_DIR,
  },
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
    return;
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
