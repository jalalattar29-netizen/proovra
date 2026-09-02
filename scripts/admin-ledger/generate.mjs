#!/usr/bin/env node
/**
 * THE ADMIN CONTROL PLANE COMPLETION LEDGER.
 *
 * =============================================================================
 * WHY IT IS GENERATED AND NOT WRITTEN
 * =============================================================================
 * A hand-maintained status column is wrong within a week. This repository
 * already learned that once: the capability map's hand-maintained
 * classification column was 176 rows wrong out of 1083, and the only thing
 * that made it trustworthy again was deriving it.
 *
 * So everything derivable is DERIVED — the route list from the file tree, the
 * navigation and scope from the registry, the endpoints from a live trace of
 * 1066 API routes, the internal composition from a source scan. A page cannot
 * be omitted by forgetting to add a row, because the rows come from the tree.
 *
 * What cannot be derived is whether a human actually opened the page in a
 * browser at 320px as a read-only member and saw something correct. That lives
 * in `admin-control-plane-completion.evidence.json`, one entry per route, and
 * it is the ONLY hand-maintained input. Every claim in it names the artefact
 * that backs it, so a claim with no artefact is a validation failure rather
 * than a sentence somebody typed.
 *
 * =============================================================================
 * THE STATUS VOCABULARY IS DELIBERATELY SMALL
 * =============================================================================
 *   REDESIGNED_AND_E2E_VERIFIED
 *   CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED
 *   NO_INTERNAL_RECOMPOSITION_REQUIRED   (reason + browser evidence required)
 *   PENDING                              (the honest default)
 *
 * These are NOT statuses, and the validator rejects them if they appear:
 * "shell applied", "returns 200", "inherited shared styles", "audited",
 * "deferred", "sampled", "covered by parent". Each of those was used at some
 * point to describe a page that had not been looked at.
 *
 * Usage:
 *   node scripts/admin-ledger/generate.mjs            write the markdown
 *   node scripts/admin-ledger/generate.mjs --check    validate only, exit 1 on
 *                                                     any structural failure
 *   node scripts/admin-ledger/generate.mjs --require-complete
 *                                                     also exit 1 if any route
 *                                                     is still PENDING
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
/**
 * Overridable so a test can exercise the validator against a deliberately
 * bad file. Without this the only way to prove the validator still rejects a
 * proofless claim is to break the real evidence file and put it back, which
 * is a test that damages the thing it is testing.
 */
const EVIDENCE = (() => {
  const hit = process.argv.find((a) => a.startsWith("--evidence="));
  return hit ? resolve(process.cwd(), hit.slice(11)) : resolve(HERE, "evidence.json");
})();
const OUT = resolve(REPO, "docs/admin/admin-control-plane-completion.md");

export const VALID_STATUSES = Object.freeze([
  "REDESIGNED_AND_E2E_VERIFIED",
  "CONTEXTUAL_DETAIL_REDESIGNED_AND_E2E_VERIFIED",
  "NO_INTERNAL_RECOMPOSITION_REQUIRED",
  "PENDING",
]);

/** Words that have been used to mean "we did not look at this page". */
const FORBIDDEN_STATUS_WORDS =
  /shell|200|inherited|audited|deferred|sampled|parent|presumed|partial/i;

/** The proofs a route must carry before it may claim a completed status. */
export const REQUIRED_PROOFS = Object.freeze([
  "desktop",
  "mobile",
  "rtl",
  "states",
  "authorization",
  "contract",
]);

function readInventory() {
  const raw = execFileSync(
    process.execPath,
    [resolve(REPO, "apps/web/scripts/admin-inventory.mjs"), "--json"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw);
}

function readComposition() {
  const raw = execFileSync(
    process.execPath,
    [resolve(REPO, "apps/web/scripts/admin-composition-audit.mjs"), "--json"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  return new Map(parsed.rows.map((r) => [r.route, r]));
}

function readEvidence() {
  if (!existsSync(EVIDENCE)) return {};
  return JSON.parse(readFileSync(EVIDENCE, "utf8"));
}

/**
 * Everything wrong with the ledger, as sentences a person can act on.
 *
 * Returned rather than thrown so `--check` can report all of them at once. A
 * validator that stops at the first problem makes people fix things one round
 * trip at a time.
 */
export function validate(rows) {
  const problems = [];

  for (const r of rows) {
    const where = r.route;

    if (!VALID_STATUSES.includes(r.status)) {
      problems.push(`${where}: status "${r.status}" is not one of ${VALID_STATUSES.join(", ")}`);
      continue;
    }
    if (r.status !== "PENDING" && FORBIDDEN_STATUS_WORDS.test(r.statusReason ?? "")) {
      problems.push(
        `${where}: the reason reads like a non-status ("${r.statusReason}") — say what was verified`,
      );
    }

    // A detail route has to be reachable and escapable.
    if (r.isContextualDetail) {
      if (!r.parent || r.parent === r.route) {
        problems.push(`${where}: a contextual detail must name a parent list`);
      }
      if (!r.breadcrumb) problems.push(`${where}: a contextual detail must have a breadcrumb`);
      if (!r.returnPath) problems.push(`${where}: a contextual detail must have a return path`);
    } else if (!r.inNavigation) {
      problems.push(`${where}: a non-detail page must be reachable from navigation`);
    }

    if (r.status === "NO_INTERNAL_RECOMPOSITION_REQUIRED") {
      if (!r.statusReason || r.statusReason.length < 30) {
        problems.push(`${where}: NO_INTERNAL_RECOMPOSITION_REQUIRED needs a concrete reason`);
      }
      if (!r.proofs.desktop) {
        problems.push(`${where}: NO_INTERNAL_RECOMPOSITION_REQUIRED still needs browser evidence`);
      }
    }

    if (r.status !== "PENDING") {
      for (const proof of REQUIRED_PROOFS) {
        if (!r.proofs[proof]) {
          problems.push(`${where}: claims ${r.status} without ${proof} proof`);
        }
      }
    }
  }

  return problems;
}

function build() {
  const inventory = readInventory();
  const composition = readComposition();
  const evidence = readEvidence();

  const known = new Set(inventory.rows.map((r) => r.route));
  // Keys starting with _ are notes to the reader, not routes. JSON has no
  // comments and the alternative — a second file nobody opens — is worse.
  const orphans = Object.keys(evidence).filter(
    (k) => !k.startsWith("_") && !known.has(k),
  );

  const rows = inventory.rows.map((inv) => {
    const ev = evidence[inv.route] ?? {};
    const comp = composition.get(inv.route);
    return {
      route: inv.route,
      dynamic: inv.route.includes("/:"),
      family: ev.family ?? "(unassigned)",
      purpose: (inv.purpose ?? "").trim(),
      scope: inv.actualScope ?? inv.navScope ?? "UNKNOWN",
      scopeSource: inv.navScope ? "adminNavigation registry" : "handler trace",
      endpoints: inv.api ?? [],
      authority: [...new Set((inv.api ?? []).flatMap((a) => a.authority ?? []))],
      capabilities: inv.capabilities ?? [],
      navSection: inv.navSection ?? null,
      inNavigation: Boolean(inv.inNavigation),
      isContextualDetail: Boolean(inv.isContextualDetail),
      parent: inv.parent ?? null,
      breadcrumb: ev.breadcrumb ?? null,
      returnPath: ev.returnPath ?? null,
      composition: comp
        ? `${comp.composition.cards}c/${comp.composition.tables}t/${comp.composition.sections}s`
        : "—",
      findings: comp?.findings ?? [],
      lines: inv.lines ?? 0,
      status: ev.status ?? "PENDING",
      statusReason: ev.statusReason ?? "",
      fixture: ev.fixture ?? null,
      proofs: ev.proofs ?? {},
      blocker: ev.blocker ?? "",
    };
  });

  return { rows, orphans, inventory };
}

function markdown({ rows, inventory }) {
  const done = rows.filter((r) => r.status !== "PENDING").length;
  const cell = (v) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");

  const lines = [];
  lines.push("# Admin control plane — completion ledger");
  lines.push("");
  lines.push("<!--");
  lines.push("  GENERATED. Do not edit by hand.");
  lines.push("    node scripts/admin-ledger/generate.mjs");
  lines.push("");
  lines.push("  Route list, navigation, scope, endpoints and composition are DERIVED —");
  lines.push("  from the file tree, the navigation registry, a live trace of every API");
  lines.push("  route, and a source scan. A page cannot be omitted by forgetting a row.");
  lines.push("");
  lines.push("  Verification evidence is the one hand-maintained input, in");
  lines.push("  scripts/admin-ledger/evidence.json, and every claim there names the");
  lines.push("  artefact that backs it.");
  lines.push("-->");
  lines.push("");
  lines.push(
    `**${rows.length} routes** · ${done} completed · ${rows.length - done} pending · ` +
      `${inventory.apiRoutesKnown} API routes traced`,
  );
  lines.push("");
  lines.push("## Status");
  lines.push("");
  lines.push("| Route | Kind | Family | Status | Reason / blocker |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(
      `| \`${r.route}\` | ${r.dynamic ? "dynamic" : "static"} | ${cell(r.family)} | ` +
        `${r.status} | ${cell(r.statusReason || r.blocker)} |`,
    );
  }

  lines.push("");
  lines.push("## Scope and authorization");
  lines.push("");
  lines.push("| Route | Scope | Scope source | Capability | Backend authority | Nav | Parent |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(
      `| \`${r.route}\` | ${r.scope} | ${r.scopeSource} | ${cell(r.capabilities.join(", "))} | ` +
        `${cell(r.authority.join(", "))} | ${r.inNavigation ? r.navSection : "contextual"} | ` +
        `${cell(r.parent)} |`,
    );
  }

  lines.push("");
  lines.push("## Backend contract");
  lines.push("");
  lines.push("| Route | Method | Endpoint | Authority | teamId role |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    if (r.endpoints.length === 0) {
      lines.push(`| \`${r.route}\` | — | (no API call) | — | — |`);
      continue;
    }
    for (const e of r.endpoints) {
      lines.push(
        `| \`${r.route}\` | ${e.method} | \`${e.path}\` | ` +
          `${cell((e.authority ?? []).join(", "))} | ${cell(e.teamRole)} |`,
      );
    }
  }

  lines.push("");
  lines.push("## Verification evidence");
  lines.push("");
  lines.push(
    "| Route | Fixture | Desktop | Mobile | RTL | States | Authz | Contract | Breadcrumb | Return |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const tick = (v) => (v ? `\`${v}\`` : "—");
  for (const r of rows) {
    lines.push(
      `| \`${r.route}\` | ${tick(r.fixture)} | ${tick(r.proofs.desktop)} | ` +
        `${tick(r.proofs.mobile)} | ${tick(r.proofs.rtl)} | ${tick(r.proofs.states)} | ` +
        `${tick(r.proofs.authorization)} | ${tick(r.proofs.contract)} | ` +
        `${tick(r.breadcrumb)} | ${tick(r.returnPath)} |`,
    );
  }

  lines.push("");
  lines.push("## Internal composition");
  lines.push("");
  lines.push("| Route | Lines | cards/tables/sections | Open findings |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(
      `| \`${r.route}\` | ${r.lines} | ${r.composition} | ${cell(r.findings.join(", "))} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

const built = build();
const problems = validate(built.rows);
for (const o of built.orphans) {
  problems.push(`evidence.json has an entry for "${o}", which is not a route on disk`);
}

const pending = built.rows.filter((r) => r.status === "PENDING");

if (!process.argv.includes("--check") && !process.argv.some((a) => a.startsWith("--evidence="))) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, markdown(built), "utf8");
  console.log(`wrote ${OUT}`);
}

console.log(
  `${built.rows.length} routes · ${built.rows.length - pending.length} completed · ${pending.length} pending`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} ledger problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

if (process.argv.includes("--require-complete") && pending.length > 0) {
  console.error(
    `\nNOT COMPLETE — ${pending.length} route(s) still PENDING:\n` +
      pending.map((r) => `  ${r.route}`).join("\n"),
  );
  process.exit(1);
}
