#!/usr/bin/env node
/**
 * PHASE 12 REMEDIATION — CORRECTIVE PASS, STEP 3 (2026-08-06).
 *
 * THE LEDGER AUTHORITY.
 *
 * Why this exists
 * ---------------
 * The previous remediation report contradicted itself in two arithmetic ways
 * (C1 and C2 in the corrective mandate), and both had the SAME cause: scalar
 * counts were MAINTAINED BY HAND in prose, next to a table of rows, and the
 * two drifted. A hand-written "Nine of nineteen" cannot be wrong-proof; a
 * count DERIVED from the rows can be.
 *
 * So this script is the only thing permitted to state a count. It reads
 * `rows.json`, refuses a malformed row set, derives every scalar, and emits
 * both a machine-readable `ledger.json` and a human `ledger.md`. Nothing
 * downstream may hard-code a total.
 *
 * What it refuses (each is an explicit exit-1 condition)
 * -----------------------------------------------------
 *   * duplicate IDs
 *   * missing IDs (the canonical 25 are pinned below)
 *   * invented IDs (anything outside the canonical set)
 *   * a VERIFIED_CLOSURE row counted as an actionable defect
 *   * an UNKNOWN row silently promoted to a PASS disposition
 *   * a row whose finalDisposition is FIXED without source evidence
 *   * a row claiming runtime/migration/browser verification with no
 *     evidence reference
 *   * counts that do not conserve: fixed + remaining + closures + unknown
 *     must equal the row count
 *
 * The canonical ID set is pinned as DATA, not derived from the file it
 * validates — otherwise a dropped row would validate itself away.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The 25 canonical rows of the normalized Phase-12 ledger, pinned so a
 * dropped or invented row is detectable. Severity here is the NORMALIZED
 * severity agreed in Step 0 of the previous pass.
 */
const CANONICAL_ROWS = Object.freeze({
  "SEC-001": "CRITICAL",
  "ARCH-005": "HIGH",
  "AUTH-001": "HIGH",
  "AUTH-002": "HIGH",
  "AUTH-003": "HIGH",
  "AUTH-004": "MEDIUM",
  "AUTH-005": "MEDIUM",
  "COMM-001": "MEDIUM",
  "ARCH-001": "MEDIUM",
  "ARCH-002": "MEDIUM",
  "ARCH-003": "MEDIUM",
  "DB-010": "MEDIUM",
  "MOBILE-001": "MEDIUM",
  "INFRA-001": "LOW",
  "LEGACY-003": "LOW",
  "LEGACY-001": "LOW",
  "COMM-002": "LOW",
  "WEB-002": "LOW",
  "ARCH-004": "LOW",
  "DB-011": "VERIFIED_CLOSURE",
  "WEB-001": "VERIFIED_CLOSURE",
  "UNK-001": "UNKNOWN_BLOCKED",
  "UNK-002": "UNKNOWN_BLOCKED",
  "UNK-003": "UNKNOWN_BLOCKED",
  "UNK-004": "UNKNOWN_BLOCKED",
});

/**
 * PHASE 12 CORRECTIVE PASS 3 §1.3 — the DISCOVERED rows, pinned the same way.
 *
 * These were found by this programme's own probing rather than by the original
 * audit. The previous pass kept them in a SEPARATE file so they could not
 * inflate the "fixed" count — a defensible instinct that produced an
 * indefensible result: a defect the programme found and fixed did not appear in
 * the programme's own totals, and a defect it found and did NOT fix (INV-001)
 * appeared nowhere at all.
 *
 * They are first-class rows now. Provenance is preserved by the `origin` field
 * rather than by the file boundary, so every count can be reported both
 * combined and split, and nothing is hidden. Pinned as DATA for the same reason
 * the canonical 25 are: a dropped row must be detectable by the thing that
 * validates it.
 */
const DISCOVERED_ROWS = Object.freeze({
  "NEW-001": "HIGH",
  "NEW-002": "MEDIUM",
  "NEW-003": "MEDIUM",
  "NEW-004": "HIGH",
  "NEW-005": "MEDIUM",
  "NEW-006": "MEDIUM",
  "INV-001": "MEDIUM",
  "SEC-002": "HIGH",
  "SEC-003": "LOW",
  "SEC-004": "MEDIUM",
  // ---------------------------------------------------------------------
  // PHASE 12 CORRECTIVE PASS §1–§7 (2026-08-06) — DISCOVERED WHILE FIXING.
  //
  // Every one of these was found by DRIVING the thing being fixed, not by
  // reading it. They are first-class rows in this same ledger, not footnotes
  // in a report, because that is the only way the counts stay honest.
  // ---------------------------------------------------------------------
  /** The currentWorkspaceId authority gate was RED: identity.routes.ts:237. */
  "NEW-007": "MEDIUM",
  /** The org external-access CSV exported a permanently-PENDING lifecycle. */
  "NEW-008": "MEDIUM",
  /** A token ROTATION collapsed onto the superseded message's provider key. */
  "NEW-009": "HIGH",
  /** Two concurrent resends raced through count()+1; one was silently lost. */
  "NEW-010": "MEDIUM",
  /** external_reviewer_role_assignments.raw_token — a plaintext token column. */
  "NEW-011": "LOW",
  /** No FK bound the invitation sidecar to its grant; orphans were possible. */
  "NEW-012": "LOW",
  // ---------------------------------------------------------------------
  // PHASE 12 CORRECTIVE PASS §1/§2 CONTINUATION (2026-08-07) — DISCOVERED
  // WHILE DRIVING ARCH-003 / ARCH-004, not while reading them.
  //
  // They are pinned here for exactly the reason the block above is: a defect
  // this programme found and fixed that does not appear in the programme's own
  // totals is a hidden row, and the previous pass has already been corrected
  // once for that. The continuation's prose claimed four closures the row set
  // did not carry AND named two discoveries that existed in no ledger at all —
  // which is the arithmetic contradiction §1 of the continuation mandate
  // names. Both halves are repaired by making the rows the only authority.
  // ---------------------------------------------------------------------
  /**
   * The composite `requireAuthAndLegal` turned a clean 401 into a 500:
   * `requireAuth` SENDS its 401 and returns normally, so the composite ran
   * `requireLegalAcceptance` on top and Fastify raised
   * FST_ERR_REP_ALREADY_SENT.
   */
  "NEW-013": "MEDIUM",
  /**
   * A loop-registered route pair rendered its path as a template literal, so
   * the runtime-capability inventory that scans registration literals saw
   * `POST /v1/orgs/:id/members/:memberId/` — a path in no router. An audit
   * gate with a blind spot is a fictional control.
   */
  "NEW-014": "LOW",
  // ---------------------------------------------------------------------
  // PHASE 12 CORRECTIVE PASS §1 CONTINUATION (2026-08-07) — DISCOVERED BY
  // CORRECTING ARCH-005's AMBIGUITY CONTRACT.
  //
  // Both were found by driving the corrected semantics, not by reading them,
  // and NEW-016 was findable only because NEW-016's own fix (distinguishing a
  // REJECTED write from an honest zero-row match) was made first.
  // ---------------------------------------------------------------------
  /**
   * An AMBIGUOUS outcome rode the RETRY ladder: a timeout was classified
   * "retryable" and re-executed after 30 s. A timeout is precisely the case in
   * which the receiver may already have acted, so the resend was a DUPLICATE
   * external side effect wearing a retry's clothes.
   */
  "NEW-015": "HIGH",
  /**
   * `automation_runs.status` / `automation_webhook_deliveries.status` were
   * VARCHAR(20) while `DEAD_LETTERED_UNKNOWN` is 21 characters. The widened
   * CHECK accepted a value the COLUMN then refused, and the fenced updater
   * reported the rejection as "matched zero rows" — indistinguishable from
   * ordinary contention — so reconciliation revisited the row forever and
   * never terminated it.
   */
  "NEW-016": "MEDIUM",
});

/** Every admissible row id, with its pinned normalized severity. */
const ALL_ROWS = Object.freeze({ ...CANONICAL_ROWS, ...DISCOVERED_ROWS });

const ACTIONABLE_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/** Dispositions that assert the defect is gone. */
const CLOSED_DISPOSITIONS = new Set(["FIXED_VERIFIED"]);
/** Dispositions that assert the row still carries work. */
const OPEN_DISPOSITIONS = new Set([
  "OPEN_NOT_STARTED",
  "OPEN_PARTIAL",
  "FIXED_UNVERIFIED",
  "REOPENED",
]);
/** Non-defect dispositions. */
const CLOSURE_DISPOSITIONS = new Set(["VERIFIED_CLOSURE_RETAINED"]);
const UNKNOWN_DISPOSITIONS = new Set([
  "UNKNOWN_RESOLVED_LOCAL",
  "UNKNOWN_OWNER_PENDING",
  "UNKNOWN_STILL_BLOCKED",
]);

const VERIFICATION_STATES = new Set([
  "PASS",
  "FAIL",
  "PARTIAL",
  "NOT_APPLICABLE",
  "NOT_EXECUTED",
]);

function fail(problems) {
  process.stderr.write("\nLEDGER REFUSED — the row set is not admissible:\n");
  for (const p of problems) process.stderr.write(`  * ${p}\n`);
  process.stderr.write("\nNo counts were emitted. Fix rows.json.\n");
  process.exit(1);
}

/**
 * THE PINNED SETS, EXPORTED SO AN ADVERSARIAL SUITE CAN DRIVE THE REAL THING.
 *
 * PHASE 12 CONTINUATION §1 (2026-08-07). The mandate asks for adversarial
 * ledger cases — a refusal that has never been observed refusing is the same
 * fictional control this programme keeps finding. The cases must drive THIS
 * validator, not a re-implementation of it in a test file, or they prove
 * something about the copy.
 */
export const LEDGER_ROW_IDS = ALL_ROWS;
export const LEDGER_CANONICAL_ROW_IDS = CANONICAL_ROWS;
export const LEDGER_DISCOVERED_ROW_IDS = DISCOVERED_ROWS;
export const LEDGER_ROWS_PATH = path.join(HERE, "rows.json");

/**
 * Validate and derive. Returns `{ ok: false, problems }` or
 * `{ ok: true, ledger }`. It NEVER exits and NEVER writes — the CLI below owns
 * both. Structural, semantic and conservation checks run in that order, and an
 * earlier stage short-circuits the later ones exactly as the CLI always did:
 * conservation arithmetic over a malformed row set is not meaningful.
 */
export function evaluateRows(rows) {
  const problems = [];

  if (!Array.isArray(rows)) {
    return { ok: false, problems: ["rows.json must be an array of row objects."] };
  }

  // ---- structural admissibility -------------------------------------------
  const seen = new Map();
  for (const r of rows) {
    if (!r || typeof r.id !== "string") {
      problems.push("a row has no string `id`.");
      continue;
    }
    if (seen.has(r.id)) problems.push(`duplicate id: ${r.id}`);
    seen.set(r.id, r);
    if (!(r.id in ALL_ROWS)) problems.push(`invented id (not in the pinned canonical or discovered set): ${r.id}`);
  }
  for (const id of Object.keys(ALL_ROWS)) {
    if (!seen.has(id)) problems.push(`missing id: ${id}`);
  }

  const REQUIRED_FIELDS = [
    "id",
    "originalSeverity",
    "normalizedSeverity",
    "prePassDisposition",
    "claimedRemediationFiles",
    "sourceVerified",
    "runtimeVerified",
    "migrationVerified",
    "browserVerified",
    "remainingRisk",
    "finalDisposition",
    "evidenceReferences",
  ];

  for (const r of rows) {
    if (!r?.id) continue;
    for (const f of REQUIRED_FIELDS) {
      if (!(f in r)) problems.push(`${r.id}: missing required field \`${f}\``);
    }
    if (r.normalizedSeverity !== ALL_ROWS[r.id]) {
      problems.push(
        `${r.id}: normalizedSeverity "${r.normalizedSeverity}" disagrees with the pinned severity "${ALL_ROWS[r.id]}"`,
      );
    }
    for (const f of ["sourceVerified", "runtimeVerified", "migrationVerified", "browserVerified"]) {
      if (r[f] !== undefined && !VERIFICATION_STATES.has(r[f])) {
        problems.push(`${r.id}: ${f} has invalid state "${r[f]}"`);
      }
    }
    if (!Array.isArray(r.evidenceReferences)) {
      problems.push(`${r.id}: evidenceReferences must be an array`);
    }
    if (!Array.isArray(r.claimedRemediationFiles)) {
      problems.push(`${r.id}: claimedRemediationFiles must be an array`);
    }
  }

  // ---- semantic admissibility ---------------------------------------------
  for (const r of rows) {
    if (!r?.id) continue;
    const sev = ALL_ROWS[r.id];
    const d = r.finalDisposition;

    const known =
      CLOSED_DISPOSITIONS.has(d) ||
      OPEN_DISPOSITIONS.has(d) ||
      CLOSURE_DISPOSITIONS.has(d) ||
      UNKNOWN_DISPOSITIONS.has(d);
    if (!known) problems.push(`${r.id}: unknown finalDisposition "${d}"`);

    // A VERIFIED_CLOSURE row may never be counted as an actionable defect.
    if (sev === "VERIFIED_CLOSURE" && !CLOSURE_DISPOSITIONS.has(d)) {
      problems.push(
        `${r.id}: is a VERIFIED_CLOSURE but carries a defect disposition "${d}" — a proof of correctness must not be counted as a defect.`,
      );
    }
    if (sev !== "VERIFIED_CLOSURE" && CLOSURE_DISPOSITIONS.has(d)) {
      problems.push(`${r.id}: claims VERIFIED_CLOSURE_RETAINED but is not a closure row.`);
    }

    // An UNKNOWN may never be silently promoted to a PASS/defect disposition.
    if (sev === "UNKNOWN_BLOCKED" && !UNKNOWN_DISPOSITIONS.has(d)) {
      problems.push(
        `${r.id}: is UNKNOWN_BLOCKED but carries "${d}" — an unknown must resolve to an explicit UNKNOWN_* disposition, never be promoted to a pass.`,
      );
    }
    if (sev !== "UNKNOWN_BLOCKED" && UNKNOWN_DISPOSITIONS.has(d)) {
      problems.push(`${r.id}: uses an UNKNOWN_* disposition but is not an unknown row.`);
    }

    // FIXED_VERIFIED demands actual evidence.
    if (CLOSED_DISPOSITIONS.has(d)) {
      if (r.sourceVerified !== "PASS") {
        problems.push(`${r.id}: FIXED_VERIFIED requires sourceVerified=PASS (got "${r.sourceVerified}").`);
      }
      if (!r.evidenceReferences.length) {
        problems.push(`${r.id}: FIXED_VERIFIED with no evidenceReferences.`);
      }
    }
    // A claimed verification must cite evidence.
    for (const f of ["runtimeVerified", "migrationVerified", "browserVerified"]) {
      if (r[f] === "PASS" && !r.evidenceReferences.length) {
        problems.push(`${r.id}: ${f}=PASS with no evidenceReferences.`);
      }
    }
  }

  if (problems.length) return { ok: false, problems };

  // ---- DERIVED counts. Nothing below is hand-maintained. -------------------
  const bySeverity = {};
  for (const s of [...ACTIONABLE_SEVERITIES, "VERIFIED_CLOSURE", "UNKNOWN_BLOCKED"]) {
    bySeverity[s] = { total: 0, closed: 0, open: 0 };
  }
  const fixed = [];
  const remaining = [];
  const closures = [];
  const unknowns = [];

  for (const r of rows) {
    const sev = ALL_ROWS[r.id];
    const d = r.finalDisposition;
    bySeverity[sev].total += 1;
    if (CLOSED_DISPOSITIONS.has(d)) {
      bySeverity[sev].closed += 1;
      fixed.push(r.id);
    } else if (OPEN_DISPOSITIONS.has(d)) {
      bySeverity[sev].open += 1;
      remaining.push(r.id);
    } else if (CLOSURE_DISPOSITIONS.has(d)) {
      closures.push(r.id);
    } else {
      unknowns.push(r.id);
    }
  }

  const actionableTotal = ACTIONABLE_SEVERITIES.reduce((n, s) => n + bySeverity[s].total, 0);
  const actionableClosed = ACTIONABLE_SEVERITIES.reduce((n, s) => n + bySeverity[s].closed, 0);
  const actionableOpen = ACTIONABLE_SEVERITIES.reduce((n, s) => n + bySeverity[s].open, 0);

  // ---- CONSERVATION. The check the previous report failed. -----------------
  const conservationProblems = [];
  if (actionableClosed + actionableOpen !== actionableTotal) {
    conservationProblems.push(
      `actionable conservation broken: closed(${actionableClosed}) + open(${actionableOpen}) != total(${actionableTotal})`,
    );
  }
  const grand = fixed.length + remaining.length + closures.length + unknowns.length;
  if (grand !== rows.length) {
    conservationProblems.push(`row conservation broken: dispositions(${grand}) != rows(${rows.length})`);
  }
  if (rows.length !== Object.keys(ALL_ROWS).length) {
    conservationProblems.push(
      `row count ${rows.length} != pinned ${Object.keys(ALL_ROWS).length} ` +
        `(canonical ${Object.keys(CANONICAL_ROWS).length} + discovered ${Object.keys(DISCOVERED_ROWS).length})`,
    );
  }
  // PROVENANCE CONSERVATION (§1.3). Every row must declare where it came from,
  // and the declaration must agree with the pinned sets. Without this, merging
  // the discovered findings into one ledger would lose the very distinction
  // that keeping them separate was meant to protect — and a discovered row
  // could be quietly relabelled as an original one to make the original audit
  // look worse or better than it was.
  for (const r of rows) {
    if (!r?.id) continue;
    const expected = r.id in CANONICAL_ROWS ? "ORIGINAL" : "DISCOVERED";
    if (r.origin !== expected) {
      conservationProblems.push(
        `${r.id}: origin "${r.origin}" disagrees with the pinned sets (expected ${expected})`,
      );
    }
  }
  if (conservationProblems.length) return { ok: false, problems: conservationProblems };

  const byOrigin = (o) => rows.filter((r) => r.origin === o);
  const originSplit = (o) => {
    const rs = byOrigin(o).filter((r) => ACTIONABLE_SEVERITIES.includes(ALL_ROWS[r.id]));
    return {
      total: rs.length,
      closed: rs.filter((r) => CLOSED_DISPOSITIONS.has(r.finalDisposition)).length,
      open: rs.filter((r) => OPEN_DISPOSITIONS.has(r.finalDisposition)).length,
    };
  };

  const ledger = {
    generatedBy: "audit-output/phase12-independent-source-audit/ledger/generate-ledger.mjs",
    note: "Every scalar in this file is DERIVED from rows.json. No count is hand-maintained.",
    rowCount: rows.length,
    actionable: {
      total: actionableTotal,
      closed: actionableClosed,
      open: actionableOpen,
      bySeverity: Object.fromEntries(ACTIONABLE_SEVERITIES.map((s) => [s, bySeverity[s]])),
      byOrigin: {
        ORIGINAL: originSplit("ORIGINAL"),
        DISCOVERED: originSplit("DISCOVERED"),
      },
    },
    verifiedClosures: { total: bySeverity.VERIFIED_CLOSURE.total, ids: closures },
    unknownBlocked: {
      total: bySeverity.UNKNOWN_BLOCKED.total,
      ids: unknowns,
      byDisposition: unknowns.reduce((acc, id) => {
        const d = seen.get(id).finalDisposition;
        acc[d] = (acc[d] ?? 0) + 1;
        return acc;
      }, {}),
    },
    fixedIds: fixed,
    remainingIds: remaining,
    conservationEquation: `${actionableClosed} fixed + ${actionableOpen} remaining = ${actionableTotal} actionable; + ${closures.length} closures + ${unknowns.length} unknown = ${rows.length} rows`,
    verificationCoverage: {
      sourceVerifiedPass: rows.filter((r) => r.sourceVerified === "PASS").length,
      runtimeVerifiedPass: rows.filter((r) => r.runtimeVerified === "PASS").length,
      migrationVerifiedPass: rows.filter((r) => r.migrationVerified === "PASS").length,
      browserVerifiedPass: rows.filter((r) => r.browserVerified === "PASS").length,
      runtimeNotExecuted: rows.filter((r) => r.runtimeVerified === "NOT_EXECUTED").length,
    },
    rows,
  };

  return { ok: true, ledger };
}

/** CLI: read, evaluate, refuse or render. The only thing that writes or exits. */
function main() {
  const rows = JSON.parse(readFileSync(LEDGER_ROWS_PATH, "utf8"));
  const result = evaluateRows(rows);
  if (!result.ok) fail(result.problems);
  const { ledger } = result;

  writeFileSync(path.join(HERE, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);

  // ---- human rendering, also derived --------------------------------------
  const md = [];
  md.push("# Phase 12 — Corrective-Pass Ledger (GENERATED)");
  md.push("");
  md.push("> Generated by `generate-ledger.mjs` from `rows.json`.");
  md.push("> **Every number below is derived from the rows.** Do not edit this file;");
  md.push("> edit `rows.json` and regenerate. The generator refuses a row set that");
  md.push("> duplicates, drops, invents, double-counts, or silently promotes a row.");
  md.push("");
  md.push("## Derived counts");
  md.push("");
  md.push("```text");
  md.push(`rows                       ${ledger.rowCount}`);
  md.push(`actionable total           ${ledger.actionable.total}`);
  md.push(`actionable closed          ${ledger.actionable.closed}`);
  md.push(`actionable open            ${ledger.actionable.open}`);
  for (const s of ACTIONABLE_SEVERITIES) {
    const b = ledger.actionable.bySeverity[s];
    md.push(`  ${s.padEnd(9)} total ${b.total}  closed ${b.closed}  open ${b.open}`);
  }
  md.push(`verified closures          ${ledger.verifiedClosures.total}`);
  md.push(`unknown blocked            ${ledger.unknownBlocked.total}`);
  for (const [d, n] of Object.entries(ledger.unknownBlocked.byDisposition)) {
    md.push(`  ${d.padEnd(24)} ${n}`);
  }
  md.push("");
  md.push(`conservation: ${ledger.conservationEquation}`);
  md.push("```");
  md.push("");
  md.push("## Verification coverage (rows, not assertions)");
  md.push("");
  md.push("```text");
  for (const [k, v] of Object.entries(ledger.verificationCoverage)) {
    md.push(`${k.padEnd(26)} ${v}`);
  }
  md.push("```");
  md.push("");
  md.push("## Rows");
  md.push("");
  md.push("| id | sev | pre-pass | src | runtime | migration | browser | final | residual risk |");
  md.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    md.push(
      `| ${r.id} | ${r.normalizedSeverity} | ${r.prePassDisposition} | ${r.sourceVerified} | ${r.runtimeVerified} | ${r.migrationVerified} | ${r.browserVerified} | **${r.finalDisposition}** | ${r.remainingRisk} |`,
    );
  }
  md.push("");
  writeFileSync(path.join(HERE, "ledger.md"), `${md.join("\n")}\n`);

  process.stdout.write(`${JSON.stringify(
    {
      ok: true,
      rowCount: ledger.rowCount,
      actionable: {
        total: ledger.actionable.total,
        closed: ledger.actionable.closed,
        open: ledger.actionable.open,
      },
      bySeverity: ledger.actionable.bySeverity,
      verifiedClosures: ledger.verifiedClosures.total,
      unknownBlocked: ledger.unknownBlocked,
      conservationEquation: ledger.conservationEquation,
      verificationCoverage: ledger.verificationCoverage,
    },
    null,
    2,
  )}\n`);
}

/**
 * Run ONLY when executed as a script. Importing this module — which the
 * adversarial suite does — must not write files or exit the test worker.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
