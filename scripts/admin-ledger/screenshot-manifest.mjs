#!/usr/bin/env node
/**
 * THE TRACKED RECORD OF UNTRACKED PIXELS.
 *
 * =============================================================================
 * WHY A MANIFEST AND NOT COMMITTED SCREENSHOTS
 * =============================================================================
 * artifacts/ is deliberately gitignored — 94 full-page PNGs per visual pass
 * would swell the repository on every re-capture for no reviewable gain. But
 * evidence that only exists on one machine is a claim, not evidence. The
 * middle ground is this manifest: for every capture the route, viewport,
 * role, direction, state, byte size and sha256 — small, diffable, and enough
 * to prove later that the file somebody is looking at is the file the ledger
 * cited (or that it is not).
 *
 * It also REFUSES to describe an incomplete set: every admin route must have
 * its 1440 and 390 capture, or the generator exits 1 naming the holes. A
 * manifest that silently documents whatever happens to exist would inherit
 * exactly the omission problem the completion ledger was built to kill.
 *
 * Usage:
 *   node scripts/admin-ledger/screenshot-manifest.mjs          # write + verify
 *   node scripts/admin-ledger/screenshot-manifest.mjs --check  # verify only
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const REVIEW_SHOTS = resolve(REPO, "artifacts/admin-visual-review/screenshots");
const STATE_SHOTS = resolve(REPO, "artifacts/admin-visual-review/states");
const MATRIX_SHOTS = resolve(REPO, "artifacts/admin-matrix/screenshots");
const OUT = resolve(REPO, "docs/admin/evidence/screenshot-manifest.json");

function routes() {
  const raw = execFileSync(
    process.execPath,
    [resolve(REPO, "apps/web/scripts/admin-inventory.mjs"), "--json"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw).rows.map((r) => r.route);
}

/** The two slug spellings in use: review uses '-', the matrix uses '_'. */
const reviewSlug = (route) =>
  route.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");
const matrixSlug = (route) => route.replace(/[/:]/g, "_").replace(/^_/, "");

function fileEntry(abs, meta) {
  const buf = readFileSync(abs);
  return {
    ...meta,
    path: relative(REPO, abs).split(sep).join("/"),
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

function collect() {
  const all = routes();
  const bySlug = new Map(all.map((r) => [reviewSlug(r), r]));
  const byMatrixSlug = new Map(all.map((r) => [matrixSlug(r), r]));
  const entries = [];
  const problems = [];

  // 1. The visual review pair: every route at 1440 and 390, populated, LTR.
  for (const route of all) {
    for (const [viewport, suffix] of [
      ["1440", "desktop"],
      ["390", "mobile"],
    ]) {
      const abs = join(REVIEW_SHOTS, `${reviewSlug(route)}--${suffix}.png`);
      if (!existsSync(abs)) {
        problems.push(`${route}: missing ${viewport} capture (${suffix})`);
        continue;
      }
      entries.push(
        fileEntry(abs, {
          kind: "visual-review",
          route,
          viewport,
          role: "platform-admin",
          direction: "ltr",
          state: "populated",
          result: "captured",
        }),
      );
    }
  }

  // 2. State captures: family representatives across loading / error /
  //    filtered-empty / dialog / rtl / unauthorized.
  if (existsSync(STATE_SHOTS)) {
    for (const name of readdirSync(STATE_SHOTS)) {
      if (!name.endsWith(".png")) continue;
      const m = /^(.*)--([a-z-]+)\.png$/.exec(name);
      if (!m) continue;
      const route = bySlug.get(m[1]) ?? `(unmapped) ${m[1]}`;
      entries.push(
        fileEntry(join(STATE_SHOTS, name), {
          kind: "state",
          route,
          viewport: "1440",
          role: m[2] === "unauthorized" ? "read-only" : "platform-admin",
          direction: m[2] === "rtl" ? "rtl" : "ltr",
          state: m[2],
          result: "captured",
        }),
      );
    }
  }

  // 3. Matrix captures (platform-admin at 1440/390 per direction), when a
  //    matrix run has been taken on this tree.
  if (existsSync(MATRIX_SHOTS)) {
    for (const name of readdirSync(MATRIX_SHOTS)) {
      if (!name.endsWith(".png")) continue;
      const m = /^(.*)__(\d+|zoom200)__(ltr|rtl)__(.+)\.png$/.exec(name);
      if (!m) continue;
      entries.push(
        fileEntry(join(MATRIX_SHOTS, name), {
          kind: "matrix",
          route: byMatrixSlug.get(m[1]) ?? `(unmapped) ${m[1]}`,
          viewport: m[2],
          role: m[4],
          direction: m[3],
          state: "populated",
          result: "captured",
        }),
      );
    }
  }

  const required = ["loading", "error", "rtl"];
  const stateRoutes = new Set(
    entries.filter((e) => e.kind === "state").map((e) => `${e.route}|${e.state}`),
  );
  const families = entries.filter((e) => e.kind === "state").map((e) => e.route);
  if (families.length === 0) {
    problems.push("no state captures at all — run admin-states.spec.ts");
  } else {
    for (const fam of new Set(families)) {
      for (const st of required) {
        if (st === "unauthorized") continue;
        if (!stateRoutes.has(`${fam}|${st}`) && !fam.startsWith("(unmapped)")) {
          problems.push(`${fam}: no ${st} state capture`);
        }
      }
    }
  }

  entries.sort((a, b) =>
    `${a.kind}|${a.route}|${a.viewport}|${a.role}|${a.direction}|${a.state}`.localeCompare(
      `${b.kind}|${b.route}|${b.viewport}|${b.role}|${b.direction}|${b.state}`,
    ),
  );
  return { entries, problems, routeCount: all.length };
}

const { entries, problems, routeCount } = collect();
const manifest = {
  _comment:
    "GENERATED by scripts/admin-ledger/screenshot-manifest.mjs. Records every " +
    "capture backing the admin completion ledger: what was captured, of which " +
    "route, at which viewport, as which role, in which state — and the hash " +
    "that proves a file on disk is the file this manifest described.",
  routeCount,
  captureCount: entries.length,
  captures: entries,
};

if (!process.argv.includes("--check")) {
  writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`wrote ${relative(REPO, OUT)} — ${entries.length} captures over ${routeCount} routes`);
} else {
  console.log(`${entries.length} captures over ${routeCount} routes`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} manifest problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
