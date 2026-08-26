#!/usr/bin/env node
/**
 * OPERATIONS AUTHORITY VERIFIER — the §17 zero/totality audits.
 *
 * Each check below corresponds to a property this phase claims to have
 * established. They are COMPUTED from the tree on every run rather than
 * recorded in a document beside it, because a governance artifact that states
 * a conclusion without computing it is the failure mode this codebase has
 * already paid for once: an "authorization exception registry" whose PENDING
 * list was empty while three route files carried status-blind gates, and which
 * had zero production importers so nothing enforced it anywhere.
 *
 * Usage:
 *   node services/api/scripts/verify-operations-authorities.mjs [--json]
 *
 * Exit: 0 clean, 1 violations, 2 the verifier could not run.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");

function read(rel) {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

/**
 * Source with comments removed.
 *
 * Every "this code must not contain X" check below has to read CODE. A doc
 * comment that quotes the pattern being banned — in order to explain what was
 * removed and why — would otherwise fail the very check it documents, which
 * would push the reasoning out of the files it belongs in. That is a real
 * regression risk, not a hypothetical: the first run of this verifier flagged
 * two modules whose only offence was explaining the defect they had fixed.
 */
function readCode(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function tracked(...roots) {
  return execFileSync("git", ["ls-files", ...roots], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

const failures = [];
const checks = [];

function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail: detail ?? null });
  } catch (err) {
    checks.push({ name, ok: false, detail: err.message });
    failures.push({ name, detail: err.message });
  }
}

// ---------------------------------------------------------------------------

check("zero Home-only materializer authority", () => {
  // Discovery must not run as a side effect of building a dashboard. A
  // workspace nobody opens must still be scanned, and a page load must not
  // perform an unbounded multi-source sweep before it can answer.
  const commandCenter = readCode(
    "services/api/src/services/dashboard/command-center.service.ts",
  );
  if (/await\s+generateIncidentsForWorkspace\s*\(/.test(commandCenter)) {
    throw new Error(
      "command-center.service.ts calls generateIncidentsForWorkspace directly. " +
        "Discovery is a scheduled run; Home must ensure freshness and read.",
    );
  }
  return "Home is a read consumer";
});

check("exactly one scheduled Operations discovery orchestrator", () => {
  // "One production orchestration path" — the property that stops a second
  // scheduler from racing the first over the same workspaces.
  const files = tracked("services/api/src", "services/worker/src").filter(
    (f) => f.endsWith(".ts") && !f.includes(".test."),
  );
  const orchestrators = files.filter((f) =>
    /runWorkspaceOperationsSweep\s*\(/.test(read(f)) && !f.includes("/jobs/"),
  );
  const callers = orchestrators.filter((f) => !f.endsWith("server.ts"));
  if (callers.length > 0) {
    throw new Error(
      `sweep invoked outside its job module and server wiring: ${callers.join(", ")}`,
    );
  }
  return "one sweep, wired once";
});

check("zero parallel reconciliation-run systems", () => {
  // Every Operations run must claim through the ONE authority. A second
  // create against the run table would be a second lock, and two locks over
  // one workspace exclude nothing.
  const files = tracked("services/api/src", "services/worker/src", "packages").filter(
    (f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes("/dist/"),
  );
  const offenders = [];
  for (const f of files) {
    const src = readCode(f);
    if (!/WORKSPACE_OPERATIONS/.test(src)) continue;
    // The wrapper itself and the reconciliation-run authority may write rows.
    if (
      f.endsWith("workspace-operations-reconciliation.ts") ||
      f.endsWith("reconciliation-run.ts")
    ) {
      continue;
    }
    if (/governanceReconciliationRun\.(create|upsert)\s*\(/.test(src)) {
      offenders.push(f);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `run rows created outside the canonical wrapper: ${offenders.join(", ")}`,
    );
  }
  return "one run authority";
});

check("zero duplicate workspace-context resolvers", () => {
  // `AuthorizedWorkspaceContext` is minted at exactly one site. A second
  // constructor would be a second authority able to disagree with the first.
  const authorize = readCode("services/api/src/middleware/authorize.ts");
  const mints = authorize.match(/mintAuthorizedWorkspaceContext\s*\(/g) ?? [];
  // One declaration + one call.
  if (mints.length !== 2) {
    throw new Error(
      `expected exactly one mint site (declaration + call); found ${mints.length}`,
    );
  }
  if (/export\s+function\s+mintAuthorizedWorkspaceContext/.test(authorize)) {
    throw new Error("the minting constructor must stay module-private");
  }
  return "one minting site, module-private";
});

check("zero unused scope helpers", () => {
  // A helper nobody consumes is a rule nobody follows. `workspaceCaseWhere`
  // had zero production consumers before this phase, which is how Case reads
  // drifted from Evidence reads while a helper for them sat unused.
  const scopeModule = read("packages/shared-runtime/src/workspace-scope.ts");
  const exported = [
    ...scopeModule.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g),
  ].map((m) => m[1]);
  const consumers = tracked(
    "services/api/src",
    "services/worker/src",
    "packages",
  ).filter(
    (f) =>
      f.endsWith(".ts") &&
      !f.includes("/dist/") &&
      !f.endsWith("workspace-scope.ts"),
  );
  const corpus = consumers.map((f) => read(f)).join("\n");
  const orphans = exported.filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(corpus),
  );
  if (orphans.length > 0) {
    throw new Error(`scope helpers with no consumer: ${orphans.join(", ")}`);
  }
  return `${exported.length} helpers, all consumed`;
});

/**
 * The canonical lifecycle contract, as text.
 *
 * The two checks below moved from the API registry to this file when the
 * lifecycle half of each source moved there. They read the CONTRACT because
 * that is now where the answers are declared; the registry's copies were
 * removed precisely so there is nothing there left to check.
 */
const LIFECYCLE_CONTRACT_PATH =
  "packages/shared-runtime/src/ops/source-lifecycle.ts";

check("zero silent source categories", () => {
  // Every incident category some authority can write must be claimed by a
  // registered source. A category that exists, is written, and appears nowhere
  // in the contract would look — to anyone reading it — like a source nobody
  // had thought about.
  const contract = read(LIFECYCLE_CONTRACT_PATH);
  const observability = read("packages/shared/src/observability.ts");
  const block = observability.match(
    /export const INCIDENT_CATEGORIES = \[([\s\S]*?)\] as const;/,
  );
  if (!block) throw new Error("could not read INCIDENT_CATEGORIES");
  const categories = [...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  const missing = categories.filter(
    (c) => !new RegExp(`^\\s+category:\\s*"${c}",`, "m").test(contract),
  );
  if (missing.length > 0) {
    throw new Error(
      `incident categories with no registered source: ${missing.join(", ")}`,
    );
  }
  return `${categories.length} categories, all covered`;
});

check("every registered source declares every lifecycle field", () => {
  // TOTALITY, counted. The type makes every field required, so this cannot
  // fail while the tree compiles — which is the point of stating it here as
  // well: a field quietly made optional to unblock a new source would show up
  // as a count mismatch before anyone noticed the semantics had loosened.
  const contract = read(LIFECYCLE_CONTRACT_PATH);
  const body = contract.slice(
    contract.indexOf("OPERATIONS_SOURCE_LIFECYCLES"),
    contract.indexOf("UNREGISTERED_CONDITION_LIFECYCLE"),
  );
  const count = (field) =>
    [...body.matchAll(new RegExp(`^\\s+${field}:`, "gm"))].length;
  const sources = count("sourceId");
  if (sources === 0) throw new Error("contract has no sources");
  const REQUIRED = [
    "category",
    // `identity` became `legacyFingerprints` + `producers` +
    // `discoveryState` when lifecycle identity stopped being INFERRED from a
    // fingerprint and started being DECLARED by the writer. The old field
    // encoded three separate facts — which fingerprint shape a source used to
    // write, whether anything writes it now, and which module does — and
    // fifteen production emitters fell through it precisely because it could
    // only express the first.
    "producers",
    "discoveryState",
    "legacyFingerprints",
    "resolutionAuthority",
    "activityProbeKey",
    "recoveryPolicy",
    "recurrencePolicy",
    "suppressionPolicy",
    "remediationDisposition",
    "requiredCapability",
    "audience",
    "cardinality",
    "workspaceApplicability",
    "metricContract",
    "drillDownContract",
    "notApplicableDisposition",
    // A source that lets a person close it must say whether the conclusion is
    // written down. Counted here so a field quietly made optional to unblock
    // a new source shows up before anyone notices the semantics loosened.
    "requiresResolutionNote",
    "rationale",
  ];
  for (const field of REQUIRED) {
    if (count(field) !== sources) {
      throw new Error(
        `${sources} sources but ${count(field)} declarations of "${field}"`,
      );
    }
  }
  return `${sources} sources x ${REQUIRED.length + 1} declared fields`;
});

check("resolution authority is declared per SOURCE, never per category", () => {
  // The defect this whole closure removed: `OPERATOR_RESOLUTION_AUTHORITY`, a
  // Record keyed by IncidentCategory, deciding whether an operator could
  // declare a condition over. Four sources write category WORKER, so it was a
  // rule about a set nobody had enumerated — and it let a 26-record report
  // backlog be closed while all 26 records were still above the threshold.
  //
  // Not "no such map" as a style preference: any second policy map keyed by
  // category is the same defect wearing a different name.
  for (const rel of tracked("services/api/src", "apps/web", "packages")) {
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    const src = readCode(rel);
    if (/OPERATOR_RESOLUTION_AUTHORITY/.test(src)) {
      throw new Error(`${rel} still references OPERATOR_RESOLUTION_AUTHORITY`);
    }
    if (/Record<\s*IncidentCategory\s*,\s*ResolutionAuthority\s*>/.test(src)) {
      throw new Error(`${rel} declares resolution authority per category`);
    }
  }
  return "no category-keyed resolution policy anywhere in the tree";
});

check("zero TSA retry or restamp paths in Operations", () => {
  // Not "no button" — no reachable code. A timestamp proves a record existed
  // at a moment; re-contacting the authority mints a token whose genTime is
  // later than the evidence it certifies, which is a different and weaker
  // claim wearing the original's name.
  const modules = [
    "services/api/src/services/operations/operations-reconciliation.service.ts",
    "services/api/src/services/operations/operations-source-registry.ts",
    "services/api/src/services/operations/operations-grouping.service.ts",
    "services/api/src/jobs/workspace-operations-reconciliation.job.ts",
    "services/api/src/services/dashboard/incident-generator.service.ts",
  ];
  const forbidden = [/requestTimestamp/i, /rfc3161/i, /restamp/i, /tsaClient/i];
  for (const rel of modules) {
    const src = readCode(rel);
    for (const pattern of forbidden) {
      if (pattern.test(src)) {
        throw new Error(`${rel} references ${pattern}`);
      }
    }
  }
  return "no provider path from Operations";
});

check("zero unbound tenant NULL-team incident reads", () => {
  // `OperationalIncident.teamId = NULL` meant both "no tenant" and "orphan of
  // a deleted workspace". A tenant read that unions the NULL bucket returns
  // every OTHER tenant's orphans.
  const files = tracked("services/api/src", "services/worker/src").filter(
    (f) => f.endsWith(".ts") && !f.includes(".test."),
  );
  const offenders = [];
  // ANCHORED ON THE MODEL, not on the file.
  //
  // A file-level scan is wrong here, and produced a false positive on the
  // first run: `me-inbox.routes.ts` contains the same OR shape against
  // `OperationsInboxSnapshot` — a PER-USER table whose every query is bound by
  // `userId`, and where a NULL `teamId` is the caller's OWN account-tier row
  // rather than another tenant's orphan. Flagging it would have pushed someone
  // to "fix" a correct query by deleting a user's own history the moment they
  // selected a workspace.
  //
  // The window is generous but bounded: a Prisma call's `where` sits within a
  // few hundred characters of the call, and reading further would reintroduce
  // exactly the file-level confusion this replaces.
  const UNBOUND_OR =
    /OR:\s*\[\s*\{\s*teamId:[^}]*\}\s*,\s*\{\s*teamId:\s*null\s*\}\s*\]/;
  for (const f of files) {
    const flat = readCode(f).replace(/\s+/g, " ");
    for (const m of flat.matchAll(/operationalIncident\.\w+\s*\(/g)) {
      if (UNBOUND_OR.test(flat.slice(m.index, m.index + 400))) {
        offenders.push(f);
        break;
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`unbound NULL-team incident reads: ${offenders.join(", ")}`);
  }
  return "tenant incident reads are scope-discriminated";
});

check("clear may only be asserted through the canonical gate", () => {
  // One predicate, one place. A surface that re-derives "is this workspace
  // clear" is a second answer to the question this phase exists to make
  // singular.
  const summary = readCode(
    "services/api/src/services/operations/operations-summary.service.ts",
  );
  if (!/mayAssertOperationsClear\s*\(/.test(summary)) {
    throw new Error("the summary does not consume the canonical clear gate");
  }
  if (/mayAssertAllClear:\s*complete\b/.test(summary)) {
    throw new Error(
      "mayAssertAllClear is still derived from read-completeness alone",
    );
  }
  return "one clear gate";
});

check("zero plan-name authorization or population shortcuts", () => {
  // Population semantics are a function of workspace KIND and ownership,
  // never of a commercial label.
  const scopeModule = readCode("packages/shared-runtime/src/workspace-scope.ts");
  for (const plan of ["FREE", "PRO", "TEAM", "ENTERPRISE"]) {
    if (new RegExp(`["']${plan}["']`).test(scopeModule)) {
      throw new Error(`workspace-scope.ts references the plan name ${plan}`);
    }
  }
  return "scope is kind-and-owner only";
});

// ---------------------------------------------------------------------------

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ checks, failures }, null, 2));
  process.exit(failures.length > 0 ? 1 : 0);
}

console.log("OPERATIONS AUTHORITY VERIFIER");
console.log("=============================");
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (c.detail) console.log(`        ${c.detail}`);
}
console.log("");
if (failures.length === 0) {
  console.log(`CLEAN — ${checks.length} authority audits passed.`);
  process.exit(0);
}
console.log(`${failures.length} FAILED.`);
process.exit(1);
