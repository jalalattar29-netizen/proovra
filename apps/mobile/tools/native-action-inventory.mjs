#!/usr/bin/env node
/**
 * NATIVE ACTION INVENTORY — what the app lets an ordinary user DO.
 *
 * The route inventory answers "which SURFACES exist natively". F-01 asked a
 * different question at a level nothing measured: which ACTIONS does the app
 * offer, and is any of them Enterprise administration that the web reserves
 * for a console an ordinary user never reaches?
 *
 * A route-level inventory cannot answer it. `/organizations/[id]` is
 * membership-gated and correctly native — routeRegistry.ts:185 says so in
 * words — while the administration BELOW it is enterprise-gated. The two live
 * on the same surface, so the surface's classification tells you nothing about
 * the actions on it.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS ANSWERS IT, AND WHY NOT THE OTHER WAY
 * ---------------------------------------------------------------------------
 * The first version of this file tried to read the CLIENT GATE around each
 * action — the `isOrgOwner(...)` that decides whether a control renders. It
 * reported 115 of 122 actions ungated, because a native surface gates in the
 * JSX that renders the control and the handler it calls is a separate
 * function. A tool that cries wolf 115 times is worse than no tool.
 *
 * So this measures something factual instead: for every WRITE the native app
 * makes, which WEB page makes the same write? The capability map already
 * records both consumers per route, and the product manifest already
 * classifies every web route as NATIVE_REQUIRED or admin/enterprise/marketing.
 * The question becomes a join, and the answer is evidence rather than
 * inference:
 *
 *   MATCHES_WEB     a non-enterprise web page performs the same write. The
 *                   native app is offering what the product offers.
 *   ENTERPRISE_ONLY the only web page performing it is one the registry
 *                   reserves. THIS is an F-01 instance.
 *   NATIVE_ONLY     no web consumer at all — a deliberate native affordance,
 *                   listed so it is reviewed rather than assumed.
 *
 * A client gate is not authorization: the server decides, and every one of
 * these routes is authorized there. What this measures is whether the product
 * OFFERS something it will then refuse — a different defect, which wastes a
 * person's time and misrepresents what their role is.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
const MOBILE = resolve(import.meta.dirname, "..");
const REPO = resolve(MOBILE, "..", "..");
const CAPABILITY_MAP = join(REPO, "docs/architecture/current-runtime-capability-map.json");

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/*
 * READS COUNT, AND THEY WERE NOT COUNTED.
 *
 * The first version of this inventory looked at writes only, on the reasoning
 * that a write is what does damage. That is the wrong question for F-01. The
 * question is whether the app OFFERS an ordinary user something the product
 * reserves for a console they never reach — and showing them an Enterprise
 * console's DATA is exactly that, whether or not they can change it. A
 * governance campaign's findings, another workspace's audit timeline and a
 * platform queue's depth are all reads, and all three would have been
 * invisible to a writes-only instrument.
 *
 * So every method is classified now. `kind` is carried on the row because the
 * two are not the same finding: an Enterprise read is a disclosure and an
 * Enterprise write is an action, and a reader of this inventory is owed the
 * difference.
 */
const CLASSIFIED_METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]);

/**
 * The product manifest's own classification, keyed by the SAME source file the
 * capability map records for a web consumer.
 *
 * Nothing here forms a second opinion about which web routes are reserved: the
 * manifest already decides NATIVE_REQUIRED vs ADMIN_ONLY / ENTERPRISE_ONLY
 * from routeRegistry, and this joins against it.
 *
 * A consumer file the manifest does not know is reported as UNKNOWN_WEB_OWNER
 * and FAILS the check rather than passing it. The first draft of this tool
 * looked up a manifest file that was not there; every web route then read
 * "UNCLASSIFIED", the ENTERPRISE_ONLY verdict could never fire, and it
 * reported a clean result over nothing. A check that cannot fail is not a
 * check — the same lesson the contract audit records.
 */
async function loadClassifications() {
  const { buildManifest } = await import("./derive-product-manifest.mjs");
  const manifest = await buildManifest();
  const byFile = new Map();
  for (const row of manifest.rows) byFile.set(row.sourceFile, row.classification);
  if (byFile.size === 0) throw new Error("the product manifest classified nothing");
  return byFile;
}

const RESERVED = new Set(["ADMIN_ONLY", "ENTERPRISE_ONLY"]);
/** Not a classification — an admission that this tool could not reach one. */
const UNRESOLVED = new Set(["UNKNOWN_WEB_OWNER", "UNOWNED_WEB_FILE"]);

/**
 * WHICH PAGES REACH A GIVEN WEB FILE.
 *
 * A consumer that is not a `page.tsx` — a section, a panel, a hook — has no
 * route classification of its own, and the first version of this tool dropped
 * it as NOT_A_PAGE. That is how two reads the web offers on `/settings` came
 * to be reported as Enterprise-only: their only literal page consumer was a
 * console, and the two components `settings/page.tsx` actually imports were
 * not counted at all.
 *
 * The web's own import graph decides it. Relative specifiers only: a bare
 * package name is not a file in this tree, and an alias would be a second
 * opinion about module resolution that this tool has no business forming.
 */
function buildPageOwnership() {
  const WEB = join(REPO, "apps/web");
  /** file (repo-relative, posix) -> Set of files that import it */
  const importedBy = new Map();
  const files = [];

  const skip = new Set(["node_modules", ".next", "dist", "coverage", "__tests__", "e2e"]);
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  })(WEB);

  const rel = (abs) => relative(REPO, abs).split(sep).join("/");
  const EXTS = ["", ".tsx", ".ts", "/index.tsx", "/index.ts"];

  for (const abs of files) {
    const src = readFileSync(abs, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)) {
      for (const ext of EXTS) {
        const candidate = resolve(dirname(abs), m[1] + ext);
        if (!files.includes(candidate)) continue;
        const key = rel(candidate);
        if (!importedBy.has(key)) importedBy.set(key, new Set());
        importedBy.get(key).add(rel(abs));
        break;
      }
    }
  }

  /** Every page in this repo, so a layout can be resolved to its subtree. */
  const allPages = files.map(rel).filter((f) => /\/page\.tsx?$/.test(f));

  /**
   * A LAYOUT IS RENDERED AROUND EVERY PAGE BENEATH IT, and middleware runs in
   * front of all of them. `NotificationBell` sits in the app shell inside
   * `app/(app)/layout.tsx`: every ordinary user sees it on every page, and a
   * resolver that only walked up to a `page.tsx` concluded nobody rendered it.
   */
  function surfacesRenderedBy(file) {
    if (/\/page\.tsx?$/.test(file)) return [file];
    if (/\/(layout|template)\.tsx?$/.test(file)) {
      const scope = file.replace(/\/(layout|template)\.tsx?$/, "/");
      return allPages.filter((p) => p.startsWith(scope));
    }
    // Middleware runs for the whole estate, so it is owned by all of it.
    if (/^apps\/web\/middleware\.tsx?$/.test(file)) return allPages;
    return [];
  }

  /** Every page that reaches this file, transitively. */
  return function ownersOf(file) {
    // A layout can be the consumer itself — `app/(app)/layout.tsx` calls
    // `POST /v1/auth/logout` directly — and then what it renders is the
    // answer, not who imports it.
    const self = surfacesRenderedBy(file);
    if (self.length > 0) return self;

    const pages = new Set();
    const seen = new Set([file]);
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const importer of importedBy.get(current) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        const rendered = surfacesRenderedBy(importer);
        if (rendered.length > 0) for (const p of rendered) pages.add(p);
        else queue.push(importer);
      }
    }
    return [...pages];
  };
}

/**
 * @param {{ map?: object }} [options] `map` replaces the capability map this
 * reads. It exists so the NEGATIVE tests can hand it an action that MUST be
 * refused and prove the refusal happens — a check whose failure path has never
 * executed is a claim, not a check. Production callers pass nothing.
 */
export async function inventory(options = {}) {
  const map = options.map ?? JSON.parse(readFileSync(CAPABILITY_MAP, "utf8"));
  const classOf = await loadClassifications();
  const ownersOf = buildPageOwnership();

  /**
   * One web consumer's classification.
   *
   * A page carries its own. Anything else carries the classification of the
   * pages that render it: if ANY of them is a surface an ordinary user
   * reaches, the product offers this action to an ordinary user, which is the
   * question being asked. A file no page reaches is UNOWNED_WEB_FILE and
   * fails, because a row nobody can classify is not a pass.
   */
  function classifyWebConsumer(file) {
    const own = classOf.get(file);
    if (own) return { classification: own, via: null };
    if (/\/page\.tsx?$/.test(file)) return { classification: "UNKNOWN_WEB_OWNER", via: null };
    const pages = ownersOf(file);
    if (pages.length === 0) return { classification: "UNOWNED_WEB_FILE", via: null };
    const classified = pages.map((p) => ({ page: p, classification: classOf.get(p) ?? "UNKNOWN_WEB_OWNER" }));
    const unknown = classified.find((c) => c.classification === "UNKNOWN_WEB_OWNER");
    if (unknown) return { classification: "UNKNOWN_WEB_OWNER", via: unknown.page };
    // ONE page is recorded, not all of them: a component in the app shell is
    // rendered by every page in the estate, and a row that names 170 of them
    // is a row nobody reads. The one named is the page that DECIDED the
    // verdict, which is the only one a reviewer needs to check.
    const open = classified.find((c) => !RESERVED.has(c.classification));
    const decided = open ?? classified[0];
    return { classification: decided.classification, via: decided.page, viaCount: pages.length };
  }

  const rows = [];
  for (const route of map.routes) {
    const [method, path] = route.routeId.split(" ");
    if (!CLASSIFIED_METHODS.has(method)) continue;

    const consumers = route.productConsumers ?? [];
    const native = consumers.filter((c) => c.class === "MOBILE");
    if (native.length === 0) continue;

    const web = consumers.filter((c) => c.class === "WEB");
    // Every web consumer is classified, including the ones that are not
    // pages: a section or a hook carries the classification of the pages that
    // render it.
    const owners = web.map((c) => ({ file: c.file, ...classifyWebConsumer(c.file) }));

    /*
     * ONE OPEN OWNER SETTLES IT. The question is whether the product offers
     * this action to an ordinary user; a single surface an ordinary user
     * reaches answers yes, whatever else also performs it. Unresolved owners
     * only decide a row that has no open owner at all — there, the difference
     * between "reserved" and "we could not tell" still matters and is not
     * guessed.
     */
    const OPEN = (o) => !RESERVED.has(o.classification) && !UNRESOLVED.has(o.classification);
    let verdict;
    if (web.length === 0) verdict = "NATIVE_ONLY";
    else if (owners.some(OPEN)) verdict = "MATCHES_WEB";
    else if (owners.some((o) => o.classification === "UNKNOWN_WEB_OWNER")) {
      verdict = "UNKNOWN_WEB_OWNER";
    } else if (owners.some((o) => o.classification === "UNOWNED_WEB_FILE")) {
      verdict = "UNOWNED_WEB_FILE";
    } else {
      verdict = "ENTERPRISE_ONLY";
    }

    rows.push({
      routeId: route.routeId,
      method,
      kind: WRITE_METHODS.has(method) ? "WRITE" : "READ",
      path,
      gates: route.gates ?? [],
      securityFamily: route.primarySecurityFamily ?? null,
      nativeSites: native.map((c) => `${c.file}:${c.line}`),
      webOwners: owners,
      verdict,
    });
  }

  rows.sort((a, b) => a.routeId.localeCompare(b.routeId));
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
  const byKind = rows.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {});
  return { rows, counts, byKind };
}

/**
 * NAVIGATION AND VISIBLE CONTROLS — where the app POINTS.
 *
 * A control that links into a reserved web console makes no API call, so the
 * route join above cannot see it, and it is an F-01 instance in its own right:
 * the user is offered a surface the product does not let them have.
 *
 * The reserved prefixes are the manifest's, so a console added to the web is
 * covered the day it is added. A URL the server minted — a presigned download,
 * a TOTP URI, a mailto: — is not a native decision about where a person may go
 * and is not a literal path here anyway.
 *
 * @param {{ classOf?: Map<string,string>, sources?: Array<{file: string, text: string}> }} [options]
 * Both exist for the NEGATIVE tests, which hand this a source file containing
 * a link that MUST be refused and prove the refusal happens.
 */
export async function navigationOffers(options = {}) {
  const classOf = options.classOf ?? (await loadClassifications());

  /**
   * A web route's own path, from the file the manifest classified.
   *
   * A dynamic segment matches one segment, not everything below its parent.
   * The first version took the static prefix — `/organizations/[id]/admin/
   * overview` became `/organizations` — and reported the native Spaces
   * screen's link to `/organizations` as an offer of Enterprise
   * administration. `/organizations` is NATIVE_REQUIRED in the manifest's own
   * table; the tool had reclassified an open surface by truncating it.
   */
  function toPattern(file) {
    const m = /^apps\/web\/app\/(.*)\/page\.tsx?$/.exec(file);
    if (!m) return null;
    const path = "/" + m[1].replace(/\((?:[^/)]+)\)\//g, "").replace(/\(([^/)]+)\)$/, "");
    const source = path
      .split("/")
      .filter(Boolean)
      .map((seg) => (seg.startsWith("[") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/");
    return { path, re: new RegExp(`^/${source}(?:/|$)`) };
  }

  const reserved = [];
  /** Open surfaces, so a literal that IS one is never read as a reserved one. */
  const open = [];
  for (const [file, classification] of classOf) {
    const p = toPattern(file);
    if (!p) continue;
    (RESERVED.has(classification) ? reserved : open).push({ ...p, file, classification });
  }
  // Longest first, so a finding names the most specific surface it matched.
  reserved.sort((a, b) => b.path.length - a.path.length);

  const sources = options.sources ?? readNativeSources();
  const findings = [];
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/["'`](\/[A-Za-z0-9/_-]{2,})["'`]/g)) {
      const literal = m[1];
      // An exact open surface wins: `/organizations` is a surface of its own,
      // whatever is reserved below it.
      if (open.some((o) => o.path === literal)) continue;
      const hit = reserved.find((r) => r.re.test(literal));
      if (!hit) continue;
      findings.push({
        file,
        literal,
        webSurface: hit.path,
        classification: hit.classification,
        line: text.slice(0, m.index).split("\n").length,
      });
    }
  }
  return { findings, reservedPaths: reserved.map((r) => r.path) };
}

function readNativeSources() {
  const out = [];
  const skip = new Set(["node_modules", "ios", "android", ".expo", "test", "tools", "docs"]);
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push({ file: relative(REPO, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
      }
    }
  })(MOBILE);
  return out;
}

/* -------------------------------------------------------------------- main */

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { rows, counts, byKind } = await inventory();
  console.log(
    `native actions: ${rows.length} (READ ${byKind.READ ?? 0}, WRITE ${byKind.WRITE ?? 0})  ` +
      Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join("  "),
  );
  for (const r of rows) {
    if (r.verdict === "ENTERPRISE_ONLY") {
      // `webRoutes` never existed on a row. This line had never executed,
      // because the verdict it prints had never fired: a writes-only
      // instrument could not reach it. The first Enterprise READ found
      // crashed the reporter, which is its own small lesson about checks
      // whose failure path has never run.
      console.log(
        `  ENTERPRISE_ONLY ${r.kind} ${r.routeId}\n    native: ${r.nativeSites.join(", ")}\n` +
          `    web:    ${r.webOwners.map((o) => `${o.file} [${o.classification}]`).join(", ")}`,
      );
    }
  }
  for (const r of rows) {
    if (r.verdict === "NATIVE_ONLY") console.log(`  NATIVE_ONLY ${r.routeId}  (${r.nativeSites[0]})`);
  }
  const nav = await navigationOffers();
  console.log(
    `navigation: ${nav.findings.length} link(s) into a reserved web surface ` +
      `(${nav.reservedPaths.length} reserved surfaces checked)`,
  );
  for (const f of nav.findings) {
    console.log(`  RESERVED_LINK ${f.file}:${f.line} -> ${f.literal} [${f.classification}]`);
  }

  if (process.argv.includes("--json")) {
    const out = join(MOBILE, "docs", "native-action-inventory.json");
    writeFileSync(out, `${JSON.stringify({ counts, byKind, navigation: nav, rows }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
  // Both are failures: an Enterprise action offered natively, and a web owner
  // this tool could not classify — an unclassified row is not a pass.
  const bad =
    (counts.ENTERPRISE_ONLY ?? 0) +
    (counts.UNKNOWN_WEB_OWNER ?? 0) +
    (counts.UNOWNED_WEB_FILE ?? 0) +
    nav.findings.length;
  if (process.argv.includes("--check") && bad > 0) process.exit(1);
}
