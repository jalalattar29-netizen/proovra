/**
 * G0 — extract the ACTUAL bodies of the callables behind the 28 previously
 * unresolved handler bindings, and their terminal effects + endpoints.
 *
 * The bindings destructure from `EvidenceDetailCtx` (an object literal built in
 * `evidence/[id]/page.tsx` and passed to every `_tabs/*` component) and from
 * `_hooks/useEvidenceArtifactActions.ts`. Neither is a runtime unknown.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ROOT = "D:/digital-witness";
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;

const RULES = [
  [/\bapiFetch\s*\(|\bfetch\s*\(/, "API"],
  [/notifyApiError|toSafeUserError|setError|setBanner|setNotice/, "FEEDBACK"],
  [/router\.(push|replace)|window\.open|window\.location/, "NAV"],
  [/createObjectURL|revokeObjectURL|\.download\b|new Blob/, "DOWNLOAD"],
  [/\bset[A-Z][A-Za-z]*\s*\(/, "STATE"],
  [/navigator\.clipboard|writeText/, "CLIPBOARD"],
  [/confirm\(|setConfirm|setDialog|setOpen/, "DIALOG"],
];

/** Read a declaration's full body by brace balancing. */
function body(file, name) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split("\n");
  const re = new RegExp(`(?:const|function|let)\\s+${name}\\b`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return null;
  let depth = 0, started = false;
  const out = [];
  for (let k = i; k < Math.min(lines.length, i + 160); k++) {
    out.push(lines[k]);
    for (const c of lines[k]) {
      if (c === "{") { depth++; started = true; }
      else if (c === "}") depth--;
    }
    if (started && depth <= 0) break;
  }
  return { line: i + 1, text: out.join("\n") };
}

const PAGE = `${ROOT}/apps/web/app/(app)/evidence/[id]/page.tsx`;
const HOOK = `${ROOT}/apps/web/app/(app)/evidence/[id]/_hooks/useEvidenceArtifactActions.ts`;
const MW = `${ROOT}/apps/web/components/cases-experience/MatterWorkspace.tsx`;
const INC = `${ROOT}/apps/web/app/(app)/operations/_components/IncidentSurface.tsx`;

const targets = [
  ["loadWorkflowEvents", PAGE], ["loadWorkspace", PAGE], ["openOriginal", PAGE],
  ["downloadOriginal", PAGE], ["restoreTrash", PAGE], ["removeCase", PAGE],
  ["handleRemoveRelationship", PAGE],
  ["downloadReport", HOOK], ["downloadVerificationPackage", HOOK],
];

const res = [];
for (const [name, file] of targets) {
  const b = body(file, name);
  if (!b) { console.log(`${name.padEnd(30)} NOT FOUND in ${file.split("/").pop()}`); continue; }
  const effects = [...new Set(RULES.filter(([re]) => re.test(b.text)).map(([, k]) => k))];
  const endpoints = [...new Set([...b.text.matchAll(/["'`](\/v1\/[^"'`]*)/g)].map((m) => m[1]))];
  res.push({ name, file: file.replace(`${ROOT}/`, ""), line: b.line, effects, endpoints, bodyLines: b.text.split("\n").length });
  console.log(`${name.padEnd(30)} ${file.split("/").pop()}:${String(b.line).padEnd(5)} [${effects.join(",")}]  ${endpoints.slice(0, 2).join("  ")}`);
}

/* the object-member bindings: links.onUnlink / handlers.onToggleMark / handlers.onOpen */
console.log("\n--- object-member bindings ---");
for (const [obj, member, file] of [["links", "onUnlink", MW], ["handlers", "onToggleMark", INC], ["handlers", "onOpen", INC]]) {
  const src = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = src.split("\n");
  const decl = lines.findIndex((l) => new RegExp(`${member}\\s*[:(]`).test(l));
  const effects = decl >= 0
    ? [...new Set(RULES.filter(([re]) => re.test(lines.slice(decl, decl + 40).join("\n"))).map(([, k]) => k))]
    : [];
  console.log(`  ${obj}.${member.padEnd(16)} ${file.split("/").pop()}:${decl >= 0 ? decl + 1 : "?"}  [${effects.join(",")}]`);
  res.push({ name: `${obj}.${member}`, file: file.replace(`${ROOT}/`, ""), line: decl + 1, effects, endpoints: [], memberBinding: true });
}

writeFileSync(`${OUT}/q5-hook-bodies.json`, JSON.stringify({
  frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5", resolved: res,
}, null, 1));
console.log(`\nresolved ${res.length} callables → q5-hook-bodies.json`);
