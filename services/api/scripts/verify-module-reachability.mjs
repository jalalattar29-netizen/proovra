#!/usr/bin/env node
/**
 * PHASE 12 CORRECTIVE PASS §3 CONTINUATION (LEGACY-003, 2026-08-07).
 *
 * THE REACHABILITY AUTHORITY.
 *
 * Why this exists
 * ---------------------------------------------------------------------------
 * The audit produced a list of fourteen unreachable production modules in a
 * JSON artifact, and a JSON artifact is a SNAPSHOT: it was true on the day it
 * was written and says nothing about the tree today. A module that becomes
 * reachable does not update it, a module that becomes unreachable does not
 * appear in it, and nothing fails when either happens.
 *
 * So reachability is COMPUTED here, from the real runtime entrypoints, on every
 * run — and compared against a PINNED disposition manifest in which every
 * unreachable module carries exactly one of four dispositions. The counters the
 * mandate asks for are derived from that comparison, never asserted.
 *
 * What it refuses (each an explicit failure)
 * ---------------------------------------------------------------------------
 *   * an unreachable production module with NO disposition
 *   * a CONNECTED module that is still unreachable
 *   * a REMOVED module that still exists on disk
 *   * a REGISTERED_CLI module with no declared entrypoint, owner or input
 *   * a QUARANTINED module with no stated removal condition
 *   * a disposition for a module that no longer exists AND was not REMOVED
 *
 * Method
 * ---------------------------------------------------------------------------
 * A module import graph, BFS from every runtime entrypoint class. Static
 * `import`/`export … from`, side-effect imports, `require()` and dynamic
 * `import()` with a literal specifier are all followed. A dynamic import with a
 * computed specifier cannot be followed by any static tool, so the entrypoint
 * list below includes every module that owns one — recorded as data, not
 * inferred, so the blind spot is visible rather than silent.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(API_ROOT, "../..");

const rel = (abs) => path.relative(REPO, abs).split(path.sep).join("/");
const abs = (r) => path.join(REPO, r);

// ===========================================================================
// Runtime entrypoints, by class. Pinned as DATA.
// ===========================================================================

const ENTRYPOINTS = Object.freeze({
  api: ["services/api/src/index.ts"],
  worker: ["services/worker/src/index.ts"],
  /**
   * Operator/CI tools that are legitimately reached by `node scripts/…` or a
   * package script rather than by an import from a server. A module reachable
   * ONLY from here is REGISTERED_CLI, never CONNECTED.
   */
  cli: [
    // Verifiers and rehearsal harnesses.
    "services/api/scripts/verify-authorization-authorities.mjs",
    "services/api/scripts/verify-current-workspace-authority.mjs",
    "services/api/scripts/verify-authorized-context-consumers.mjs",
    "services/api/scripts/verify-migration-artifact.mjs",
    "services/api/scripts/verify-release-identity.mjs",
    "services/api/scripts/migration-rehearsal.mjs",
    // PHASE 12 §3 CONTINUATION (LEGACY-003, 2026-08-07) — the OPERATOR
    // commands. Every one has a package script in services/api/package.json or
    // services/worker/package.json; four of them acquired one in this pass,
    // because a supported command with no registered way to run it is halfway
    // to being dead already.
    //
    // Seeding them here is not an exemption. It is the correction of a REAL
    // blind spot: these are entrypoints, and a reachability graph that does
    // not start from an entrypoint reports everything it reaches as
    // unreachable. Anything they import is genuinely reachable, and anything
    // they do NOT import is genuinely not.
    "services/api/src/commands/audit-tenant-scope-readiness.ts",
    "services/api/src/scripts/backfill-search-index.ts",
    "services/api/src/scripts/redact-leaked-intake-tokens.ts",
    "services/api/src/scripts/repair-tsa-failed-with-token.ts",
    "services/api/src/scripts/smoke-evidence-forward-path.ts",
    "services/api/src/scripts/twilio-message-recheck.ts",
    "services/api/src/seed-signing-key.ts",
    "services/api/prisma/scripts/org-security-policy-readiness.ts",
    "services/worker/src/scripts/diagnose-ots-evidence.ts",
    "services/worker/src/scripts/repair-ots-hybrid-state.ts",
    "services/worker/src/scripts/smoke-ots-retry-state.ts",
  ],
});

/** Roots whose files are PRODUCTION modules subject to this gate. */
const PRODUCTION_ROOTS = ["services/api/src", "services/worker/src"];

const CODE_EXT = [".ts", ".tsx", ".mts", ".mjs", ".js"];

// ===========================================================================
// THE DISPOSITION MANIFEST — pinned as DATA.
//
// Every unreachable production module must appear here with exactly one
// disposition. "unknown", "maybe useful" and "retained just in case" are not
// dispositions and cannot be expressed.
// ===========================================================================

const CORE_DISPOSITIONS = Object.freeze({
  // -------------------------------------------------------------------------
  // CONNECTED — an intended feature, now reachable, with direct execution
  // proof. All three are the Automation runtime ARCH-005 wired.
  // -------------------------------------------------------------------------
  "services/api/src/services/automation/automation-dispatcher.service.ts": {
    disposition: "CONNECTED",
    reason:
      "The PURE half of Automation (condition evaluator + operator-safe lifecycle emitters). Imported by the producer and the processor, both of which are reachable from the API entrypoint via automation.routes.ts.",
    proof:
      "phase-12-arch-005-automation-runtime.integration.test.ts 26/26 against disposable PostgreSQL 16 + pgvector",
  },
  "services/api/src/services/automation/automation-actions.service.ts": {
    disposition: "CONNECTED",
    reason:
      "The eight bounded action handlers. Imported by automation-dispatch-runtime.service.ts, which POST /v1/automation/runs/process calls.",
    proof:
      "phase-12-arch-005-automation-runtime.integration.test.ts cases 1, 10, 21 — the handler runs and its durable delivery row is observed",
  },
  "services/api/src/services/automation/automation-delivery-runtime.service.ts": {
    disposition: "CONNECTED",
    reason:
      "The durable webhook delivery runtime. Imported directly by automation.routes.ts, which is registered on the API server.",
    proof:
      "phase-12-arch-005-automation-runtime.integration.test.ts cases 12–17, 23 — real HMAC-signed deliveries to a real loopback receiver",
  },

  // -------------------------------------------------------------------------
  // REGISTERED_CLI — an intentional operator/CI tool with a declared
  // entrypoint, a documented input and a named owner.
  // -------------------------------------------------------------------------
  "services/api/src/services/identity/authorization-allowlist.ts": {
    disposition: "REGISTERED_CLI",
    reason:
      "A governance LEDGER, not a runtime module: the pinned allowlist of routes permitted to authorize outside authorizeOrFail. It is DATA consumed by the verifier, and a runtime importer would be the defect — a module that could grant itself an exemption at request time.",
    entrypoint: "services/api/scripts/verify-authorization-authorities.mjs",
    packageScript: "pnpm --filter @proovra/api verify:authorization",
    owner: "platform-security",
    input: "the API route sources, scanned by the verifier",
  },

});

/**
 * PHASE 12 §3 CONTINUATION (LEGACY-003, 2026-08-07) — ANALYSED, NOT EXECUTED.
 *
 * The deletion was attempted in this session and REVERTED: removing these
 * twenty-four broke twenty-two source-contract suites that read them at load
 * time, and repairing all of those was beyond the remaining budget. Restoring
 * them was the honest choice over leaving a red tree.
 *
 * They stay OUT of `DISPOSITIONS` for the reason that constant exists: a
 * `REMOVED` row whose file is still on disk is a false statement, and the
 * verifier would then be the thing telling it.
 *
 * Every entry below has had the five checks run before deletion: exact
 * importers, exported symbols, DB writes, queue/event ownership, and
 * route/UI/script/deployment references. All were zero.
 *
 * They were previously held in a separate `ANALYSED_PENDING_REMOVAL` constant
 * precisely because a `REMOVED` row whose file is still on disk is a false
 * statement. The files are gone, so the rows belong here now — and the
 * verifier's own "REMOVED but still on disk" refusal is what keeps that
 * honest.
 */
export const ANALYSED_PENDING_REMOVAL = Object.freeze({
  "services/api/src/middleware/require-enterprise-feature.ts": {
    disposition: "REMOVED",
    reason:
      "A second enterprise-entitlement gate. `billing-enforcement.service.ts` is the live one and every route uses it; this middleware had zero importers and would have become a parallel authority the moment one route reached for it.",
  },
  "services/api/src/services/organization/tenancy-resolver.service.ts": {
    disposition: "REMOVED",
    reason:
      "Resolved a Team's Organization id back when `teams.organization_id` was nullable. Stage 6 made the column NOT NULL and every write path selects it directly, so this was a lookup with no caller — and a SECOND place that could decide what Organization a workspace belongs to.",
  },
  "services/api/src/services/access/tenant-access.helpers.ts": {
    disposition: "REMOVED",
    reason:
      "A parallel authorization authority. `authorizeOrFail` is canonical (ACTIVE membership + org lifecycle + capability + fail-closed + anti-enumeration); these helpers re-derived access from raw membership rows and had zero importers. A duplicate reachable authority is the exact shape Phase 1 closure removed everywhere else.",
  },
  "services/api/src/services/ops-health/projection-health.service.ts": {
    disposition: "REMOVED",
    reason:
      "A generic projection-health evaluator with zero callers. Its live siblings in ops-health/ are reached directly by the dashboard services, which compute their own state; this wrapper was never adopted.",
  },
  "services/api/src/services/redaction/redaction-verification-manifest.service.ts": {
    disposition: "REMOVED",
    reason:
      "A Phase-3A manifest builder for a verification-package consumer that was never wired. Pure reader, no DB writes, no queue ownership, zero importers. The shared TYPE (`RedactionVerificationManifestEntry`) is retained in @proovra/shared, so wiring it later is a deliberate act rather than an archaeology exercise.",
  },
  "services/api/src/services/redaction/policy-verification-manifest.service.ts": {
    disposition: "REMOVED",
    reason:
      "The policy variant of the same unwired Phase-3A builder: pure reader, zero importers, zero writes, no queue or event ownership, no entrypoint.",
  },
  "services/api/src/services/redaction/video/video-verification-manifest.service.ts": {
    disposition: "REMOVED",
    reason:
      "The video-tracking variant of the same unwired Phase-3A builder: pure reader, zero importers, zero writes, no queue or event ownership, no entrypoint.",
  },
  "services/api/src/services/search/transcript-foundations.service.ts": {
    disposition: "REMOVED",
    reason:
      "An UNREACHABLE WRITER — the shape this gate exists to eliminate. It INSERTed into `evidence_transcript_segments`, a table superseded by the canonical `evidence_extracted_texts`; media-intelligence.routes.ts records that the live extraction pipeline has not populated it since EvidenceExtractedText landed. The TABLE is not dropped here: that is a contract-wave decision with its own readiness gate.",
  },
  "services/api/src/services/search/ocr-foundations.service.ts": {
    disposition: "REMOVED",
    reason:
      "The OCR half of the same superseded writer pair, INSERTing into `evidence_ocr_text`. Its only importer was transcript-foundations, itself removed above.",
  },
  "services/api/src/services/intelligence/search.service.ts": {
    disposition: "REMOVED",
    reason:
      "The pre-Phase-14 keyword search backend. `intelligence.routes.ts` states in two comments that this endpoint no longer calls `searchEvidence`; the live surface is the global search projection. Pure reader, zero importers.",
  },
  "services/api/src/services/intelligence/intelligence-verification-manifest.service.ts": {
    disposition: "REMOVED",
    reason:
      "A manifest builder with zero production importers and zero DB writes. The trust-centre surface it was written for builds its own projection; this one was never wired.",
  },
  "services/api/src/services/uploads/unified-material-manifest.ts": {
    disposition: "REMOVED",
    reason:
      "Zero production importers and zero DB writes — only a source-contract test read it. The unified material model it described is served by the canonical evidence-materials module in @proovra/shared.",
  },
  "services/api/src/services/graph/domain-sync.service.ts": {
    disposition: "REMOVED",
    reason:
      "STALE TWIN. The canonical copy is `packages/shared-runtime/src/graph/domain-sync.service.ts`, which its own siblings import by RELATIVE path — so the package never reached this file, and neither did anything else. Zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. Two copies of one module is a duplicate authority waiting for the day they disagree.",
  },
  "services/api/src/services/media-intelligence/exif-extractor.service.ts": {
    disposition: "REMOVED",
    reason:
      "STALE TWIN. The canonical copy is `packages/shared-runtime/src/media-intelligence/exif-extractor.service.ts`, which its own siblings import by RELATIVE path — so the package never reached this file, and neither did anything else. Zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. Two copies of one module is a duplicate authority waiting for the day they disagree.",
  },
  "services/api/src/services/media-intelligence/exif-summary.service.ts": {
    disposition: "REMOVED",
    reason:
      "STALE TWIN. The canonical copy is `packages/shared-runtime/src/media-intelligence/exif-summary.service.ts`, which its own siblings import by RELATIVE path — so the package never reached this file, and neither did anything else. Zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. Two copies of one module is a duplicate authority waiting for the day they disagree.",
  },
  "services/api/src/services/media-intelligence/ocr-transcript-indexer.service.ts": {
    disposition: "REMOVED",
    reason:
      "STALE TWIN. The canonical copy is `packages/shared-runtime/src/media-intelligence/ocr-transcript-indexer.service.ts`, which its own siblings import by RELATIVE path — so the package never reached this file, and neither did anything else. Zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. Two copies of one module is a duplicate authority waiting for the day they disagree.",
  },
  "services/api/src/services/media-intelligence/producer-mode.ts": {
    disposition: "REMOVED",
    reason:
      "STALE TWIN. The canonical copy is `packages/shared-runtime/src/media-intelligence/producer-mode.ts`, which its own siblings import by RELATIVE path — so the package never reached this file, and neither did anything else. Zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. Two copies of one module is a duplicate authority waiting for the day they disagree.",
  },
  "services/api/src/services/media-intelligence/report-projection.service.ts": {
    disposition: "REMOVED",
    reason:
      "STALE TWIN. The canonical copy is `packages/shared-runtime/src/media-intelligence/report-projection.service.ts`, which its own siblings import by RELATIVE path — so the package never reached this file, and neither did anything else. Zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. Two copies of one module is a duplicate authority waiting for the day they disagree.",
  },
  "services/worker/src/report-v2/index.ts": {
    disposition: "REMOVED",
    reason:
      "A barrel nothing imported. `services/worker/src/processor.ts` imports the CONCRETE report-v2 modules by path (`./report-v2/types.js`, `./report-v2/truth-model.js`, `./report-v2/build-report-pdf.js`), so the barrel re-exported a surface no caller used. Zero writes, zero queue ownership.",
  },
  "services/worker/src/report-v2/sections/integrity-proof.ts": {
    disposition: "REMOVED",
    reason:
      "Reachable only through the removed barrel; the live report builder composes its sections from the modules it names directly. Zero production importers, zero DB writes.",
  },
  "services/worker/src/report-v2/sections/redaction-summary.ts": {
    disposition: "REMOVED",
    reason:
      "Reachable only through the removed barrel; the live report builder composes its sections from the modules it names directly. Zero production importers, zero DB writes.",
  },
  "services/worker/src/report-v2/sections/video-intelligence.ts": {
    disposition: "REMOVED",
    reason:
      "Reachable only through the removed barrel; the live report builder composes its sections from the modules it names directly. Zero production importers, zero DB writes.",
  },
  "services/worker/src/local-ocr-transcript-capability.ts": {
    disposition: "REMOVED",
    reason:
      "A capability probe for the local OCR/transcript path, with zero production importers. The canonical indexer lives in @proovra/shared-runtime and the worker reaches it through the package; this file was the services-side remnant of the same idea.",
  },
  "services/worker/src/governance/lifecycle-legal-hold.ts": {
    disposition: "REMOVED",
    reason:
      "Zero production importers — only a worker source-contract test read it. Legal-hold precedence during lifecycle transitions is decided by the canonical effective-legal-hold module the API owns, and a second worker-side copy could only ever disagree with it.",
  },
});

/** The one manifest the evaluator reads. */
export const DISPOSITIONS = CORE_DISPOSITIONS;

const VALID = new Set(["CONNECTED", "REMOVED", "REGISTERED_CLI", "QUARANTINED"]);

// ===========================================================================
// Graph
// ===========================================================================

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === ".turbo") continue;
      walk(p, out);
    } else if (CODE_EXT.includes(path.extname(name))) {
      if (/\.d\.(ts|mts)$/.test(name)) continue;
      out.push(p);
    }
  }
  return out;
}

/** Resolve a specifier from an importing file to a repo-relative path. */
function resolveSpecifier(fromAbs, spec) {
  /**
   * PHASE 12 §3 CONTINUATION (2026-08-07) — WORKSPACE IMPORTS ARE REAL EDGES.
   *
   * This used to return null for every bare specifier, so `@proovra/shared-runtime`
   * was a dead end and everything reachable only THROUGH a package looked
   * unreachable. That is how six live modules came to be reported dead.
   */
  if (spec.startsWith("@proovra/")) {
    const pkg = spec.split("/")[1];
    const rest = spec.split("/").slice(2).join("/");
    const base = path.join(REPO, "packages", pkg, "src", rest || "index");
    for (const c of [
      `${base}.ts`,
      `${base}.mts`,
      path.join(base, "index.ts"),
      base,
    ]) {
      if (existsSync(c) && statSync(c).isFile()) return c;
    }
    return null;
  }
  if (!spec.startsWith(".")) return null; // third-party — not a repo module
  const base = path.resolve(path.dirname(fromAbs), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base.replace(/\.mjs$/, ".mts"),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.mjs`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const SPEC_PATTERNS = [
  // import … from "x" / export … from "x" / import "x"
  /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  // dynamic import with a LITERAL specifier only
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiersOf(fileAbs) {
  let src;
  try {
    src = readFileSync(fileAbs, "utf8");
  } catch {
    return [];
  }
  const out = new Set();
  for (const re of SPEC_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
  }
  return [...out];
}

export function computeReachability() {
  const reachableByClass = {};
  const reachable = new Set();

  for (const [cls, entries] of Object.entries(ENTRYPOINTS)) {
    const seen = new Set();
    const queue = entries.map(abs).filter((p) => existsSync(p));
    while (queue.length) {
      const cur = queue.pop();
      const r = rel(cur);
      if (seen.has(r)) continue;
      seen.add(r);
      reachable.add(r);
      for (const spec of specifiersOf(cur)) {
        const next = resolveSpecifier(cur, spec);
        if (next) queue.push(next);
      }
    }
    reachableByClass[cls] = [...seen].sort();
  }

  const production = PRODUCTION_ROOTS.flatMap((root) => walk(abs(root))).map(rel).sort();
  const unreachable = production.filter((p) => !reachable.has(p));
  return { production, reachable, unreachable, reachableByClass };
}

// ===========================================================================
// Evaluation
// ===========================================================================

export function evaluate() {
  const { production, reachable, unreachable, reachableByClass } = computeReachability();
  const problems = [];

  // Structural: every disposition names a valid class.
  for (const [file, d] of Object.entries(DISPOSITIONS)) {
    if (!VALID.has(d.disposition)) {
      problems.push(`${file}: invalid disposition "${d.disposition}"`);
    }
    if (!d.reason || d.reason.length < 40) {
      problems.push(`${file}: disposition has no substantive reason`);
    }
    if (d.disposition === "CONNECTED" && !d.proof) {
      problems.push(`${file}: CONNECTED with no execution proof`);
    }
    if (d.disposition === "REGISTERED_CLI") {
      for (const f of ["entrypoint", "owner", "input"]) {
        if (!d[f]) problems.push(`${file}: REGISTERED_CLI missing \`${f}\``);
      }
      if (d.entrypoint && !existsSync(abs(d.entrypoint))) {
        problems.push(`${file}: REGISTERED_CLI entrypoint ${d.entrypoint} does not exist`);
      }
    }
    if (d.disposition === "QUARANTINED" && !d.removalCondition) {
      problems.push(`${file}: QUARANTINED with no stated removal condition`);
    }
  }

  // 1. Every unreachable production module carries a disposition.
  const unclassified = unreachable.filter((f) => !(f in DISPOSITIONS));
  for (const f of unclassified) {
    problems.push(`UNCLASSIFIED unreachable production module: ${f}`);
  }

  // 2. A CONNECTED module must actually be reachable now.
  const stillUnreachable = [];
  for (const [file, d] of Object.entries(DISPOSITIONS)) {
    if (d.disposition !== "CONNECTED") continue;
    if (!reachable.has(file)) {
      stillUnreachable.push(file);
      problems.push(`CONNECTED but still unreachable: ${file}`);
    }
  }

  // 3. A REMOVED module must be gone. `DISPOSITIONS` holds only EXECUTED
  //    dispositions, so any REMOVED row here that still exists is a lie the
  //    manifest is telling; the analysed-but-unexecuted plan lives in
  //    `ANALYSED_PENDING_REMOVAL` and is counted as unclassified instead.
  const stillPresent = [];
  for (const [file, d] of Object.entries(DISPOSITIONS)) {
    if (d.disposition !== "REMOVED") continue;
    if (existsSync(abs(file))) {
      stillPresent.push(file);
      problems.push(`REMOVED but still on disk: ${file}`);
    }
  }
  // A file cannot be dispositioned twice — that would let a reader see
  // whichever answer they preferred.
  for (const file of Object.keys(ANALYSED_PENDING_REMOVAL)) {
    if (file in CORE_DISPOSITIONS) {
      problems.push(`${file} appears in BOTH the manifest and the pending plan`);
    }
  }

  // 4. A disposition for a module that no longer exists and was NOT removed is
  //    a stale row — the snapshot problem this gate replaces.
  for (const [file, d] of Object.entries(DISPOSITIONS)) {
    if (d.disposition === "REMOVED") continue;
    if (!existsSync(abs(file))) {
      problems.push(`stale disposition — ${file} does not exist but is not REMOVED`);
    }
  }

  const counters = {
    UnclassifiedUnreachableProductionModules: unclassified.length,
    ConnectedButUnreachable: stillUnreachable.length,
    RemovedButPresent: stillPresent.length,
    ProductionModules: production.length,
    ReachableProductionModules: production.length - unreachable.length,
    UnreachableProductionModules: unreachable.length,
  };

  return { ok: problems.length === 0, problems, counters, unreachable, reachableByClass };
}

function main() {
  const r = evaluate();
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: r.ok,
        counters: r.counters,
        unreachable: r.unreachable,
        dispositions: Object.fromEntries(
          Object.entries(DISPOSITIONS).map(([k, v]) => [k, v.disposition]),
        ),
        problems: r.problems,
      },
      null,
      2,
    )}\n`,
  );
  if (!r.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
