#!/usr/bin/env node
/**
 * THE ERROR SURFACE — every rejection the product can produce, and what each
 * client actually SAYS about it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The web app has a 93-entry dictionary turning a backend code into calm,
 * actionable copy. The native app has none: it classifies by HTTP status alone
 * and answers from eight generic sentences. So on a phone, a plan limit, a
 * legal hold, an org-lifecycle refusal and a genuine permission problem are
 * all "You don't have access to this." — and every 409 conflict, which is the
 * shape of most product refusals, reads "Something went wrong. Please try
 * again." for something retrying will never fix.
 *
 * That is not a copy problem. It is the product telling a person the wrong
 * thing about their own work, on the client most likely to be used under
 * pressure.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MEASURES, AND FROM WHAT
 * ---------------------------------------------------------------------------
 * Nothing here is typed by hand. Three inventories are read from the tree:
 *
 *   PRODUCED   every code the API can emit — the `ErrorCode` enum, plus every
 *              string literal handed to `AppError`, `code:` on an error
 *              envelope, or a `denial:` reply.
 *   WEB        the codes `apps/web/lib/feedback/toSafeUserError.ts` maps, plus
 *              any code a web file names directly.
 *   NATIVE     the codes `apps/mobile` names anywhere — a shared dictionary
 *              entry, a screen comparing `err.code`, or a product module.
 *
 * A code PRODUCED and consumed by neither client is not necessarily a defect:
 * plenty are internal, or reach a user only as a status bucket. The rows that
 * matter are the ones a person can actually provoke, and the report ranks by
 * that rather than by count.
 *
 * Usage:  node tools/error-surface-inventory.mjs [--json] [--check]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".expo",
  "ios",
  "android",
  "test-results",
  "playwright-report",
  "audit-output",
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (abs) => relative(REPO, abs).split(sep).join("/");

/** A code is SHOUT_CASE with at least one underscore — never a random word. */
const CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Codes the API can actually emit.
 *
 * Read from the places that PRODUCE one, not from a list somebody keeps: the
 * canonical enum, `new AppError(ErrorCode.X | "X")`, `code: "X"` on a reply,
 * and `denial: "X"` — the capture-trust surfaces answer with that shape.
 */
/**
 * WHERE a code is produced, which is what decides whether anybody can see it.
 *
 * `code:` matches a log line, an audit row and a security event as readily
 * as an error envelope, and treating those as user-facing would demand copy
 * for things no user can reach. The call the occurrence sits inside is read
 * instead — a bounded window back from the match, which is enough to see the
 * receiver.
 */
const OBSERVABILITY_RECEIVER =
  /\b(log(ger)?|req\.log|app\.log|audit\w*|record\w*Audit|emit\w*|track\w*|metric\w*|counter|security\w*Event|captureException|telemetry)\b\s*[.(]/i;

function producedCodes() {
  const found = new Map(); // code -> Set(file)
  const origin = new Map(); // code -> Set(kind)
  const add = (code, file, kind) => {
    if (!CODE_SHAPE.test(code)) return;
    if (!found.has(code)) found.set(code, new Set());
    found.get(code).add(rel(file));
    if (!origin.has(code)) origin.set(code, new Set());
    origin.get(code).add(kind);
  };

  const enumFile = join(REPO, "services/api/src/errors.ts");
  const enumSrc = readFileSync(enumFile, "utf8");
  for (const m of enumSrc.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*"([A-Z][A-Z0-9_]+)"/gm)) {
    add(m[2], enumFile, "ENUM");
  }

  for (const file of walk(join(REPO, "services/api/src"))) {
    const src = readFileSync(file, "utf8");
    const inRoutes = /[/\\]routes[/\\]/.test(file);

    for (const m of src.matchAll(/\bcode:\s*"([A-Z][A-Z0-9_]+)"/g)) {
      const before = src.slice(Math.max(0, m.index - 220), m.index);
      const observability = OBSERVABILITY_RECEIVER.test(before);
      // NOT EVERY `code:` IS AN ERROR.
      //
      // `ACTIVE_LEGAL_HOLD` is a WARNING inside a governance snapshot —
      // `{ code, label, severity }` pushed onto a warnings array — and it
      // already carries its own human label. Counting it as an unanswered
      // error code asks for dictionary copy that would never be shown, and
      // inflates the denominator every coverage claim is measured against.
      //
      // The tell is a sibling `label:` within the same object literal, which
      // an error envelope never has.
      const after = src.slice(m.index, m.index + 220);
      const labelled =
        /\blabel:\s*["'`]/.test(after) &&
        !/\berror:\s*\{/.test(before.slice(-80));
        /\blabel:\s*["'`]/.test(after) &&
        !/\berror:\s*\{/.test(before.slice(-80));
      add(
        m[1],
        file,
        observability
          ? "OBSERVABILITY"
          : labelled
            ? "LABELLED_WARNING"
            : inRoutes
              ? "REPLY"
              : "ENVELOPE",
      );
    }
    for (const m of src.matchAll(/\bdenial:\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], file, "REPLY");
    for (const m of src.matchAll(/new AppError\(\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], file, "THROWN");
    for (const m of src.matchAll(/DirectCaptureError\(\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], file, "THROWN");
  }
  return { found, origin };
}

/**
 * Can a person meet this code?
 *
 * A reply carries it to the client by definition. A thrown domain error does
 * too: the server's handler serialises `err.code` onto the wire
 * (`errors.ts`), which is the whole reason a bounded code exists. An
 * `ENVELOPE` occurrence outside a route file is a service composing the same
 * shape and is treated as reaching a client, because it usually does.
 *
 * Everything else — a code that only ever appears in a log, an audit row or
 * the enum itself — cannot.
 */
function reachabilityOf(kinds) {
  if (kinds.has("REPLY") || kinds.has("THROWN") || kinds.has("ENVELOPE")) return "REACHABLE";
  // A code that only ever appears as a labelled warning reaches a person
  // WITH its own words already attached, so it needs no dictionary entry.
  if (kinds.has("LABELLED_WARNING")) return "LABELLED_WARNING";
  if (kinds.has("OBSERVABILITY")) return "OBSERVABILITY_ONLY";
  return "ENUM_ONLY";
}

/** Codes each client NAMES, and where. */
function clientCodes(root, extra = []) {
  const found = new Map();
  const files = [...walk(join(REPO, root)), ...extra.map((p) => join(REPO, p))];
  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (/\.(test|spec)\.[tm]sx?$/.test(file) || /__tests__/.test(file)) continue;
    for (const m of src.matchAll(/"([A-Z][A-Z0-9_]+)"|'([A-Z][A-Z0-9_]+)'/g)) {
      const code = m[1] ?? m[2];
      if (!CODE_SHAPE.test(code)) continue;
      if (!found.has(code)) found.set(code, new Set());
      found.get(code).add(rel(file));
    }
    // The web dictionary's keys are bare identifiers, not string literals.
    if (file.endsWith("toSafeUserError.ts")) {
      for (const m of src.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*\{/gm)) {
        const code = m[1];
        if (!CODE_SHAPE.test(code)) continue;
        if (!found.has(code)) found.set(code, new Set());
        found.get(code).add(rel(file));
      }
    }
  }
  return found;
}

/** The shared dictionary, when one exists — the goal state for both clients. */
function sharedDictionaryCodes() {
  const file = join(REPO, "packages/shared/src/user-facing-errors.ts");
  const found = new Set();
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return found;
  }
  for (const m of src.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*\{/gm)) {
    if (CODE_SHAPE.test(m[1])) found.add(m[1]);
  }
  return found;
}

export function inventory() {
  const { found: produced, origin } = producedCodes();
  const web = clientCodes("apps/web", ["apps/web/lib/feedback/toSafeUserError.ts"]);
  const native = clientCodes("apps/mobile");
  const shared = sharedDictionaryCodes();

  const rows = [];
  for (const [code, files] of produced) {
    const webFiles = web.get(code);
    const nativeFiles = native.get(code);
    // A code in the SHARED dictionary is answered on both clients: each
    // resolver reads it before falling back to its status buckets. Counting
    // it only where a file happens to name the string would understate the
    // coverage the move created — and understating it is how somebody
    // "fixes" it twice.
    const inShared = shared.has(code);
    const kinds = origin.get(code) ?? new Set();
    const reachability = reachabilityOf(kinds);
    /*
     * A CODE CAN BE ANSWERED BY A RULE RATHER THAN BY AN ENTRY.
     *
     * Both clients map any `*_RETIRED` code to the shared FEATURE_RETIRED
     * copy — web in `toSafeUserError`, native in `safe-error.ts` — because
     * twenty-two routes answer 410 with one and every one of them used to
     * fall through to "review your input and try again".
     *
     * Counting them as unanswered would report a debt that has been paid,
     * and would grow by one every time another endpoint is retired.
     */
    const answeredByRule = /_RETIRED$/.test(code);
    rows.push({
      code,
      reachability,
      producedAs: [...kinds].sort(),
      producedIn: [...files].slice(0, 4),
      producedCount: files.size,
      web: inShared || Boolean(webFiles) || answeredByRule,
      webFiles: webFiles ? [...webFiles].slice(0, 3) : [],
      native: inShared || Boolean(nativeFiles) || answeredByRule,
      nativeFiles: nativeFiles ? [...nativeFiles].slice(0, 3) : [],
      shared: inShared,
      answeredByRule,
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));

  const counts = {
    produced: rows.length,
    web: rows.filter((r) => r.web).length,
    native: rows.filter((r) => r.native).length,
    shared: rows.filter((r) => r.shared).length,
    neither: rows.filter((r) => !r.web && !r.native).length,
    webOnly: rows.filter((r) => r.web && !r.native).length,
    nativeOnly: rows.filter((r) => r.native && !r.web).length,
    reachable: rows.filter((r) => r.reachability === "REACHABLE").length,
    observabilityOnly: rows.filter((r) => r.reachability === "OBSERVABILITY_ONLY").length,
    enumOnly: rows.filter((r) => r.reachability === "ENUM_ONLY").length,
    // THE NUMBER A COVERAGE CLAIM MAY USE. Any denominator that includes
    // codes nobody can meet overstates the gap and understates the work.
    reachableAnsweredOnWeb: rows.filter((r) => r.reachability === "REACHABLE" && r.web).length,
    reachableAnsweredOnNative: rows.filter((r) => r.reachability === "REACHABLE" && r.native).length,
    reachableAnsweredByNeither: rows.filter(
      (r) => r.reachability === "REACHABLE" && !r.web && !r.native,
    ).length,
  };
  return { rows, counts };
}

/* -------------------------------------------------------------------- main */

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { rows, counts } = inventory();
  console.log(
    `error codes produced by the API: ${counts.produced}  ` +
      `(reachable ${counts.reachable}, observability-only ${counts.observabilityOnly}, ` +
      `enum-only ${counts.enumOnly})`,
  );
  console.log(
    `  of the REACHABLE ones: web ${counts.reachableAnsweredOnWeb}  ` +
      `native ${counts.reachableAnsweredOnNative}  ` +
      `answered by neither ${counts.reachableAnsweredByNeither}`,
  );

  if (process.argv.includes("--json")) {
    const out = join(REPO, "docs/architecture/error-surface-inventory.json");
    writeFileSync(out, `${JSON.stringify({ counts, rows }, null, 2)}\n`);
    console.log(`wrote ${rel(out)}`);
  }
}
