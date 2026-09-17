/**
 * PHASE UI-TRUTH — verifier for the "failed read renders as empty" hazard.
 *
 * The inventory pass flags any catch that writes an empty value into rendered
 * state. That over-reports: a page may write `[]` AND record a typed failure
 * that the surface then renders ("Could not load…"). Only the first kind is a
 * false all-clear.
 *
 * This pass re-reads each flagged catch block and keeps it ONLY when the block
 * records nothing a human could see: no failure state, no notification, no
 * error classification, no rethrow. Everything else is demoted, with the
 * reason, so the count the report prints is one I can defend line by line.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./surfaces.mjs";

const DATA = join(REPO, "audit", "ui-truth", "data");
const elements = JSON.parse(readFileSync(join(DATA, "data-elements.json"), "utf8"));
const placement = JSON.parse(readFileSync(join(DATA, "placement.json"), "utf8"));
/** file -> the surfaces that own it, so a confirmed hazard names a page. */
const ROUTES_BY_FILE = new Map();
for (const row of placement.rows) for (const f of row.ownedFiles) {
  const list = ROUTES_BY_FILE.get(f) ?? [];
  if (!list.includes(row.route)) list.push(row.route);
  ROUTES_BY_FILE.set(f, list);
}

const hazards = (elements.hazards ?? []).filter(
  (h) => h.type === "FAILED_READ_COERCED_TO_ZERO_OR_EMPTY",
);

/** Anything in a catch block that makes the failure visible or propagable. */
const RECORDS_FAILURE = [
  /set[A-Za-z0-9_]*(Error|Failure|Failed|Unavailable|Problem|Denial|Refus)/,
  /classifyReadFailure|toSafeUserError|notifyApiError|reportError|captureException/,
  /setState\(\s*\{[^}]*status:\s*["'](unavailable|error|failed|auth_error|not_found)/,
  /\bthrow\b/,
  /read:\s*\(?err/,
  /console\.(error|warn)/,
];

/** Read the catch block that starts at or just before the flagged line. */
function catchBlockAt(file, line) {
  const text = readFileSync(join(REPO, file), "utf8");
  const lines = text.split(/\r?\n/);
  // Walk back to the nearest `catch` within 12 lines, then take the braces.
  let start = -1;
  for (let i = line - 1; i >= Math.max(0, line - 13); i -= 1) {
    if (/\bcatch\b/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = start; i < Math.min(lines.length, start + 60); i += 1) {
    const line = lines[i];
    out.push(line);
    // Count braces only from the `catch` keyword onward: the same physical
    // line usually closes the preceding `try` ("} catch {"), and counting that
    // closing brace ended the block before it began.
    const from = i === start ? Math.max(0, line.indexOf("catch")) : 0;
    for (const ch of line.slice(from)) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") depth -= 1;
    }
    if (started && depth <= 0) break;
  }
  return { start: start + 1, text: out.join("\n") };
}

const rows = [];
for (const h of hazards) {
  const block = catchBlockAt(h.file, h.line);
  if (!block) {
    rows.push({ ...h, verdict: "UNVERIFIABLE", reason: "no catch block found within 12 lines of the flagged line" });
    continue;
  }
  const recorded = RECORDS_FAILURE.filter((re) => re.test(block.text)).map((re) => String(re));
  rows.push({
    file: h.file,
    line: h.line,
    surfaceRoute: h.surfaceRoute ?? h.route ?? ((ROUTES_BY_FILE.get(h.file) ?? []).join(",") || "SHARED_COMPONENT"),
    catchStartLine: block.start,
    catchSource: block.text.trim().slice(0, 400),
    // A catch that explains itself is a decision, not an oversight; it is
    // still reported, but separately, because the copy may still be wrong.
    verdict: recorded.length > 0
      ? "DEMOTED_RECORDS_FAILURE"
      : /\/\/|\/\*/.test(block.text)
        ? "DOCUMENTED_DELIBERATE_SILENCE"
        : "CONFIRMED_SILENT",
    recordedBy: recorded,
  });
}

rows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
const confirmed = rows.filter((r) => r.verdict === "CONFIRMED_SILENT");
const byRoute = {};
for (const r of confirmed) byRoute[r.surfaceRoute ?? "UNKNOWN"] = (byRoute[r.surfaceRoute ?? "UNKNOWN"] ?? 0) + 1;

const payload = {
  artifact: "ui-truth/empty-on-failure-verification",
  schemaVersion: 1,
  note: "Second pass over the FAILED_READ_COERCED_TO_ZERO_OR_EMPTY hazards: a catch that records nothing visible is confirmed; one that records a typed failure is demoted.",
  totals: {
    flagged: hazards.length,
    confirmedSilent: confirmed.length,
    demoted: rows.filter((r) => r.verdict === "DEMOTED_RECORDS_FAILURE").length,
    documentedDeliberate: rows.filter((r) => r.verdict === "DOCUMENTED_DELIBERATE_SILENCE").length,
    unverifiable: rows.filter((r) => r.verdict === "UNVERIFIABLE").length,
    confirmedByRoute: Object.fromEntries(Object.entries(byRoute).sort((a, b) => b[1] - a[1])),
  },
  rows,
};
writeFileSync(join(DATA, "empty-on-failure-verification.json"), JSON.stringify(payload, null, 2) + "\n");
console.log(JSON.stringify(payload.totals, null, 2));
