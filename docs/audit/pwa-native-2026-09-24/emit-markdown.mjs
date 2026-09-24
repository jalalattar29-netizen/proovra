import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUTDIR = resolve("D:/digital-witness/docs/audit/pwa-native-2026-09-24");
const M = JSON.parse(readFileSync(join(OUTDIR, "route-matrix.json"), "utf8"));
const I = JSON.parse(readFileSync(join(OUTDIR, "interaction-register.json"), "utf8"));
const G = JSON.parse(readFileSync(join(OUTDIR, "endpoint-gap-register.json"), "utf8"));
const SHA = M.auditedSha;
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/* ------------------------------------------------------------------ (B) */

const applicable = M.rows.filter((r) => r.auditDisposition === "APPLICABLE");
const excluded = M.rows.filter((r) => r.auditDisposition === "EXCLUDED");

let b = `# B — COMPLETE ROUTE MATRIX (all 208 routes)

**Audited SHA:** \`${SHA}\`
**Machine source:** \`route-matrix.json\` in this directory (emitted by \`emit-artifacts.mjs\`).

Every route discovered under \`apps/web/app\` appears exactly once, including the
144 excluded ones with their rationale. Dispositions are re-derived from
\`apps/web/lib/navigation/routeRegistry.ts\`, not inherited.

| | Count |
|---|---:|
| Discovered | ${M.counts.webRoutesDiscovered} |
| APPLICABLE | **${M.counts.applicable}** |
| EXCLUDED — PLATFORM_ADMIN | ${M.counts.excludedAdmin} |
| EXCLUDED — Enterprise/org console | ${M.counts.excludedEnterprise} |
| EXCLUDED — marketing funnel | ${M.counts.excludedMarketing} |
| Re-classified into scope by this audit | ${M.counts.reclassifiedIntoScope} |

Columns: **WebEP** = endpoints the page's own import closure calls (shell-level calls
excluded — see \`inverse-coverage.mjs\`); **Nat** = of those, called by the native
screen; **Gap** = called by web, never called anywhere in native; **Ctl** = interactive
controls on the native screen; **Tests** = mobile test files referencing it
(**R** = includes a render test).

## B.1 APPLICABLE (${applicable.length})

| Route | Native screen | Ledger | Phys | WebEP | Nat | Gap | Ctl | Tests |
|---|---|---|---:|---:|---:|---:|---:|---|
`;
for (const r of applicable.sort((a, b2) => a.routePath.localeCompare(b2.routePath))) {
  const tests = r.testFiles.length === 0 ? "**0**" : `${r.testFiles.length}${r.renderTests.length ? " R" : ""}`;
  b += `| \`${esc(r.routePath)}\`${r.reclassifiedRationale ? " ⚠️" : ""} | ${r.nativeFile ? "`" + esc(r.nativeFile.replace("apps/mobile/app/", "")) + "`" : "**NONE**"} | ${esc(r.ledgerStatus)} | ${r.physicallyAccepted === null ? "—" : r.physicallyAccepted ? "yes" : "**no**"} | ${r.webEndpointsPageScoped ?? "—"} | ${r.nativeEndpointsPresent ?? "—"} | ${r.endpointsMissingEntirely ?? "—"} | ${r.nativeControls ?? "—"} | ${tests} |\n`;
}

b += `\n⚠️ = re-classified into scope by this audit.\n\n### Re-classification rationale\n\n`;
for (const r of applicable.filter((x) => x.reclassifiedRationale)) {
  b += `**\`${r.routePath}\`** (${r.routeId}, domain ${r.domain}, requiredActiveSpace ${r.requiredActiveSpace})\n\n> ${r.reclassifiedRationale}\n\n`;
}

b += `## B.2 EXCLUDED (${excluded.length})\n\n| Route | routeId | Class | Rationale |\n|---|---|---|---|\n`;
for (const r of excluded.sort((a, b2) => a.manifestClassification.localeCompare(b2.manifestClassification) || a.routePath.localeCompare(b2.routePath))) {
  b += `| \`${esc(r.routePath)}\` | ${esc(r.routeId ?? "—")} | ${r.manifestClassification} | ${esc(r.exclusionRationale).slice(0, 190)} |\n`;
}
writeFileSync(join(OUTDIR, "B-route-matrix.md"), b);

/* ------------------------------------------------------------------ (D) */

const byRoute = new Map();
for (const c of I.controls) {
  if (!byRoute.has(c.routePath)) byRoute.set(c.routePath, []);
  byRoute.get(c.routePath).push(c);
}
const kindTally = {};
for (const c of I.controls) kindTally[c.wiredTo] = (kindTally[c.wiredTo] || 0) + 1;

let d = `# D — COMPLETE INTERACTION REGISTER

**Audited SHA:** \`${SHA}\`
**Machine source:** \`interaction-register.json\` (${I.count} controls).

Every interactive control on every applicable native screen, with what its handler is
**wired to** — resolved by following named handlers up to 3 levels inside the file.

**No control is marked passing because an \`onPress\` exists.** A handler whose effect
cannot be reached in-file is \`UNVERIFIED\`, not a pass. And no verdict here is a
runtime claim: this is source evidence that a handler is bound and what it calls. That
a tap reaches the server on a real device is **UNVERIFIED for all ${I.count} controls**
(0 simulator runs, 0 device runs).

| Wired to | Controls |
|---|---:|
${Object.entries(kindTally).sort((a, b2) => b2[1] - a[1]).map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n")}

| Verdict | Controls |
|---|---:|
| WIRED_SOURCE_INFERRED | ${M.counts.nativeControlsWired} |
| UNVERIFIED (handler leaves the file) | ${M.counts.nativeControlsUnresolved} |

`;
for (const [route, cs] of [...byRoute].sort((a, b2) => b2[1].length - a[1].length)) {
  d += `\n## \`${route}\` — ${cs.length} controls\n\n\`${cs[0].nativeFile}\`\n\n| Line | Prop | Wired to | Handler | Verdict |\n|---:|---|---|---|---|\n`;
  for (const c of cs.sort((a, b2) => a.line - b2.line)) {
    d += `| ${c.line} | \`${c.prop}\` | \`${c.wiredTo}\` | \`${esc(c.handler).slice(0, 90)}\` | ${c.verdict === "UNVERIFIED" ? "**UNVERIFIED**" : "wired"} |\n`;
  }
}
writeFileSync(join(OUTDIR, "D-interaction-register.md"), d);

/* ------------------------------------------------------------------ (G) */

let g = `# G — TEST COVERAGE MATRIX

**Audited SHA:** \`${SHA}\`

## G.1 What was actually executed

| Suite | Command | Result | When |
|---|---|---|---|
| \`apps/mobile\` unit + render | \`node --test\` | **942 pass / 0 fail / 0 skipped** (15.1 s) | this audit, after \`pnpm run build:deps\` |

\`build:deps\` is required first: \`@proovra/shared\` resolves through a gitignored
\`dist/\`, and a stale one fails the suite with
\`No matching export … for import "userFacingErrorFor"\`.

## G.2 Proof tiers — what each tier can and cannot establish

| Tier | Files | Establishes | Does NOT establish |
|---|---:|---|---|
| Pure logic / projection | ${M.counts.mobileTestFiles - M.counts.mobileRenderTestFiles} | parsers, path builders, state machines, gating math | that anything renders |
| Render (\`*.render.test.mjs\`) | ${M.counts.mobileRenderTestFiles} | a component tree mounts and shows expected text | native layout, fonts, safe areas, gestures |
| Authenticated integration | **0** | — | — |
| E2E against a running API | **0** | — | — |
| Simulator | **0** | — | — |
| Physical device | **0** | — | — |

\`capture-lifecycle-e2e.test.mjs\` is named e2e but runs in-process under \`node --test\`
with no server; it is counted above as logic, not as E2E.

## G.3 Per-route coverage

${M.counts.routesWithZeroTests} of ${M.counts.applicable} applicable routes have **no** referencing test file.
${M.counts.routesWithRenderTest} have a render test.

| Route | Test files | Render? |
|---|---|---|
`;
for (const r of applicable.sort((a, b2) => a.testFiles.length - b2.testFiles.length || a.routePath.localeCompare(b2.routePath))) {
  g += `| \`${esc(r.routePath)}\` | ${r.testFiles.length === 0 ? "**none**" : r.testFiles.map((t) => "`" + t + "`").join(", ")} | ${r.renderTests.length ? "yes" : "no"} |\n`;
}
writeFileSync(join(OUTDIR, "G-test-coverage-matrix.md"), g);

console.log("B:", applicable.length, "+", excluded.length);
console.log("D:", I.count, "controls across", byRoute.size, "routes");
console.log("G: zero-test routes", M.counts.routesWithZeroTests);
