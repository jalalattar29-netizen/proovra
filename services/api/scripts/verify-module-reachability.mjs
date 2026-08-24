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
 *
 * PHASE 13 (NEW-047, 2026-08-17) — THE EDGES ARE READ FROM THE SYNTAX TREE.
 * ---------------------------------------------------------------------------
 * They used to be read by a regular expression with a 400-CHARACTER WINDOW
 * between the `import`/`export` keyword and its `from "…"`:
 *
 *     /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*["']([^"']+)["']/g
 *
 * A six-line comment written INSIDE a re-export brace list pushed one statement
 * past that window. The edge to `rbac.service.ts` stopped being followed and a
 * 940-line RBAC lifecycle authority was reported as an unreachable production
 * module — a finding produced entirely by the shape of a comment, with nothing
 * about the runtime changed. Widening the window would only move the cliff.
 *
 * The edges now come from `moduleSpecifiersOf`, which reads the real
 * `ImportDeclaration` / `ExportDeclaration` / `ImportEqualsDeclaration` /
 * `import()` / `require()` nodes. A specifier inside a COMMENT produces no node
 * at all, a specifier inside a STRING LITERAL is an ordinary expression and
 * never a module specifier, and the distance between a keyword and its
 * specifier is not a quantity this file can observe. Every computed specifier
 * that a static tool genuinely cannot follow is COUNTED and REPORTED by
 * `evaluate()` — the blind spot is a number in the output, never a silent
 * assumption in either direction.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { moduleSpecifiersOf } from "./capability-authority/structural-reach.mjs";

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
    // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the read-only destruction
    // candidate report (`pnpm --filter @proovra/worker destruction-candidates`).
    // An operator entrypoint, and the one an operator is expected to read
    // BEFORE enabling automatic physical destruction, so it is emphatically
    // live code rather than a leftover.
    "services/worker/src/scripts/destruction-candidates.ts",
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
 * PHASE 12 §3 CONTINUATION (LEGACY-003) — ANALYSED **AND EXECUTED** (closed
 * 2026-08-15).
 *
 * A previous pass analysed these twenty-four to a decision but reverted the
 * deletion, because removing them broke the source-contract suites that read
 * them at load time. They were parked in a separate `ANALYSED_PENDING_REMOVAL`
 * constant for the reason `DISPOSITIONS` exists: a `REMOVED` row whose file is
 * still on disk is a false statement, and the verifier would have been the
 * thing telling it.
 *
 * The files are now gone and the dependent suites assert the truthful final
 * disposition instead of reading a deleted module, so these rows have been
 * merged into `DISPOSITIONS`. That merge is what ARMS the verifier's own
 * "REMOVED but still on disk" refusal against them: if anyone restores one of
 * these files without also retiring its row, this gate fails.
 *
 * Every entry below had the five checks run before deletion — exact importers,
 * exported symbols, DB writes, queue/event ownership, and
 * route/UI/script/deployment references — and they were re-run mechanically at
 * execution time. Two results are worth recording because they corrected the
 * earlier analysis rather than confirming it:
 *
 *   - The six `media-intelligence`/`graph` entries are NOT duplicate
 *     authorities. Each is a SIX-LINE re-export shim left by the Phase 31.22
 *     boundary refactor, forwarding to the canonical implementation in
 *     `@proovra/shared-runtime`. A shim that re-exports its canonical cannot
 *     diverge from it, so the "two copies waiting to disagree" reading the
 *     earlier pass recorded was wrong. They are removed because the migration
 *     they scaffolded is COMPLETE — every importer now names the package.
 *
 *   - `transcript-foundations` and `ocr-foundations` really are unreachable
 *     WRITERS (`$queryRawUnsafe` INSERTs, which a `prisma.create` scan misses),
 *     and they are the ONLY inserters of their two tables. Removing them is
 *     behaviour-neutral because an unreachable module never ran: the worker's
 *     `search-indexing.processor` only stamps `indexed_at_utc` on existing rows
 *     and is written to tolerate matching none.
 */
export const EXECUTED_REMOVALS = Object.freeze({
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
      "COMPLETED-MIGRATION SHIM, not a duplicate authority. This file was six lines: a doc comment plus `export * from \"@proovra/shared-runtime/graph\"`, left by the Phase 31.22 boundary refactor to preserve the old api/src import path for the domain-sync graph projection while callers moved. Because it RE-EXPORTED `packages/shared-runtime/src/graph/domain-sync.service.ts` rather than copying it, the two could never disagree — the earlier pass recorded this as a stale twin and that reading was wrong. It is removed because the migration it scaffolded is COMPLETE: zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. The remaining test importers were migrated onto the package in the same pass.",
  },
  "services/api/src/services/media-intelligence/exif-extractor.service.ts": {
    disposition: "REMOVED",
    reason:
      "COMPLETED-MIGRATION SHIM, not a duplicate authority. This file was six lines: a doc comment plus `export * from \"@proovra/shared-runtime/media-intelligence\"`, left by the Phase 31.22 boundary refactor to preserve the old api/src import path for the EXIF extractor while callers moved. Because it RE-EXPORTED `packages/shared-runtime/src/media-intelligence/exif-extractor.service.ts` rather than copying it, the two could never disagree — the earlier pass recorded this as a stale twin and that reading was wrong. It is removed because the migration it scaffolded is COMPLETE: zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. The remaining test importers were migrated onto the package in the same pass.",
  },
  "services/api/src/services/media-intelligence/exif-summary.service.ts": {
    disposition: "REMOVED",
    reason:
      "COMPLETED-MIGRATION SHIM, not a duplicate authority. This file was six lines: a doc comment plus `export * from \"@proovra/shared-runtime/media-intelligence\"`, left by the Phase 31.22 boundary refactor to preserve the old api/src import path for the EXIF summary reader while callers moved. Because it RE-EXPORTED `packages/shared-runtime/src/media-intelligence/exif-summary.service.ts` rather than copying it, the two could never disagree — the earlier pass recorded this as a stale twin and that reading was wrong. It is removed because the migration it scaffolded is COMPLETE: zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. The remaining test importers were migrated onto the package in the same pass.",
  },
  "services/api/src/services/media-intelligence/ocr-transcript-indexer.service.ts": {
    disposition: "REMOVED",
    reason:
      "COMPLETED-MIGRATION SHIM, not a duplicate authority. This file was six lines: a doc comment plus `export * from \"@proovra/shared-runtime/media-intelligence\"`, left by the Phase 31.22 boundary refactor to preserve the old api/src import path for the OCR/transcript indexer while callers moved. Because it RE-EXPORTED `packages/shared-runtime/src/media-intelligence/ocr-transcript-indexer.service.ts` rather than copying it, the two could never disagree — the earlier pass recorded this as a stale twin and that reading was wrong. It is removed because the migration it scaffolded is COMPLETE: zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. The remaining test importers were migrated onto the package in the same pass.",
  },
  "services/api/src/services/media-intelligence/producer-mode.ts": {
    disposition: "REMOVED",
    reason:
      "COMPLETED-MIGRATION SHIM, not a duplicate authority. This file was six lines: a doc comment plus `export * from \"@proovra/shared-runtime/media-intelligence\"`, left by the Phase 31.22 boundary refactor to preserve the old api/src import path for the producer-mode resolver while callers moved. Because it RE-EXPORTED `packages/shared-runtime/src/media-intelligence/producer-mode.ts` rather than copying it, the two could never disagree — the earlier pass recorded this as a stale twin and that reading was wrong. It is removed because the migration it scaffolded is COMPLETE: zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. The remaining test importers were migrated onto the package in the same pass.",
  },
  "services/api/src/services/media-intelligence/report-projection.service.ts": {
    disposition: "REMOVED",
    reason:
      "COMPLETED-MIGRATION SHIM, not a duplicate authority. This file was six lines: a doc comment plus `export * from \"@proovra/shared-runtime/media-intelligence\"`, left by the Phase 31.22 boundary refactor to preserve the old api/src import path for the media report projection while callers moved. Because it RE-EXPORTED `packages/shared-runtime/src/media-intelligence/report-projection.service.ts` rather than copying it, the two could never disagree — the earlier pass recorded this as a stale twin and that reading was wrong. It is removed because the migration it scaffolded is COMPLETE: zero production importers, zero DB writes, zero queue or event ownership, no route/UI caller, no package script, no deployment reference. The remaining test importers were migrated onto the package in the same pass.",
  },
  "services/worker/src/report-v2/index.ts": {
    disposition: "REMOVED",
    reason:
      "A barrel no PRODUCTION module imported. `services/worker/src/processor.ts` imports the CONCRETE report-v2 modules by path (`./report-v2/types.js`, `./report-v2/truth-model.js`, `./report-v2/build-report-pdf.js`), so the barrel re-exported a surface the runtime never used. Zero writes, zero queue ownership. CORRECTION at execution time: the earlier analysis recorded this as 'a barrel nothing imported', which was wrong — three worker TESTS imported it as the directory specifier `../src/report-v2`, a form a path-based grep for `report-v2/index` does not match. They were migrated onto the concrete modules, which is strictly better: they now exercise the same import paths production does.",
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

/**
 * The one manifest the evaluator reads.
 *
 * LEGACY-003 closure: the executed removals are merged in, so guard 3
 * ("REMOVED but still on disk") now covers them. A restored file with a live
 * REMOVED row fails this gate rather than quietly reappearing.
 */
export const DISPOSITIONS = Object.freeze({
  ...CORE_DISPOSITIONS,
  ...EXECUTED_REMOVALS,
});

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

/**
 * Per-file edge cache.
 *
 * The BFS visits a hub module once per entrypoint CLASS, and the production
 * sweep visits every module again to collect unfollowable specifiers. Parsing
 * `services/api/src` four times is seconds this gate does not need to spend,
 * and — more importantly — a cache guarantees the reachability walk and the
 * unresolved report are reading the SAME tree rather than two parses that could
 * in principle disagree.
 */
const EDGE_CACHE = new Map();

function edgesOf(fileAbs) {
  const key = rel(fileAbs);
  const cached = EDGE_CACHE.get(key);
  if (cached) return cached;
  let src;
  try {
    src = readFileSync(fileAbs, "utf8");
  } catch {
    const empty = { edges: [], unresolved: [] };
    EDGE_CACHE.set(key, empty);
    return empty;
  }
  const parsed = moduleSpecifiersOf(key, src);
  EDGE_CACHE.set(key, parsed);
  return parsed;
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
      for (const { spec } of edgesOf(cur).edges) {
        const next = resolveSpecifier(cur, spec);
        if (next) queue.push(next);
      }
    }
    reachableByClass[cls] = [...seen].sort();
  }

  const production = PRODUCTION_ROOTS.flatMap((root) => walk(abs(root))).map(rel).sort();
  const unreachable = production.filter((p) => !reachable.has(p));

  /**
   * The specifiers no static tool can follow, from every module this gate has
   * an opinion about: everything the BFS reached, plus every production module
   * (a computed import in a module nothing reaches is still a fact about the
   * tree, and hiding it would let a blind spot arrive unnoticed).
   *
   * Reported as DATA. A gate that silently treats an unfollowable edge as
   * "followed" over-reports reachability; one that treats it as "absent"
   * under-reports it. Neither is a measurement, so the count is published and
   * `evaluate()` refuses on every entry — there is no exemption list.
   */
  const unresolvedSpecifiers = [];
  const inspected = new Set([...reachable, ...production]);
  for (const file of [...inspected].sort()) {
    const p = abs(file);
    if (!existsSync(p)) continue;
    for (const u of edgesOf(p).unresolved) {
      unresolvedSpecifiers.push({ file, ...u });
    }
  }

  return { production, reachable, unreachable, reachableByClass, unresolvedSpecifiers };
}

// ===========================================================================
// Evaluation
// ===========================================================================

export function evaluate() {
  const { production, reachable, unreachable, reachableByClass, unresolvedSpecifiers } =
    computeReachability();
  const problems = [];

  /**
   * 0. AN EDGE THIS TOOL CANNOT FOLLOW IS A REFUSAL, NOT A ROUNDING ERROR.
   *
   * Every other verdict below rests on the graph being complete. A computed
   * specifier is the one place completeness can fail, and there is no safe
   * default: treating it as followed over-reports reachability, treating it as
   * absent under-reports it, and treating it as "probably fine" is how a
   * 940-line authority came to be reported dead in the first place.
   *
   * There is deliberately NO exemption list here. The tree currently has none
   * of these — the two optional-dependency imports that look computed are
   * `const` bindings the parser can fold — so the honest arming of this gate is
   * an unconditional refusal. If a genuinely dynamic specifier is introduced,
   * this fails and someone has to decide what it means, in writing.
   */
  for (const u of unresolvedSpecifiers) {
    problems.push(
      `UNFOLLOWABLE module specifier (${u.kind}) at ${u.file}:${u.line} — \`${u.expression}\`. ` +
        "The import graph cannot be complete while this edge is unknown; either make the specifier " +
        "statically readable or add the owning module to ENTRYPOINTS as a declared blind spot.",
    );
  }

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
  //    manifest is telling — including the LEGACY-003 removals, which are
  //    merged in precisely so this refusal covers them.
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
  for (const file of Object.keys(EXECUTED_REMOVALS)) {
    if (file in CORE_DISPOSITIONS) {
      problems.push(`${file} carries TWO dispositions (core manifest + removals)`);
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
    UnfollowableModuleSpecifiers: unresolvedSpecifiers.length,
  };

  return {
    ok: problems.length === 0,
    problems,
    counters,
    unreachable,
    reachableByClass,
    unresolvedSpecifiers,
  };
}

function main() {
  const r = evaluate();
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: r.ok,
        counters: r.counters,
        unreachable: r.unreachable,
        unresolvedSpecifiers: r.unresolvedSpecifiers,
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
