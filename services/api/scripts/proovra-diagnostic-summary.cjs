#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * ADM-013 — READ A `diag.json` AND PRINT ONLY WHAT IS SAFE TO PRINT.
 *
 * =============================================================================
 * WHY THIS EXISTS RATHER THAN `cat diag.json`
 * =============================================================================
 * `diag.json` is already redacted at the source — the diagnostic selects no
 * token, hash, key or evidence content, pseudonymises workspace and user ids
 * per run, reduces emails to a domain and IPs to a network. But "already
 * redacted" is not the same as "safe to display", and the two differ in a way
 * that matters on a shared screen:
 *
 *   - the traced-account section names ONE real person's activity, and its
 *     email domain plus timestamps is enough to identify them in a room;
 *   - the workspace distributions are per-customer shapes;
 *   - the whole document is thousands of lines, so anything alarming in it
 *     scrolls past unread.
 *
 * So this prints AGGREGATES ONLY. No id, no pseudonym, no email, no domain, no
 * timestamp of any individual's action, no per-workspace row. What survives is
 * the set of numbers a reader actually needs to decide what to do next, and an
 * explicit statement of what could not be read.
 *
 * =============================================================================
 * IT VALIDATES BEFORE IT SUMMARISES
 * =============================================================================
 * A truncated `diag.json` — a dropped SSH session, a full disk, a container
 * killed mid-write — is a file that still looks plausible when skimmed and is
 * missing the sections that mattered. This parses first and refuses loudly, so
 * a partial capture is never read as a healthy platform.
 *
 * The exit code is the machine-readable part:
 *
 *   0  valid, and every section was read
 *   1  valid, but at least one section FAILED — the numbers are incomplete
 *   2  not valid: unparseable, not a diagnostic document, or wrong shape
 *
 * A failed section exits non-zero deliberately. The alternative is a summary
 * that prints a confident set of numbers with one silently missing, which is
 * the exact failure mode the diagnostic itself was built to avoid.
 *
 * =============================================================================
 * HOW TO RUN IT
 * =============================================================================
 * It has NO dependencies — no Prisma, no pg, nothing from node_modules — so it
 * runs anywhere a Node binary exists, including piped into the API container on
 * a host that has no Node of its own:
 *
 *   node proovra-diagnostic-summary.cjs diag.json
 *   docker exec -i "$API" node /tmp/proovra-diagnostic-summary.cjs < diag.json
 *
 * With no path argument it reads stdin.
 */

const fs = require("node:fs");

/** The output shape this reader understands. Refuses anything else. */
const SUPPORTED_MAJOR = 1;

function die(code, message) {
  process.stderr.write(`diagnostic-summary: ${message}\n`);
  process.exit(code);
}

// -----------------------------------------------------------------------------
// Read and validate.
// -----------------------------------------------------------------------------

function readInput() {
  const file = process.argv[2];
  try {
    return file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
  } catch (err) {
    die(2, `could not read ${file ?? "stdin"}: ${err.message}`);
  }
}

const raw = readInput();

if (raw.trim() === "") {
  die(2, "input is empty. Nothing was captured — re-run the diagnostic.");
}

let doc;
try {
  doc = JSON.parse(raw);
} catch (err) {
  // The most common cause is a truncated capture, and saying so is more useful
  // than relaying a character offset.
  die(
    2,
    `input is not valid JSON (${err.message}). ` +
      `Read ${raw.length} bytes; the capture is most likely truncated.`,
  );
}

const meta = doc && doc.diagnostic;
if (!meta || meta.name !== "proovra-diagnostic") {
  die(2, "this is not a proovra-diagnostic document.");
}

const major = Number(String(meta.version ?? "").split(".")[0]);
if (!Number.isFinite(major) || major !== SUPPORTED_MAJOR) {
  die(
    2,
    `output version ${meta.version} is not supported by this reader ` +
      `(expects ${SUPPORTED_MAJOR}.x). The shape may have changed — read the ` +
      `raw document rather than trusting a summary written for another shape.`,
  );
}

const sections = doc.sections ?? {};

// -----------------------------------------------------------------------------
// Print.
// -----------------------------------------------------------------------------

const out = [];
const line = (s = "") => out.push(s);
const num = (v) => (typeof v === "number" ? String(v) : "not read");

/** A section is present only if it exists AND reported ok. Never assumed. */
function ok(name) {
  return Boolean(sections[name] && sections[name].ok);
}
function ifRead(name, fn) {
  if (ok(name)) fn(sections[name]);
  else
    line(
      `  Not read: ${sections[name]?.error ?? "section absent"}. ` +
        `This is NOT a zero.`,
    );
}

line("PROOVRA PRODUCTION DIAGNOSTIC — SUMMARY");
line("=".repeat(70));
line(`Diagnostic version : ${meta.version}`);
// The self-hash is how a reader confirms the document in front of them came
// from the script in front of them.
line(`Source sha256      : ${meta.sourceSha256}`);
line(`Database           : ${meta.database}`);
line(`Generated (UTC)    : ${meta.generatedAtUtc}`);
line(`Read-only          : ${meta.readOnly === true ? "yes" : "NO — INVESTIGATE"}`);
line(
  `Complete           : ${
    meta.complete === true
      ? "yes"
      : `NO — failed: ${(meta.sectionsFailed ?? []).join(", ") || "unknown"}`
  }`,
);

line();
line("INCIDENTS");
line("-".repeat(70));
ifRead("incidents", (s) => {
  line(`  Total rows                     : ${num(s.total)}`);
  const st = s.byStatus ?? {};
  line(`  Open                           : ${num(st.OPEN)}`);
  line(`  Acknowledged                   : ${num(st.ACKNOWLEDGED)}`);
  line(`  Resolved                       : ${num(st.RESOLVED)}`);
  const dw = s.duplicates?.workspaceScoped ?? {};
  const dp = s.duplicates?.platformScoped ?? {};
  line(`  Duplicate groups (workspace)   : ${num(dw.groups)}  excess rows ${num(dw.excess)}`);
  // The platform-scoped excess is the population the convergence targets: rows
  // a standard unique index never deduplicated because NULL is distinct from
  // NULL in Postgres.
  line(`  Duplicate groups (platform)    : ${num(dp.groups)}  excess rows ${num(dp.excess)}`);
  line(`  Workspaces with unresolved     : ${num(s.unresolvedByWorkspace?.workspacesWithUnresolved)}`);
  line(`  Open but unseen for 30 days    : ${num(s.historicalStillOpen?.notSeenIn30Days)}`);
});

line();
line("ATTENTION SIGNALS");
line("-".repeat(70));
ifRead("signals", (s) => {
  line(`  Open incidents                 : ${num(s.openIncidents)}`);
  line(`  Incident-backed signals        : ${num(s.incidentBackedSignals)}${
    s.incidentBackedTruncated ? " (capped at 100 — more exist)" : ""
  }`);
  line(`  Additional signals             : ${num(s.additionalSignals?.total)}`);
  // Stated once, because adding the incident-backed signals to the open
  // incidents double-counts: those signals ARE those incidents.
  line(`  Distinct attention items       : ${num(s.distinctAttentionItems)}`);
  line(`    (open incidents + additional — the incident-backed signals ARE the open incidents)`);
});

line();
line("EVIDENCE HEALTH");
line("-".repeat(70));
ifRead("evidenceHealth", (s) => {
  const c = s.cohorts ?? {};
  line(`  Timestamp failed only          : ${num(c.tsaFailedOnly)}`);
  line(`  Signed without report only     : ${num(c.signedWithoutReportOnly)}`);
  line(`  Both conditions                : ${num(c.both)}`);
  line(`  DISTINCT affected records      : ${num(c.distinctAffectedEvidence)}`);
  line(
    `    (the two raw totals are ${num(c.tsaFailedTotal)} and ` +
      `${num(c.signedWithoutReportTotal)} — they OVERLAP by ${num(c.both)} and must not be added)`,
  );
  const a = s.arithmeticCheck ?? {};
  line(
    `  Arithmetic check               : ${
      a.agrees === true
        ? `agrees (${num(a.expectedUnion)} = ${num(a.measuredUnion)})`
        : `DISAGREES — expected ${num(a.expectedUnion)}, measured ${num(a.measuredUnion)} — treat both as unreliable`
    }`,
  );
  const b = s.ageBuckets ?? {};
  line(
    `  Age of affected records        : <1d ${num(b.under1Day)} · 1-7d ${num(b.oneToSevenDays)} · ` +
      `7-30d ${num(b.sevenToThirtyDays)} · >30d ${num(b.overThirtyDays)}`,
  );
  line(`  OTS anchoring failed           : ${num(s.otsAnchoringFailed)}`);
});

line();
line("RUNTIME");
line("-".repeat(70));
ifRead("runtime", (s) => {
  // Queue DEPTH is a Redis fact and is not in the database. What is here is the
  // durable telemetry the API persists — and "not connected" is reported as
  // itself, never as a healthy zero.
  line(
    `  Worker telemetry rows          : ${
      Array.isArray(s.workerTelemetry)
        ? s.workerTelemetry.length
        : "not connected — queue health is UNMEASURED, not healthy"
    }`,
  );
  line(`  Search documents               : ${num(s.searchDocumentRows)}`);
  line(
    `  Search audit log table         : ${
      s.searchAuditLogTablePresent === null
        ? "could not check"
        : s.searchAuditLogTablePresent
          ? "present"
          : "absent"
    }`,
  );

  // The schema objects the readiness probes look for. The last one is the
  // precondition for incident convergence: until that partial unique index
  // exists, platform-scoped duplicates can still be created while we work.
  const so = s.schemaObjects ?? {};
  const yn = (v) => (v === true ? "present" : v === false ? "ABSENT" : "unknown");
  line(`  Search tsv column / GIN index  : ${yn(so.tsv_column)} / ${yn(so.tsv_gin)}`);
  line(`  Free-text (trigram) index      : ${yn(so.free_text_index)}`);
  line(`  Platform incident unique index : ${yn(so.platform_incident_uk)}`);

  const m = s.migrations;
  line(
    `  Migrations applied             : ${
      m ? `${num(m.applied)} (${num(m.unfinished)} unfinished)` : "could not read"
    }`,
  );
});

line();
line("TRACED ACCOUNT");
line("-".repeat(70));
// Deliberately the thinnest section in this summary. Whether a trace resolved
// is an operational fact; what that person did is not something to print on a
// shared screen. Read it from the raw document, under whatever access rule
// covers looking at one customer's activity.
ifRead("tracedAccount", (s) => {
  if (s.requested === false) {
    line("  Not requested.");
  } else if (s.resolved === false) {
    line(`  Did not resolve (${num(s.matches)} matches). No account was traced.`);
  } else {
    line("  Resolved to exactly one account.");
    line("  Details withheld from this summary — read the raw document if the");
    line("  investigation requires them, under the access rule that covers");
    line("  looking at one customer's activity.");
  }
});

line();
line("=".repeat(70));
line(
  meta.complete === true
    ? "Every section was read. A zero above is a measured zero."
    : "AT LEAST ONE SECTION FAILED. A missing number above is not a zero.",
);
line("This summary omits every identifier, email, domain and per-workspace row.");

process.stdout.write(out.join("\n") + "\n");
process.exit(meta.complete === true ? 0 : 1);
