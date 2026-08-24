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

const ELIGIBLE = "OPEN, ACKNOWLEDGED";
console.log(
  "| Incident category | Disposition | Direct action | Queue/domain authority | Safe deep link | Required capability | Eligible states | Workspace restrictions | Why |",
);
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of data.rows) {
  const authority =
    r.actionId === "ots.resume_anchoring"
      ? "enqueueCanonicalWork(UPGRADE_OTS)"
      : r.actionId === "report.regenerate_artifacts"
        ? "requestReportGeneration()"
        : "—";
  console.log(
    `| ${r.category} | ${r.disposition} | ${r.action ?? "—"} | ${authority} | ${r.deepLink ?? "—"} | ${r.permission ?? r.deepLinkPermission ?? "—"} | ${r.action ? ELIGIBLE : "—"} | ACTIVE workspace; tenant-scoped | ${r.unsafeReason ? r.unsafeReason.slice(0, 120) : "see registry"} |`,
  );
}
