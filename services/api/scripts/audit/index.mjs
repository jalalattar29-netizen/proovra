#!/usr/bin/env node
/**
 * PHASE 0 §4 — THE ONE CURRENT-AUDIT COMMAND.
 *
 *     pnpm audit:architecture                  regenerate every current artifact
 *     pnpm audit:architecture --engine-check   is the INSTRUMENT sound?
 *     pnpm audit:architecture --closure-check  is the PRODUCT closed?
 *     pnpm audit:architecture --freeze         working-tree freeze + recovery manifest
 *
 * The two checks are separate on purpose, and the separation is the most
 * important thing in this file.
 *
 * The capability generator used to exit non-zero for BOTH "an unresolved call
 * site means some number in this artifact is a guess" and "210 routes still
 * need a product judgement". Those are not the same failure. The first says the
 * measuring device is broken and nothing it prints can be trusted; the second
 * says the device works and is reporting real, open work. Conflating them
 * created a standing red that nobody could act on, which is how a red gate stops
 * being read at all — and a gate nobody reads is worse than no gate, because it
 * still looks like coverage.
 *
 *     AuditEngineIntegrity = PASS   and   ProductClosure = OPEN
 *
 * is a correct and expected state. `--engine-check` exits 0 there.
 * `--closure-check` exits non-zero there, and must keep doing so until the
 * backlog is genuinely finished.
 *
 * This is the ONLY externally-callable current-audit entry point. Everything
 * else — `capability:map`, `capability:check`, `verify:route-consumers`,
 * `verify:reachability` — is a name kept for compatibility that forwards here,
 * so no second exit-code semantics and no second opinion can grow back.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REPO, CANONICAL, DIAGNOSTICS } from "./engine/registry.mjs";
import { evaluateGovernance } from "./engine/governance.mjs";
import {
  buildFacts,
  engineProblems,
  closureProblems,
  releaseBlockingProblems,
  architectureBacklogProblems,
  freshnessHash,
} from "./engine/facts.mjs";
import { evaluate as evaluateWorkingTree } from "./engine/worktree.mjs";
import { renderReport } from "./engine/report.mjs";
import { buildTestCallerDiagnostic } from "./engine/test-caller-diagnostic.mjs";

const abs = (r) => path.join(REPO, r);
const serialize = (v) => `${JSON.stringify(v, null, 2)}\n`;

function writeArtifact(rel, value) {
  const target = abs(rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, serialize(value), "utf8");
  return target;
}

/**
 * Compare a regenerated artifact with the one on disk.
 *
 * `generatedAtUtc` moves on every run and `sourceRevision` moves on every
 * commit. Both are metadata about the run, not measurements of the tree, so
 * comparing them would make the gate fail for reasons that have nothing to do
 * with the artifact being stale — which is how a staleness gate gets disabled.
 */
const VOLATILE = /"(generatedAtUtc|sourceRevision)": "[^"]*"/g;
const stripVolatile = (s) => s.replace(VOLATILE, '"$1": "-"');

function staleness(rel, regenerated) {
  const target = abs(rel);
  if (!existsSync(target)) return `MISSING: ${rel} — run \`pnpm audit:architecture\` to generate it`;
  const onDisk = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  if (stripVolatile(onDisk) !== stripVolatile(serialize(regenerated)))
    return `STALE: ${rel} — regenerate with \`pnpm audit:architecture\``;
  return null;
}

async function writeCapabilityMap() {
  const mod = await import(
    pathToFileURL(abs("services/api/scripts/generate-runtime-capability-map.mjs")).href
  );
  const artifact = mod.build();
  writeFileSync(abs(CANONICAL.capabilityMap.path), serialize(artifact), "utf8");
  return artifact;
}

// ===========================================================================
// MODES
// ===========================================================================

/**
 * The generated artifacts live in the tree that the governance inventory walks,
 * so on a virgin checkout the first inventory describes a tree without them and
 * the second describes a tree with them — and the two disagree. Creating the
 * paths first makes the derivation a fixpoint on the first pass instead of
 * shipping an inventory that is one write out of date.
 */
function ensureGeneratedPaths() {
  for (const rel of [
    CANONICAL.governanceInventory.path,
    CANONICAL.currentFacts.path,
    ...DIAGNOSTICS.map((d) => d.path),
  ]) {
    const target = abs(rel);
    if (existsSync(target)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, serialize({ pending: "generated on first run" }), "utf8");
  }
  const report = abs(CANONICAL.currentReport.path);
  if (!existsSync(report)) {
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, "STATUS: CURRENT GENERATED REPORT\n(pending first run)\n", "utf8");
  }
}

async function regenerate() {
  ensureGeneratedPaths();
  const governance = evaluateGovernance();
  writeArtifact(CANONICAL.governanceInventory.path, governance);
  const capability = await writeCapabilityMap();
  writeArtifact(DIAGNOSTICS[0].path, await buildTestCallerDiagnostic(capability));
  const facts = await buildFacts();
  writeArtifact(CANONICAL.currentFacts.path, facts);
  // The report is rendered LAST, from the artifacts that were just written, so
  // it can never describe a state that no longer exists.
  writeFileSync(
    abs(CANONICAL.currentReport.path),
    renderReport(facts, engineProblems(facts, governance), closureProblems(facts)),
    "utf8",
  );
  return { governance, facts };
}

async function engineCheck() {
  const governance = evaluateGovernance();
  const facts = await buildFacts();

  const problems = engineProblems(facts, governance);

  // The generated artifacts must already be on disk and must match what was
  // just recomputed. An artifact that disagrees with the engine is a
  // hand-edited artifact, which is the exact defect FINAL-001 was.
  for (const [rel, value] of [
    [CANONICAL.governanceInventory.path, governance],
    [CANONICAL.currentFacts.path, facts],
  ]) {
    const s = staleness(rel, value);
    if (s) problems.push(s);
  }
  const mapOnDisk = existsSync(abs(CANONICAL.capabilityMap.path));
  if (!mapOnDisk) problems.push(`MISSING: ${CANONICAL.capabilityMap.path}`);

  print("ENGINE CHECK", {
    engineHash: facts.engineHash,
    routes: facts.facts.routes.registered,
    instrumentIntegrity: facts.facts.instrumentIntegrity,
    conservation: facts.conservation,
    auditGovernance: facts.facts.auditGovernance,
    proofFreshness: facts.facts.proofFreshness,
  });

  if (problems.length > 0) {
    console.error("\nAuditEngineIntegrity = FAIL");
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log("\nAuditEngineIntegrity = PASS");
  console.log(
    `ProductClosure = ${closureProblems(facts).length === 0 ? "CLOSED" : "OPEN"} (reported, not asserted here)`,
  );
  return 0;
}

/**
 * PHASE 1 §12 — three dimensions, reported apart.
 *
 * `ReleaseBlockingClosure` is the one that gates a shipment. `ArchitectureBacklog`
 * is real work that is not a release blocker and earns no credit for existing.
 * `ExternalClosure` is never asserted from source analysis at all — no amount of
 * static measurement proves a real environment, so it is always NOT RUN here.
 *
 * The exit code follows RELEASE BLOCKING only. Making a permanently non-zero
 * backlog fail the release gate is how a gate stops being read.
 */
async function closureCheck() {
  const facts = await buildFacts();
  const releaseBlocking = releaseBlockingProblems(facts);
  const backlog = architectureBacklogProblems(facts);

  print("CLOSURE CHECK", {
    ReleaseBlockingClosure: releaseBlocking.length === 0 ? "PASS" : "FAIL",
    ArchitectureBacklog: backlog.length === 0 ? "EMPTY" : "NON_BLOCKING_VISIBLE",
    ExternalClosure: "NOT RUN",
    openFindings: facts.findingsLedgerRef.openIds ?? [],
    undisposedRoutes: facts.facts.capabilities.undisposed,
    trackedInventory: facts.findingsLedgerRef.trackedInventory ?? null,
  });

  for (const p of backlog) console.log(`  ${p}`);

  // PHASE 13 — all three dimensions are reported in BOTH outcomes.
  //
  // The failing branch used to return before printing ArchitectureBacklog and
  // ExternalClosure, so the one run where a reader most needs the full picture
  // — the one that is refusing a release — was the one that gave the least of
  // it, and "ExternalClosure = NOT RUN" silently disappeared exactly when
  // somebody might otherwise assume it had passed. The EXIT CODE is unchanged:
  // a release-blocking problem still returns 1.
  const failed = releaseBlocking.length > 0;
  if (failed) {
    console.error("\nReleaseBlockingClosure = FAIL");
    for (const p of releaseBlocking) console.error(`  ${p}`);
  } else {
    console.log("\nReleaseBlockingClosure = PASS");
  }
  console.log(
    `ArchitectureBacklog = ${backlog.length === 0 ? "EMPTY" : "NON_BLOCKING_VISIBLE"}`,
  );
  console.log("ExternalClosure = NOT RUN");
  return failed ? 1 : 0;
}

/**
 * PHASE 0 CORRECTIVE §4 — the recovery manifest lives OUTSIDE the repository.
 *
 * It was written to `audit-output/phase0-recovery/`, which put working-tree
 * metadata inside the artifact tree — next to files that ARE current audit
 * facts, in a directory a reader is entitled to treat as authoritative. It is
 * neither: it describes one developer's checkout at one moment, not the
 * release. Gitignoring it was not enough, because a recovery record that only
 * exists inside the thing it is meant to recover is not a recovery record.
 *
 * The destination is a sibling of the repository, stamped with the UTC time of
 * the freeze so successive runs accumulate rather than overwrite. Override with
 * PROOVRA_RECOVERY_ROOT when the default is not writable.
 */
function recoveryRoot() {
  const configured = process.env.PROOVRA_RECOVERY_ROOT;
  const base = configured && configured.length > 0 ? configured : path.join(path.dirname(REPO), "proovra-recovery");
  const resolved = path.resolve(base);
  if (resolved === REPO || resolved.startsWith(REPO + path.sep)) {
    throw new Error(
      `refusing to write recovery metadata inside the repository: ${resolved}. ` +
        "Set PROOVRA_RECOVERY_ROOT to a location outside it.",
    );
  }
  return resolved;
}

/**
 * PHASE 1 §1 — write the exact baseline, outside the repository.
 *
 * Routed through `recoveryRoot()` deliberately. A first attempt at this wrote
 * the baseline with an ad-hoc relative path and it landed INSIDE the repo — a
 * baseline stored in the thing it describes, which is the one place it must
 * never be. The guard that already refuses in-repo freeze destinations is the
 * only thing that should decide where recovery state goes.
 */
async function phase1Baseline() {
  const { buildBaseline } = await import("./engine/baseline.mjs");
  const b = buildBaseline();
  const stamp = b.frozenAtUtc.replace(/[:.]/g, "-");
  const dir = path.join(recoveryRoot(), `phase1-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "phase1-baseline.json");
  writeFileSync(target, serialize(b), "utf8");
  const digest = createHash("sha256").update(readFileSync(target)).digest("hex");

  print("PHASE-1 BASELINE", {
    path: target,
    sha256: digest,
    insideRepository: false,
    branch: b.branch,
    head: b.head,
    originMain: b.originMain,
    ahead: b.ahead,
    behind: b.behind,
    fileCount: b.fileCount,
    hashFailures: b.hashFailures.length,
    statusEntries: b.statusEntryCount,
    canonicalArtifacts: b.canonicalArtifacts,
    domainProofs: b.domainProofs.map((p) => ({ path: p.path, suites: p.suiteCount, bindings: p.bindings })),
  });
  return b.hashFailures.length === 0 ? 0 : 1;
}

function freeze() {
  const result = evaluateWorkingTree();
  const stamp = result.frozenAtUtc.replace(/[:.]/g, "-");
  const dir = path.join(recoveryRoot(), `phase0-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "recovery-manifest.json");
  writeFileSync(target, serialize(result), "utf8");
  const digest = createHash("sha256").update(readFileSync(target)).digest("hex");

  print("WORKING-TREE FREEZE", {
    branch: result.branch,
    head: result.head,
    changedPathCount: result.changedPathCount,
    byClassCounts: result.byClassCounts,
    counters: result.counters,
    recoveryManifest: target,
    recoveryManifestSha256: digest,
    insideRepository: false,
  });
  const bad = Object.entries(result.counters).filter(
    ([k, v]) => k !== "AuditRelatedChangedFiles" && v !== 0,
  );
  if (bad.length > 0) {
    console.error(`\nFREEZE RED: ${bad.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    return 1;
  }
  console.log("\nFREEZE GREEN");
  return 0;
}

const print = (title, body) => {
  console.log(`\n=== ${title} ===`);
  console.log(serialize(body).trimEnd());
};

// ===========================================================================
// CLI
// ===========================================================================

async function main(argv) {
  if (argv.includes("--engine-check")) return engineCheck();
  if (argv.includes("--closure-check")) return closureCheck();
  if (argv.includes("--freeze")) return freeze();
  if (argv.includes("--phase1-baseline")) return phase1Baseline();

  const { governance, facts } = await regenerate();
  print("REGENERATED", {
    wrote: [
      CANONICAL.governanceInventory.path,
      CANONICAL.capabilityMap.path,
      CANONICAL.currentFacts.path,
      CANONICAL.currentReport.path,
      ...DIAGNOSTICS.map((d) => d.path),
    ],
    note: "the working-tree freeze is written OUTSIDE the repository — run `--freeze`",
    routes: facts.facts.routes.registered,
    auditFilesInventoried: governance.counters.AuditFilesInventoried,
  });
  return engineCheck();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}

export { engineCheck, closureCheck, regenerate, freshnessHash };
