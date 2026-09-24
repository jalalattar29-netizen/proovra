/**
 * CONTROL + STATE EXTRACTOR  (AUDIT INSTRUMENT — read-only)
 *
 * Deliverable (D) needs every interactive control on every applicable screen,
 * and the brief forbids an "onPress exists, therefore PASS" verdict. So each
 * control is recorded with what it is WIRED TO, and a control whose handler
 * cannot be resolved to an effect is reported as UNRESOLVED rather than as
 * working.
 *
 * Deliverable (C)/(E) need the four render states per surface. They are
 * detected structurally: a surface that never references a loading, empty,
 * error or success affordance does not have one, whatever its ledger row says.
 *
 * This is SOURCE-INFERRED evidence. It proves a handler is bound and what it
 * calls. It proves nothing about layout, gestures, fonts or whether a tap
 * reaches the server on a real device — those need hardware and are reported
 * separately as UNVERIFIED.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * REPO ROOT — derived from this file, never hardcoded. These instruments live at
 * <repo>/docs/audit/pwa-native-2026-09-24/, so the root is three levels up. An
 * earlier revision pinned "D:/digital-witness", which meant running them from a
 * worktree silently measured the MAIN checkout instead of the branch under test.
 * PROOVRA_AUDIT_REPO overrides it for a deliberate cross-tree comparison.
 */
const REPO = resolve(process.env.PROOVRA_AUDIT_REPO ?? resolve(import.meta.dirname, "..", "..", ".."));
const OUT = resolve(import.meta.dirname, ".");
const rel = (abs) => relative(REPO, abs).split(sep).join("/");

function walkFiles(root, skip = new Set()) {
  const out = [];
  (function w(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) w(full);
      else if (/\.tsx$/.test(e.name)) out.push(full);
    }
  })(root);
  return out;
}

const SKIP = new Set(["node_modules", ".next", ".expo", "dist", "coverage", "android", "ios", "build", "__tests__", "e2e", "test"]);

/* ------------------------------------------------------------- controls */

/** Native: anything that takes onPress / onValueChange / onChangeText / onSubmit. */
const NATIVE_CONTROL = /\b(on(?:Press|LongPress|ValueChange|ChangeText|SubmitEditing|Change|Confirm|Select|Toggle|Refresh))\s*=\s*\{/g;
/** Web: onClick / onSubmit / onChange / href. */
const WEB_CONTROL = /\b(on(?:Click|Submit|Change|KeyDown|Select|Toggle|Input))\s*=\s*\{/g;

/** State affordances, detected by the project's own primitives + generic words. */
const STATE_PATTERNS = {
  loading: /(Loading|isLoading|loading|Skeleton|Spinner|ActivityIndicator|busy|pending)/,
  empty: /(Empty|EmptyState|ProovraEmpty|no .* yet|isEmpty|length === 0|length===0)/,
  error: /(Error|ErrorState|SafeError|toSafeUserError|notifyApiError|catch\s*\()/,
  success: /(success|Success|toast|Toast|confirmed|saved|Saved|notify)/,
};

function analyse(file, controlRe) {
  const src = readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  const controls = [];
  for (const m of src.matchAll(controlRe)) {
    const upto = src.slice(0, m.index);
    const line = upto.split(/\r?\n/).length;
    // capture the handler expression: balanced-ish scan to the matching brace
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let expr = "";
    for (; i < src.length && expr.length < 400; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      if (depth >= 1) expr += ch;
    }
    expr = expr.replace(/^\{/, "").replace(/\s+/g, " ").trim();
    controls.push({ prop: m[1], line, handler: expr.slice(0, 220) });
  }
  const states = {};
  for (const [k, re] of Object.entries(STATE_PATTERNS)) states[k] = re.test(src);
  return { controls, states, loc: lines.length };
}

/**
 * Direct effects visible in an expression, without following any name.
 */
function directKinds(h) {
  const kinds = new Set();
  if (/apiFetch|fetch\(|axios|mutate\(|downloadAsync|uploadAsync|\.post\(|\.patch\(|\.delete\(/.test(h)) kinds.add("API_CALL");
  if (/router\.(push|replace|back|navigate)|Linking\.openURL|navigation\.|redirect\(/.test(h)) kinds.add("NAVIGATION");
  if (/\bset[A-Z]\w*\s*\(/.test(h)) kinds.add("LOCAL_STATE");
  if (/Alert\.alert|window\.confirm|confirm\(|setVisible|openSheet|present\(|showModal|addToast|notify/.test(h)) kinds.add("FEEDBACK_OR_DIALOG");
  return kinds;
}

/** Every identifier this expression could hand control to. */
function referencedNames(h) {
  const names = new Set();
  for (const m of h.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  // bare identifiers / ternary branches: `setEmail`, `a ? doX : doY`
  for (const m of h.matchAll(/(?:^|[?:=>,\s(])([A-Za-z_$][\w$]*)(?=\s*(?:$|[?:,)\s]))/g)) names.add(m[1]);
  for (const m of h.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) names.add(m[1] + "." + m[2]);
  const NOISE = new Set(["void", "async", "await", "if", "return", "const", "let", "true", "false", "null", "undefined", "e", "ev", "event", "item", "String", "Number", "Boolean", "JSON"]);
  for (const n of [...names]) if (NOISE.has(n)) names.delete(n);
  return names;
}

/** Find a local definition body for `name` in `src`. */
function resolveNamed(src, name) {
  if (name.includes(".")) return null;
  const esc = name.replace(/[^\w$]/g, "");
  const res = [
    new RegExp(`(?:const|let)\\s+${esc}\\s*=\\s*(?:useCallback\\s*\\(\\s*)?(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]*)?=>\\s*\\{`, "m"),
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${esc}\\s*\\([^)]*\\)[^{]*\\{`, "m"),
    new RegExp(`(?:const|let)\\s+${esc}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]*)?=>\\s*`, "m"),
  ];
  for (const re of res) {
    const m = re.exec(src);
    if (!m) continue;
    const start = m.index + m[0].length - 1;
    if (src[start] !== "{") return src.slice(start, start + 400);
    let depth = 0;
    let out = "";
    for (let i = start; i < src.length && out.length < 2500; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      if (depth >= 1) out += ch;
    }
    return out;
  }
  return null;
}

/**
 * Classify by following named handlers up to `maxDepth`. A control whose
 * effect cannot be reached is UNRESOLVED — never a pass.
 */
function classifyDeep(src, h, maxDepth = 3) {
  const kinds = new Set();
  const seen = new Set();
  let resolvedAny = false;
  let sawExternal = false;

  (function visit(expr, depth) {
    if (depth > maxDepth || !expr) return;
    for (const k of directKinds(expr)) kinds.add(k);
    for (const name of referencedNames(expr)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (/^set[A-Z]/.test(name)) {
        kinds.add("LOCAL_STATE");
        resolvedAny = true;
        continue;
      }
      const body = resolveNamed(src, name);
      if (body) {
        resolvedAny = true;
        visit(body, depth + 1);
      } else if (name.includes(".") || /^[a-z]/.test(name)) {
        sawExternal = true;
      }
    }
  })(h, 0);

  if (kinds.size > 0) return [...kinds].sort().join("+");
  if (sawExternal && !resolvedAny) return "EXTERNAL_HANDLER_UNRESOLVED";
  if (!h.trim()) return "UNRESOLVED_EMPTY";
  return "UNRESOLVED";
}

/* ------------------------------------------------------------ run both */

const nativeFiles = [
  ...walkFiles(join(REPO, "apps/mobile/app"), SKIP),
  ...walkFiles(join(REPO, "apps/mobile/src"), SKIP),
];
const webFiles = walkFiles(join(REPO, "apps/web/app"), SKIP);

function collect(files, controlRe) {
  const byFile = {};
  for (const abs of files) {
    const r = rel(abs);
    const a = analyse(abs, controlRe);
    if (a.controls.length === 0 && !Object.values(a.states).some(Boolean)) continue;
    const src = readFileSync(abs, "utf8");
    for (const c of a.controls) c.kind = classifyDeep(src, c.handler);
    byFile[r] = a;
  }
  return byFile;
}

const nativeByFile = collect(nativeFiles, NATIVE_CONTROL);
const webByFile = collect(webFiles, WEB_CONTROL);

const tally = (byFile) => {
  let controls = 0;
  const kinds = {};
  const states = { loading: 0, empty: 0, error: 0, success: 0 };
  for (const a of Object.values(byFile)) {
    controls += a.controls.length;
    for (const c of a.controls) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    for (const k of Object.keys(states)) if (a.states[k]) states[k]++;
  }
  return { files: Object.keys(byFile).length, controls, kinds, statesPresentInFiles: states };
};

const summary = { native: tally(nativeByFile), web: tally(webByFile) };
writeFileSync(join(OUT, "controls-and-states.json"), JSON.stringify({ summary, nativeByFile, webByFile }, null, 1));
console.log(JSON.stringify(summary, null, 1));
