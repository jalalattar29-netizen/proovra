/**
 * GENERATE THE OPERATIONS SOURCE TABLE.
 *
 * The sibling of `operations-disposition-table.mjs`, answering the other
 * question. That one asks "given a condition that EXISTS, what may an operator
 * do about it?"; this one asks "what does discovery LOOK AT, is that look
 * required for the picture to be complete, and where is it written?".
 *
 * Like its sibling, it READS the canonical registry rather than restating it.
 * A hand-written source table drifts the first time a source is added, and a
 * drifted table is worse than none because it is read as authoritative — which
 * is precisely how "six sources failed" became a sentence nobody could act on.
 *
 * Usage:
 *   node services/api/scripts/operations-source-table.mjs [--json]
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..");

/**
 * Read through the same loader the tests use. Re-implementing the registry
 * here would produce a second table that agreed with the first only by luck.
 */
const script = `
import {
  OPERATIONS_SOURCES,
  requiredSourceIds,
} from "./src/services/operations/operations-source-registry.ts";

const required = new Set(requiredSourceIds());
console.log(JSON.stringify({
  required: [...required],
  rows: OPERATIONS_SOURCES.map((s) => ({
    id: s.id,
    owner: s.owner,
    scopeAuthority: s.scopeAuthority,
    discovery: s.discovery,
    fingerprint: s.fingerprint,
    resolution: s.resolution,
    reopen: s.reopen,
    requiredCapability: s.requiredCapability,
    disposition: s.disposition,
    remediationCategory: s.remediationCategory,
    required: required.has(s.id),
    surfaces: s.surfaces,
  })),
}, null, 2));
`;

const out = execFileSync(
  process.execPath,
  ["--experimental-strip-types", "--input-type=module", "-e", script],
  { cwd: API, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);

const data = JSON.parse(out);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

/**
 * The DOMAIN each source belongs to.
 *
 * Derived from the id's own namespace rather than stored on the registry
 * entry: the namespace is already the domain, and adding a second field
 * carrying the same fact is how the two come to disagree.
 */
function domainOf(id) {
  return id.split(".")[0];
}

/**
 * The threshold at which a source produces a condition.
 *
 * Read from the SCANNER, which is the only thing that can be right about it.
 * A source whose threshold is per-record has no number — one failing record is
 * one condition — and saying so is more honest than inventing a "1".
 */
const THRESHOLDS = {
  "evidence_integrity.tsa_failed": "per record (tsaStatus = FAILED)",
  "evidence_integrity.ots_failed": "per record (otsStatus = FAILED)",
  "evidence_integrity.ots_pending_aged": "per record (OTS pending past window)",
  "pipeline.report_backlog": "HIGH at 20, CRITICAL at 100",
  "pipeline.package_backlog": "HIGH at 20, CRITICAL at 100",
  "pipeline.signed_without_report_aged": "HIGH at 5 aged past 14d",
  "review.stale_workflows": "HIGH at 5 untouched past 72h",
  "coordination.backlog_stale": "HIGH at 10 unresolved past 21d",
  "queue.retry_storm": "any condition at occurrenceCount >= 5",
  "platform.telemetry_stale": "no snapshot within 30m",
  "platform.worker_heartbeat_stale": "no heartbeat within 15m",
};

/** Severity, likewise read from the scanner that assigns it. */
const SEVERITIES = {
  "evidence_integrity.tsa_failed": "derived per record",
  "evidence_integrity.ots_failed": "derived per record",
  "evidence_integrity.ots_pending_aged": "derived per record",
  "pipeline.report_backlog": "HIGH, CRITICAL at 100",
  "pipeline.package_backlog": "HIGH, CRITICAL at 100",
  "pipeline.signed_without_report_aged": "WARNING, HIGH at 15",
  "review.stale_workflows": "WARNING, HIGH at 15",
  "coordination.backlog_stale": "WARNING, HIGH at 30",
  "queue.retry_storm": "WARNING, HIGH at 3",
  "platform.telemetry_stale": "WARNING, HIGH past 2h",
  "platform.worker_heartbeat_stale": "WARNING, HIGH past 1h",
};

/**
 * WHICH WRITER a source's conditions go through.
 *
 * The single most load-bearing column in this table, and the reason it exists.
 * The production failure partitioned exactly here: every source that reaches
 * `recordIncident` failed, and every source that does not reach it succeeded.
 * A table without this column cannot show that.
 */
const SWEEP_EXECUTED = new Set(Object.keys(THRESHOLDS));
function writerOf(row) {
  if (!SWEEP_EXECUTED.has(row.id)) {
    return "own domain, at the moment of failure";
  }
  return row.id.startsWith("evidence_integrity.")
    ? "recordIncident (per record, via syncEvidenceIntegrityConditions)"
    : "recordIncident (threshold rule)";
}

const cell = (v) => String(v ?? "—").replace(/\|/g, "\\|");

console.log(
  "| Source ID | Domain | Eligibility / applicability | Threshold | Grouping key | Severity | Writer path | Resolution condition | Required capability | Remediation disposition |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of data.rows) {
  console.log(
    [
      "",
      cell(r.id),
      cell(domainOf(r.id)),
      cell(
        `${r.required ? "REQUIRED" : "optional"} · ${r.scopeAuthority} · ${r.discovery}`,
      ),
      cell(THRESHOLDS[r.id] ?? "written by its own domain, not swept"),
      cell(r.fingerprint),
      cell(SEVERITIES[r.id] ?? "set by the producing domain"),
      cell(writerOf(r)),
      cell(r.resolution),
      cell(r.requiredCapability),
      cell(`${r.disposition}${r.remediationCategory ? ` → ${r.remediationCategory}` : ""}`),
      "",
    ].join("|"),
  );
}

console.log("");
console.log(
  `sources: ${data.rows.length} · required (freshness-participating): ${data.required.length} · sweep-executed: ${SWEEP_EXECUTED.size}`,
);
