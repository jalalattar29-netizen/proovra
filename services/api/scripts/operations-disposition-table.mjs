/**
 * GENERATE THE OPERATIONS REMEDIATION DISPOSITION TABLE.
 *
 * Reads the CANONICAL registry and prints one row per incident category. It is
 * a projection of the code, not a document maintained beside it — a
 * hand-written table drifts the first time a category is added, and a drifted
 * table is worse than none because it is read as authoritative.
 *
 * Usage:
 *   node services/api/scripts/operations-disposition-table.mjs [--json]
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..");

/**
 * The registry is TypeScript, so it is read through the same loader the tests
 * use rather than re-implemented here. Re-implementing it would produce a
 * second table that agreed with the first only by luck.
 */
const script = `
import {
  REMEDIATION_DISPOSITIONS,
  actionById,
  entryForIncident,
  registeredCategories,
} from "./src/services/operations/remediation-registry.ts";
import { INCIDENT_CATEGORIES } from "@proovra/shared";

const rows = [];
for (const category of INCIDENT_CATEGORIES) {
  // EVIDENCE_INTEGRITY resolves per fingerprint class, so it contributes two
  // rows — the whole point of the registry is that TSA and OTS get different
  // answers even though they share a category.
  const probes =
    category === "EVIDENCE_INTEGRITY"
      ? [
          ["EVIDENCE_INTEGRITY (tsa_failure)", "tsa_failure:e"],
          ["EVIDENCE_INTEGRITY (ots_failure)", "ots_failure:e"],
        ]
      : [[category, category.toLowerCase() + ":e"]];

  for (const [label, fingerprint] of probes) {
    const entry = entryForIncident({ category, fingerprint });
    rows.push({
      category: label,
      disposition: entry ? entry.disposition : "NO_SAFE_REMEDIATION_AUTHORITY",
      action: entry?.action?.label ?? null,
      actionId: entry?.action?.actionId ?? null,
      permission: entry?.action?.permission ?? null,
      deepLink: entry?.deepLink?.href ?? null,
      deepLinkPermission: entry?.deepLink?.requiredPermission ?? null,
      unsafeReason: entry?.unsafeReason ?? null,
    });
  }
}
console.log(JSON.stringify({ dispositions: REMEDIATION_DISPOSITIONS, registered: registeredCategories(), rows }, null, 2));
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
 * The columns that are PROPERTIES OF THE ACTION rather than of the registry
 * entry, derived from the one authority that owns each.
 *
 * Kept here rather than in the registry because they describe the DOMAIN the
 * action dispatches into — the registry's job is to say which action applies,
 * not to restate the domain's own rules.
 */
const ACTION_FACTS = {
  "ots.resume_anchoring": {
    authority: "enqueueCanonicalWork(JOB_NAMES.UPGRADE_OTS)",
    incidentStates: "OPEN, ACKNOWLEDGED",
    // Read from the executor: ANCHORED/UPGRADED short-circuit to
    // ALREADY_SATISFIED rather than spending work to reach a state the record
    // is already in.
    sourceStates: "otsStatus NOT IN (ANCHORED, UPGRADED); evidence not deleted",
  },
  "report.regenerate_artifacts": {
    authority: "requestReportGeneration()",
    incidentStates: "OPEN, ACKNOWLEDGED",
    sourceStates:
      "evidence not deleted; domain refuses on legal hold / lifecycle / already-terminal",
  },
};

const rows = data.rows.map((r) => {
  const facts = r.actionId ? ACTION_FACTS[r.actionId] : null;
  return {
    ...r,
    authority: facts?.authority ?? "—",
    incidentStates: facts?.incidentStates ?? "—",
    sourceStates: facts?.sourceStates ?? "—",
    // Every action and every deep link is tenant-scoped and requires an
    // ACTIVE workspace: `requireOpsCapability` refuses suspended, inactive
    // and wrong-workspace contexts before the registry is consulted.
    restrictions: "ACTIVE workspace; tenant-scoped; operations.view required",
  };
});

console.log(
  "| Incident category | Subtype/source | Disposition | User-facing action | Domain/queue authority | Required capability | Eligible incident states | Eligible source states | Workspace restrictions | Deep link | Why |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const [category, subtype] = r.category.includes("(")
    ? [r.category.split(" (")[0], r.category.split("(")[1].replace(")", "")]
    : [r.category, "—"];
  const why =
    r.unsafeReason ??
    (r.action
      ? "the domain owns the work; Operations dispatches to it"
      : r.deepLink
        ? "the fix lives in another surface the caller can already open"
        : "no safe action exists from here; the condition clears when its source recovers");
  console.log(
    `| ${category} | ${subtype} | ${r.disposition} | ${r.action ?? "—"} | ${r.authority} | ${r.permission ?? r.deepLinkPermission ?? "—"} | ${r.incidentStates} | ${r.sourceStates} | ${r.restrictions} | ${r.deepLink ?? "—"} | ${why.replace(/\s+/g, " ").slice(0, 150)} |`,
  );
}
