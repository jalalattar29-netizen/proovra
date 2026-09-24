/**
 * O — GLOBAL FINDINGS REGISTER  (AUDIT INSTRUMENT — read-only)
 *
 * Collapses the 64 per-page registers into root causes, links each to every
 * affected page, and keeps the individual discrepancies visible underneath.
 *
 * CLASSIFICATION IS HAND-MADE AND IS SAID TO BE. The grouping and the blast
 * radius are machine-derived; the verdict on each group was reached by reading
 * both implementations, and each carries the evidence that settled it. A group
 * this table does not name is reported UNCLASSIFIED rather than assumed to be
 * a defect — the register is not allowed to inflate itself.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCssIndex, nativeTokens } from "./M-style-resolver.mjs";

const HERE = resolve(import.meta.dirname, ".");
const idx = JSON.parse(readFileSync(join(HERE, "page-comparison-index.json"), "utf8"));
const matrix = JSON.parse(readFileSync(join(HERE, "route-matrix.json"), "utf8"));

/**
 * Verdicts reached by reading BOTH sides. `evidence` is what settled it.
 * Key is a substring of the owning web file.
 */
const VERDICTS = [
  ["components/marketing/", {
    verdict: "INTENTIONAL_PLATFORM_ADAPTATION",
    title: "Marketing site chrome (header, footer, language switcher)",
    evidence: "apps/web/middleware.ts splits the estate across an app host and a marketing host. These components render the marketing host's navigation. An installed app has no marketing site to navigate, and `docs/uc-disposition.md` records the same disposition. Native correctly renders none of them.",
  }],
  ["feedback/ProovraSupportReference", {
    verdict: "REAL_GAP",
    title: "Support reference code cannot be copied natively",
    evidence: "Web renders a Copy button beside the support reference on every error and support surface. `grep -rn \"Clipboard|copyToClipboard|Copy\\b\" apps/mobile/src/ui apps/mobile/app/(stack)/support.tsx` returns NOTHING — native has no clipboard affordance at all. A user reading a support code off a phone screen must transcribe it by hand.",
  }],
  ["app-primitives/AppListbox", {
    verdict: "REAL_GAP",
    title: "No native equivalent of the accessible listbox primitive",
    evidence: "AppListbox is 'the single accessible custom listbox for every internal surface… Replaces native <select> everywhere in the authenticated product' (its own header). Native `src/ui/index.tsx` exports no Picker, Listbox, Dropdown or Select primitive. Any web surface offering a choice from a list has no native counterpart control.",
  }],
  ["feedback/ProovraToast", {
    verdict: "FALSE_POSITIVE_ACCESSIBILITY_FINDING",
    title: "Toast dismiss exists natively but is unlabelled",
    evidence: "Reported missing only because the labels differ. Native DOES implement dismiss: `src/toast-context.tsx:115-120` renders a TouchableOpacity with `onPress={() => onDismiss(toast.id)}`. Its visible content is the glyph `×` and it carries NO accessibilityLabel, where web uses aria-label 'Dismiss notification'. Not a missing control — an unlabelled one, which a screen reader announces as 'times'.",
  }],
  ["navigation/PageRouteGate", {
    verdict: "PARTIAL",
    title: "Route-level denial/unavailable state",
    evidence: "Web wraps pages in PageRouteGate, which renders 'This page is not available' and a headline for denial. Native has error/denial handling at the DATA layer (`src/errors/safe-error.ts` models 403 'forbidden'; `discussion-section.tsx:71` branches to a denied phase) but no route-level gate component. Whether every native screen refuses a disallowed route is SOURCE-UNRESOLVED per screen and is listed per page.",
  }],
  ["components/ui/Button.tsx", {
    verdict: "FALSE_POSITIVE_GENERIC_SLOT",
    title: "Generic primitive children slots",
    evidence: "The label read was the Button primitive's own children expression `{loading ? <Spinner/> : leadingIcon}`, not a product control. Filtered at source in N-page-compare.mjs (`labelVariants`, exprOnly) — retained here so the correction is visible rather than silently dropped.",
  }],
  ["components/ui-legacy.tsx", {
    verdict: "FALSE_POSITIVE_GENERIC_SLOT",
    title: "Legacy primitive internal slots",
    evidence: "Same class as ui/Button — an internal error slot expression, not a distinct control.",
  }],
  ["security-center/components/PersonalSecuritySections", {
    verdict: "PLACEMENT_DIFFERENCE",
    title: "Change-password form sits on a different native screen",
    evidence: "All 34 items (heading, Current/New/Confirm password inputs, 'sign out my other sessions', Change password, Verify & continue, Cancel) are implemented natively at `apps/mobile/app/(stack)/settings/security.tsx:218-273`. The web renders them INSIDE /settings; native gives them their own sub-screen. Per-route pairing could not see across screens — this is why the global native-presence pass exists. Not a gap; a navigation difference (see H-N4).",
  }],
  ["app/login/page.tsx", {
    verdict: "REAL_GAP",
    title: "Legal documents are unreachable from the native sign-in screen",
    evidence: "Web `/login` renders three tappable links — Terms of Service, Privacy Policy, Cookie Policy. Native `app/(stack)/auth.tsx:135-139` renders ONE non-interactive `<ProovraText variant=\"label\" color={theme.color.ink.muted} center>` reading 'By continuing you agree to the Terms and acknowledge the Privacy Policy.' There is no Pressable, no onPress and no Link, so neither document can be opened at the point of consent, and Cookie Policy is not mentioned at all. The same line is painted in `ink.muted` = #94A3B8, which is 2.42:1 on `surface.app` #F7F8FC — below WCAG AA for any text size.",
  }],
  ["components/legal/LegalDocumentShell", {
    verdict: "REAL_GAP",
    title: "No table of contents in the native legal reader",
    evidence: "Web renders an 'On this page' control and an 'Open public Trust Center' link in the legal shell, across 6 legal routes. `apps/mobile/src/ui/legal-document.tsx` contains no section index, anchor or scrollTo — grep for section/heading/anchor/scrollTo returns nothing. A multi-thousand-word policy is a single unindexed scroll on a phone.",
  }],
  ["app/(app)/inbox/page.tsx", {
    verdict: "PLACEMENT_OR_COPY_DIFFERENCE",
    title: "Inbox filtering exists natively under different labels",
    evidence: "Reported missing (Filters, Archived, Clear filters, Refresh, Done) but native implements filtering: `app/(tabs)/notifications.tsx` imports `filterInboxItems` and `INBOX_FILTERS` and renders `ProovraFilterChips` with `const [filter, setFilter] = useState(\"all\")`. The control set is a chip row rather than a filter sheet, so the individual labels differ. A copy/affordance difference, not an absent capability.",
  }],
  ["app/trust/page.tsx", {
    verdict: "INTENTIONAL_PLATFORM_ADAPTATION",
    title: "Enterprise sales calls-to-action on the public trust page",
    evidence: "'Contact sales', 'Start enterprise review', 'Review documentation' are acquisition CTAs on the marketing-host trust page. Same disposition as the marketing chrome group: an installed app carries no in-app sales funnel.",
  }],
  ["components/operational/OperationalEmptyState", {
    verdict: "SUBSUMED_BY_MISSING_SCREEN",
    title: "Operations empty-state copy",
    evidence: "All eight strings belong to /operations and /operations/health, which have NO native screen at all. They are already counted by that finding and are not a separate defect.",
  }],
];

function verdictFor(file) {
  for (const [needle, v] of VERDICTS) if (file.includes(needle)) return v;
  return null;
}

/* ------------------------------------- global native presence index */

/**
 * WHY A SECOND PASS EXISTS. Per-route pairing asks "does THIS native screen
 * have it". That mislabels a capability the two platforms simply place
 * differently: the web renders Change password inside `/settings`
 * (`security-center/components/PersonalSecuritySections.tsx`), while native
 * puts it on its own screen, `app/(stack)/settings/security.tsx:218-273`. The
 * per-route pass reported the whole form — heading, three inputs, two buttons —
 * as MISSING, when every part of it exists.
 *
 * So every label that survived per-route pairing is checked against the WHOLE
 * native element corpus. A hit is not a gap; it is a placement difference, and
 * it is reported as one.
 */
const { buildTree, flatten } = await import("./L-source-tree.mjs");
const REPO_ROOT = resolve(process.env.PROOVRA_AUDIT_REPO ?? resolve(HERE, "..", "..", ".."));

const nativeLabelIndex = new Map(); // normalised label -> [ "file:line" ]
{
  const seenFiles = new Set();
  const nativeEntries = [...new Set(matrix.rows.filter((r) => r.nativeFile).map((r) => r.nativeFile))];
  for (const entry of nativeEntries) {
    try {
      const t = buildTree(join(REPO_ROOT, entry), 8);
      for (const el of flatten(t)) {
        if (seenFiles.has(`${el.file}:${el.line}`)) continue;
        seenFiles.add(`${el.file}:${el.line}`);
        const a = el.otherAttrs ?? {};
        const raw = String(el.text || a.label || a.title || a.placeholder || a.accessibilityLabel || "").trim();
        if (!raw) continue;
        const keys = new Set();
        if (!/^\{/.test(raw) && !/<\w/.test(raw)) {
          const n = raw.toLowerCase().replace(/\{[^}]*\}/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
          if (n) keys.add(n);
        }
        for (const m of raw.matchAll(/["'`]([^"'`]{2,60})["'`]/g)) {
          const n = m[1].toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
          if (n) keys.add(n);
        }
        for (const k of keys) {
          if (!nativeLabelIndex.has(k)) nativeLabelIndex.set(k, []);
          nativeLabelIndex.get(k).push(`${el.file}:${el.line}`);
        }
      }
    } catch { /* a screen that fails to parse is reported by N, not silently here */ }
  }
}

const normKey = (s) => s.toLowerCase().replace(/\{[^}]*\}/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Is this label present ANYWHERE in native? Exact, then containment. */
function elsewhereInNative(label) {
  const k = normKey(label);
  if (!k) return null;
  if (nativeLabelIndex.has(k)) return { where: nativeLabelIndex.get(k).slice(0, 3), match: "exact" };
  const want = new Set(k.split(" ").filter((w) => w.length > 2));
  if (want.size === 0) return null;
  for (const [nk, sites] of nativeLabelIndex) {
    const have = new Set(nk.split(" ").filter((w) => w.length > 2));
    if (have.size === 0) continue;
    let shared = 0;
    for (const w of want) if (have.has(w)) shared++;
    if (shared / Math.min(want.size, have.size) >= 0.75) return { where: sites.slice(0, 3), match: "similar", nativeLabel: nk };
  }
  return null;
}

/* ------------------------------------------------------------- aggregate */

const distinct = new Map();
for (const r of idx.routes) {
  for (const m of r.missing ?? []) {
    const key = `${m.web}|${m.webLabel}`;
    if (!distinct.has(key)) distinct.set(key, { ...m, routes: new Set(), file: m.web.split(":")[0] });
    distinct.get(key).routes.add(r.routePath);
  }
}

// classify each distinct missing item against the whole native corpus
let elsewhereCount = 0;
for (const d of distinct.values()) {
  const hit = elsewhereInNative(d.webLabel);
  if (hit) { d.elsewhere = hit; elsewhereCount++; }
}

const groups = new Map();
for (const d of distinct.values()) {
  if (!groups.has(d.file)) groups.set(d.file, { file: d.file, items: [], routes: new Set() });
  const g = groups.get(d.file);
  g.items.push(d);
  for (const rt of d.routes) g.routes.add(rt);
}
const ordered = [...groups.values()].sort((a, b) => b.routes.size - a.routes.size || b.items.length - a.items.length);

/* --------------------------------------------------------- style corpus */

const css = buildCssIndex();
const tok = await nativeTokens();
const natVals = new Set([...tok.flat.values()].map((v) => String(v).toLowerCase().replace(/\s+/g, "")));
const tokenHex = new Set();
for (const v of css.vars.values()) for (const m of String(v).matchAll(/#[0-9a-fA-F]{3,8}\b/g)) tokenHex.add(m[0].toLowerCase());

let hardOcc = 0;
const hardDistinct = new Set();
const hardByFile = new Map();
const allHex = new Set();
for (const rules of css.byClass.values()) {
  for (const r of rules) {
    for (const [p, v] of Object.entries(r.decls)) {
      if (!/color|background|border|shadow|fill|stroke/.test(p)) continue;
      const raw = String(v);
      const hasVar = /var\(/.test(raw);
      for (const m of raw.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        allHex.add(m[0].toLowerCase());
        if (!hasVar) {
          hardOcc++;
          hardDistinct.add(m[0].toLowerCase());
          hardByFile.set(r.file, (hardByFile.get(r.file) || 0) + 1);
        }
      }
    }
  }
}

/* ------------------------------------------------------------- counts */

const T = (f) => idx.routes.reduce((a, r) => a + (r.counts?.[f] ?? 0), 0);
const counts = {
  auditedSha: idx.auditedSha,
  applicableRoutes: idx.routes.length,
  routesCompared: idx.routes.filter((r) => r.status === "COMPARED").length,
  routesNoNativeScreen: idx.routes.filter((r) => r.status === "NO_NATIVE_SCREEN").length,
  routesErrored: idx.routes.filter((r) => r.status === "ERROR").length,
  webFilesInspected: new Set(idx.routes.flatMap((r) => r.webFilesList ?? [])).size,
  nativeFilesInspected: new Set(idx.routes.flatMap((r) => r.natFilesList ?? [])).size,
  webElements: T("webElements"),
  nativeElements: T("nativeElements"),
  pairableWebElements: T("pairable"),
  pairedExact: T("paired"),
  pairedCopyDiffers: T("pairedCopyDiffers"),
  pairedRoleDiffers: T("pairedRoleDiffers"),
  missingOccurrences: T("missingInNative"),
  missingDistinct: distinct.size,
  missingButPresentElsewhereInNative: elsewhereCount,
  missingNowhereInNative: distinct.size - elsewhereCount,
  extraInNative: T("extraInNative"),
  unlabelled: T("unlabelled"),
  sourceUnresolvedLabels: T("sourceUnresolvedLabels"),
  webStylePropsResolved: T("webStylePropsResolved"),
  webStyleUnresolved: T("webStyleUnresolved"),
  nativeStylePropsResolved: T("nativeStyleProps"),
  webInteractiveElements: T("webHandlers"),
  nativeInteractiveElements: T("nativeHandlers"),
  webConditionalBranches: T("webGuardedElements"),
  nativeConditionalBranches: T("nativeGuardedElements"),
  cssFilesIndexed: css.files.length,
  cssClassesIndexed: css.byClass.size,
  cssCustomProperties: css.vars.size,
  nativeTokenValues: tok.flat.size,
  distinctHexInWebCss: allHex.size,
  hexAlsoInNativeTokens: [...allHex].filter((h) => natVals.has(h)).length,
  hardcodedHexOccurrences: hardOcc,
  hardcodedHexDistinct: hardDistinct.size,
  hardcodedHexAlsoNative: [...hardDistinct].filter((h) => natVals.has(h)).length,
  screenshots: 0, simulatorRuns: 0, deviceRuns: 0,
};

writeFileSync(join(HERE, "global-findings.json"), JSON.stringify({
  counts,
  groups: ordered.map((g) => ({
    file: g.file, routes: [...g.routes].sort(), routeCount: g.routes.size,
    itemCount: g.items.length,
    verdict: verdictFor(g.file)?.verdict ?? "UNCLASSIFIED",
    items: g.items.map((i) => ({ role: i.role, label: i.webLabel, at: i.web, routes: [...i.routes], elsewhere: i.elsewhere ?? null })),
  })),
  style: {
    hardcodedByFile: [...hardByFile].sort((a, b) => b[1] - a[1]),
    hardDistinct: [...hardDistinct].sort(),
  },
}, null, 1));

/* ------------------------------------------------------------- markdown */

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const slug = (r) => r.replace(/^\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";

const classified = ordered.filter((g) => verdictFor(g.file));
const unclassified = ordered.filter((g) => !verdictFor(g.file));

let md = `# P — GLOBAL FINDINGS REGISTER (source comparison)

**Audited SHA:** \`${counts.auditedSha}\`
**Method:** static source comparison only. No rendering, no screenshots, no devices.

Each finding links to every page it affects. Shared root causes are grouped; the
individual discrepancies stay visible underneath the group.

## P.1 Headline counts

| | |
|---|---:|
| Applicable routes | ${counts.applicableRoutes} |
| Routes source-compared | ${counts.routesCompared} |
| Routes with no native screen | ${counts.routesNoNativeScreen} |
| Distinct PWA files read (rendered trees) | **${counts.webFilesInspected}** |
| Distinct Native files read (rendered trees) | **${counts.nativeFilesInspected}** |
| PWA elements identified | **${counts.webElements}** |
| Native elements identified | **${counts.nativeElements}** |
| PWA elements in a pairable role | ${counts.pairableWebElements} |
| — paired exactly | ${counts.pairedExact} |
| — paired, copy differs | ${counts.pairedCopyDiffers} |
| — paired, role differs (possible wrong control) | ${counts.pairedRoleDiffers} |
| — unpaired on its own route (distinct) | ${counts.missingDistinct} |
| —— of those, PRESENT on another native screen (placement difference) | ${counts.missingButPresentElsewhereInNative} |
| —— of those, **found NOWHERE in native** | **${counts.missingNowhereInNative}** |
| — unpaired (per-route occurrences) | ${counts.missingOccurrences} |
| Extra in Native | ${counts.extraInNative} |
| Unlabelled (not pairable by label) | ${counts.unlabelled} |
| **SOURCE-UNRESOLVED labels** | **${counts.sourceUnresolvedLabels}** |
| PWA style properties resolved to literals | **${counts.webStylePropsResolved}** |
| PWA style items SOURCE-UNRESOLVED | ${counts.webStyleUnresolved} |
| Native style properties resolved | ${counts.nativeStylePropsResolved} |
| PWA interactive elements | ${counts.webInteractiveElements} |
| Native interactive elements | ${counts.nativeInteractiveElements} |
| PWA conditional branches | ${counts.webConditionalBranches} |
| Native conditional branches | ${counts.nativeConditionalBranches} |
| **Screenshots / simulator / device runs** | **0 / 0 / 0** |

## P.2 THE STYLE FINDING — a shared token file is not shared styling

This is the answer to "do not report a shared token as proof of parity", and it is
measured, not asserted.

| | Count |
|---|---:|
| CSS files indexed | ${counts.cssFilesIndexed} |
| CSS classes indexed | ${counts.cssClassesIndexed} |
| CSS custom properties | ${counts.cssCustomProperties} |
| Values in the shared native token set (\`packages/ui/src/tokens/proovra.generated.ts\`) | ${counts.nativeTokenValues} |
| Distinct hex colours declared anywhere in web CSS | **${counts.distinctHexInWebCss}** |
| …that exist in the native token set | **${counts.hexAlsoInNativeTokens}** |
| **Hex literals written DIRECTLY in component CSS, bypassing tokens** | **${counts.hardcodedHexOccurrences} occurrences, ${counts.hardcodedHexDistinct} distinct** |
| …that exist in the native token set | **${counts.hardcodedHexAlsoNative}** |

Both platforms do import the same generated token module, and that fact proves
nothing: the web paints most of its surfaces from **${counts.hardcodedHexDistinct} colours hardcoded in
stylesheets**, of which only **${counts.hardcodedHexAlsoNative}** have any native counterpart. Native has no
access to the other ${counts.hardcodedHexDistinct - counts.hardcodedHexAlsoNative} because they exist only as literals inside \`apps/web\`.

### Where the hardcoding is concentrated

| Hex literals | File |
|---:|---|
${[...hardByFile].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([f, n]) => `| ${n} | \`${f}\` |`).join("\n")}

\`capture-v2.css\` alone declares ${hardByFile.get("apps/web/components/capture-v2/capture-v2.css") ?? 0} colour literals, and \`/capture\` is a
NATIVE_REQUIRED route whose native screen paints from the ${counts.nativeTokenValues}-value token set.

**SOURCE-UNRESOLVED:** which of these declarations actually reaches a pixel depends on
cascade order and runtime class application. This audit resolves what is DECLARED and
does not claim which declaration wins.

## P.3 Root-cause groups — classified

${classified.map((g) => {
  const v = verdictFor(g.file);
  return `### ${v.title}

- **Verdict:** \`${v.verdict}\`
- **Owning PWA component:** \`${g.file}\`
- **Blast radius:** ${g.routes.size} of ${counts.applicableRoutes} applicable routes, ${g.items.length} distinct element(s)
- **Evidence:** ${v.evidence}

Affected routes: ${[...g.routes].sort().map((r) => `[\`${r}\`](pages/${slug(r)}.md)`).join(", ")}

| Role | Label | PWA source | In native? |
|---|---|---|---|
${g.items.slice(0, 12).map((i) => `| ${i.role} | ${esc(i.label)} | \`${i.at}\` |`).join("\n")}
`;
}).join("\n")}

## P.4 Root-cause groups — UNCLASSIFIED (${unclassified.length})

These were grouped mechanically and **have not been individually adjudicated**. They
are listed so nothing is hidden, and they are **not** claimed as defects.

| Routes | Items | Owning PWA component |
|---:|---:|---|
${unclassified.slice(0, 60).map((g) => `| ${g.routes.size} | ${g.items.length} | \`${g.file}\` |`).join("\n")}
${unclassified.length > 60 ? `\n_…${unclassified.length - 60} further groups in \`global-findings.json\`._` : ""}

## P.5 Per-page registers

${idx.routes.map((r) => `- [\`${r.routePath}\`](pages/${slug(r.routePath)}.md) — ${r.status === "NO_NATIVE_SCREEN" ? "**no native screen**" : `web ${r.counts.webElements}el/${r.counts.webFiles}f · native ${r.counts.nativeElements}el/${r.counts.nativeFiles}f · ${r.counts.missingInNative} missing`}`).join("\n")}
`;

writeFileSync(join(HERE, "P-global-findings-register.md"), md);
console.log(JSON.stringify(counts, null, 1));
console.log(`\nclassified groups: ${classified.length}  unclassified: ${unclassified.length}`);
