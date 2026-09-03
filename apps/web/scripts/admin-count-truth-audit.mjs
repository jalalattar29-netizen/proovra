#!/usr/bin/env node
/**
 * WHERE DOES EVERY NUMBER ON AN ADMIN LIST COME FROM?
 *
 * =============================================================================
 * THE QUESTION
 * =============================================================================
 * A count is a claim. "200 incidents" claims there are two hundred. If the
 * request capped at 200 the claim is false, and it is false in the direction
 * that matters: an operator counting open conditions during a review, or
 * checking whether a workspace appears in a list, gets a confident wrong
 * answer and has no way to tell.
 *
 * So this asks, for every count rendered on an admin page, WHAT BACKS IT:
 *
 *   EXACT_TOTAL       a server count of everything matching the filter
 *   SERVER_HAS_MORE   the server said whether another page exists
 *   CAP_DISCLOSED     only a cap is known, and the wording admits it
 *   LOADED_ONLY       rows.length, with no metadata at all  ← a claim with
 *                     nothing behind it
 *
 * LOADED_ONLY is the finding. It is not automatically wrong — a list the
 * server never truncates is completely described by its own length — but it
 * cannot be distinguished from a truncated one by reading the page, so each
 * one has to be reviewed and recorded rather than assumed.
 *
 * =============================================================================
 * WHAT IT CANNOT DO
 * =============================================================================
 * It reads source. It sees that a page passes `total={x}` and that `x` comes
 * from a response field; it cannot see whether the SERVER computed that field
 * over the same predicate as the rows. That is the API tests' job, and
 * scim-sync-failure-filters asserts exactly it.
 *
 * Usage:
 *   node apps/web/scripts/admin-count-truth-audit.mjs
 *   node apps/web/scripts/admin-count-truth-audit.mjs --json
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIR = join(WEB_ROOT, "app", "(app)", "admin");

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "page.tsx") out.push(p);
  }
  return out;
}

function routeOf(file) {
  const rel = relative(join(WEB_ROOT, "app", "(app)"), dirname(file));
  return (
    "/" +
    rel
      .split(sep)
      .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
      .map((s) => (s.startsWith("[") ? ":" + s.replace(/[[\].]/g, "") : s))
      .join("/")
  );
}

function sourceFor(file) {
  const parts = [readFileSync(file, "utf8")];
  const dir = dirname(file);
  for (const sub of ["_sections", "_tabs", "_components"]) {
    const d = join(dir, sub);
    try {
      if (!statSync(d).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const n of readdirSync(d)) {
      if (/\.tsx?$/.test(n)) parts.push(readFileSync(join(d, n), "utf8"));
    }
  }
  return parts.join("\n");
}

/** Comments stripped: a page that DISCUSSES a count must not be scored on it. */
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Nouns that make a bare `{x.length}` a CLAIM ABOUT A COLLECTION.
 *
 * `{steps.length}` inside "step 2 of {steps.length}" is a progress indicator,
 * not a population count, and flagging it would bury the real ones.
 */
const COUNTED_NOUN =
  /(record|item|row|result|event|job|run|grant|session|failure|incident|organization|user|workspace|alert|attestation|inquiry|request|condition|report|token|rule|member|customer|export|check)/i;

/**
 * Lists the server returns IN FULL.
 *
 * A bare length is the exact population when nothing truncates it, so these
 * are not findings — but "nothing truncates it" is a claim about the SERVER,
 * which this script cannot see. Each entry therefore names the handler, and
 * an API test (admin-count-truth-complete-lists.test.ts) asserts that handler
 * still has no row cap. Delete a cap-free `findMany` guard and the API suite
 * fails; add a `take` to one of these endpoints and it fails too.
 */
const COMPLETE_LISTS = [
  {
    route: "/admin/platform/automation",
    noun: "rule",
    endpoint: "GET /v1/automation/rules",
    reason:
      "Rules are per-workspace configuration, bounded by what an operator " +
      "created; the handler runs findMany with no take, so the length IS the " +
      "population.",
  },
];

/**
 * Counts of a field ON ONE RECORD, not of a list.
 *
 * The record arrived whole, so its own array length is exact. Each entry names
 * the expression and why the field is not truncated on the way here.
 */
const PER_RECORD_FIELDS = [
  {
    route: "/admin/identity",
    expression: "a.ipAllowlist",
    reason:
      "The allowlist is a column on the ServiceAccount row being rendered, " +
      "selected in full by the roster query — there is no separate paged read " +
      "of it, so the length is the account's whole allowlist.",
  },
];

const isPerRecordField = (route, expression) =>
  PER_RECORD_FIELDS.some(
    (d) => d.route === route && d.expression === expression,
  );

const isDeclaredComplete = (route, noun) =>
  COMPLETE_LISTS.some(
    (d) => d.route === route && noun.toLowerCase().includes(d.noun),
  );

/**
 * The noun a count is attached to, cleaned for the record.
 *
 * The raw capture runs to the next `{`, so a template literal leaves its `$`
 * behind — `event$` in a committed table reads as a typo in the product rather
 * than an artefact of the scanner.
 */
const nounOf = (trailing) =>
  trailing.trim().replace(/[$\s]+$/, "").slice(0, 24);

function classify(block) {
  if (/\btotal=\{/.test(block)) return "EXACT_TOTAL";
  if (/\bhasMore=\{/.test(block)) return "SERVER_HAS_MORE";
  if (/\bcap=\{/.test(block)) return "CAP_DISCLOSED";
  return "LOADED_ONLY";
}

const rows = walk(ADMIN_DIR).map((file) => {
  const route = routeOf(file);
  const code = strip(sourceFor(file));
  const sites = [];

  // 1. <ResultCount …/> — read the props it was given.
  for (const m of code.matchAll(/<ResultCount([\s\S]{0,600}?)\/>/g)) {
    const props = m[1];
    const noun = /noun="([^"]+)"/.exec(props)?.[1] ?? "?";
    sites.push({
      kind: "ResultCount",
      noun,
      truth: classify(props),
      filteredAware: /\bfiltered=\{/.test(props),
      loadingAware: /\bloading=\{/.test(props),
    });
  }

  // The regions already described by a <ResultCount>, so an inline match
  // inside its own props is not a second, unbacked count. Without this the
  // audit reported `noun="inquiry"` as a bare length claim.
  const resultCountSpans = [
    ...code.matchAll(/<ResultCount[\s\S]{0,600}?\/>/g),
  ].map((m) => [m.index, m.index + m[0].length]);
  const insideAResultCount = (i) =>
    resultCountSpans.some(([a, b]) => i >= a && i <= b);

  // 2. A hand-written `{x.length}` next to a counted noun.
  for (const m of code.matchAll(
    /\{\s*([A-Za-z_$][\w$.?]*)\.length\s*\}([^<{]{0,40})/g,
  )) {
    const trailing = m[2];
    if (!COUNTED_NOUN.test(trailing)) continue;
    if (insideAResultCount(m.index)) continue;

    // `{matches.length} of {RUNBOOK_INDEX.length} runbooks` states its own
    // denominator. The population is on screen, so nothing is hidden — this is
    // an exact total written longhand, not an unbacked claim. Both halves have
    // to be checked: the FIRST `{…length}` is followed by `} of {`, the second
    // is preceded by it, and only the second is adjacent to the noun.
    const ahead = code.slice(m.index, m.index + m[0].length + 60);
    const behind = code.slice(Math.max(0, m.index - 60), m.index);
    if (/\}\s*of\s*\{/.test(ahead) || /\}\s*of\s*\{?\s*$/.test(behind)) {
      sites.push({
        kind: "inline",
        noun: nounOf(trailing),
        truth: "EXACT_TOTAL",
        filteredAware: true,
        loadingAware: false,
      });
      continue;
    }

    // A field on ONE ROW is not a claim about a list, but that cannot be
    // inferred from shape: `{a.ipAllowlist.length}` and `{group.results.length}`
    // are the same expression, and an earlier version of this script exempted
    // both because both roots are bound by a `.map(`. One is an allowlist that
    // arrived whole with its record; the other is a page of search results that
    // was cut off at ten. Guessing got the second one wrong, so the exemption
    // is now a written-down decision per site rather than a pattern.
    if (isPerRecordField(route, m[1])) continue;

    // A neighbouring hasMore/total in the same JSX region still counts as
    // metadata — the wording may be hand-rolled but the fact is real.
    const around = code.slice(Math.max(0, m.index - 400), m.index + 400);
    sites.push({
      kind: "inline",
      noun: nounOf(trailing),
      truth: /truncated|perTypeLimit|capped/.test(around)
        ? "CAP_DISCLOSED"
        : /nextCursor|hasMore|\btotal\b/.test(around)
          ? "SERVER_HAS_MORE"
          : "LOADED_ONLY",
      filteredAware: /match|matching/i.test(around),
      loadingAware: /loading/i.test(around),
    });
  }

  // 3. A bare `{identifier}` next to a counted noun — `{total} matches`.
  //    Missed entirely while only `.length` was scanned, which is how
  //    /admin/search shipped a sum of capped groups labelled "N matches".
  for (const m of code.matchAll(
    /(^|[^$])\{\s*([a-z][A-Za-z0-9_]{2,24})\s*\}(\s*[a-z][^<{]{0,30})/gm,
  )) {
    // `${total} workspaces` inside a template literal is NOT this pattern — it
    // is string interpolation, and those three pages already render
    // "Showing 1–25 of 214" with real pagination behind it. Requiring the brace
    // not to be preceded by `$` is what keeps a correct page out of the report.
    const [, , ident, trailing] = m;
    if (!/^(total|count|shown|matches|results|num[A-Z]\w*)$/.test(ident))
      continue;
    if (!COUNTED_NOUN.test(trailing)) continue;
    if (insideAResultCount(m.index)) continue;
    const around = code.slice(Math.max(0, m.index - 900), m.index + 900);
    sites.push({
      kind: "bare-total",
      noun: nounOf(trailing),
      truth: /truncated|hasMore|nextCursor|perTypeLimit|\bcap\b/.test(around)
        ? "CAP_DISCLOSED"
        : "LOADED_ONLY",
      filteredAware: /match|matching/i.test(around),
      loadingAware: /loading/i.test(around),
    });
  }

  return { route, sites };
});

const flat = rows
  .flatMap((r) => r.sites.map((s) => ({ route: r.route, ...s })))
  .map((s) =>
    s.truth === "LOADED_ONLY" && isDeclaredComplete(s.route, s.noun)
      ? { ...s, truth: "COMPLETE_LIST" }
      : s,
  );
const loadedOnly = flat.filter((s) => s.truth === "LOADED_ONLY");

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        generatedFrom: "apps/web/app/(app)/admin",
        completeListDeclarations: COMPLETE_LISTS,
        sites: flat,
      },
      null,
      2,
    ),
  );
} else if (process.argv.includes("--markdown")) {
  // Generated rather than written, because a hand-maintained table of 17 call
  // sites is a table that is wrong within a month — the capability map in this
  // repo is 176 rows wrong for exactly that reason.
  const MEANING = {
    EXACT_TOTAL:
      "the server counted everything matching the filter — the number is a fact",
    SERVER_HAS_MORE:
      "the server said whether another page exists — completeness is a fact, the total is not claimed",
    CAP_DISCLOSED:
      "only the request's cap is known, and the wording says so",
    COMPLETE_LIST:
      "the endpoint returns every row; see the declaration table below",
    LOADED_ONLY: "**nothing** — the page prints the length of what it received",
  };
  const out = [];
  out.push("# Where every admin count comes from");
  out.push("");
  out.push(
    "Generated by `apps/web/scripts/admin-count-truth-audit.mjs --markdown`.",
  );
  out.push(
    "Do not edit by hand — `apps/web/__tests__/admin-count-truth.test.mjs`",
  );
  out.push("regenerates it and fails on a difference.");
  out.push("");
  out.push(
    "A count is a claim. `200 incidents` claims there are two hundred; if the",
  );
  out.push(
    "request capped at 200 the claim is false, and false in the direction that",
  );
  out.push(
    "matters — an operator counting open conditions during a review gets a",
  );
  out.push("confident wrong answer with no way to tell.");
  out.push("");
  out.push("## Call sites");
  out.push("");
  out.push("| Route | Rendered by | Backed by | Filter-aware | Loading-aware |");
  out.push("| --- | --- | --- | :-: | :-: |");
  for (const s of flat) {
    out.push(
      `| \`${s.route}\` | ${s.kind} — ${s.noun.trim()} | \`${s.truth}\` | ${
        s.filteredAware ? "yes" : "—"
      } | ${s.loadingAware ? "yes" : "—"} |`,
    );
  }
  out.push("");
  out.push("## What each classification means");
  out.push("");
  for (const [k, v] of Object.entries(MEANING)) out.push(`- \`${k}\` — ${v}`);
  out.push("");
  out.push("## Lists declared complete");
  out.push("");
  out.push(
    "The one place this audit accepts a bare length. Each is a claim about a",
  );
  out.push(
    "handler in `services/api`, asserted by",
  );
  out.push("`services/api/test/admin-count-truth-complete-lists.test.ts`.");
  out.push("");
  for (const d of COMPLETE_LISTS) {
    out.push(`- **\`${d.endpoint}\`** — counted on \`${d.route}\`. ${d.reason}`);
  }
  out.push("");
  out.push("## Counts of a field on one record");
  out.push("");
  out.push(
    "Not list populations. Written down rather than inferred: `a.ipAllowlist`",
  );
  out.push(
    "and `group.results` are the same shape, and an earlier pattern-based",
  );
  out.push("exemption wrongly cleared the second — a page of search results");
  out.push("that had been cut off at ten.");
  out.push("");
  for (const d of PER_RECORD_FIELDS) {
    out.push(`- **\`${d.expression}\`** on \`${d.route}\`. ${d.reason}`);
  }
  out.push("");
  console.log(out.join("\n"));
} else {
  const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
  console.log(pad("ROUTE", 36) + pad("KIND", 13) + pad("TRUTH", 17) + "NOUN");
  console.log("-".repeat(96));
  for (const s of flat) {
    console.log(pad(s.route, 36) + pad(s.kind, 13) + pad(s.truth, 17) + s.noun);
  }
  const by = {};
  for (const s of flat) by[s.truth] = (by[s.truth] ?? 0) + 1;
  console.log(
    `\n${flat.length} count site(s) across ${rows.filter((r) => r.sites.length).length} route(s)`,
  );
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
  if (loadedOnly.length > 0) {
    console.log(
      `\n${loadedOnly.length} site(s) show a number with no server metadata behind it.`,
    );
  }
}

process.exit(loadedOnly.length > 0 ? 1 : 0);
