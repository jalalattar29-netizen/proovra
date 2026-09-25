/**
 * V4 INSTRUMENT — scoped, semantically-paired per-route comparison (read-only).
 *
 * Two corrections over v3:
 *
 *  1. EXPORT-SCOPED TREES (10-scoped-extract.mjs). v3 walked whole files, so a
 *     route importing one export of a 9-panel module was charged with all nine.
 *     Measured on /evidence-requests/[id]: 71 files -> 33, and
 *     HiddenFeaturePanels 90 elements -> 13.
 *
 *  2. SEMANTIC PAIRING. v3 paired on an exact normalised literal, so
 *     "Email address" vs "Email" scored as unpaired and landed in
 *     COPY_OR_COMPOSITION_DIFF. Pairing now runs in four ordered passes and
 *     records WHICH pass matched, so a copy difference is reported as a copy
 *     difference rather than as a missing control:
 *        P1 exact        same role + identical normalised literal
 *        P2 copy-differs same role + token-overlap >= 0.5 (Jaccard on words)
 *        P3 role-differs identical literal, different role
 *        P4 unpaired
 *
 * Emits routes-v4/<slug>.json. Adjudication stays in 12-adjudicate-v4.mjs.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { scopedCrawl, extractScoped } from "./10-scoped-extract.mjs";
import { ROOT } from "./03-deep-extract.mjs";

const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;
mkdirSync(`${OUT}/routes-v4`, { recursive: true });
const slug = (r) => (r === "/" ? "root" : r.slice(1).replace(/[/\[\]]/g, "-").replace(/-+/g, "-"));

const WEB_ROLE = (tag) => {
  const t = tag.replace(/^.*\./, "");
  if (/^(button|Button|IconButton|AppButton)$/.test(t)) return "BUTTON";
  if (/^(a|Link|NextLink)$/.test(t)) return "LINK";
  if (/^(input|textarea|Input|TextField|AppInput|SearchInput)$/.test(t)) return "INPUT";
  if (/^(select|Select|AppListbox|Listbox|Combobox)$/.test(t)) return "SELECT";
  if (/^h[1-6]$/.test(t)) return "HEADING";
  if (/^(img|Image|NextImage)$/.test(t)) return "IMAGE";
  if (/Icon$/.test(t) || t === "svg") return "ICON";
  if (/(Dialog|Modal|Drawer|Sheet|Popover)$/.test(t)) return "DIALOG";
  if (/(Badge|Chip|Pill|Tag)$/.test(t)) return "BADGE";
  if (/(Card|Panel|Tile)$/.test(t)) return "CARD";
  if (/(Section|PageSection)$/.test(t)) return "SECTION";
  if (/(Table|Tbody|Thead)$/.test(t) || /^(table|tbody|thead|tr|td|th)$/.test(t)) return "TABLE";
  if (/(Tab|Tabs|SegmentedControl)$/.test(t)) return "TAB";
  if (/(Empty|EmptyState)$/.test(t)) return "STATE_EMPTY";
  if (/(Skeleton|Spinner|Loading)$/.test(t)) return "STATE_LOADING";
  if (/(Error|ErrorState|Degraded|DenialState)$/.test(t)) return "STATE_ERROR";
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
  if (/^ProovraSection$/.test(t)) return "SECTION";
  if (/^ProovraCard$/.test(t)) return "CARD";
  if (/^(ProovraBadge|ProovraStatusBadge)$/.test(t)) return "BADGE";
  if (/^ProovraEmptyState$/.test(t)) return "STATE_EMPTY";
  if (/^(ProovraLoadingState|ActivityIndicator)$/.test(t)) return "STATE_LOADING";
  if (/^ProovraErrorState$/.test(t)) return "STATE_ERROR";
  if (/^(ProovraListRow|ProovraDataList)$/.test(t)) return "LIST";
  if (/^(ProovraFilterChips|ProovraSegmented)$/.test(t)) return "TAB";
  if (/^(Image|ProovraImage)$/.test(t)) return "IMAGE";
  if (/^(ProovraText|Text)$/.test(t)) return "TEXT";
  if (/^(Modal|ProovraSheet|StepUpSheet|ProovraConfirmSheet)$/.test(t)) return "DIALOG";
  if (/^(ScrollView|View|SafeAreaView|KeyboardAvoidingView|FlatList)$/.test(t)) return "BOX";
  return "COMPONENT";
};

const norm = (s) =>
  String(s).toLowerCase().replace(/&amp;/g, "&").replace(/&nbsp;| /g, " ")
    .replace(/&rsquo;|&#8217;/g, "'").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[—–]/g, "-").replace(/[.,:;!?…]+$/, "").replace(/\s+/g, " ").trim();

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "your", "you", "this", "that", "is", "are", "with", "by", "it", "as", "at", "be"]);
const toks = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const isLiteralLabel = (s) =>
  typeof s === "string" && s.length > 0 && !/[{}$`]/.test(s) && !/^[a-z_$][\w$]*(\.[\w$]+)+$/.test(s);

function labelled(files, roleFn) {
  const out = [];
  for (const f of files) {
    for (const el of f.elements) {
      let label = null, from = null;
      for (const k of ["label", "title", "aria-label", "ariaLabel", "accessibilityLabel", "placeholder", "alt", "heading"]) {
        const p = el.props[k];
        if (p && p.literal && isLiteralLabel(p.v)) { label = p.v; from = k; break; }
      }
      if (label) out.push({ role: roleFn(el.tag), tag: el.tag, label, labelFrom: from, file: f.file, line: el.line, className: el.props.className && el.props.className.literal ? el.props.className.v : null, styleExpr: el.props.style ? String(el.props.style.v).slice(0,120) : null });
    }
    for (const t of f.texts) {
      if (t.kind === "jsxText" && isLiteralLabel(t.v) && t.v.length > 1) {
        out.push({ role: "TEXT", tag: "#text", label: t.v, labelFrom: "jsxText", file: f.file, line: t.line });
      }
    }
  }
  return out;
}

function treeOf(entryAbs) {
  const { reached, unbound, external } = scopedCrawl(entryAbs);
  const files = [];
  for (const [abs, slot] of reached) files.push(extractScoped(abs, slot.nodes));
  return { files, unbound, external };
}

export function compareScoped(row, counterparts) {
  const web = treeOf(`${ROOT}/${row.webEntry}`);
  const cp = counterparts?.[row.route]?.set ?? [];
  const natEntries = cp.length ? cp.map((s) => `${ROOT}/${s.file}`) : (row.nativeEntry ? [`${ROOT}/${row.nativeEntry}`] : []);
  const natFiles = new Map(); const natUnbound = [];
  for (const e of natEntries) {
    const t = treeOf(e);
    for (const f of t.files) if (!natFiles.has(f.file)) natFiles.set(f.file, f);
    natUnbound.push(...t.unbound);
  }
  const nat = { files: [...natFiles.values()], unbound: natUnbound };

  const W = labelled(web.files, WEB_ROLE);
  const N = labelled(nat.files, NAT_ROLE);
  const natTok = N.map((n) => ({ ...n, t: toks(n.label) }));
  const natByLabel = new Map();
  for (const n of N) {
    const k = norm(n.label);
    if (!natByLabel.has(k)) natByLabel.set(k, []);
    natByLabel.get(k).push(n);
  }
  /* Role presence must come from EVERY native element, not only the labelled
   * ones. A screen whose buttons carry `label={t("x")}` has no literal label, so
   * deriving the role set from `N` reported BUTTON as absent on screens full of
   * buttons — measured: 496 false "role absent" rows before this fix. */
  const natRoles = new Set();
  for (const f of nat.files) for (const el of f.elements) natRoles.add(NAT_ROLE(el.tag));

  const exact = [], copy = [], roleDiff = [], unpaired = [];
  const usedNat = new Set();
  const seen = new Set();
  for (const w of W) {
    const key = `${w.role}|${norm(w.label)}|${w.file}:${w.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const nk = norm(w.label);

    const hits = natByLabel.get(nk) ?? [];
    const same = hits.find((h) => h.role === w.role);
    if (same) { exact.push({ w, n: same }); usedNat.add(`${same.file}:${same.line}`); continue; }

    const wt = toks(w.label);
    let best = null, bestScore = 0;
    for (const n of natTok) {
      if (n.role !== w.role) continue;
      const s = jaccard(wt, n.t);
      if (s > bestScore) { bestScore = s; best = n; }
    }
    if (best && bestScore >= 0.5) {
      copy.push({ w, n: best, score: +bestScore.toFixed(2) });
      usedNat.add(`${best.file}:${best.line}`);
      continue;
    }
    if (hits.length) { roleDiff.push({ w, n: hits[0] }); continue; }
    unpaired.push({ w, natHasRole: natRoles.has(w.role), bestScore: +bestScore.toFixed(2), bestNat: best ? { label: best.label, at: `${best.file}:${best.line}` } : null });
  }
  const webLabels = new Set(W.map((w) => norm(w.label)));
  const extra = N.filter((n) => !webLabels.has(norm(n.label)) && !usedNat.has(`${n.file}:${n.line}`));

  return {
    route: row.route, frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5",
    webEntry: row.webEntry, nativeCounterpartScreens: cp.map((s) => s.file),
    ledgerStatus: row.ledgerStatus, borderline: row.borderline,
    trees: {
      web: { files: web.files.length, labelled: W.length, unboundExports: web.unbound.length },
      native: { files: nat.files.length, labelled: N.length, unboundExports: nat.unbound.length },
    },
    pairing: {
      exact: exact.length, copyDiffers: copy.length, roleDiffers: roleDiff.length,
      unpaired: unpaired.length, extraInNative: extra.length,
      unpairedRoleAbsent: unpaired.filter((u) => !u.natHasRole).length,
    },
    exactList: exact.map((p) => ({ role: p.w.role, label: p.w.label, web: `${p.w.file}:${p.w.line}`, nat: `${p.n.file}:${p.n.line}`, webClass: p.w.className, webStyle: p.w.styleExpr, natStyle: p.n.styleExpr, natTag: p.n.tag })),
    copyList: copy.map((p) => ({ role: p.w.role, webLabel: p.w.label, natLabel: p.n.label, score: p.score, web: `${p.w.file}:${p.w.line}`, nat: `${p.n.file}:${p.n.line}`, webClass: p.w.className, webStyle: p.w.styleExpr, natStyle: p.n.styleExpr, natTag: p.n.tag })),
    roleDiffList: roleDiff.map((p) => ({ label: p.w.label, webRole: p.w.role, natRole: p.n.role, web: `${p.w.file}:${p.w.line}`, nat: `${p.n.file}:${p.n.line}` })),
    unpairedList: unpaired.map((u) => ({ role: u.w.role, label: u.w.label, at: `${u.w.file}:${u.w.line}`, natHasRole: u.natHasRole, bestScore: u.bestScore, bestNat: u.bestNat })),
    extraList: extra.slice(0, 200).map((n) => ({ role: n.role, label: n.label, at: `${n.file}:${n.line}` })),
    webUnbound: web.unbound.slice(0, 40), natUnbound: nat.unbound.slice(0, 40),
  };
}

/* ======================================================================= main */
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const { rows } = JSON.parse(readFileSync(`${OUT}/routes.json`, "utf8"));
const { counterparts } = JSON.parse(readFileSync(`${OUT}/native-counterparts.json`, "utf8"));
const target = only ? rows.filter((r) => r.route === only) : rows;

let T = { exact: 0, copy: 0, role: 0, unp: 0, absent: 0, webU: 0, natU: 0 };
for (const row of target) {
  const t0 = Date.now();
  const reg = compareScoped(row, counterparts);
  writeFileSync(`${OUT}/routes-v4/${slug(row.route)}.json`, JSON.stringify(reg, null, 1));
  const p = reg.pairing;
  T.exact += p.exact; T.copy += p.copyDiffers; T.role += p.roleDiffers;
  T.unp += p.unpaired; T.absent += p.unpairedRoleAbsent;
  T.webU += reg.trees.web.unboundExports; T.natU += reg.trees.native.unboundExports;
  console.log(
    `${row.route.padEnd(44)} wf=${String(reg.trees.web.files).padStart(3)} nf=${String(reg.trees.native.files).padStart(3)}` +
    ` | lbl ${String(reg.trees.web.labelled).padStart(4)}/${String(reg.trees.native.labelled).padStart(4)}` +
    ` | exact=${String(p.exact).padStart(3)} copy=${String(p.copyDiffers).padStart(3)} role=${String(p.roleDiffers).padStart(2)}` +
    ` unpaired=${String(p.unpaired).padStart(4)} (roleAbsent ${p.unpairedRoleAbsent}) extra=${p.extraInNative}` +
    ` | ${Date.now() - t0}ms`,
  );
}
console.log("");
console.log("TOTALS  exact:", T.exact, " copyDiffers:", T.copy, " roleDiffers:", T.role, " unpaired:", T.unp, " (roleAbsent", T.absent + ")");
console.log("unbound exports  web:", T.webU, " native:", T.natU);
