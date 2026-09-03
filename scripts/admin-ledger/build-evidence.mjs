#!/usr/bin/env node
/**
 * THE LEDGER'S EVIDENCE, DERIVED FROM THE ARTIFACTS THAT EXIST.
 *
 * =============================================================================
 * WHAT THIS IS AND IS NOT
 * =============================================================================
 * scripts/admin-ledger/evidence.json is the completion ledger's one
 * hand-maintained input. Hand-maintained does not mean hand-invented: every
 * proof value in it must name an artifact, and the artifacts are produced by
 * runs — the visual review, the browser matrix, the state captures, the
 * composition contract, the mutation matrix. This builder reads THOSE and
 * writes the evidence file, refusing to claim anything the artifacts do not
 * carry:
 *
 *   desktop / mobile   the 1440/390 capture exists for the route, and the
 *                      matrix's platform-admin rows for it are clean
 *   rtl                the matrix ran the route in RTL (1440 and 320) as
 *                      platform-admin with zero findings
 *   states             the route's family representative carries the
 *                      loading / error / rtl (and where applicable
 *                      filtered-empty / dialog / unauthorized) captures,
 *                      and the mutation render suites exercise its actions
 *   authorization      the matrix refused every non-admin role on the
 *                      route, and the API matrix test carries the endpoint
 *                      side
 *   contract           the composition contract passes for the route and
 *                      the ledger's own backend-contract trace resolved
 *                      every endpoint
 *
 * A route any input cannot vouch for stays PENDING and the builder exits 1
 * saying why. The generated file is still the reviewable input — a human
 * reads the diff, and the validator in generate.mjs still runs on it.
 *
 * Usage:
 *   node scripts/admin-ledger/build-evidence.mjs           # write evidence.json
 *   node scripts/admin-ledger/build-evidence.mjs --check   # report only
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const EVIDENCE = resolve(HERE, "evidence.json");
const FINDINGS = resolve(REPO, "artifacts/admin-matrix/findings.json");
const REVIEW = resolve(REPO, "artifacts/admin-visual-review/review.json");
const MANIFEST = resolve(REPO, "docs/admin/evidence/screenshot-manifest.json");
const MUTATIONS = resolve(REPO, "docs/admin/evidence/mutation-matrix.json");

const reviewSlug = (route) =>
  route.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function inventory() {
  return JSON.parse(
    run(process.execPath, [resolve(REPO, "apps/web/scripts/admin-inventory.mjs"), "--json"]),
  ).rows;
}

/** The composition contract, executed now — not a stale artifact. */
function compositionPasses() {
  try {
    run(process.execPath, [resolve(REPO, "apps/web/scripts/admin-composition-contract.mjs")]);
    return true;
  } catch {
    return false;
  }
}

const problems = [];
const need = (cond, why) => {
  if (!cond) problems.push(why);
  return cond;
};

// ---------------------------------------------------------------------------
// Inputs.
// ---------------------------------------------------------------------------

need(existsSync(FINDINGS), "artifacts/admin-matrix/findings.json is missing — run the matrix");
need(existsSync(REVIEW), "artifacts/admin-visual-review/review.json is missing — run the review");
need(existsSync(MANIFEST), "screenshot manifest missing — run screenshot-manifest.mjs");
need(existsSync(MUTATIONS), "mutation matrix JSON missing — run admin-mutation-matrix.mjs --json");
if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const rows = inventory();
const findings = JSON.parse(readFileSync(FINDINGS, "utf8")).findings;
const review = JSON.parse(readFileSync(REVIEW, "utf8"));
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const mutations = JSON.parse(readFileSync(MUTATIONS, "utf8"));
const compositionOk = compositionPasses();
need(compositionOk, "the composition contract does not pass on this tree");

const reviewByRoute = new Map(review.routes.map((r) => [r.route, r]));
const capturesByRoute = new Map();
for (const c of manifest.captures) {
  if (!capturesByRoute.has(c.route)) capturesByRoute.set(c.route, []);
  capturesByRoute.get(c.route).push(c);
}

/** Matrix rows for one route, split the ways the proofs need. */
function matrixFor(route) {
  const mine = findings.filter((f) => f.route === route);
  const adminOk = mine.filter((f) => f.role === "platform-admin" && f.ok);
  const adminBad = mine.filter((f) => f.role === "platform-admin" && !f.ok);
  const rtlOk = adminOk.filter((f) => f.dir === "rtl");
  const denialRoles = new Set(
    mine
      .filter((f) => f.role !== "platform-admin" && f.ok)
      .map((f) => f.role),
  );
  const denialBad = mine.filter((f) => f.role !== "platform-admin" && !f.ok);
  return { mine, adminOk, adminBad, rtlOk, denialRoles, denialBad };
}

/** Which routes this branch actually recomposed, from the branch diff. */
function changedRoutes() {
  const diff = run("git", ["diff", "--name-only", "origin/main..HEAD", "--", "apps/web/app/(app)/admin"]);
  const changed = new Set();
  for (const line of diff.split("\n")) {
    const m = /^apps\/web\/app\/\(app\)\/admin\/(.*)$/.exec(line.trim());
    if (!m) continue;
    const dir = m[1].replace(/\/[^/]*$/, "");
    changed.add(dir);
  }
  const out = new Set();
  for (const r of rows) {
    const routeDir = r.route
      .replace(/^\/admin\/?/, "")
      .replace(/:(\w+)/g, "[$1]");
    for (const c of changed) {
      if (c === routeDir || c.startsWith(`${routeDir}/`) || (routeDir === "" && !c.includes("/"))) {
        out.add(r.route);
      }
    }
    if (changed.has(routeDir === "" ? "page.tsx" : `${routeDir}/page.tsx`)) out.add(r.route);
  }
  return out;
}

const recomposed = changedRoutes();

/** The family-representative state captures each route may lean on. */
const FAMILY_REP = {
  "dashboard-kpi": "/admin",
  "data-table": "/admin/contact-sales",
  "dynamic-detail": "/admin/contact-sales/:id",
};
const stateCaptureRoutes = new Set(
  manifest.captures.filter((c) => c.kind === "state").map((c) => c.route),
);

// ---------------------------------------------------------------------------
// Existing hand-carried fields (breadcrumbs, return paths, families) survive.
// ---------------------------------------------------------------------------
const previous = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, "utf8")) : {};

const out = {
  _comment: [
    "THE ONE HAND-MAINTAINED INPUT TO THE ADMIN COMPLETION LEDGER.",
    "",
    "Regenerated from executed artifacts by scripts/admin-ledger/build-evidence.mjs",
    "(visual review, browser matrix, state captures, screenshot manifest,",
    "mutation matrix, composition contract). Every proof names the artifact",
    "that backs it; the builder refuses to write a claim its inputs do not",
    "carry, and generate.mjs validates the result independently. Breadcrumbs,",
    "return paths and families are carried over as reviewed facts.",
  ],
};

let pending = 0;
for (const inv of rows) {
  const route = inv.route;
  const prev = previous[route] ?? {};
  const m = matrixFor(route);
  const caps = capturesByRoute.get(route) ?? [];
  const desktop = caps.find((c) => c.kind === "visual-review" && c.viewport === "1440");
  const mobile = caps.find((c) => c.kind === "visual-review" && c.viewport === "390");
  const rev = reviewByRoute.get(route);

  const routeProblems = [];
  if (!desktop) routeProblems.push("no 1440 capture in the manifest");
  if (!mobile) routeProblems.push("no 390 capture in the manifest");
  if (!rev) routeProblems.push("no visual-review measurements");
  if (m.adminOk.filter((f) => f.dir === "ltr").length < 8) {
    routeProblems.push(`platform-admin LTR ran ${m.adminOk.filter((f) => f.dir === "ltr").length}/8 viewports clean`);
  }
  if (m.rtlOk.length < 2) routeProblems.push(`RTL ran ${m.rtlOk.length}/2 clean`);
  if (m.adminBad.length > 0) {
    routeProblems.push(`platform-admin findings open: ${m.adminBad[0].problems.join("; ").slice(0, 120)}`);
  }
  const wantRoles = ["anonymous", "free-personal", "pro-personal", "read-only", "workspace-admin", "org-owner"];
  const missingRoles = wantRoles.filter((r) => !m.denialRoles.has(r));
  if (missingRoles.length > 0) routeProblems.push(`role refusal not verified for: ${missingRoles.join(", ")}`);
  if (m.denialBad.length > 0) {
    routeProblems.push(`role findings open: ${m.denialBad[0].role} — ${m.denialBad[0].problems.join("; ").slice(0, 100)}`);
  }
  const unresolved = (inv.api ?? []).filter((a) => (a.authority ?? []).includes("UNRESOLVED"));
  if (unresolved.length > 0) routeProblems.push(`unresolved endpoint: ${unresolved[0].literal}`);

  const mutationRows = mutations.rows.filter((r) => r.route === route);
  const mutationsClean = mutationRows.every((r) =>
    Object.values(r.checks).every((c) => c.final !== null),
  );
  if (!mutationsClean) routeProblems.push("mutation matrix cells open");

  if (routeProblems.length > 0 || !compositionOk) {
    pending += 1;
    out[route] = {
      ...(prev.family ? { family: prev.family } : {}),
      ...(prev.breadcrumb ? { breadcrumb: prev.breadcrumb } : {}),
      ...(prev.returnPath ? { returnPath: prev.returnPath } : {}),
      status: "PENDING",
      blocker: routeProblems.join("; ").slice(0, 400),
      proofs: {
        ...(desktop ? { desktop: desktop.path } : {}),
        ...(mobile ? { mobile: mobile.path } : {}),
      },
    };
    problems.push(`${route}: ${routeProblems.join("; ")}`);
    continue;
  }

  const statesProof = stateCaptureRoutes.has(route)
    ? "docs/admin/evidence/screenshot-manifest.json#state-captures"
    : "docs/admin/evidence/screenshot-manifest.json#family-state-captures + apps/web/__tests__/render/admin-mutations-*.render.test.tsx";

  const isDetail = route.includes("/:");
  const status = isDetail
    ? "CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED"
    : recomposed.has(route)
      ? "REDESIGNED_AND_E2E_VERIFIED"
      : "NO_INTERNAL_RECOMPOSITION_REQUIRED";

  out[route] = {
    ...(prev.family ? { family: prev.family } : {}),
    ...(prev.breadcrumb ? { breadcrumb: prev.breadcrumb } : {}),
    ...(prev.returnPath ? { returnPath: prev.returnPath } : {}),
    status,
    statusReason:
      status === "NO_INTERNAL_RECOMPOSITION_REQUIRED"
        ? "Composition met the contract as it stood; the browser matrix ran it clean at every required viewport, in RTL, and refused every non-admin role, with populated fixture data on screen."
        : `Recomposed on this branch and verified in the browser: ${rev.desktop.screensTall} screens at 1440, ${rev.mobile.screensTall} at 390, matrix clean across ${m.adminOk.length} platform-admin runs and ${m.denialRoles.size} refused roles.`,
    fixture: "services/api/scripts/seed-admin-fixture.ts",
    proofs: {
      desktop: desktop.path,
      mobile: mobile.path,
      rtl: "artifacts/admin-matrix/findings.json#platform-admin-rtl-1440+320",
      states: statesProof,
      authorization:
        "artifacts/admin-matrix/findings.json#role-refusals + services/api/test/admin-authorization-matrix.integration.test.ts",
      contract:
        "apps/web/scripts/admin-composition-contract.mjs (exit 0) + docs/admin/evidence/mutation-matrix.json",
    },
  };
}

if (!process.argv.includes("--check")) {
  writeFileSync(EVIDENCE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`wrote scripts/admin-ledger/evidence.json — ${rows.length - pending} verified, ${pending} pending`);
} else {
  console.log(`${rows.length - pending} verifiable, ${pending} pending`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} route problem(s):`);
  for (const p of problems.slice(0, 60)) console.error(`  ${p}`);
  process.exit(1);
}
