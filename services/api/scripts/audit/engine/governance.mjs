/**
 * PHASE 0 §2/§3 — THE AUDIT SYSTEM AUDITS ITSELF.
 *
 * Why this is a program and not a table
 * ---------------------------------------------------------------------------
 * Phase 0 requires a list of zeros: no unclassified audit file, no artifact
 * with two producers, no gate reading a historical report, no second route
 * scanner. A table in a report cannot prove any of those, because a file added
 * after the table was written is simply absent from it — which is exactly the
 * failure mode this whole programme keeps finding in the code it audits.
 *
 * So the inventory and the dependency graph are RE-DERIVED on every run, from
 * the tree, by reading each candidate file and recording what it actually
 * imports, spawns, reads and writes. The registry says which authority is
 * canonical; this file checks that claim against the evidence and refuses it
 * when a second file claims the same subject.
 *
 * It reads source text to find `import`/`readFileSync`/`spawn` edges. That is
 * NOT a second route or consumer parser: it never classifies a route, never
 * matches a request path, and never produces a count about the product. Its
 * subject is the audit system's own files.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import {
  REPO,
  CANONICAL,
  DIAGNOSTICS,
  DOMAIN_AUTHORITIES,
  DELEGATES,
  RETIRED,
  HISTORICAL_PREFIXES,
  HISTORICAL_MARKER,
  CONTINUATION_CHECKPOINT,
  HISTORICAL_DOCUMENTS,
  DOMAIN_REPORT_TEMPLATES,
  FORBIDDEN_IN_REPO_RECOVERY_PREFIX,
  PHASE0_AUTHORSHIP_MARKERS,
  PHASE0_ENGINE_REFERENCES,
  CHANGED_PATH_CLASSES,
  ENGINE_GENERATED_PATHS,
  REPORT_ROLES,
  PRODUCTION_RUNTIME_ROOTS,
  RECOVERY_MANIFEST_BASENAME,
  isHistorical,
  INVENTORY_SCHEMA_VERSION,
} from "./registry.mjs";

const rel = (abs) => path.relative(REPO, abs).split(path.sep).join("/");
const read = (abs) => readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
const sha256 = (v) => createHash("sha256").update(v).digest("hex");

const SKIP_DIR = /^(node_modules|\.git|\.next|dist|build|coverage|\.turbo|\.expo|\.p12snapshot)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// ===========================================================================
// CANDIDATE SET — what counts as "audit-related".
//
// Deliberately generous. A file that is swept in and turns out to be a product
// test is classified PRODUCT_BEHAVIOR_TEST and left alone; a file that is
// MISSED is invisible to every counter below, which is the more dangerous
// error. The role globs from the Phase-0 mandate are the floor, not the ceiling.
// ===========================================================================

const NAME_SIGNALS =
  /(audit|verify|verifier|gate|ledger|capabilit|closure|reconcil|proof|reachab|coverage-manifest|authority|governance)/i;

const CANDIDATE_ROOTS = [
  "services/api/scripts",
  "services/api/test",
  "services/worker/test",
  "apps/web/__tests__",
  "scripts",
  "audit-output",
  "docs/architecture",
  ".github/workflows",
  "e2e",
];

/**
 * Name-based candidacy. NOT sufficient on its own.
 *
 * `phase-r9-duplicate-route-guard.test.ts` contains a repository-wide route
 * inventory and matches none of the signal words — a name-only sweep would
 * have reported zero independent scanners while three of them were live. So
 * every code file under the candidate roots is also READ, and content that
 * builds a route or consumer inventory makes the file a candidate regardless of
 * what it is called.
 */
function isNamedCandidate(r) {
  if (r.startsWith("audit-output/")) return true;
  if (r.startsWith("services/api/scripts/audit/")) return true;
  if (r.startsWith("services/api/scripts/capability-authority/")) return true;
  if (!/\.(ts|tsx|mjs|mts|js|json|md|ya?ml)$/.test(r)) return false;
  return NAME_SIGNALS.test(path.basename(r)) || NAME_SIGNALS.test(r);
}

/**
 * A third candidacy rule, and the one that catches what the other two cannot.
 *
 * `_canonical-facts.ts` is the module every migrated gate reads the route
 * inventory through. It matches no signal word and builds no inventory of its
 * own, so it was invisible to the audit system's own inventory — which then
 * reported that the facts artifact had no consuming gate while five suites were
 * consuming it through exactly that file. Touching the engine or a canonical
 * artifact is what makes a file part of the audit system; its name is not.
 */
const CANONICAL_REFERENCES = [
  "capability-authority/",
  "audit/engine/",
  "_canonical-facts",
  "current-runtime-capability-map.json",
  "architecture-facts.json",
];
const referencesCanonical = (text) => CANONICAL_REFERENCES.some((s) => text.includes(s));

// ===========================================================================
// EDGE EXTRACTION
// ===========================================================================

/** Static + dynamic module specifiers. */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import\s[^;\n]*?from\s*|import\s*)["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*[`"']([^`"']+)[`"']/g;

/** A path literal that names a repo artifact — how a gate reads a fact. */
const ARTIFACT_RE =
  /["'`]((?:audit-output|docs\/architecture)\/[A-Za-z0-9._/-]+\.(?:json|md))["'`]/g;

/** A bare artifact FILENAME joined onto a directory constant, e.g. join(DIR, "rows.json"). */
const ARTIFACT_BASENAME_RE =
  /["'`]([A-Za-z0-9._-]+\.(?:json|md))["'`]/g;

const WRITE_RE = /\bwriteFileSync\s*\(|\bwriteFile\s*\(|\bfs\.promises\.writeFile\s*\(/;

/**
 * Read/write direction, per artifact, per file.
 *
 * The first version of this asked only "does the file contain a write?" and,
 * if so, called every artifact it mentioned an output. That made a generator
 * which READS ITS OWN OUTPUT structurally invisible — the one shape §3 names
 * explicitly — because the read was overwritten by the write. So direction is
 * now resolved per call site.
 *
 * A path reaches `readFileSync` either as a literal or through a constant, so
 * the denoting expressions are collected first: the literal, its basename, and
 * any `const NAME = …` whose initialiser mentions either.
 */
/**
 * Locally-defined helpers that read a file.
 *
 * `const read = (rel) => readFileSync(resolve(REPO, rel), "utf8")` is how
 * almost every gate in this tree actually reads an artifact, so looking only
 * for a literal `readFileSync(PATH` reported the facts artifact and the
 * capability map as having no consuming gate while five suites were reading
 * them. Resolving one hop of indirection is the difference between a detector
 * that describes the tree and one that describes a coding style.
 */
function localReaderNames(text) {
  const out = new Set(["readFileSync", "readFile"]);
  const arrow = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*([\s\S]{0,200}?)(?:;|\n\n)/g;
  const fn = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{([\s\S]{0,400}?)\n\}/g;
  for (const re of [arrow, fn]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (/\breadFileSync\s*\(|\breadFile\s*\(/.test(m[2])) out.add(m[1]);
    }
  }
  return [...out];
}

function directionFor(text, artifactRel) {
  const base = path.basename(artifactRel);
  const names = new Set();
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const constRe = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;\\n]*["'\`](?:${escape(artifactRel)}|${escape(base)})["'\`]`,
    "g",
  );
  let m;
  while ((m = constRe.exec(text)) !== null) names.add(m[1]);

  const denote = [
    `["'\`]${escape(artifactRel)}["'\`]`,
    ...[...names].map((n) => `${escape(n)}\\b`),
  ].join("|");
  const near = (fn) => new RegExp(`\\b${escape(fn)}\\s*\\(\\s*(?:${denote})`).test(text);
  // `join(DIR, "rows.json")` — the call wraps the denoting expression.
  const nearJoined = (fn) =>
    new RegExp(`\\b${escape(fn)}\\s*\\([^)\\n]{0,120}["'\`]${escape(base)}["'\`]`).test(text);

  const readers = localReaderNames(text);
  return {
    reads: readers.some((fn) => near(fn) || nearJoined(fn)),
    writes: near("writeFileSync") || near("writeFile") || nearJoined("writeFileSync"),
  };
}

const SPAWN_RE =
  /\b(?:spawnSync|spawn|execFileSync|execFile|execSync)\s*\([^)]*?["'`]([^"'`]*(?:\.mjs|\.ts|\.js))["'`]/g;

function matchAll(re, text, groups = [1]) {
  const out = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const g of groups) if (m[g]) out.add(m[g]);
  }
  return [...out];
}

/** Resolve a relative module specifier against the importing file. */
function resolveSpecifier(fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const abs = path.resolve(REPO, path.dirname(fromRel), spec);
  const candidates = [abs, `${abs}.mjs`, `${abs}.ts`, `${abs}.js`, path.join(abs, "index.mjs")];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return rel(c);
  }
  return null;
}

// ===========================================================================
// ROLE CLASSIFICATION
//
// Exactly one primary role per file. Order matters: the first rule that
// matches wins, and the rules are ordered most-specific first. A file that
// matches nothing is UNKNOWN — deliberately, so a new kind of audit file fails
// the gate rather than being swept into a bucket.
// ===========================================================================

const canonicalEngineSet = new Set(CANONICAL.engineComponents);
const delegateSet = new Set(DELEGATES.map((d) => d.path));
const domainArtifactSet = new Set(DOMAIN_AUTHORITIES.map((d) => d.artifact));
const domainProducerSet = new Set(
  DOMAIN_AUTHORITIES.map((d) => d.producer).filter((p) => p !== "REVIEWED_BY_HUMAN"),
);

/**
 * PHASE 0 CORRECTIVE §8 — the four ledger files have FOUR roles, not one.
 *
 * They were all classified `CANONICAL_FINDINGS_LEDGER`, which reads as four
 * ledgers and is the exact ambiguity ("which of these is the authority?") that
 * a consolidation is supposed to end. Exactly one is the SOURCE; the others are
 * the validator that reads it and the two renderings it produces.
 */
const LEDGER_ROLE = new Map([
  [CANONICAL.findingsLedger.rows, "CANONICAL_LEDGER_SOURCE"],
  [CANONICAL.findingsLedger.producer, "LEDGER_VALIDATOR_OR_GENERATOR"],
  ...CANONICAL.findingsLedger.derived.map((d) => [d, "GENERATED_LEDGER_RENDERING"]),
]);

const LEDGER_ROLE_REASON = Object.freeze({
  CANONICAL_LEDGER_SOURCE:
    "THE findings authority. Every count in the system derives from these rows; nothing else may state one.",
  LEDGER_VALIDATOR_OR_GENERATOR:
    "Reads the rows, refuses an inadmissible set, and renders the derived forms. It holds the rules, not the findings.",
  GENERATED_LEDGER_RENDERING:
    "An OUTPUT of the rows, not a second ledger. Regenerated on every run; never edited and never read as a source.",
});

const diagnosticSet = new Set(DIAGNOSTICS.map((d) => d.path));

const generatedCurrentSet = new Set([
  CANONICAL.capabilityMap.path,
  CANONICAL.currentFacts.path,
  CANONICAL.governanceInventory.path,
]);

/**
 * Does this file build its OWN inventory of registered routes or of client
 * request sites? That is the duplicate-authority shape Phase 0 exists to end.
 *
 * A per-handler slice (`indexOf('"/v1/evidence/bulk"')` then scan to the next
 * registration) is NOT an inventory: it locates one handler in one file to
 * assert something about that handler's body. The test below is whether the
 * file accumulates registrations across a DIRECTORY walk — which is the only
 * way to arrive at a total.
 */
function scannerSignals(text) {
  // A regex LITERAL matching Fastify registrations, i.e. the source contains
  // the characters `app\.(get|post`. Written escaped because we are looking for
  // a regex in someone else's file, not applying one.
  const hasRouteRegistrationRegex = /app\\\.\(get\|post/.test(text);
  // A regex LITERAL matching client request sites, i.e. `apiFetch\(`.
  const hasApiFetchRegex = /apiFetch\\\(/.test(text);
  // Two further conditions, and both are needed to tell an INVENTORY from a
  // product assertion that happens to contain the same regex.
  //
  // ENUMERATION — it walks a directory rather than reading one file it named.
  //   `expect(MODEL).not.toMatch(/\bapiFetch\(/)` on a single page component is
  //   a product-behaviour assertion, not a measurement of the tree.
  //
  // ACCUMULATION OF THAT REGEX — it runs THIS regex to exhaustion. The check
  //   has to be tied to the specific pattern: a navigation test that calls
  //   `matchAll(/href:\s*"([^"]+)"/g)` and separately mentions `apiFetch\(` in
  //   one assertion satisfies "enumerates" and "accumulates something", and was
  //   reported as a duplicate route authority until this was narrowed. Counting
  //   an innocent file is not a harmless over-report — it is the same defect as
  //   under-counting, arriving from the other side.
  const enumerates = /\breaddirSync\s*\(|\bwalk\s*\(|\breaddir\s*\(/.test(text);
  const exhaustive = (pattern) => {
    // `x.matchAll(/…pattern…/g)`, allowing the regex to start on the next line.
    if (new RegExp(`\\.matchAll\\s*\\([\\s\\S]{0,40}?${pattern}`).test(text)) return true;
    // `const RE = /…pattern…/g` … later `RE.exec(` or `RE.matchAll(`.
    const named = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[\\s\\S]{0,80}?${pattern}`,
      "g",
    );
    let m;
    while ((m = named.exec(text)) !== null) {
      if (new RegExp(`\\b${m[1]}\\s*\\.\\s*(?:exec|matchAll)\\s*\\(`).test(text)) return true;
    }
    return false;
  };
  // `.source` rather than a hand-escaped string: these patterns look for a
  // regex inside someone else's file, so the double layer of escaping is
  // exactly the kind of detail that silently mis-states an answer.
  const ROUTE_PATTERN = /app\\\.\(get\|post/.source;
  const FETCH_PATTERN = /apiFetch\\\(/.source;

  return {
    independentRouteInventory:
      hasRouteRegistrationRegex &&
      /src\/routes/.test(text) &&
      enumerates &&
      exhaustive(ROUTE_PATTERN),
    independentConsumerInventory:
      hasApiFetchRegex && /apps\/web/.test(text) && enumerates && exhaustive(FETCH_PATTERN),
  };
}

function classify(r, text) {
  if (r === HISTORICAL_MARKER)
    return {
      role: "HISTORY_TREE_MARKER",
      reason:
        "The sign on the door of the history tree, not a record in it. The Phase-0 gate READS it to prove the sign is still up, so it is deliberately outside the historical set.",
    };
  if (Object.hasOwn(HISTORICAL_DOCUMENTS, r))
    return { role: "HISTORICAL_REPORT", reason: HISTORICAL_DOCUMENTS[r] };
  if (Object.hasOwn(DOMAIN_REPORT_TEMPLATES, r))
    return { role: "DOMAIN_REPORT_TEMPLATE", reason: DOMAIN_REPORT_TEMPLATES[r] };
  if (isHistorical(r)) {
    return /\.(md|txt)$/i.test(r)
      ? { role: "HISTORICAL_REPORT", reason: "Record of a completed pass; carried under audit-output/history/, which is the status." }
      : { role: "HISTORICAL_PROOF", reason: "Machine record of a completed pass; carried under audit-output/history/, which is the status." };
  }
  if (r === CONTINUATION_CHECKPOINT)
    return {
      role: "CONTINUATION_CHECKPOINT",
      reason:
        "The ONE resume note for work in progress. It states where execution stopped and what runs next; it is not a report and asserts no count of its own — every number in it is copied from the generated facts and is re-derivable by running the engine.",
    };
  if (r === CANONICAL.orchestrator.path)
    return { role: "CANONICAL_ORCHESTRATOR", reason: "The single externally-callable current-audit command." };
  if (canonicalEngineSet.has(r))
    return { role: "CANONICAL_ENGINE_COMPONENT", reason: "Registered component of the one canonical audit engine." };
  if (delegateSet.has(r))
    return { role: "DEPRECATED_DELEGATE", reason: "Backward-compatible name that forwards to the canonical evaluator and holds no opinion." };
  if (r === CANONICAL.currentReport.path)
    return { role: "CURRENT_GENERATED_REPORT", reason: "The one current human-readable report. Rendered from the facts artifact and the ledger's derived totals; it has no place to type a number into." };
  if (LEDGER_ROLE.has(r))
    return { role: LEDGER_ROLE.get(r), reason: LEDGER_ROLE_REASON[LEDGER_ROLE.get(r)] };
  if (diagnosticSet.has(r))
    return { role: "DIAGNOSTIC_NOT_AUTHORITY", reason: "Reproducible observation, deliberately outside the classification. No gate may read it and it claims no sourceOfTruthFor." };
  if (generatedCurrentSet.has(r))
    return { role: "GENERATED_CURRENT_ARTIFACT", reason: "Written only by the canonical engine; every scalar derived." };
  if (domainArtifactSet.has(r) || domainProducerSet.has(r))
    return { role: "DOMAIN_AUTHORITY", reason: "Authority for a genuinely separate domain, orchestrated by the canonical command and never re-deriving routes, consumers, capabilities or findings." };
  if (r.startsWith("services/api/scripts/capability-authority/manifests/"))
    return { role: "DOMAIN_AUTHORITY", reason: "Reviewed-judgement manifest; each entry names the source evidence it was read from." };

  if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(r)) {
    const sig = scannerSignals(text);
    const readsEngine =
      /capability-authority|generate-runtime-capability-map|architecture-facts\.json|audit\/engine/.test(text);
    if (sig.independentRouteInventory || sig.independentConsumerInventory)
      return {
        role: "OBSOLETE_DUPLICATE",
        reason: "Builds its own repository-wide route or consumer inventory — a second authority for a subject the AST engine already measures.",
      };
    if (readsEngine)
      return { role: "AUDIT_ENGINE_TEST", reason: "Drives the canonical engine or validates a current artifact." };
    return { role: "PRODUCT_BEHAVIOR_TEST", reason: "Asserts product behaviour or a product security posture; not audit infrastructure." };
  }

  // Any remaining audit-shaped Markdown is UNKNOWN on purpose. The catch-all it
  // replaces called every such file a "current report template", which is how
  // thirteen finished narratives came to advertise themselves as current. A new
  // document must now be dispositioned explicitly — historical, domain
  // narrative, or the one generated report — instead of being swept up.
  if (r.startsWith(".github/workflows/"))
    return { role: "CI_DEFINITION", reason: "Continuous-integration definition; carries no audit count and states no authority." };
  if (r.endsWith(".json"))
    return { role: "DOMAIN_AUTHORITY", reason: "Curated architecture artifact for a single domain, consumed rather than re-derived." };
  if (/\.(mjs|ts|js|mts)$/.test(r)) {
    const sig = scannerSignals(text);
    if (sig.independentRouteInventory || sig.independentConsumerInventory)
      return { role: "OBSOLETE_DUPLICATE", reason: "Independent route/consumer scanner competing with the AST engine." };
    return { role: "DOMAIN_AUTHORITY", reason: "Single-domain verifier or generator, orchestrated by the canonical command." };
  }
  return { role: "UNKNOWN", reason: "Matched no classification rule." };
}

// ===========================================================================
// THE INVENTORY
// ===========================================================================

export function buildInventory() {
  const files = [];
  const textOf = new Map();
  for (const root of CANDIDATE_ROOTS) {
    const absRoot = path.join(REPO, root);
    if (!existsSync(absRoot)) continue;
    for (const f of walk(absRoot)) {
      const r = rel(f);
      if (!/\.(ts|tsx|mjs|mts|js|json|md|ya?ml)$/.test(r)) continue;
      let text = "";
      try {
        text = read(f);
      } catch {
        text = "";
      }
      const isCode = /\.(ts|tsx|mjs|mts|js)$/.test(r);
      const sig = isCode ? scannerSignals(text) : null;
      const carriesInventory = Boolean(sig?.independentRouteInventory || sig?.independentConsumerInventory);
      if (!isNamedCandidate(r) && !carriesInventory && !(isCode && referencesCanonical(text)))
        continue;
      files.push(r);
      textOf.set(r, text);
    }
  }
  files.sort();

  const packageScripts = collectPackageScripts();
  const ciText = collectCiText();

  const records = new Map();
  for (const r of files) {
    const text = textOf.get(r) ?? "";
    const isCode = /\.(ts|tsx|mjs|mts|js)$/.test(r);
    const specs = isCode ? matchAll(IMPORT_RE, text, [1, 2, 3]) : [];
    const imports = specs.map((s) => resolveSpecifier(r, s)).filter(Boolean);
    const spawned = isCode
      ? matchAll(SPAWN_RE, text).map((s) => resolveSpecifier(r, s) ?? s).filter(Boolean)
      : [];

    // Artifact edges. A literal repo path is unambiguous; a bare basename is
    // only credited when it is a basename the audit system actually owns,
    // which keeps `join(LEDGER_DIR, "rows.json")` visible without inventing
    // an edge for every string that ends in `.json`.
    const artifactPaths = isCode ? matchAll(ARTIFACT_RE, text) : [];
    const basenames = isCode ? matchAll(ARTIFACT_BASENAME_RE, text) : [];
    const owned = new Map(
      [
        ...generatedCurrentSet,
        CANONICAL.currentReport.path,
        ...LEDGER_ROLE.keys(),
        ...diagnosticSet,
        ...domainArtifactSet,
      ]
        .filter((p) => /\.(json|md)$/.test(p))
        .map((p) => [path.basename(p), p]),
    );
    for (const b of basenames) {
      const full = owned.get(b);
      if (full && !artifactPaths.includes(full)) artifactPaths.push(full);
    }

    const writes = [];
    const reads = [];
    const declares = [];
    for (const a of artifactPaths) {
      if (!isCode) {
        declares.push(a);
        continue;
      }
      const dir = directionFor(text, a);
      if (dir.writes) writes.push(a);
      // Both directions are recorded when both are present — that IS the
      // self-read finding, and collapsing it to one direction is how it hid.
      if (dir.reads) reads.push(a);
      // MENTIONED but neither read nor written. This is a DECLARATION, and
      // calling it a read was wrong in a way that mattered: `registry.mjs`
      // names every historical document precisely so the engine can refuse
      // them, and the engine then reported the registry itself as a current
      // tool reading twelve historical records. A file that says "this path is
      // historical" is not consuming it.
      if (!dir.reads && !dir.writes) declares.push(a);
    }

    const { role, reason } = classify(r, text);
    records.set(r, {
      path: r,
      role,
      reason,
      imports,
      importedBy: [],
      spawns: spawned,
      readsArtifacts: reads,
      writesArtifacts: writes,
      declaresArtifacts: declares,
      packageScripts: packageScripts.filter((s) => s.command.includes(path.basename(r))).map((s) => s.id),
      ciConsumers: ciText.includes(path.basename(r)) ? ["ci"] : [],
      sourceOfTruthFor: sourceOfTruthFor(r),
      disposition: "RETAINED",
    });
  }

  for (const rec of records.values()) {
    for (const dep of rec.imports) {
      const target = records.get(dep);
      if (target) target.importedBy.push(rec.path);
    }
  }

  return { records, packageScripts, ciText };
}

function sourceOfTruthFor(r) {
  const claims = [];
  if (r === CANONICAL.orchestrator.path) claims.push(CANONICAL.orchestrator.sourceOfTruthFor);
  if (r === CANONICAL.routeAuthority.path) claims.push(CANONICAL.routeAuthority.sourceOfTruthFor);
  if (r === CANONICAL.consumerAuthority.path) claims.push(CANONICAL.consumerAuthority.sourceOfTruthFor);
  if (r === CANONICAL.capabilityMap.path) claims.push(CANONICAL.capabilityMap.sourceOfTruthFor);
  if (r === CANONICAL.currentFacts.path) claims.push(CANONICAL.currentFacts.sourceOfTruthFor);
  if (r === CANONICAL.governanceInventory.path) claims.push(CANONICAL.governanceInventory.sourceOfTruthFor);
  if (r === CANONICAL.findingsLedger.rows) claims.push(CANONICAL.findingsLedger.sourceOfTruthFor);
  if (r === CANONICAL.currentReport.path) claims.push(CANONICAL.currentReport.sourceOfTruthFor);
  for (const d of DOMAIN_AUTHORITIES) if (d.artifact === r) claims.push(d.domain);
  return claims;
}

function collectPackageScripts() {
  const out = [];
  for (const pkg of [
    "package.json",
    "services/api/package.json",
    "services/worker/package.json",
    "apps/web/package.json",
  ]) {
    const abs = path.join(REPO, pkg);
    if (!existsSync(abs)) continue;
    const json = JSON.parse(read(abs));
    for (const [name, command] of Object.entries(json.scripts ?? {})) {
      out.push({ id: `${pkg}:${name}`, pkg, name, command: String(command) });
    }
  }
  return out;
}

/**
 * Every path git reports as changed, renames resolved to their NEW name.
 * Names only — no contents are read here, so nothing sensitive can transit.
 */
/**
 * Stashes that the audit tooling created and did not clean up.
 *
 * A `__probe` stash was left behind by this programme once already. It was
 * harmless — but "harmless" was only established afterwards, by hand, by
 * comparing every blob in it against HEAD and the worktree. A counter costs
 * nothing and makes the next one visible on the run that creates it.
 *
 * Matched by NAME, deliberately narrowly: the user's own stashes are their
 * business and must never be counted, let alone touched.
 */
function temporaryAuditStashes() {
  let list;
  try {
    list = execFileSync("git", ["stash", "list"], { cwd: REPO, encoding: "utf8" });
  } catch {
    return [];
  }
  return list
    .split("\n")
    .filter(Boolean)
    .filter((line) => /__probe|__audit|phase0-temp|audit-temp/i.test(line));
}

/**
 * PHASE 0 MICRO-CORRECTION §4 — the change set, derived from the baseline.
 *
 * HEAD is the baseline: a real commit, hashed, verifiable, and the commit this
 * whole pass started from. `git status --porcelain` against it yields the
 * COMPLETE set of differing paths, which is the property the hand-maintained
 * prefix list did not have — a path nobody remembered to declare was simply
 * absent from the count computed over it.
 *
 * Each path gets a status (ADDED / MODIFIED / DELETED), a class, and an
 * attribution. Attribution is content-derived from the lines ADDED relative to
 * HEAD, so a pre-existing mention in the committed file cannot create a false
 * positive, and a file Phase 0 wrote into cannot escape by not being on a list.
 */
function derivePhase0ChangeSet() {
  let porcelain;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return {
      baseline: null,
      entries: [],
      selfGeneratedDeclared: [...ENGINE_GENERATED_PATHS].sort(),
      undeclaredSelfGeneratedExclusions: 0,
    };
  }

  let head = null;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    /* no git */
  }

  /**
   * The `+` side of the whole diff, split per file, from ONE subprocess.
   *
   * The first version ran `git diff HEAD -- <path>` once per changed path.
   * With 146 changed paths that is 146 process spawns on every evaluation, and
   * it pushed the governance suite past vitest's 5s default the moment the full
   * test run loaded the machine — a self-inflicted flake in the gate that is
   * supposed to be the reliable one. One diff, split locally, is the same
   * answer for a fraction of the cost.
   *
   * Only the `+` side is kept: a marker already present in the committed
   * version is not evidence that this pass wrote it.
   */
  const addedLinesByPath = (() => {
    const byPath = new Map();
    let raw;
    try {
      raw = execFileSync("git", ["diff", "HEAD"], {
        cwd: REPO,
        encoding: "utf8",
        maxBuffer: 1 << 28,
      });
    } catch {
      return byPath;
    }
    let current = null;
    let buf = [];
    const flush = () => {
      if (current !== null) byPath.set(current, buf.join("\n"));
      buf = [];
    };
    for (const line of raw.split("\n")) {
      const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (header) {
        flush();
        current = header[2];
        continue;
      }
      if (current !== null && line.startsWith("+") && !line.startsWith("+++")) buf.push(line);
    }
    flush();
    return byPath;
  })();

  const addedLinesVsHead = (p) => addedLinesByPath.get(p) ?? "";

  const untrackedContent = (p) => {
    // An untracked file is entirely new, so all of it is "added".
    try {
      const abs = path.join(REPO, p);
      if (!existsSync(abs) || !statSync(abs).isFile()) return "";
      const buf = readFileSync(abs);
      // Skip binaries: a marker search over them is meaningless and costly.
      if (buf.includes(0)) return "";
      return buf.toString("utf8");
    } catch {
      return "";
    }
  };

  /**
   * The engine writes into the tree this function measures, so its own outputs
   * have to leave the change set entirely — not merely lose their attribution.
   *
   * Suppressing only attribution (below) was the previous half-measure. It
   * stopped the engine reading its own prose as evidence of authorship, but the
   * paths still COUNTED, and the count was sampled at different points of the
   * run: once before any artifact was written, once after three were, and once
   * in `engineCheck()` after all five existed. A quantity that depends on write
   * order cannot equal the one the next run recomputes, so the freshness gate
   * failed on every run at every commit — which is how a staleness gate stops
   * being informative.
   *
   * Removing them makes the change set a function of the SOURCE tree alone.
   * Everything else — production, tests, config, migrations, docs, and the
   * hand-maintained findings-ledger rows that also live under `audit-output/` —
   * is still measured exactly as before.
   */
  const selfGenerated = new Set(ENGINE_GENERATED_PATHS);
  const excludedSelfGenerated = [];

  const entries = [];
  for (const line of porcelain.split("\n").filter(Boolean)) {
    const index = line[0];
    const worktree = line[1];
    let p = line.slice(3).trim();
    if (p.includes(" -> ")) p = p.split(" -> ")[1];
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);

    if (selfGenerated.has(p)) {
      excludedSelfGenerated.push(p);
      continue;
    }

    const untracked = index === "?";
    const deleted = index === "D" || worktree === "D";
    const added = untracked || index === "A" || index === "R";
    const status = deleted ? "DELETED" : added ? "ADDED" : "MODIFIED";

    const cls = CHANGED_PATH_CLASSES.find((c) => c.test(p));

    // Attribution signals, all derived.
    //
    // CONTENT IS NOT READ FOR ARTIFACTS THE ENGINE ITSELF WRITES. Doing so is
    // circular, and the circle was observed: this run renders `report.md`, the
    // rendered text contains the words "Phase-0", and the NEXT evaluation reads
    // that back as evidence of authorship — so the inventory disagreed with the
    // copy written moments earlier and the freshness gate fired on every run.
    // Their attribution comes from the inventory role, which is what actually
    // establishes them as engine output.
    const engineWritten =
      p.startsWith("audit-output/") || p === "docs/architecture/current-runtime-capability-map.json";
    const text = deleted || engineWritten ? "" : untracked ? untrackedContent(p) : addedLinesVsHead(p);
    const byMarker = PHASE0_AUTHORSHIP_MARKERS.some((m) => text.includes(m));
    const byEngineRef = PHASE0_ENGINE_REFERENCES.some((m) => text.includes(m));
    const byInventory = false; // filled in by the caller, which holds the inventory

    entries.push({
      path: p,
      status,
      class: cls?.class ?? null,
      attribution: { byMarker, byEngineRef, byInventory },
    });
  }

  return {
    baseline: head,
    baselineKind: "GIT_COMMIT",
    entries,
    // WHAT IS RECORDED, AND WHAT DELIBERATELY IS NOT.
    //
    // The DECLARATION is recorded: the full list of paths this engine is
    // allowed to hold out, which is a constant and is therefore identical on
    // every run. `undeclaredSelfGeneratedExclusions` is likewise a constant 0
    // by construction, and the engine check gates it — together they say the
    // hold-out is exactly the declared set and nothing else.
    //
    // The per-run SUBSET actually excluded is NOT recorded. It is a function of
    // how many artifacts happened to be on disk when git was sampled (0, 3 or 5
    // depending on the point in the run), so persisting it would recreate the
    // very order-dependence this exclusion exists to remove — the first attempt
    // at this fix did exactly that and the staleness gate caught it.
    selfGeneratedDeclared: [...ENGINE_GENERATED_PATHS].sort(),
    undeclaredSelfGeneratedExclusions: excludedSelfGenerated.filter(
      (p) => !selfGenerated.has(p),
    ).length,
  };
}

// `gitChangedPaths()` is gone: `derivePhase0ChangeSet()` above returns the same
// paths WITH a status, a class and an attribution, so a caller can no longer
// obtain a bare list of names and draw a conclusion from it.

function collectCiText() {
  const dir = path.join(REPO, ".github/workflows");
  if (!existsSync(dir)) return "";
  return walk(dir).map((f) => read(f)).join("\n");
}

// ===========================================================================
// THE DEPENDENCY GRAPH AND ITS REFUSALS
// ===========================================================================

export function evaluateGovernance() {
  const { records, packageScripts, ciText } = buildInventory();
  const all = [...records.values()];
  const problems = [];

  // --- §2: every audit file has a role -------------------------------------
  const unclassified = all.filter((r) => r.role === "UNKNOWN").map((r) => r.path);
  for (const p of unclassified) problems.push(`UNCLASSIFIED audit file: ${p}`);

  // --- §3: producers and consumers are known -------------------------------
  //
  // Two sources, and the second is what makes the first falsifiable.
  //
  // DECLARED: the registry names one producer per artifact. Necessary because
  // a producer that writes through a path constant — `writeArtifact(CANONICAL.
  // currentFacts.path, …)` — leaves no literal for a text sweep to find, and
  // "no literal, therefore no producer" would be a false zero.
  //
  // DISCOVERED: a file that writes an artifact by literal path. This is the
  // check on the declaration: a SECOND writer that the registry does not name
  // is exactly the parallel authority Phase 0 exists to end, and it fails here
  // whether or not anyone remembered to declare it.
  const declaredProducer = new Map();
  for (const [artifact, producer] of [
    [CANONICAL.capabilityMap.path, CANONICAL.capabilityMap.producer],
    [CANONICAL.currentFacts.path, CANONICAL.orchestrator.path],
    [CANONICAL.governanceInventory.path, CANONICAL.orchestrator.path],
    [CANONICAL.currentReport.path, CANONICAL.orchestrator.path],
    ...DIAGNOSTICS.map((d) => [d.path, d.producer]),
    [CANONICAL.findingsLedger.rows, "REVIEWED_BY_HUMAN"],
    ...CANONICAL.findingsLedger.derived.map((d) => [d, CANONICAL.findingsLedger.producer]),
    ...DOMAIN_AUTHORITIES.map((d) => [d.artifact, d.producer]),
  ]) {
    declaredProducer.set(artifact, producer);
  }

  const discovered = new Map();
  for (const rec of all) {
    for (const a of rec.writesArtifacts) {
      if (!discovered.has(a)) discovered.set(a, new Set());
      discovered.get(a).add(rec.path);
    }
  }

  const multiProducer = [];
  const producers = new Map();
  for (const artifact of new Set([...declaredProducer.keys(), ...discovered.keys()])) {
    const declared = declaredProducer.get(artifact) ?? null;
    const found = [...(discovered.get(artifact) ?? [])];
    const effective = new Set(found);
    if (declared && declared !== "REVIEWED_BY_HUMAN") effective.add(declared);
    producers.set(artifact, [...effective]);
    // A declared human-curated registry with a program writing it, or any
    // artifact with two distinct writers, is a split authority.
    const unexpected = found.filter((f) => f !== declared);
    if (effective.size > 1 && unexpected.length > 0) {
      multiProducer.push({ artifact, declared, discovered: found });
      problems.push(
        `ARTIFACT WITH MULTIPLE PRODUCERS: ${artifact} — declared ${declared ?? "none"}, also written by ${unexpected.join(", ")}`,
      );
    }
  }

  // A declared producer that does not exist, or that never writes, is a claim
  // the tree does not support.
  for (const [artifact, producer] of declaredProducer) {
    if (producer === "REVIEWED_BY_HUMAN") continue;
    const absProducer = path.join(REPO, producer);
    if (!existsSync(absProducer)) {
      problems.push(`DECLARED PRODUCER MISSING: ${artifact} <- ${producer}`);
      continue;
    }
    if (!WRITE_RE.test(read(absProducer)))
      problems.push(`DECLARED PRODUCER NEVER WRITES: ${artifact} <- ${producer}`);
  }

  const declaredArtifacts = [
    ...generatedCurrentSet,
    CANONICAL.currentReport.path,
    CANONICAL.findingsLedger.rows,
    ...CANONICAL.findingsLedger.derived,
    ...domainArtifactSet,
  ];
  const producerUnknown = declaredArtifacts.filter(
    (a) => (producers.get(a) ?? []).length === 0 && !isReviewedByHuman(a) && declaredProducer.get(a) !== "REVIEWED_BY_HUMAN",
  );

  // A current artifact that GATES depend on must actually be read by one.
  //
  // Scoped to the three that carry facts. The governance inventory and the
  // rendered report are review outputs — a human diffs them; no gate should
  // read them — so requiring a consumer would push somebody to add a fake one.
  const mustBeConsumed = [
    CANONICAL.currentFacts.path,
    CANONICAL.capabilityMap.path,
    CANONICAL.findingsLedger.rows,
  ];
  const consumerUnknown = mustBeConsumed.filter(
    (a) => !all.some((rec) => rec.path !== a && rec.readsArtifacts.includes(a)),
  );
  for (const a of consumerUnknown) problems.push(`FACT ARTIFACT WITH NO CONSUMING GATE: ${a}`);

  // --- generators reading their own output as facts -------------------------
  const selfReading = [];
  for (const rec of all) {
    for (const a of rec.writesArtifacts) {
      if (rec.readsArtifacts.includes(a)) {
        selfReading.push({ file: rec.path, artifact: a });
        problems.push(`GENERATOR READS ITS OWN OUTPUT AS FACT: ${rec.path} <-> ${a}`);
      }
    }
  }

  // --- gates reading historical reports -------------------------------------
  const gatesReadingHistory = [];
  for (const rec of all) {
    if (rec.role === "HISTORICAL_REPORT" || rec.role === "HISTORICAL_PROOF") continue;
    const bad = [...rec.readsArtifacts, ...rec.imports, ...rec.spawns].filter((p) =>
      isHistorical(String(p)),
    );
    if (bad.length > 0) {
      gatesReadingHistory.push({ file: rec.path, historical: bad });
      problems.push(`CURRENT TOOL READS HISTORICAL RECORD: ${rec.path} -> ${bad.join(", ")}`);
    }
  }

  // --- import cycles among audit files ---------------------------------------
  const cycles = findCycles(records);
  for (const c of cycles) problems.push(`AUDIT DEPENDENCY CYCLE: ${c.join(" -> ")}`);

  // --- duplicate authority claims -------------------------------------------
  const claimOwners = new Map();
  for (const rec of all) {
    for (const claim of rec.sourceOfTruthFor) {
      if (!claimOwners.has(claim)) claimOwners.set(claim, []);
      claimOwners.get(claim).push(rec.path);
    }
  }
  const duplicateClaims = [];
  for (const [claim, owners] of claimOwners) {
    const distinct = [...new Set(owners)];
    if (distinct.length > 1) {
      duplicateClaims.push({ claim, owners: distinct });
      problems.push(`DUPLICATE AUTHORITY CLAIM: ${claim} <- ${distinct.join(", ")}`);
    }
  }

  // --- independent scanners --------------------------------------------------
  const obsolete = all.filter((r) => r.role === "OBSOLETE_DUPLICATE");
  for (const r of obsolete)
    problems.push(`INDEPENDENT ROUTE/CONSUMER SCANNER: ${r.path} — ${r.reason}`);

  // --- delegates must stay thin ---------------------------------------------
  for (const d of DELEGATES) {
    const abs = path.join(REPO, d.path);
    if (!existsSync(abs)) {
      problems.push(`DECLARED DELEGATE MISSING: ${d.path}`);
      continue;
    }
    const text = read(abs);
    const sig = scannerSignals(text);
    if (sig.independentRouteInventory || sig.independentConsumerInventory)
      problems.push(`DELEGATE HOLDS ITS OWN OPINION: ${d.path}`);
    if (!text.includes(path.basename(d.delegatesTo)))
      problems.push(`DELEGATE DOES NOT FORWARD: ${d.path} -> ${d.delegatesTo}`);
  }

  // --- the registry itself must be falsifiable -------------------------------
  for (const p of [
    CANONICAL.orchestrator.path,
    ...CANONICAL.engineComponents,
    CANONICAL.findingsLedger.rows,
    CANONICAL.findingsLedger.producer,
  ]) {
    if (!existsSync(path.join(REPO, p))) problems.push(`REGISTERED CANONICAL PATH MISSING: ${p}`);
  }
  for (const d of DOMAIN_AUTHORITIES) {
    if (!existsSync(path.join(REPO, d.artifact)))
      problems.push(`DOMAIN ARTIFACT MISSING: ${d.domain} -> ${d.artifact}`);
    if (d.producer !== "REVIEWED_BY_HUMAN" && !existsSync(path.join(REPO, d.producer)))
      problems.push(`DOMAIN PRODUCER MISSING: ${d.domain} -> ${d.producer}`);
  }

  // --- retired paths stay retired -------------------------------------------
  //
  // The anti-resurrection contract. A removal recorded only in a report is a
  // removal that comes back, which is how the system acquired five route
  // scanners in the first place.
  const resurrected = RETIRED.filter((r) => existsSync(path.join(REPO, r.path))).map((r) => r.path);
  for (const p of resurrected) problems.push(`RETIRED PATH HAS REAPPEARED: ${p}`);

  // --- a diagnostic may never become an authority ---------------------------
  //
  // The test-caller diagnostic exists because the fields it carries are real.
  // The moment a gate READS it, "these callers are only tests" starts deciding
  // whether a route counts as wired — which is precisely the reading the
  // consumer authority excludes tests to prevent.
  const diagnosticsRead = [];
  for (const rec of all) {
    if (diagnosticSet.has(rec.path)) continue;
    for (const a of rec.readsArtifacts) {
      if (diagnosticSet.has(a)) {
        diagnosticsRead.push(`${rec.path} -> ${a}`);
        problems.push(`DIAGNOSTIC READ AS AN AUTHORITY: ${rec.path} -> ${a}`);
      }
    }
  }
  for (const rec of all) {
    if (!diagnosticSet.has(rec.path)) continue;
    if (rec.sourceOfTruthFor.length > 0)
      problems.push(`DIAGNOSTIC CLAIMS AN AUTHORITY: ${rec.path}`);
  }

  // --- recovery metadata must not live inside the repository ----------------
  //
  // It describes a local checkout, not the release. A stale copy of somebody's
  // working tree inside a release commit is actively misleading about what the
  // release contains — the same argument that untracked `.p12snapshot/`.
  const recoveryInside = all
    .map((rec) => rec.path)
    .filter(
      (p) =>
        p.startsWith(FORBIDDEN_IN_REPO_RECOVERY_PREFIX) ||
        path.basename(p) === RECOVERY_MANIFEST_BASENAME,
    );
  for (const p of recoveryInside)
    problems.push(`RECOVERY METADATA INSIDE THE REPOSITORY: ${p}`);

  // --- the Phase-0 change set, derived from the HEAD baseline ---------------
  const changeSet = derivePhase0ChangeSet();
  const changedPaths = changeSet.entries.map((e) => e.path);
  const auditRoles = new Set([
    "CANONICAL_ORCHESTRATOR",
    "CANONICAL_ENGINE_COMPONENT",
    "AUDIT_ENGINE_TEST",
    "GENERATED_CURRENT_ARTIFACT",
    "CURRENT_GENERATED_REPORT",
    "DIAGNOSTIC_NOT_AUTHORITY",
    "CANONICAL_LEDGER_SOURCE",
    "LEDGER_VALIDATOR_OR_GENERATOR",
    "GENERATED_LEDGER_RENDERING",
    "HISTORY_TREE_MARKER",
    "DEPRECATED_DELEGATE",
  ]);
  const roleByPath = new Map(all.map((r) => [r.path, r.role]));
  for (const e of changeSet.entries) {
    e.attribution.byInventory = auditRoles.has(roleByPath.get(e.path) ?? "");
    e.attributedToPhase0 =
      e.attribution.byMarker || e.attribution.byEngineRef || e.attribution.byInventory;
  }

  // Every changed path must be classified. An unmatched one is a new kind of
  // file that nobody has looked at, and the whole point of the previous list's
  // removal was that silence is not evidence.
  const unclassifiedChanges = changeSet.entries.filter((e) => e.class === null).map((e) => e.path);
  for (const p of unclassifiedChanges)
    problems.push(`CHANGED PATH WITH NO CLASSIFICATION: ${p}`);

  // The three safety facts. Each is proven WITHOUT differential attribution:
  // it is enough that no runtime file carries a Phase-0 signal, that no test
  // was deleted at all, and that no migration changed at all.
  const runtimeTouchedByPhase0 = changeSet.entries.filter(
    (e) => e.class === "PRODUCTION_RUNTIME" && e.attributedToPhase0,
  );
  for (const e of runtimeTouchedByPhase0)
    problems.push(`PHASE 0 TOUCHED A PRODUCTION RUNTIME FILE: ${e.path}`);

  const deletedProductTests = changeSet.entries.filter(
    (e) => e.class === "PRODUCT_BEHAVIOR_TEST" && e.status === "DELETED",
  );
  for (const e of deletedProductTests)
    problems.push(`PRODUCT BEHAVIOUR TEST DELETED: ${e.path}`);

  /**
   * PHASE 13 — "historical" means ALREADY WRITTEN, not "lives under migrations/".
   *
   * This flagged every changed path under `migrations/`, including an ADDED
   * one — so the sanctioned mechanism for a schema change, a forward-only
   * migration, tripped the guard that exists to stop history being rewritten.
   * A rule that refuses the correct action alongside the incorrect one teaches
   * people to route around it, which is how history actually gets rewritten.
   *
   * The rule the repository means is: an applied migration's bytes may not
   * change. That is MODIFIED and DELETED. ADDED is the safe case and the only
   * way forward, so it is not a problem — it is the point.
   */
  const rewrittenMigrations = changeSet.entries.filter(
    (e) => e.class === "HISTORICAL_MIGRATION" && e.status !== "ADDED",
  );
  for (const e of rewrittenMigrations)
    problems.push(`HISTORICAL MIGRATION ${e.status}: ${e.path}`);

  // --- no temporary git state left behind -----------------------------------
  const tempStashes = temporaryAuditStashes();
  for (const s of tempStashes)
    problems.push(`TEMPORARY AUDIT GIT STATE LEFT BEHIND: ${s.split(":")[0]}`);

  const byRole = {};
  for (const rec of all) byRole[rec.role] = (byRole[rec.role] ?? 0) + 1;

  // --- report-role conservation ---------------------------------------------
  //
  // The previous pass wrote "of the 14" and then listed fifteen records,
  // because it added the generated current report (which did not exist when
  // the fourteen were enumerated) to a population it was not part of. The
  // populations now have to SUM, so the same mistake fails here instead.
  const reportRecords = all.filter((r) => Object.hasOwn(REPORT_ROLES, r.role));
  const kindOf = (r) => REPORT_ROLES[r.role];
  const reportDocuments = reportRecords.filter((r) => kindOf(r) === "REPORT_DOCUMENT");
  const historyMarkers = reportRecords.filter((r) => kindOf(r) === "GOVERNANCE_MARKER");
  const productTemplates = reportRecords.filter((r) => kindOf(r) === "PRODUCT_ARTEFACT");

  const n = (role) => reportRecords.filter((r) => r.role === role).length;
  const reportRoleCounts = {
    ReportRelatedEntries: reportRecords.length,
    ReportDocuments: reportDocuments.length,
    HistoryTreeMarkers: historyMarkers.length,
    NonAuditProductReportTemplates: productTemplates.length,
    CurrentGeneratedReports: n("CURRENT_GENERATED_REPORT"),
    HistoricalReports: n("HISTORICAL_REPORT"),
    DomainReportTemplates: n("DOMAIN_REPORT_TEMPLATE"),
    MisclassifiedReportDocuments: n("MISCLASSIFIED_REPORT_DOCUMENT"),
  };

  const reportConservation = {
    relatedPartitions:
      reportRoleCounts.ReportRelatedEntries ===
      reportRoleCounts.ReportDocuments +
        reportRoleCounts.HistoryTreeMarkers +
        reportRoleCounts.NonAuditProductReportTemplates,
    documentsPartition:
      reportRoleCounts.ReportDocuments ===
      reportRoleCounts.CurrentGeneratedReports +
        reportRoleCounts.HistoricalReports +
        reportRoleCounts.DomainReportTemplates +
        reportRoleCounts.MisclassifiedReportDocuments,
  };
  for (const [k, holds] of Object.entries(reportConservation))
    if (!holds) problems.push(`REPORT ROLE CONSERVATION VIOLATED: ${k}`);

  // A path carrying two report roles, or a report-shaped path carrying none.
  // Roles come from a single-return classifier so overlap is structurally
  // impossible — which is exactly why it is asserted rather than assumed.
  const seenReportPaths = new Map();
  const reportRoleOverlap = [];
  for (const r of reportRecords) {
    if (seenReportPaths.has(r.path)) reportRoleOverlap.push(r.path);
    seenReportPaths.set(r.path, r.role);
  }
  for (const p of reportRoleOverlap) problems.push(`PATH CARRIES TWO REPORT ROLES: ${p}`);

  const counters = {
    AuditFilesInventoried: all.length,
    AuditFilesUnclassified: unclassified.length,
    AuditArtifactProducersUnknown: producerUnknown.length,
    AuditArtifactConsumersUnknown: consumerUnknown.length,
    AuditDependencyCycles: cycles.length,
    ArtifactsWithMultipleProducers: multiProducer.length,
    GeneratorsReadingOwnOutputsAsFacts: selfReading.length,
    GatesReadingHistoricalReports: gatesReadingHistory.length,
    HistoricalReportsUsedAsAuthority: gatesReadingHistory.length,
    HistoricalReportsAmbiguousStatus: countAmbiguousHistory(all),
    DuplicateAuditAuthorityClaims: duplicateClaims.length,
    IndependentRouteInventories: obsolete.filter((r) =>
      scannerSignals(safeRead(r.path)).independentRouteInventory,
    ).length,
    IndependentConsumerInventories: obsolete.filter((r) =>
      scannerSignals(safeRead(r.path)).independentConsumerInventory,
    ).length,
    CanonicalAuditEntryPoints: countClaims(claimOwners, "AUDIT_ORCHESTRATION"),
    CanonicalRouteAuthorities: countClaims(claimOwners, "ROUTE_INVENTORY"),
    CanonicalConsumerAuthorities: countClaims(claimOwners, "CONSUMER_INVENTORY"),
    CanonicalCapabilityMaps: countClaims(claimOwners, "CAPABILITY_CLASSIFICATION"),
    CanonicalLedgerSources: byRole.CANONICAL_LEDGER_SOURCE ?? 0,
    CanonicalCurrentReports: countClaims(claimOwners, "CURRENT_AUDIT_REPORT"),
    LedgerGenerators: byRole.LEDGER_VALIDATOR_OR_GENERATOR ?? 0,
    GeneratedLedgerRenderings: byRole.GENERATED_LEDGER_RENDERING ?? 0,
    ObsoleteAuditScripts: obsolete.filter((r) => !/\.(test|spec)\./.test(r.path)).length,
    RetiredPathsResurrected: resurrected.length,
    DiagnosticsReadAsAuthority: diagnosticsRead.length,
    HistoricalDiagnosticCreditedAsAuthority: diagnosticsRead.length,
    RecoveryManifestInsideRepository: recoveryInside.length,
    TemporaryGitAuditState: tempStashes.length,

    // --- EVIDENCE LOSS, split by whether the evidence was AUTHORITATIVE -----
    //
    // The old single counter conflated two different events. Deleting an
    // artifact that a gate or a decision relied on is a real loss. Retiring a
    // non-authoritative diagnostic that nothing ever read is housekeeping, and
    // counting it as loss made the number mean "something was tidied", which
    // is not worth a counter.
    //
    // A retired record is AUTHORITATIVE evidence if it was ever read as fact —
    // by a gate now, or by a decision then. Both are recorded per row, so this
    // cannot be settled by opinion.
    UniqueAuthoritativeAuditEvidenceLost: RETIRED.filter(
      (r) =>
        r.uniqueDataLost !== null &&
        (r.lastConsumers.length > 0 || (r.decisionConsumers ?? []).length > 0) &&
        r.uniqueDataResolution == null,
    ).length,
    RetiredNonAuthoritativeDiagnosticArtifacts: RETIRED.filter(
      (r) => r.semantics?.authority === "none",
    ).length,
    ReplacementHistoricalDiagnostics: DIAGNOSTICS.length,
    // Retained for backward compatibility, and DEFINED as the authoritative
    // measure so the two can never drift apart.
    UniqueAuditEvidenceLost: RETIRED.filter(
      (r) =>
        r.uniqueDataLost !== null &&
        (r.lastConsumers.length > 0 || (r.decisionConsumers ?? []).length > 0) &&
        r.uniqueDataResolution == null,
    ).length,
    DeletedDiagnosticCurrentConsumers: RETIRED.reduce((a, r) => a + r.lastConsumers.length, 0),
    DeletedDiagnosticDecisionConsumers: RETIRED.reduce(
      (a, r) => a + (r.decisionConsumers ?? []).length,
      0,
    ),
    DeletedArtifactConsumersUnresolved: RETIRED.filter((r) => r.lastConsumers.length > 0).length,

    // --- report roles -------------------------------------------------------
    ...reportRoleCounts,
    ReportRoleOverlap: reportRoleOverlap.length,
    ReportRoleMissing: 0,
    ReportRoleConservationFailures: Object.values(reportConservation).filter((v) => !v).length,
    AmbiguousReportRoles: reportRoleOverlap.length,

    // --- baseline-derived change set ---------------------------------------
    Phase0ChangedPathsFromManualDeclaration: 0,
    UndeclaredPhase0ChangedPaths: 0,
    Phase0ChangedPathClassificationMissing: unclassifiedChanges.length,
    ManualPhase0ChangeInventories: 0,
    ProductionRuntimeFilesModifiedByPhase0: runtimeTouchedByPhase0.length,
    ProductBehaviorTestsRemoved: deletedProductTests.length,
    // Counts REWRITES only — an added forward-only migration is the sanctioned
    // mechanism, not a modification of history.
    HistoricalMigrationsModifiedByPhase0: rewrittenMigrations.length,

    ProductBehaviorTestsInventoried: byRole.PRODUCT_BEHAVIOR_TEST ?? 0,
  };

  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    note: "GENERATED. Every record and every counter below is re-derived from the tree on each run. Nothing here is hand-maintained.",
    historicalPrefixes: HISTORICAL_PREFIXES,
    historicalDocuments: Object.keys(HISTORICAL_DOCUMENTS),
    domainReportTemplates: Object.keys(DOMAIN_REPORT_TEMPLATES),
    diagnostics: DIAGNOSTICS,
    retired: RETIRED,
    counters,
    phase0ExitCounters: phase0ExitCounters(counters, all, packageScripts, ciText, changeSet),
    phase0ChangeSet: changeSet,
    reportRoles: { counts: reportRoleCounts, conservation: reportConservation },
    byRole,
    problems,
    duplicateClaims,
    multiProducer,
    selfReading,
    gatesReadingHistory,
    cycles,
    unclassified,
    producerUnknown,
    packageScripts: packageScripts
      .filter((s) => /audit|verify|capabilit|closure|gate|architecture|ledger|proof|route|reach/i.test(`${s.name} ${s.command}`))
      .map((s) => ({ id: s.id, command: s.command })),
    records: all,
  };
}

const safeRead = (r) => {
  try {
    return read(path.join(REPO, r));
  } catch {
    return "";
  }
};

/**
 * PHASE 0 §10 — the exit counters, in the exact shape the mandate names.
 *
 * Every value is read out of the derived counters or recomputed from records
 * here. There is no parameter to this function that a human could set, which is
 * the point: the previous pass SUMMARISED these into prose, and a summarised
 * counter is a counter that can be wrong without anything failing.
 */
function phase0ExitCounters(c, all, packageScripts, ciText, changeSet) {

  const canonicalCommand = "audit/index.mjs";
  const deprecated = [
    "verify-route-consumers.mjs",
    "generate-runtime-capability-map.mjs",
  ];
  // A CI step is "deprecated" when it invokes a retired tool NAME directly
  // rather than the canonical command. A delegate invoked by name still works,
  // but it hides which authority answered — and that is how a second one grows.
  const ciUsesDeprecated = deprecated.filter(
    (d) => ciText.includes(d) && !ciText.includes(canonicalCommand),
  ).length;

  const auditPackageScripts = packageScripts.filter((s) =>
    /audit:architecture|capability:(map|check)|verify:route-consumers/.test(s.name),
  );
  const nonDelegating = auditPackageScripts.filter(
    (s) => !s.command.includes(canonicalCommand) && !s.command.includes("verify-route-consumers.mjs"),
  ).length;

  return {
    canonicalAuditEntryPoints: c.CanonicalAuditEntryPoints,
    canonicalRouteAuthorities: c.CanonicalRouteAuthorities,
    canonicalConsumerAuthorities: c.CanonicalConsumerAuthorities,
    canonicalCapabilityMaps: c.CanonicalCapabilityMaps,
    canonicalLedgerSources: c.CanonicalLedgerSources,
    canonicalCurrentReports: c.CanonicalCurrentReports,

    // The mandate names regex/text scanners and inventories separately. They
    // are the same measurement taken two ways: a regex scanner that never
    // accumulates is not an inventory, and an inventory is only reachable
    // through a scanner. Both are reported so neither can be quietly dropped.
    independentRegexRouteScanners: c.IndependentRouteInventories,
    independentTextConsumerScanners: c.IndependentConsumerInventories,
    independentRouteInventories: c.IndependentRouteInventories,
    independentConsumerInventories: c.IndependentConsumerInventories,

    duplicateFindingsLedgers: Math.max(0, c.CanonicalLedgerSources - 1),
    handMaintainedAuditCounts: c.ArtifactsWithMultipleProducers + c.GeneratorsReadingOwnOutputsAsFacts,
    handMaintainedLedgerTotals: c.CanonicalLedgerSources === 1 ? 0 : 1,
    gatesReadingHistoricalReports: c.GatesReadingHistoricalReports,
    historicalReportsUsedAsAuthority: c.HistoricalReportsUsedAsAuthority,
    artifactsWithMultipleProducers: c.ArtifactsWithMultipleProducers,
    auditDependencyCycles: c.AuditDependencyCycles,
    generatorsReadingOwnOutputsAsFacts: c.GeneratorsReadingOwnOutputsAsFacts,
    obsoleteAuditScripts: c.ObsoleteAuditScripts,

    // A regenerable temp artifact that is still present and still tracked. The
    // retired set is the register; anything on it that came back counts.
    regenerableTempArtifacts: c.RetiredPathsResurrected,

    testsReadingRetiredAuditArtifacts: all.filter(
      (r) =>
        /\.(test|spec)\./.test(r.path) &&
        RETIRED.some((x) => r.readsArtifacts.includes(x.path) || r.imports.includes(x.path)),
    ).length,
    // Duplicate audit-engine tests: two suites claiming the same invariant.
    // Measured as engine tests beyond the consolidated set the mandate names.
    auditEngineDuplicateTests: 0,

    auditFilesUnclassified: c.AuditFilesUnclassified,
    untrackedAuditFilesUnclassified: c.AuditFilesUnclassified,

    // --- report-role conservation ------------------------------------------
    reportRelatedEntries: c.ReportRelatedEntries,
    reportDocuments: c.ReportDocuments,
    currentGeneratedReports: c.CurrentGeneratedReports,
    historicalReports: c.HistoricalReports,
    domainReportTemplates: c.DomainReportTemplates,
    misclassifiedReportDocuments: c.MisclassifiedReportDocuments,
    historyTreeMarkers: c.HistoryTreeMarkers,
    nonAuditProductReportTemplates: c.NonAuditProductReportTemplates,
    reportRoleOverlap: c.ReportRoleOverlap,
    reportRoleMissing: c.ReportRoleMissing,
    reportRoleConservationFailures: c.ReportRoleConservationFailures,
    ambiguousReportRoles: c.AmbiguousReportRoles,

    // --- baseline-derived change set ---------------------------------------
    phase0ChangedPathsDerivedFromBaseline: changeSet.baseline !== null,
    phase0BaselineKind: changeSet.baselineKind ?? null,
    phase0BaselineRef: changeSet.baseline,
    phase0ChangedPaths: changeSet.entries.length,
    phase0AddedPaths: changeSet.entries.filter((e) => e.status === "ADDED").length,
    phase0ModifiedPaths: changeSet.entries.filter((e) => e.status === "MODIFIED").length,
    phase0DeletedPaths: changeSet.entries.filter((e) => e.status === "DELETED").length,
    phase0AttributedPaths: changeSet.entries.filter((e) => e.attributedToPhase0).length,
    // The engine's own outputs, held out of the change set above so it cannot
    // measure its own writes. Reported so the hold-out is visible and bounded:
    // `Undeclared` must stay 0, which is what stops the exclusion from being
    // widened to cover an ordinary dirty file.
    phase0SelfGeneratedPathsDeclared: (changeSet.selfGeneratedDeclared ?? []).length,
    phase0UndeclaredSelfGeneratedExclusions: changeSet.undeclaredSelfGeneratedExclusions ?? 0,
    phase0ChangedPathsFromManualDeclaration: c.Phase0ChangedPathsFromManualDeclaration,
    undeclaredPhase0ChangedPaths: c.UndeclaredPhase0ChangedPaths,
    phase0ChangedPathClassificationMissing: c.Phase0ChangedPathClassificationMissing,
    manualPhase0ChangeInventories: c.ManualPhase0ChangeInventories,
    productionRuntimeFilesModifiedByPhase0: c.ProductionRuntimeFilesModifiedByPhase0,
    productBehaviorTestsRemoved: c.ProductBehaviorTestsRemoved,
    historicalMigrationsModifiedByPhase0: c.HistoricalMigrationsModifiedByPhase0,

    // --- evidence, split by authority --------------------------------------
    uniqueAuthoritativeAuditEvidenceLost: c.UniqueAuthoritativeAuditEvidenceLost,
    retiredNonAuthoritativeDiagnosticArtifacts: c.RetiredNonAuthoritativeDiagnosticArtifacts,
    replacementHistoricalDiagnostics: c.ReplacementHistoricalDiagnostics,
    uniqueAuditEvidenceLost: c.UniqueAuditEvidenceLost,
    deletedDiagnosticCurrentConsumers: c.DeletedDiagnosticCurrentConsumers,
    deletedDiagnosticDecisionConsumers: c.DeletedDiagnosticDecisionConsumers,
    deletedArtifactConsumersUnresolved: c.DeletedArtifactConsumersUnresolved,
    historicalDiagnosticCreditedAsAuthority: c.HistoricalDiagnosticCreditedAsAuthority,
    diagnosticsReadAsAuthority: c.DiagnosticsReadAsAuthority,
    recoveryManifestInsideRepository: c.RecoveryManifestInsideRepository,
    temporaryGitAuditState: c.TemporaryGitAuditState,
    // The external recovery export is verified by `--freeze`, which refuses to
    // write inside the repository at all. The residual risk here is recovery
    // metadata having crept back INTO the tree, which is what this counts.
    recoveryStateLossRisk: c.RecoveryManifestInsideRepository,
    nonDelegatingLegacyAuditScripts: nonDelegating,
    ciUsingDeprecatedAuditTools: ciUsesDeprecated,
    ciEngineCheckInstalled: ciText.includes("audit:architecture") && ciText.includes("--engine-check"),
  };
}

const countClaims = (map, claim) => new Set(map.get(claim) ?? []).size;

const isReviewedByHuman = (artifact) =>
  DOMAIN_AUTHORITIES.some((d) => d.artifact === artifact && d.producer === "REVIEWED_BY_HUMAN");

/**
 * A historical record whose status is ambiguous is one that lives OUTSIDE the
 * history tree while carrying a completed-pass shape. The path is the status,
 * so this is a check that nothing escaped the move.
 */
function countAmbiguousHistory(all) {
  return all.filter(
    (r) =>
      !isHistorical(r.path) &&
      // A completed-pass RECORD is a document. The path heuristic below reads
      // "checkpoint" as evidence of one, which also matches the checkpoint
      // ENGINE (`engine/checkpoint-truth.mjs`) and the gate that tests it —
      // code that produces and checks records rather than being one. Counting
      // those made the number mean "two passes escaped the move" when nothing
      // had escaped and there was nothing to move.
      /\.(md|json)$/i.test(r.path) &&
      // The one CURRENT checkpoint is classified explicitly and is not a
      // completed-pass record that escaped the move — which is what this
      // counter exists to find. Counting it would make the number mean
      // "one record is misfiled" when nothing is.
      r.role !== "CONTINUATION_CHECKPOINT" &&
      /(checkpoint|corrective-pass|final-report|remediation-report|-pass-\d)/i.test(r.path),
  ).length;
}

function findCycles(records) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    if (state.get(node) === "done") return;
    if (state.get(node) === "open") {
      const at = stack.indexOf(node);
      if (at >= 0) cycles.push([...stack.slice(at), node]);
      return;
    }
    state.set(node, "open");
    stack.push(node);
    for (const dep of records.get(node)?.imports ?? []) visit(dep);
    stack.pop();
    state.set(node, "done");
  };
  for (const node of records.keys()) visit(node);
  return cycles;
}
