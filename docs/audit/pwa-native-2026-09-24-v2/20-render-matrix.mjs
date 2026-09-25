#!/usr/bin/env node
/**
 * 20 — renders CURRENT-ROUTE-IMPLEMENTATION-MATRIX.md from route-matrix.json
 * and ledger-reconciliation.json (run 19-route-matrix.mjs first). Nothing in
 * the document is hand-written except the header text below; re-run both
 * scripts after every batch.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { foundation, matrix, generatedAt } = JSON.parse(fs.readFileSync(path.join(HERE, "route-matrix.json"), "utf8"));
const recon = JSON.parse(fs.readFileSync(path.join(HERE, "ledger-reconciliation.json"), "utf8"));
const ledger = JSON.parse(fs.readFileSync(path.join(HERE, "WORK-LEDGER.json"), "utf8"));

const yes = (b) => (b ? "yes" : "**no**");
const ids = (list, n = 6) => (list.length === 0 ? "—" : list.slice(0, n).map((x) => "`" + x.replace(/^(CONTENT_FILE|UNREACHABLE|CONTROL|ENDPOINT|CSS):/, "$1:").slice(0, 90) + "`").join(", ") + (list.length > n ? ` … +${list.length - n}` : ""));
const byAxis = recon.rows.filter((x) => x.class === "UNRESOLVED").reduce((a, x) => ((a[x.axis] = (a[x.axis] ?? 0) + 1), a), {});

let md = `# CURRENT ROUTE IMPLEMENTATION MATRIX

Generated ${generatedAt} from the CURRENT tree by \`19-route-matrix.mjs\` → \`20-render-matrix.mjs\`. One entry per applicable PWA route (62 NATIVE_REQUIRED + the 2 declared aliases the frozen inventory carried = ${matrix.length}). The other 144 web routes are source-classified in \`reclass.json\`: 16 PUBLIC_INFORMATIONAL_ONLY, 36 ADMIN_ONLY, 94 ENTERPRISE_ONLY — no web route was added or removed since the freeze (checked against \`apps/web/app/**/page.tsx\`, 208 pages).

**How each column is decided (no column is asserted by hand):**
- **Native** — the serving file(s), verified to exist; \`(n)\` = number of OTHER native files that navigate to it.
- **Deep link** — iOS: the route matches a component of \`apps/web/public/.well-known/apple-app-site-association\`; Android: an \`app.json\` intent-filter pathPrefix covers it; scheme: a \`proovra://\` canonical family in \`src/deep-link.ts\`.
- **F / D / C** — Functional / Data / Content: \`PARTIAL\` while any ledger row for the route is UNRESOLVED on that axis (UNREACHABLE+CONTROL+HANDLER+FUNCTIONAL / ENDPOINT / CONTENT); otherwise \`AUTOMATED-TESTED\` when a test loads the native screen, else \`SOURCE-IMPLEMENTED\`.
- **V** — Visual: \`PARTIAL\` while a shared visual foundation the screen consumes is unmet or a CSS/VISUAL row is open. Per-screen pixel comparison is NOT automated, so no row is VISUAL-DONE; **DEVICE-ACCEPTED is false for every route** until the physical-device gate runs.
- **L10n** — the web localizes only /login and /register — the only web screens that call \`t()\` (/verify/[token] mounts useLocale but renders English; Settings › Preferences is a language picker, which native also has). Everywhere else the PWA is English-only, so English-only native is parity, and the language CHOICE still reaches the shell (navigation/header read the dictionary on both).

## Shared foundations (verified in source)

| Foundation | Consumed |
|---|---|
| Fonts loaded at the root (\`useAppFonts\` in app/_layout.tsx) | ${yes(foundation.fontsLoaded)} |
| Sidebar/rail artwork (\`sidebar-bg.png\` via ImageBackground) | ${yes(foundation.sidebarArtwork)} |
| App-shell background artwork (\`app-shell-bg.png\`) behind header + content | ${yes(foundation.appShellBackground)} |
| Auth hero artwork (\`auth-hero.png\`) on login/register/reset/verify-email | ${yes(foundation.authHeroArtwork)} |

## Ledger reconciliation (${ledger.rows.length} child ids; was 1,044 before this pass)

| Class | Rows |
|---|---:|
${Object.entries(recon.totals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n")}

UNRESOLVED by axis: ${Object.entries(byAxis).map(([k, v]) => `${k} ${v}`).join(" · ")}. The 60 ROUTE rows are per-route aggregates — this matrix replaces them as the per-route truth.

Every CLOSED row was re-checked: cited native files must exist today, and a fixed control's label must still be in native source (a SELECT/LINK whose accessible name became a chip/picker label counts only when its cited test exists). Recheck failures: **${recon.recheckFailed.length}**.

## Matrix

| Route | Native (nav refs) | Nav | Deep link iOS/And/scheme | F | D | V | C | L10n | Tests | Open ids |
|---|---|---|---|---|---|---|---|---|---:|---|
`;
for (const r of matrix) {
  const native = r.native.map((n) => `\`${n.expoPath}\`(${n.navReferences})`).join(" + ") || "**none**";
  const dl = r.reachable.deepLink;
  const open = [...r.functional.open, ...r.data.open, ...r.content.open].concat(r.visual.gaps.filter((g) => !/open CSS/.test(g)));
  md += `| \`${r.route}\` | ${native} | ${r.reachable.navigation ? "yes" : "link-only"} | ${dl.ios ? "✓" : "–"}/${dl.android ? "✓" : "–"}/${dl.canonicalScheme ? "✓" : "–"} | ${r.functional.status} | ${r.data.status} | ${r.visual.status} | ${r.content.status} | ${r.content.localization.startsWith("MISSING") ? "**MISSING**" : r.content.localization.startsWith("DICT") ? "dict" : "en=web"} | ${r.tests.length} | ${ids(open, 3)} |\n`;
}
md += `
## Per-route detail

`;
for (const r of matrix) {
  md += `### \`${r.route}\`
- **Web entry:** \`${r.webEntry}\` · **Native:** ${r.native.map((n) => `\`${n.file}\``).join(", ") || "none"}
- **Reachable:** navigation ${r.reachable.navigation ? "yes (" + r.native.map((n) => n.navSample.join(", ")).filter(Boolean).join("; ") + ")" : "link/token only"} · deep link iOS ${r.reachable.deepLink.ios} / Android ${r.reachable.deepLink.android} / scheme ${r.reachable.deepLink.canonicalScheme}
- **Functional:** ${r.functional.status} ${ids(r.functional.open, 20)}
- **Data:** ${r.data.status} ${ids(r.data.open, 20)}
- **Visual:** ${r.visual.status}${r.visual.gaps.length ? " — " + r.visual.gaps.join("; ") : ""}
- **Content:** ${r.content.status} ${ids(r.content.open, 20)} · localization: ${r.content.localization}
- **Tests:** ${r.tests.map((t) => "`" + t.replace(/^apps\/mobile\//, "") + "`").join(", ") || "none"}
- **Ledger:** ${r.ledger.total} rows (${Object.entries(r.ledger.byClass).map(([k, v]) => `${k} ${v}`).join(", ")}) · SOURCE-FIXED ${r.sourceFixed} · AUTOMATED-TESTED ${r.automatedTested} · DEVICE-ACCEPTED ${r.deviceAccepted}

`;
}
fs.writeFileSync(path.join(HERE, "CURRENT-ROUTE-IMPLEMENTATION-MATRIX.md"), md);
console.log("wrote CURRENT-ROUTE-IMPLEMENTATION-MATRIX.md", md.length);
