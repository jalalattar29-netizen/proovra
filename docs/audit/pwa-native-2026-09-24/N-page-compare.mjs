/**
 * N — PER-PAGE SOURCE COMPARISON ENGINE  (AUDIT INSTRUMENT — read-only)
 *
 * Builds, for each applicable route, the register the brief asks for: both
 * component trees, an element correspondence table, resolved style values,
 * handler traces, conditional-state inventories and the counts that make the
 * coverage claim checkable.
 *
 * HOW ELEMENTS ARE PAIRED. Tag names never match across platforms — a web
 * `<button>Archive</button>` and a native `<ProovraButton label="Archive" />`
 * share nothing but the word. So elements are classified into platform-neutral
 * ROLES and paired on their normalised visible LABEL. A label that is computed
 * at runtime cannot be paired and is reported SOURCE-UNRESOLVED rather than
 * counted as matched or missing — guessing either way would be a false finding.
 *
 * WHAT THIS DOES NOT DO. It does not decide that a paired element LOOKS the
 * same; that is the style comparison, which is reported as resolved declared
 * values side by side. And it never claims runtime behaviour.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { buildTree, flatten } from "./L-source-tree.mjs";
import { buildCssIndex, resolveClassName, resolveNativeToken, nativeTokens } from "./M-style-resolver.mjs";

const REPO = resolve(process.env.PROOVRA_AUDIT_REPO ?? resolve(import.meta.dirname, "..", "..", ".."));
const HERE = resolve(import.meta.dirname, ".");
const PAGES = join(HERE, "pages");
mkdirSync(PAGES, { recursive: true });

/* ------------------------------------------------------------ role model */

/** Platform-neutral roles. Order matters: first match wins. */
const WEB_ROLES = [
  [/^(button)$/i, "BUTTON"],
  [/Button$/, "BUTTON"],
  [/^(input|textarea|select)$/i, "INPUT"],
  [/Input$|Field$|Textarea$|Select$/, "INPUT"],
  [/^a$/i, "LINK"],
  [/^Link$/, "LINK"],
  [/Card$/, "CARD"],
  [/Badge$|Chip$|Pill$/, "BADGE"],
  [/Tab$|Tabs$|TabList$/, "TAB"],
  [/Dialog$|Modal$|Sheet$|Drawer$|Popover$/, "DIALOG"],
  [/^(table|tbody|thead|tr|td|th|ul|ol|li)$/i, "LIST"],
  [/List$|Table$|Grid$/, "LIST"],
  [/^(svg|path|circle|rect|g)$/i, "ICON"],
  [/Icon$/, "ICON"],
  [/^img$/i, "IMAGE"],
  [/Image$|Avatar$|Illustration$/, "IMAGE"],
  [/Chart$|Graph$|Donut$|Spark/, "CHART"],
  [/^(h1|h2|h3|h4|h5|h6)$/i, "HEADING"],
  [/^(p|span|strong|em|small|label|code|pre|dt|dd)$/i, "TEXT"],
  [/Text$|Label$|Heading$|Title$/, "TEXT"],
  [/Empty/i, "STATE_EMPTY"],
  [/Loading|Skeleton|Spinner/i, "STATE_LOADING"],
  [/Error|Denial/i, "STATE_ERROR"],
  [/^(form)$/i, "FORM"],
  [/^(div|section|main|aside|header|footer|nav|article|figure)$/i, "CONTAINER"],
  [/^(Fragment|>)$/, "FRAGMENT"],
];

const NATIVE_ROLES = [
  [/Button$/, "BUTTON"],
  [/^(Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)$/, "BUTTON"],
  [/^(TextInput)$/, "INPUT"],
  [/Input$|Field$/, "INPUT"],
  [/^Link$/, "LINK"],
  [/Card$/, "CARD"],
  [/Badge$|Chip$|Pill$/, "BADGE"],
  [/Tab$|Tabs$|SegmentedControl/, "TAB"],
  [/Modal$|Sheet$|Dialog$/, "DIALOG"],
  [/^(FlatList|SectionList|ScrollView)$/, "LIST"],
  [/List$|ListRow$|Table$/, "LIST"],
  [/Icon$/, "ICON"],
  [/^(Image|SvgUri)$/, "IMAGE"],
  [/Image$|Avatar$/, "IMAGE"],
  [/Chart$|Graph$|Donut$|Spark/, "CHART"],
  [/Empty/i, "STATE_EMPTY"],
  [/Loading|Skeleton|ActivityIndicator/i, "STATE_LOADING"],
  [/Error/i, "STATE_ERROR"],
  [/^(Switch|Slider|Picker|Checkbox)$/, "INPUT"],
  [/Text$|Label$|Heading$|Title$/, "TEXT"],
  [/^(View|SafeAreaView|KeyboardAvoidingView|Fragment|>)$/, "CONTAINER"],
];

function roleOf(tag, table) {
  const base = tag.replace(/^.*\./, "");
  for (const [re, role] of table) if (re.test(base)) return role;
  return "OTHER";
}

/* ----------------------------------------------------------- label model */

/** The visible words an element carries, from text or a label-ish attribute. */
function labelOf(el) {
  const a = el.otherAttrs ?? {};
  const cand = el.text || a.label || a.title || a.placeholder || a["aria-label"] || a.accessibilityLabel || a.heading || a.name || "";
  return String(cand).trim();
}

/**
 * Every string a label could present. A native label is often an expression —
 * `creating ? "Cancel" : "+ New"` renders one of two literals, and
 * `caseStatusDisplay(c.status).label` renders none that source can name. Taking
 * only the whole expression as the label made both unpairable, which inflated
 * "missing" with controls that plainly exist.
 */
function labelVariants(el) {
  const raw = labelOf(el);
  const out = new Set();

  /**
   * A label that is ONLY an expression carries no words the product shows.
   * `{loading ? <Spinner size={spinnerSize} /> : leadingIcon}` is the generic
   * Button primitive's own children slot; normalising it yielded the words
   * "loading spinner size", which then failed to pair and was reported as a
   * MISSING control that never existed. An expression counts only for the
   * string literals inside it.
   */
  const exprOnly = /^\{/.test(raw.trim()) || /<\w/.test(raw);
  if (!exprOnly) {
    const whole = norm(raw);
    if (whole) out.add(whole);
  }
  for (const m of raw.matchAll(/["'`]([^"'`]{2,60})["'`]/g)) {
    const n = norm(m[1]);
    if (n) out.add(n);
  }
  return out;
}

const tokens = (s) => new Set(s.split(" ").filter((w) => w.length > 2));

/**
 * Containment similarity. The web writes a long placeholder ("Search cases,
 * owners, IDs, or references…") where native writes a short one ("Search
 * cases"). They are the same control with different copy — a COPY finding, not
 * an absent control. Symmetric containment catches that without matching
 * unrelated strings.
 */
function similarity(aKeys, bKeys) {
  let best = 0;
  for (const a of aKeys) {
    for (const b of bKeys) {
      if (a === b) return 1;
      const ta = tokens(a);
      const tb = tokens(b);
      if (ta.size === 0 || tb.size === 0) continue;
      let shared = 0;
      for (const w of ta) if (tb.has(w)) shared++;
      const score = shared / Math.min(ta.size, tb.size);
      if (score > best) best = score;
    }
  }
  return best;
}

const norm = (s) =>
  s.toLowerCase()
    .replace(/\{[^}]*\}/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isDynamic = (s) => /\{/.test(s) && norm(s).length === 0;

/* ------------------------------------------------------------- analysis */

/**
 * url path -> page source file, for EVERY discovered route (not only the
 * applicable ones), so a redirect shim can be followed to the page that
 * actually renders the surface.
 */
let URL_TO_SOURCE = new Map();
export function setRouteIndex(rows) {
  URL_TO_SOURCE = new Map(rows.map((r) => [r.routePath, r.sourceFile]));
}

/**
 * Resolve a literal redirect target to the page that serves it. `/terms`
 * redirects to `/legal/terms`, which no literal route declares — it is served
 * by the dynamic `/legal/[slug]`. An exact-match-only lookup silently gives up
 * and reports the shim as an empty page.
 */
function sourceForUrl(url) {
  const clean = url.split("?")[0].replace(/\/+$/, "") || "/";
  if (URL_TO_SOURCE.has(clean)) return URL_TO_SOURCE.get(clean);
  const segs = clean.split("/").filter(Boolean);
  let best = null;
  for (const [pattern, file] of URL_TO_SOURCE) {
    const pSegs = pattern.split("/").filter(Boolean);
    if (pSegs.length !== segs.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < pSegs.length; i++) {
      if (pSegs[i] === segs[i]) score += 2;
      else if (/^\[.+\]$/.test(pSegs[i])) score += 1;
      else { ok = false; break; }
    }
    if (ok && (!best || score > best.score)) best = { file, score };
  }
  return best?.file ?? null;
}

function analyseSide(entryRelPath, roleTable, hops = []) {
  const abs = join(REPO, entryRelPath);
  const tree = buildTree(abs, 8);

  /**
   * Eight applicable routes are a bare `redirect("/x")`. The surface a user
   * actually sees is at the target, so the comparison follows it and SAYS it
   * followed it. Comparing Native against an empty shim would score every one
   * of them a perfect match over nothing.
   */
  if (tree.redirectTarget && tree.root.elementCount === 0 && hops.length < 3) {
    const target = sourceForUrl(tree.redirectTarget);
    if (target) {
      const inner = analyseSide(target, roleTable, [...hops, { from: entryRelPath, to: tree.redirectTarget, targetFile: target }]);
      return { ...inner, redirectChain: [...hops, { from: entryRelPath, to: tree.redirectTarget, targetFile: target }] };
    }
    return {
      entry: entryRelPath, filesVisited: 1, files: [], truncated: [], elements: [], elementCount: 0,
      byRole: {}, interactive: [], guarded: [], styleSheets: [],
      redirectChain: [...hops, { from: entryRelPath, to: tree.redirectTarget, targetFile: null }],
      unresolvedRedirect: tree.redirectTarget,
    };
  }
  const flat = flatten(tree);
  const byRole = {};
  for (const el of flat) {
    el.role = roleOf(el.tag, roleTable);
    byRole[el.role] = (byRole[el.role] || 0) + 1;
  }
  const interactive = flat.filter((e) => Object.keys(e.handlers ?? {}).length > 0 || ["BUTTON", "INPUT", "LINK", "TAB"].includes(e.role));
  const guarded = flat.filter((e) => (e.guards ?? []).length > 0);
  return {
    entry: entryRelPath,
    resolvedEntry: tree.resolvedEntry,
    followedDefaultExports: tree.followedDefaultExports ?? [],
    clientRedirect: tree.clientRedirect ?? null,
    filesVisited: tree.filesVisited,
    files: collectFiles(tree.root),
    truncated: tree.truncated,
    elements: flat,
    elementCount: flat.length,
    byRole,
    interactive,
    guarded,
    styleSheets: collectStyleSheets(tree.root),
  };
}

function collectFiles(node, out = []) {
  if (!node || node.repeated || node.truncatedAtDepth) return out;
  out.push({ file: node.file, depth: node.depth, elements: node.elementCount, via: node.viaTag });
  for (const c of node.children ?? []) collectFiles(c, out);
  return out;
}
function collectStyleSheets(node, out = []) {
  if (!node || node.repeated || node.truncatedAtDepth) return out;
  for (const s of node.styleSheets ?? []) out.push({ file: node.file, ...s });
  for (const c of node.children ?? []) collectStyleSheets(c, out);
  return out;
}

/* ------------------------------------------------------------- pairing */

const PAIRABLE = new Set(["BUTTON", "INPUT", "LINK", "TAB", "BADGE", "HEADING", "CARD", "DIALOG", "CHART", "IMAGE", "STATE_EMPTY", "STATE_LOADING", "STATE_ERROR"]);

/**
 * Two passes, deliberately in this order:
 *
 *   1. EXACT — the same words on both sides.
 *   2. FUZZY, within the same role — enough shared words to be the same
 *      control. This exists because the first version reported 2 480 elements
 *      "missing" while native plainly had them: the web's search placeholder
 *      reads "Search cases, owners, IDs, or references…" and native's reads
 *      "Search cases". That is a COPY difference, which is a real finding, and
 *      reporting it as an absent control is a false one.
 *
 * What survives both passes is genuinely absent from the native tree.
 */
function pair(web, nat) {
  const rows = [];
  const natPool = nat.elements
    .filter((e) => PAIRABLE.has(e.role))
    .map((e) => ({ e, used: false, keys: labelVariants(e) }));

  const natByKey = new Map();
  for (const n of natPool) {
    for (const k of n.keys) {
      if (!natByKey.has(k)) natByKey.set(k, []);
      natByKey.get(k).push(n);
    }
  }

  const deferred = [];

  for (const w of web.elements) {
    if (!PAIRABLE.has(w.role)) continue;
    const lbl = labelOf(w);
    const keys = labelVariants(w);
    if (keys.size === 0) {
      rows.push({
        role: w.role, webLabel: lbl || "(none)", web: `${w.file}:${w.line}`,
        status: (isDynamic(lbl) || /^{|<w/.test(lbl)) ? "SOURCE-UNRESOLVED" : "UNLABELLED",
        reason: (isDynamic(lbl) || /^{|<w/.test(lbl))
          ? "label is computed at runtime and contains no string literal — cannot be paired statically"
          : "element carries no literal label in source",
      });
      continue;
    }

    let hit = null;
    for (const k of keys) {
      const cands = (natByKey.get(k) ?? []).filter((n) => !n.used);
      hit = cands.find((n) => n.e.role === w.role) ?? cands[0];
      if (hit) break;
    }
    if (hit) {
      hit.used = true;
      rows.push({
        role: w.role, webLabel: lbl, web: `${w.file}:${w.line}`,
        nativeRole: hit.e.role, nativeLabel: labelOf(hit.e), native: `${hit.e.file}:${hit.e.line}`,
        status: hit.e.role === w.role ? "PAIRED" : "PAIRED_ROLE_DIFFERS",
      });
    } else {
      deferred.push({ w, lbl, keys });
    }
  }

  // pass 2 — fuzzy, same role only
  for (const d of deferred) {
    let best = null;
    let bestScore = 0;
    for (const n of natPool) {
      if (n.used || n.e.role !== d.w.role) continue;
      const s = similarity(d.keys, n.keys);
      if (s > bestScore) { bestScore = s; best = n; }
    }
    if (best && bestScore >= 0.6) {
      best.used = true;
      rows.push({
        role: d.w.role, webLabel: d.lbl, web: `${d.w.file}:${d.w.line}`,
        nativeRole: best.e.role, nativeLabel: labelOf(best.e), native: `${best.e.file}:${best.e.line}`,
        similarity: Number(bestScore.toFixed(2)),
        status: "PAIRED_COPY_DIFFERS",
      });
    } else {
      rows.push({ role: d.w.role, webLabel: d.lbl, web: `${d.w.file}:${d.w.line}`, status: "MISSING_IN_NATIVE" });
    }
  }

  const extras = natPool
    .filter((n) => !n.used && n.keys.size > 0)
    .map((n) => ({ role: n.e.role, nativeLabel: labelOf(n.e), native: `${n.e.file}:${n.e.line}`, status: "EXTRA_IN_NATIVE" }));

  return { rows, extras };
}

/* --------------------------------------------------------- style compare */

async function styleCompare(web, nat, cssIdx) {
  const webResolved = [];
  const seen = new Set();
  for (const el of web.elements) {
    const cn = el.styleAttrs?.className;
    if (!cn) continue;
    if (/[${}`]/.test(cn)) {
      webResolved.push({ where: `${el.file}:${el.line}`, className: cn, status: "SOURCE-UNRESOLVED", reason: "className built from a runtime expression" });
      continue;
    }
    for (const r of resolveClassName(cn, cssIdx)) {
      const k = `${r.class}|${r.selector ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      webResolved.push({ where: `${el.file}:${el.line}`, ...r });
    }
  }

  const natResolved = [];
  const seenN = new Set();
  for (const s of nat.styleSheets) {
    for (const m of s.text.matchAll(/(\w+)\s*:\s*\{([^{}]*)\}/g)) {
      const name = m[1];
      const decls = {};
      for (const d of m[2].matchAll(/(\w+)\s*:\s*([^,]+?)(?:,|$)/g)) {
        const prop = d[1];
        const raw = d[2].trim();
        const tok = await resolveNativeToken(raw);
        decls[prop] = tok ? { raw, value: tok.value, token: tok.token, unresolved: tok.unresolved } : { raw, value: /^["'\d]/.test(raw) ? raw.replace(/["']/g, "") : null, unresolved: /^["'\d]/.test(raw) ? null : "non-literal expression" };
      }
      const k = `${s.file}|${name}`;
      if (seenN.has(k)) continue;
      seenN.add(k);
      natResolved.push({ file: s.file, name, decls });
    }
  }

  // inline style={{...}} on native elements
  for (const el of nat.elements) {
    const st = el.styleAttrs?.style;
    if (!st) continue;
    natResolved.push({ file: el.file, name: `inline@${el.line}`, inline: st.slice(0, 200), decls: {} });
  }

  return { webResolved, natResolved };
}

/* ---------------------------------------------------------------- render */

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const slug = (r) => r.replace(/^\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";

export async function compareRoute(row, cssIdx) {
  const web = analyseSide(row.sourceFile, WEB_ROLES);
  const nat = row.nativeFile ? analyseSide(row.nativeFile, NATIVE_ROLES) : null;

  if (!nat) {
    return {
      routePath: row.routePath, status: "NO_NATIVE_SCREEN", web,
      counts: { webFiles: web.filesVisited, nativeFiles: 0, webElements: web.elementCount, nativeElements: 0, pairable: 0, paired: 0, missingInNative: web.elementCount, extraInNative: 0, webHandlers: web.interactive.length, nativeHandlers: 0, webGuardedElements: web.guarded.length, nativeGuardedElements: 0, webStylePropsResolved: 0, nativeStyleProps: 0, unlabelled: 0, sourceUnresolvedLabels: 0, webStyleRulesResolved: 0, webStyleUnresolved: 0, nativeStyleRules: 0 },
    };
  }

  const p = pair(web, nat);
  const styles = await styleCompare(web, nat, cssIdx);

  const counts = {
    webFiles: web.filesVisited,
    nativeFiles: nat.filesVisited,
    webElements: web.elementCount,
    nativeElements: nat.elementCount,
    pairable: p.rows.length,
    paired: p.rows.filter((r) => r.status === "PAIRED").length,
    pairedRoleDiffers: p.rows.filter((r) => r.status === "PAIRED_ROLE_DIFFERS").length,
    pairedCopyDiffers: p.rows.filter((r) => r.status === "PAIRED_COPY_DIFFERS").length,
    missingInNative: p.rows.filter((r) => r.status === "MISSING_IN_NATIVE").length,
    extraInNative: p.extras.length,
    unlabelled: p.rows.filter((r) => r.status === "UNLABELLED").length,
    sourceUnresolvedLabels: p.rows.filter((r) => r.status === "SOURCE-UNRESOLVED").length,
    webStyleRulesResolved: styles.webResolved.filter((r) => r.status === "RESOLVED").length,
    webStylePropsResolved: styles.webResolved.filter((r) => r.status === "RESOLVED").reduce((a, r) => a + Object.keys(r.decls ?? {}).length, 0),
    webStyleUnresolved: styles.webResolved.filter((r) => r.status === "SOURCE-UNRESOLVED").length,
    nativeStyleRules: styles.natResolved.length,
    nativeStyleProps: styles.natResolved.reduce((a, r) => a + Object.keys(r.decls ?? {}).length, 0),
    webHandlers: web.interactive.length,
    nativeHandlers: nat.interactive.length,
    webGuardedElements: web.guarded.length,
    nativeGuardedElements: nat.guarded.length,
  };

  return { routePath: row.routePath, status: "COMPARED", web, nat, pairing: p, styles, counts };
}

export function renderRoute(r) {
  if (r.status === "NO_NATIVE_SCREEN") {
    return `# ${r.routePath} — NO NATIVE SCREEN

**PWA entry:** \`${r.web.entry}\` — ${r.web.filesVisited} files, ${r.web.elementCount} elements rendered.
**Native:** none. No ledger row, no screen file.

Every one of the ${r.web.elementCount} PWA elements is missing natively. This route is
not a parity gap inside a screen; it is an absent screen. See H-3.

## A. PWA component tree

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
${r.web.files.map((f) => `| ${f.depth} | \`${f.file}\` | ${f.elements} | \`${esc(f.via)}\` |`).join("\n")}
`;
  }

  const { web, nat, pairing, styles, counts } = r;
  const missing = pairing.rows.filter((x) => x.status === "MISSING_IN_NATIVE");
  const paired = pairing.rows.filter((x) => x.status.startsWith("PAIRED"));
  const roleDiff = pairing.rows.filter((x) => x.status === "PAIRED_ROLE_DIFFERS");
  const unres = pairing.rows.filter((x) => x.status === "SOURCE-UNRESOLVED");

  const roleTable = [...new Set([...Object.keys(web.byRole), ...Object.keys(nat.byRole)])]
    .sort()
    .map((k) => `| ${k} | ${web.byRole[k] ?? 0} | ${nat.byRole[k] ?? 0} | ${(nat.byRole[k] ?? 0) - (web.byRole[k] ?? 0)} |`)
    .join("\n");

  return `# ${r.routePath}

**PWA entry:** \`${web.entry}\`
**Native entry:** \`${nat.entry}\`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | ${counts.webFiles} | ${counts.nativeFiles} |
| Elements | ${counts.webElements} | ${counts.nativeElements} |
| Interactive elements | ${counts.webHandlers} | ${counts.nativeHandlers} |
| Conditionally-rendered elements | ${counts.webGuardedElements} | ${counts.nativeGuardedElements} |
| Style rules resolved | ${counts.webStyleRulesResolved} (${counts.webStylePropsResolved} props) | ${counts.nativeStyleRules} (${counts.nativeStyleProps} props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
${web.files.map((f) => `| ${f.depth} | \`${f.file}\` | ${f.elements} | \`${esc(f.via)}\` |`).join("\n")}
${web.truncated.length ? `\n**Truncated branches (depth bound 8):** ${web.truncated.map((t) => "`" + t.file + "`").join(", ")}\n` : ""}
## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
${nat.files.map((f) => `| ${f.depth} | \`${f.file}\` | ${f.elements} | \`${esc(f.via)}\` |`).join("\n")}
${nat.truncated.length ? `\n**Truncated branches (depth bound 8):** ${nat.truncated.map((t) => "`" + t.file + "`").join(", ")}\n` : ""}
## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
${roleTable}

### C.1 Paired (${paired.length})

${paired.length === 0 ? "_none_" : `| Role | Label | PWA | Native |
|---|---|---|---|
${paired.slice(0, 120).map((x) => `| ${x.role}${x.status === "PAIRED_ROLE_DIFFERS" ? ` → ${x.nativeRole} ⚠` : ""} | ${esc(x.webLabel)} | \`${x.web}\` | \`${x.native}\` |`).join("\n")}${paired.length > 120 ? `\n\n_…${paired.length - 120} further paired rows in the JSON._` : ""}`}

${roleDiff.length ? `**${roleDiff.length} paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.\n` : ""}
### C.2 MISSING in Native (${missing.length})

${missing.length === 0 ? "_none_" : `| Role | Label | PWA source |
|---|---|---|
${missing.slice(0, 150).map((x) => `| ${x.role} | ${esc(x.webLabel)} | \`${x.web}\` |`).join("\n")}${missing.length > 150 ? `\n\n_…${missing.length - 150} further in the JSON._` : ""}`}

### C.3 EXTRA in Native (${pairing.extras.length})

${pairing.extras.length === 0 ? "_none_" : `| Role | Label | Native source |
|---|---|---|
${pairing.extras.slice(0, 80).map((x) => `| ${x.role} | ${esc(x.nativeLabel)} | \`${x.native}\` |`).join("\n")}`}

### C.4 SOURCE-UNRESOLVED labels (${unres.length})

${unres.length === 0 ? "_none_" : `| Role | PWA source | Why unpairable |
|---|---|---|
${unres.slice(0, 60).map((x) => `| ${x.role} | \`${x.web}\` | ${esc(x.reason)} |`).join("\n")}`}

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (${counts.webStyleRulesResolved} rules, ${counts.webStylePropsResolved} properties)

${styles.webResolved.filter((x) => x.status === "RESOLVED").slice(0, 40).map((x) => `**\`.${x.class}\`** — \`${x.file}\` · \`${esc(x.selector)}\`${x.atRule ? ` _[${esc(x.atRule)}]_` : ""}

${Object.entries(x.decls).map(([p, v]) => `- \`${p}\`: **${esc(v.value ?? v.raw)}**${v.chain?.length ? `  _(${esc(v.chain.join(" → "))})_` : ""}${v.unresolved ? `  ⚠ ${v.unresolved}` : ""}`).join("\n")}`).join("\n\n") || "_no static classes on this route_"}

${styles.webResolved.filter((x) => x.status === "TAILWIND_DEFAULT").length ? `\n**Stock Tailwind utilities used (${styles.webResolved.filter((x) => x.status === "TAILWIND_DEFAULT").length}).** \`apps/web/tailwind.config.ts\` declares \`theme: { extend: {} }\`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:\n\n${styles.webResolved.filter((x) => x.status === "TAILWIND_DEFAULT").slice(0, 25).map((x) => `- \`.${x.class}\` → ${esc(JSON.stringify(x.resolved))}`).join("\n")}\n` : ""}
${styles.webResolved.filter((x) => x.status === "SOURCE-UNRESOLVED").length ? `\n### D.2 PWA SOURCE-UNRESOLVED (${styles.webResolved.filter((x) => x.status === "SOURCE-UNRESOLVED").length})\n\n${styles.webResolved.filter((x) => x.status === "SOURCE-UNRESOLVED").slice(0, 30).map((x) => `- \`${x.class ?? x.className}\` at \`${x.where}\` — ${esc(x.reason)}`).join("\n")}\n` : ""}
### D.3 Native StyleSheet rules resolved (${counts.nativeStyleRules} rules, ${counts.nativeStyleProps} properties)

${nat.styleSheets.length === 0 ? "_this screen declares no StyleSheet; it styles through shared primitives only_" : styles.natResolved.filter((x) => Object.keys(x.decls).length).slice(0, 40).map((x) => `**\`${x.name}\`** — \`${x.file}\`

${Object.entries(x.decls).map(([p, v]) => `- \`${p}\`: **${esc(v.value ?? v.raw)}**${v.token ? `  _(${esc(v.token)})_` : ""}${v.unresolved ? `  ⚠ ${v.unresolved}` : ""}`).join("\n")}`).join("\n\n")}

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | ${counts.webFiles} |
| Native files inspected (rendered tree) | ${counts.nativeFiles} |
| PWA elements identified | ${counts.webElements} |
| Native elements identified | ${counts.nativeElements} |
| Pairable PWA elements | ${counts.pairable} |
| Paired | ${counts.paired} |
| Missing in Native | ${counts.missingInNative} |
| Extra in Native | ${counts.extraInNative} |
| Unlabelled (not pairable by label) | ${counts.unlabelled} |
| SOURCE-UNRESOLVED labels | ${counts.sourceUnresolvedLabels} |
| PWA style properties resolved | ${counts.webStylePropsResolved} |
| PWA style items SOURCE-UNRESOLVED | ${counts.webStyleUnresolved} |
| Native style properties resolved | ${counts.nativeStyleProps} |
| PWA interactive elements | ${counts.webHandlers} |
| Native interactive elements | ${counts.nativeHandlers} |
| PWA conditional branches | ${counts.webGuardedElements} |
| Native conditional branches | ${counts.nativeGuardedElements} |
`;
}

/* ------------------------------------------------------------------ main */

const matrix = JSON.parse(readFileSync(join(HERE, "route-matrix.json"), "utf8"));
setRouteIndex(matrix.rows);
const applicable = matrix.rows.filter((r) => r.auditDisposition === "APPLICABLE");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets = only.length ? applicable.filter((r) => only.includes(r.routePath)) : applicable;

const cssIdx = buildCssIndex();
await nativeTokens();

const all = [];
for (const row of targets) {
  process.stdout.write(`… ${row.routePath}`);
  try {
    const r = await compareRoute(row, cssIdx);
    writeFileSync(join(PAGES, `${slug(row.routePath)}.md`), renderRoute(r));
    all.push({
      routePath: r.routePath, status: r.status, counts: r.counts,
      missing: r.pairing?.rows.filter((x) => x.status === "MISSING_IN_NATIVE") ?? [],
      roleDiffs: r.pairing?.rows.filter((x) => x.status === "PAIRED_ROLE_DIFFERS") ?? [],
      copyDiffs: r.pairing?.rows.filter((x) => x.status === "PAIRED_COPY_DIFFERS") ?? [],
      extras: r.pairing?.extras ?? [],
      unresolvedLabels: r.pairing?.rows.filter((x) => x.status === "SOURCE-UNRESOLVED") ?? [],
      webFilesList: r.web.files.map((f) => f.file),
      natFilesList: r.nat?.files.map((f) => f.file) ?? [],
    });
    console.log(`  ✓ web ${r.counts.webElements}el/${r.counts.webFiles}f  nat ${r.counts.nativeElements}el/${r.counts.nativeFiles}f  missing ${r.counts.missingInNative}`);
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
    all.push({ routePath: row.routePath, status: "ERROR", error: e.message });
  }
}

writeFileSync(join(HERE, "page-comparison-index.json"), JSON.stringify({ auditedSha: matrix.auditedSha, routes: all }, null, 1));
console.log(`\nwrote ${all.length} page registers to docs/audit/pwa-native-2026-09-24/pages/`);
