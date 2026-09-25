/**
 * V3 INSTRUMENT — per-route PWA↔Native comparison (read-only).
 *
 * Consumes 03-deep-extract (full recursive trees, 0 unresolved imports) and
 * 05-style-index (web CSS -> literals, native theme -> literals) and emits, per
 * applicable route:
 *
 *   routes-raw/<slug>.json   the full machine register (levels 1-8)
 *   routes/<slug>.md         the human register
 *
 * It does NOT adjudicate. Every pairing it proposes carries the evidence that
 * produced it so a human verdict can be recorded against it in 07-adjudicate.
 *
 * Usage:  node 06-compare.mjs [--only /route] [--from N] [--count N]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { crawl, totals, ROOT } from "./03-deep-extract.mjs";
import { buildCssIndex, buildNativeTokenIndex, resolveClassName, resolveThemeToken } from "./05-style-index.mjs";

const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;
mkdirSync(`${OUT}/routes`, { recursive: true });
mkdirSync(`${OUT}/routes-raw`, { recursive: true });

const slug = (r) => (r === "/" ? "root" : r.slice(1).replace(/[/\[\]]/g, "-").replace(/-+/g, "-"));

/* ------------------------------------------------------- role normalisation */

const WEB_ROLE = (tag) => {
  const t = tag.replace(/^.*\./, "");
  if (/^(button|Button|IconButton|AppButton)$/.test(t)) return "BUTTON";
  if (/^(a|Link|NextLink)$/.test(t)) return "LINK";
  if (/^(input|textarea|Input|TextField|AppInput|SearchInput)$/.test(t)) return "INPUT";
  if (/^(select|Select|AppListbox|Listbox|Combobox)$/.test(t)) return "SELECT";
  if (/^h[1-6]$/.test(t)) return "HEADING";
  if (/^(img|Image|NextImage)$/.test(t)) return "IMAGE";
  if (/^(svg|Icon)$/.test(t) || /Icon$/.test(t)) return "ICON";
  if (/(Dialog|Modal|Drawer|Sheet|Popover)$/.test(t)) return "DIALOG";
  if (/(Badge|Chip|Pill|Tag)$/.test(t)) return "BADGE";
  if (/(Card|Panel|Tile)$/.test(t)) return "CARD";
  if (/(Section|PageSection)$/.test(t)) return "SECTION";
  if (/(Table|Tbody|Thead)$/.test(t) || /^(table|tbody|thead|tr|td|th)$/.test(t)) return "TABLE";
  if (/(Tab|Tabs|SegmentedControl)$/.test(t)) return "TAB";
  if (/(Empty|EmptyState)$/.test(t)) return "STATE_EMPTY";
  if (/(Skeleton|Spinner|Loading)$/.test(t)) return "STATE_LOADING";
  if (/(Error|ErrorState|Degraded)$/.test(t)) return "STATE_ERROR";
  if (/(Toast|Alert|Banner)$/.test(t)) return "NOTICE";
  if (/^(form|Form)$/.test(t)) return "FORM";
  if (/^(label|Label)$/.test(t)) return "LABEL";
  if (/^(ul|ol|li|List|ListRow)$/.test(t)) return "LIST";
  if (/^[a-z]/.test(t)) return "BOX";
  return "COMPONENT";
};

const NAT_ROLE = (tag) => {
  const t = tag.replace(/^.*\./, "");
  if (/^(ProovraButton|Pressable|TouchableOpacity|TouchableHighlight|Button)$/.test(t)) return "BUTTON";
  if (/^(ProovraInput|TextInput|Switch|Checkbox)$/.test(t)) return "INPUT";
  if (/^(ProovraSection)$/.test(t)) return "SECTION";
  if (/^(ProovraCard)$/.test(t)) return "CARD";
  if (/^(ProovraBadge|ProovraStatusBadge)$/.test(t)) return "BADGE";
  if (/^(ProovraEmptyState)$/.test(t)) return "STATE_EMPTY";
  if (/^(ProovraLoadingState|ActivityIndicator)$/.test(t)) return "STATE_LOADING";
  if (/^(ProovraErrorState)$/.test(t)) return "STATE_ERROR";
  if (/^(ProovraListRow)$/.test(t)) return "LIST";
  if (/^(ProovraFilterChips|ProovraSegmented)$/.test(t)) return "TAB";
  if (/^(Image|ProovraImage)$/.test(t)) return "IMAGE";
  if (/^(ProovraText|Text)$/.test(t)) return "TEXT";
  if (/^(Modal|ProovraSheet|StepUpSheet)$/.test(t)) return "DIALOG";
  if (/^(ScrollView|View|SafeAreaView|KeyboardAvoidingView|FlatList)$/.test(t)) return "BOX";
  return "COMPONENT";
};

const norm = (s) =>
  String(s).toLowerCase().replace(/&amp;/g, "&").replace(/&nbsp;| /g, " ")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[—–]/g, "-").replace(/[.,:;!?]+$/, "").replace(/\s+/g, " ").trim();

const isLiteralLabel = (s) =>
  typeof s === "string" && s.length > 0 && !/[{}$`]/.test(s) && !/^[a-z_$][\w$]*(\.[\w$]+)+$/.test(s);

/* ------------------------------------------------------------ label harvest */

/** Every labelled element on a side: {role, label, file, line, tag, styleRef}. */
function labelled(tree, roleFn) {
  const out = [];
  for (const f of tree.files) {
    for (const el of f.elements) {
      const role = roleFn(el.tag);
      let label = null, from = null;
      for (const k of ["label", "title", "aria-label", "ariaLabel", "accessibilityLabel", "placeholder", "alt", "heading"]) {
        const p = el.props[k];
        if (p && p.literal && isLiteralLabel(p.v)) { label = p.v; from = k; break; }
      }
      out.push({
        role, tag: el.tag, label, labelFrom: from, file: f.file, line: el.line,
        className: el.props.className?.literal ? el.props.className.v : (el.props.className ? String(el.props.className.v) : null),
        classLiteral: !!el.props.className?.literal,
        style: el.props.style ? String(el.props.style.v).slice(0, 160) : null,
        href: el.props.href ? String(el.props.href.v) : null,
        handlers: el.handlers,
      });
    }
    // JSX text nodes become TEXT elements so copy is comparable
    for (const t of f.texts) {
      if (t.kind === "jsxText" && isLiteralLabel(t.v)) out.push({ role: "TEXT", tag: "#text", label: t.v, labelFrom: "jsxText", file: f.file, line: t.line, className: null, handlers: [] });
    }
  }
  return out;
}

/* ============================================================== the compare */

/** Union of several crawls, de-duplicated by file. */
function crawlUnion(entries) {
  const byFile = new Map(); const missing = []; const external = new Set();
  for (const e of entries) {
    const t = crawl(e);
    for (const f of t.files) if (!byFile.has(f.file)) byFile.set(f.file, f);
    missing.push(...t.missing); t.external.forEach((x) => external.add(x));
  }
  return { files: [...byFile.values()], missing, external: [...external] };
}

export async function compareRoute(row, cssIdx, tokIdx, counterparts) {
  const web = crawl(`${ROOT}/${row.webEntry}`);
  // The native counterpart of a web route is the entry screen PLUS the screens
  // it navigates to that are not themselves another applicable route's entry
  // (08-nav-graph.mjs). Without this, web /settings — one page — is compared
  // against one native screen while five sibling screens implement the rest.
  const cp = counterparts?.[row.route]?.set ?? [];
  const natEntries = cp.length ? cp.map((s) => `${ROOT}/${s.file}`) : (row.nativeEntry ? [`${ROOT}/${row.nativeEntry}`] : []);
  const nat = natEntries.length ? crawlUnion(natEntries) : { files: [], missing: [], external: [] };

  const W = labelled(web, WEB_ROLE);
  const N = labelled(nat, NAT_ROLE);

  /* ---- LEVEL 4: exact text / label correspondence */
  const natByLabel = new Map();
  for (const n of N) if (n.label) {
    const k = norm(n.label);
    if (!natByLabel.has(k)) natByLabel.set(k, []);
    natByLabel.get(k).push(n);
  }
  const natRoles = new Set(N.map((n) => n.role));

  const paired = [], copyDiff = [], roleDiff = [], missing = [], unlabelled = [];
  const seenWeb = new Set();
  for (const w of W) {
    if (!w.label) { unlabelled.push(w); continue; }
    const key = `${w.role}|${norm(w.label)}|${w.file}:${w.line}`;
    if (seenWeb.has(key)) continue;
    seenWeb.add(key);
    const hits = natByLabel.get(norm(w.label));
    if (hits && hits.length) {
      const same = hits.find((h) => h.role === w.role);
      if (same) paired.push({ w, n: same });
      else roleDiff.push({ w, n: hits[0] });
    } else {
      missing.push({ w, natHasRole: natRoles.has(w.role) });
    }
  }
  const webLabels = new Set(W.filter((w) => w.label).map((w) => norm(w.label)));
  const extra = N.filter((n) => n.label && !webLabels.has(norm(n.label)));

  /* ---- LEVEL 5: resolved style properties, per element */
  let webPropsResolved = 0, webClassesUnresolved = 0, webCompeting = 0, webNonLiteralClass = 0;
  const webColorUse = new Map();      // resolved colour -> count
  const webUnresolvedClassSet = new Set();
  for (const w of W) {
    if (!w.className) continue;
    if (!w.classLiteral) { webNonLiteralClass++; continue; }
    const r = resolveClassName(w.className, cssIdx);
    webPropsResolved += Object.keys(r.resolved).length;
    webClassesUnresolved += r.unresolvedClasses.length;
    r.unresolvedClasses.forEach((c) => webUnresolvedClassSet.add(c));
    webCompeting += r.competing.length;
    for (const [p, d] of Object.entries(r.resolved)) {
      if (/color|background|border|fill|stroke|shadow/.test(p) && d.value) {
        for (const m of String(d.value).matchAll(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g)) {
          const v = m[0].toLowerCase();
          webColorUse.set(v, (webColorUse.get(v) ?? 0) + 1);
        }
      }
    }
  }
  let natPropsResolved = 0, natTokenUnresolved = 0;
  const natColorUse = new Map();
  for (const f of nat.files) {
    for (const s of f.stylesheets) natPropsResolved += Object.keys(s.decls).length;
    for (const t of f.themeTokens) {
      const r = resolveThemeToken(t.t, tokIdx);
      if (r.value == null) { natTokenUnresolved++; continue; }
      const v = String(r.value).toLowerCase();
      if (/^#|^rgba?\(/.test(v)) natColorUse.set(v, (natColorUse.get(v) ?? 0) + 1);
    }
  }
  const webColors = new Set(webColorUse.keys()), natColors = new Set(natColorUse.keys());
  const sharedColors = [...webColors].filter((c) => natColors.has(c));
  const webOnlyColors = [...webColors].filter((c) => !natColors.has(c));

  /* ---- LEVEL 7: handlers */
  const webHandlers = web.files.flatMap((f) => f.handlers.map((h) => ({ ...h, file: f.file })));
  const natHandlers = nat.files.flatMap((f) => f.handlers.map((h) => ({ ...h, file: f.file })));

  /* ---- LEVEL 8: data paths */
  const webApi = new Map(), natApi = new Map();
  for (const f of web.files) for (const a of f.apiPaths) webApi.set(a.p, `${f.file}:${a.line}`);
  for (const f of nat.files) for (const a of f.apiPaths) natApi.set(a.p, `${f.file}:${a.line}`);
  const apiBase = (p) => p.split("?")[0].replace(/\$\{…\}/g, ":p").replace(/\/+$/, "");
  const natApiBases = new Set([...natApi.keys()].map(apiBase));
  const apiOnlyWeb = [...webApi.keys()].filter((p) => !natApiBases.has(apiBase(p)));
  const apiOnlyNat = [...natApi.keys()].filter((p) => ![...webApi.keys()].map(apiBase).includes(apiBase(p)));
  const apiShared = [...webApi.keys()].filter((p) => natApiBases.has(apiBase(p)));

  /* ---- LEVEL 6: conditional states */
  const webCond = web.files.reduce((a, f) => a + f.conditionals.length, 0);
  const natCond = nat.files.reduce((a, f) => a + f.conditionals.length, 0);
  const stateRole = (rs) => ["STATE_EMPTY", "STATE_LOADING", "STATE_ERROR"].filter((k) => rs.has(k));
  const webStates = stateRole(new Set(W.map((w) => w.role)));
  const natStates = stateRole(natRoles);

  return {
    route: row.route, frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5",
    webEntry: row.webEntry, nativeEntry: row.nativeEntry,
    ledgerStatus: row.ledgerStatus, physicallyAccepted: row.physicallyAccepted,
    tier: row.tier, policy: row.policy, borderline: row.borderline,
    trees: {
      web: { ...totals(web), unresolvedImports: web.missing.length, external: web.external },
      native: { ...totals(nat), unresolvedImports: nat.missing.length, external: nat.external },
    },
    level4: {
      webLabelled: W.filter((w) => w.label).length, natLabelled: N.filter((n) => n.label).length,
      paired: paired.length, roleDiff: roleDiff.length, missing: missing.length,
      extraInNative: extra.length, webUnlabelled: unlabelled.length,
      missingWithRolePresent: missing.filter((m) => m.natHasRole).length,
      missingWithRoleAbsent: missing.filter((m) => !m.natHasRole).length,
      samples: {
        paired: paired.slice(0, 40).map((p) => ({ role: p.w.role, label: p.w.label, web: `${p.w.file}:${p.w.line}`, nat: `${p.n.file}:${p.n.line}` })),
        roleDiff: roleDiff.slice(0, 40).map((p) => ({ label: p.w.label, webRole: p.w.role, natRole: p.n.role, web: `${p.w.file}:${p.w.line}`, nat: `${p.n.file}:${p.n.line}` })),
        missing: missing.slice(0, 20000).map((m) => ({ role: m.w.role, label: m.w.label, at: `${m.w.file}:${m.w.line}`, natHasRole: m.natHasRole })),
        extra: extra.slice(0, 60).map((n) => ({ role: n.role, label: n.label, at: `${n.file}:${n.line}` })),
      },
    },
    level5: {
      webPropsResolved, webClassesUnresolved, webNonLiteralClass, webCompetingRules: webCompeting,
      webDistinctUnresolvedClasses: webUnresolvedClassSet.size,
      natPropsResolved, natTokenUnresolved,
      webDistinctColors: webColors.size, natDistinctColors: natColors.size,
      sharedColors: sharedColors.length, webOnlyColors: webOnlyColors.length,
      webOnlyColorSample: webOnlyColors.slice(0, 30), sharedColorSample: sharedColors.slice(0, 20),
    },
    level6: { webConditionals: webCond, natConditionals: natCond, webStateRoles: webStates, natStateRoles: natStates },
    level7: {
      webHandlers: webHandlers.length, natHandlers: natHandlers.length,
      webHandlerSample: webHandlers.slice(0, 60).map((h) => `${h.prop}=${h.expr.slice(0, 60)} @${h.file}:${h.line}`),
      natHandlerSample: natHandlers.slice(0, 60).map((h) => `${h.prop}=${h.expr.slice(0, 60)} @${h.file}:${h.line}`),
    },
    level8: {
      webApi: [...webApi.keys()].length, natApi: [...natApi.keys()].length,
      shared: apiShared.length, onlyWeb: apiOnlyWeb.length, onlyNative: apiOnlyNat.length,
      onlyWebList: apiOnlyWeb, onlyNativeList: apiOnlyNat, sharedList: apiShared,
      webApiWhere: Object.fromEntries([...webApi.entries()].slice(0, 80)),
      natApiWhere: Object.fromEntries([...natApi.entries()]),
    },
  };
}

/* ======================================================================= main */
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const from = args.includes("--from") ? Number(args[args.indexOf("--from") + 1]) : 0;
const count = args.includes("--count") ? Number(args[args.indexOf("--count") + 1]) : 999;

const { rows } = JSON.parse(readFileSync(`${OUT}/routes.json`, "utf8"));
const cssIdx = buildCssIndex();
const tokIdx = await buildNativeTokenIndex();
const { counterparts } = JSON.parse(readFileSync(`${OUT}/native-counterparts.json`, "utf8"));

const target = only ? rows.filter((r) => r.route === only) : rows.slice(from, from + count);
console.log(`comparing ${target.length} route(s) | css classes ${cssIdx.byClass.size} | native tokens ${tokIdx.size}`);

for (const row of target) {
  const t0 = Date.now();
  const reg = await compareRoute(row, cssIdx, tokIdx, counterparts);
  writeFileSync(`${OUT}/routes-raw/${slug(row.route)}.json`, JSON.stringify(reg, null, 1));
  const L = reg.level4, S = reg.level5, A = reg.level8;
  console.log(
    `${row.route.padEnd(44)} wf=${String(reg.trees.web.files).padStart(3)} nf=${String(reg.trees.native.files).padStart(3)}` +
    ` | lbl ${String(L.webLabelled).padStart(4)}/${String(L.natLabelled).padStart(3)}` +
    ` pair=${String(L.paired).padStart(3)} miss=${String(L.missing).padStart(4)} (roleAbsent ${L.missingWithRoleAbsent})` +
    ` | css ${String(S.webPropsResolved).padStart(5)} unres=${String(S.webClassesUnresolved).padStart(4)}` +
    ` | col w${String(S.webDistinctColors).padStart(3)}/n${String(S.natDistinctColors).padStart(2)} shared=${S.sharedColors}` +
    ` | api ${A.shared}/${A.webApi} onlyW=${A.onlyWeb}` +
    ` | ${Date.now() - t0}ms`,
  );
}
