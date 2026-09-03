#!/usr/bin/env node
/**
 * DOES EACH ADMIN PAGE MEET THE COMPOSITION CONTRACT?
 *
 * =============================================================================
 * WHY A SECOND AUDIT
 * =============================================================================
 * `admin-composition-audit.mjs` looks for DEFECTS — a raw KMS ARN, a "Page 1 of
 * 0", a missing empty state. It reports 18 pages with findings and all 18 are
 * the same hard-coded status hex, which is a consistency observation rather
 * than a fault. On its evidence the console is finished.
 *
 * It is not finished, and the gap is the difference between "nothing is broken"
 * and "this page is composed". A list with no total count is not broken. A
 * detail page with no timestamps is not broken. A page whose filters are
 * advertised in the UI and applied in the browser rather than by the server is
 * not broken either — it is wrong at 10,000 rows, silently.
 *
 * So this asks the positive question, against the contract:
 *
 *   LISTS       title, scope, total count, filters, server-side filtering,
 *               sorting where advertised, pagination, empty result,
 *               filtered-empty result, responsive table
 *
 *   DETAILS     breadcrumb, return path, identity summary, scope, state,
 *               timestamps, related records, history, grouped actions
 *
 *   ANY PAGE    no lone-value card walls, no pill walls, no duplicated
 *               primary actions, red only on proven failure
 *
 * =============================================================================
 * WHAT IT CANNOT DO
 * =============================================================================
 * It reads source. It can see that a page renders a `<FilterBar>` and passes
 * the filter into the request; it cannot see whether the server honours it.
 * That is what the browser matrix and the contract matrix are for, and this
 * says PRESENT/ABSENT rather than CORRECT.
 *
 * Every check names the contract clause it enforces, so a failure is
 * actionable without reading this file.
 *
 * Usage:
 *   node apps/web/scripts/admin-composition-contract.mjs
 *   node apps/web/scripts/admin-composition-contract.mjs --json
 *   node apps/web/scripts/admin-composition-contract.mjs --route /admin/costs
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

/** The page plus the local components it renders from. */
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

/** Comments stripped — a page that DISCUSSES pagination must not pass on that. */
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Is this page a LIST?
 *
 * Decided by shape rather than by name: a page that renders rows from a
 * fetched array is a list whatever its route is called. `/admin/timeline` and
 * `/admin/audit` are lists; `/admin/dashboard` is not, despite having tables.
 */
function isList(code, route) {
  // A DETAIL page is never a list page, whatever it renders.
  //
  // /admin/users/:id has three related-record tables and so matched the shape,
  // and was then failed for having no total count. Contract 3.3 is about LIST
  // PAGES; contract 3.4 governs detail pages and asks for related records,
  // history and timestamps — not a count. Applying the wrong clause would have
  // put "3 organizations" above a three-row table on a person's profile.
  if (route && isDetail(route)) return false;

  // TABLE ROWS over FETCHED data. Both halves matter.
  //
  // A looser version matched any `.map((r) => …)`, which classified
  // /admin/platform/readiness as a list because it maps RUNBOOK_LINKS with a
  // parameter named `r`. It then failed that page for having no filters and no
  // total count, neither of which a posture page should have. A contract
  // applied to the wrong kind of page is worse than no contract: it generates
  // work that makes the product worse.
  const rendersRows = /<tbody|<DataTable/.test(code);
  const fetchesCollection = /apiFetch/.test(code);
  return rendersRows && fetchesCollection;
}

/**
 * Does the server page this list?
 *
 * `limit`/`offset`/`cursor` in the REQUEST, not the word "page" anywhere in
 * the file — every React page module contains "page".
 */
/**
 * Does this page FILTER a list, as opposed to merely containing a <select>?
 *
 * /admin/identity/providers has two selects and no filters: they are the
 * provider type and the JIT default role in the CREATE form. Counting them as
 * filters demanded a "no results match" state for a list nobody can filter,
 * which is a sentence that could never appear.
 *
 * A FilterBar is unambiguous. Failing that, a state setter named *Filter is
 * the convention this codebase actually uses.
 */
/**
 * How this page filters, if it does.
 *
 *   "none"      no filter control at all
 *   "declared"  a FilterBar or a *Filter state — present, but whether it
 *               reaches the server still has to be checked separately
 *   "request"   PROVEN server-side: a control whose state sits in the
 *               dependency array of a block that fetches, so changing it
 *               re-queries rather than re-rendering
 *
 * The distinction matters because the two failures below ask different
 * questions. A page in "request" cannot be filtering client-side — that is
 * what the classification means — so asking it to prove server-side filtering
 * a second time, by looking for URLSearchParams, only finds pages that build
 * their URL with a template literal instead.
 */
/**
 * How this page filters, if it does.
 *
 *   "none"      no filter control at all
 *   "declared"  a FilterBar or a *Filter state — present, but whether it
 *               reaches the server still has to be checked separately
 *   "request"   PROVEN server-side: a control whose state sits in the
 *               dependency array of a block that fetches, so changing it
 *               re-queries rather than re-renders
 *
 * The two failures below ask different questions, and a page in "request"
 * cannot be filtering client-side — that is what the classification means.
 *
 * Three calibrations, each of which had produced a wrong answer:
 *
 *   * Requiring a <FilterBar> missed the queues page, where the operator
 *     picks a queue from the overview cards and the page reloads that
 *     queue's failures from a different endpoint path. Demanding a dropdown
 *     there would have meant duplicating a card grid that already shows
 *     every queue's depth — worse UX in service of a passing script.
 *
 *   * Scanning useEffect alone missed /admin/identity/sessions. Its loader
 *     is a useCallback holding includeRevoked and includeExpired, which go
 *     straight into the query string; the effect only sees `[load]`.
 *
 *   * Scanning every useCallback was too wide: a submit handler also
 *     fetches and also lists its form fields, which classified the seats
 *     input on /admin/provisioning as a filter. A loader is named in an
 *     effect's dependency array; a submit handler is not.
 */
function filterKind(code) {
  const declared =
    /<FilterBar/.test(code) || /set[A-Z][A-Za-z0-9_]*Filter\b/.test(code);

  const stateNames = [...code.matchAll(/const \[(\w+), set\w+\] = useState/g)].map((m) => m[1]);
  if (stateNames.length === 0) return declared ? "declared" : "none";

  // The callbacks that fetch, collected FIRST so effects can be judged by
  // whether they call one.
  const fetchingCallbacks = new Map();
  for (const m of code.matchAll(/const (\w+) = useCallback\(([\s\S]{0,4000}?)\}, \[([^\]]*)\]\)/g)) {
    const [, name, cbBody, deps] = m;
    if (/apiFetch/.test(cbBody)) fetchingCallbacks.set(name, deps);
  }

  const effectDeps = [];
  const fetchingDeps = [];
  for (const m of code.matchAll(/useEffect\(([\s\S]{0,4000}?)\}, \[([^\]]*)\]\)/g)) {
    const [, effectBody, deps] = m;
    effectDeps.push(deps);
    // An effect fetches if it calls apiFetch, OR if it calls a loader that
    // does. /admin/platform/queues is the second shape:
    //
    //     useEffect(() => { if (selectedQueue) loadFailed(selectedQueue); },
    //               [selectedQueue, loadFailed]);
    //
    // The queue selector is unmistakably server-side — it reloads a different
    // endpoint path — and one indirection was enough to hide it.
    const callsALoader = [...fetchingCallbacks.keys()].some((name) =>
      new RegExp("\\b" + name + "\\s*\\(").test(effectBody),
    );
    if (/apiFetch/.test(effectBody) || callsALoader) fetchingDeps.push(deps);
  }
  for (const [name, deps] of fetchingCallbacks) {
    const runByAnEffect = effectDeps.some((d) =>
      new RegExp("(^|[\\s,])" + name + "([\\s,]|$)").test(d),
    );
    if (runByAnEffect) fetchingDeps.push(deps);
  }
  if (fetchingDeps.length === 0) return declared ? "declared" : "none";

  const requestDriving = stateNames.some((name) => {
    const bound = new RegExp("=\\{" + name + "\\}").test(code);
    const drives = fetchingDeps.some((d) =>
      new RegExp("(^|[\\s,])" + name + "([\\s,]|$)").test(d),
    );
    return bound && drives;
  });

  if (requestDriving) return "request";
  return declared ? "declared" : "none";
}

const hasFilters = (code) => filterKind(code) !== "none";

function isPaginated(code) {
  // `nextCursor`/`hasMore`, never a bare `cursor`.
  //
  // Matching `cursor` caught `cursor: "pointer"` — a CSS property — and
  // classified the analytics dashboard and the observability page as paged
  // lists needing filters. A pagination cursor always arrives as nextCursor
  // or is sent as a query parameter; the CSS one never is.
  // A REQUEST form, not the word.
  //
  // `\b(limit)\b\s*[=:,)]` matched "Soft limit: {formatMoney(...)}" in the
  // cost dashboard’s display copy and classified the page as paged. The three
  // shapes a request actually takes are `limit=` in a template, `"limit"` in
  // params.set, and `limit: <number>` in an options object — display copy
  // never puts a bare numeral after the colon.
  return (
    /\b(limit|offset|pageSize|per_page)=/.test(code) ||
    /["'](limit|offset|pageSize|per_page)["']/.test(code) ||
    /\b(limit|offset|pageSize|per_page):\s*\d/.test(code) ||
    /\bnextCursor\b|\bhasMore\b/.test(code)
  );
}

const isDetail = (route) => /\/:(id|slug)$/.test(route);

const CHECKS = [
  // ---- Lists (contract 3.3) ------------------------------------------------
  {
    id: "LIST_NO_TOTAL_COUNT",
    clause: "3.3 a list must state its total",
    when: (c, route) => isList(c, route),
    // "12 organizations", "Showing 1-20 of 340", "total" bound into copy.
    fail: (c) =>
      !/\btotal\b|\bcount\b|\{\s*rows\.length\s*\}|of\s*\{|\bresults?\b/i.test(c),
  },
  {
    id: "LIST_NO_FILTERS",
    clause: "3.3 an UNBOUNDED list must offer real filters",
    // Only where the list can actually grow.
    //
    // A blanket rule reported 17 pages, and acting on it would have added a
    // filter row above the four signer purposes and the handful of recovery
    // checks — controls with nothing to narrow, occupying the space the data
    // should have. That makes the console worse while satisfying an audit,
    // which is the failure mode this whole exercise exists to avoid.
    //
    // Pagination is the honest proxy for "can be long": a list the server
    // pages is a list nobody can read in one screen.
    when: (c, route) => isList(c, route) && isPaginated(c),
    // One definition of "has a filter", shared with the server-side check.
    // The inline regex here was a second, narrower copy that could not see the
    // queues page’s card-based queue selector.
    fail: (c) => !hasFilters(c),
  },
  {
    id: "LIST_FILTER_NOT_SERVER_SIDE",
    clause: "3.3 a filter over a PAGED list must be applied by the server",
    // Only when the server paged the list.
    //
    // The original premise was "a client-side filter lies at scale: it narrows
    // the page you can see and nothing else". That is true of a PAGED list and
    // false of a complete one. /admin/identity fetches /v1/identity/members,
    // whose service is findMany({ where: { teamId } }) with no take — the
    // browser holds every member, so filtering locally narrows all of them and
    // is both correct and instant.
    //
    // Worth recording rather than fixing here: that unbounded query is a real
    // scale risk on its own. A workspace with five thousand members ships five
    // thousand rows to render twenty. That is an API change with blast radius
    // well beyond the admin console, and pretending otherwise by bolting a
    // query parameter onto the page would leave the payload exactly as large.
    when: (c, route) =>
      isList(c, route) && isPaginated(c) && filterKind(c) === "declared",
    fail: (c) =>
      !/URLSearchParams|searchParams|\?\$\{|qs\.set|params\.set|\bquery\b\s*[,:]/.test(c),
  },
  {
    id: "LIST_NO_PAGINATION",
    clause: "3.3 a list must paginate",
    when: (c, route) => isList(c, route),
    fail: (c) => !/page|cursor|limit|offset|nextPage|hasMore/i.test(c),
  },
  {
    id: "LIST_NO_FILTERED_EMPTY",
    clause: "3.3 an empty RESULT and an empty TABLE read differently",
    when: (c, route) => isList(c, route) && hasFilters(c),
    // Applies to any filtered list, paged or not: the two sentences differ
    // whether or not the server did the narrowing.
    // "No records yet" and "No records match these filters" are different
    // sentences, and showing the first when a filter is active tells the
    // reader their data is gone.
    // Several phrasings say the same thing. The queues page words it as
    // "No failed jobs in <queue>. Other queues may still have failures",
    // which distinguishes empty-because-of-your-selection from empty-overall
    // more usefully than "no results match" would on a page whose filter is
    // the queue you are looking at.
    fail: (c) =>
      !/match|matching|still have|other \w+ may|clearing (them|the filter)/i.test(c),
  },
  {
    id: "LIST_TABLE_NOT_SCROLLABLE",
    clause: "3.3 a wide table scrolls itself, not the page",
    when: (c) => /<table/.test(c),
    fail: (c) =>
      !/overflow-x|overflowX|apf-table-wrap|table-wrap|overflow:\s*auto/.test(c),
  },

  // ---- Details (contract 3.4) ---------------------------------------------
  {
    id: "DETAIL_NO_RETURN_PATH",
    clause: "3.4 a detail page must have a deterministic way back",
    when: (_c, route) => isDetail(route),
    fail: (c) => !/←|&larr;|Back to|All \w/.test(c),
  },
  {
    id: "DETAIL_NO_TIMESTAMPS",
    clause: "3.4 a detail page must say when",
    when: (_c, route) => isDetail(route),
    // <time> is the canonical markup for a timestamp and was missing from
    // this list, so a page that used it correctly still failed. `Utc` rather
    // than `AtUtc`: lastChangedUtc is a timestamp too.
    fail: (c) =>
      !/formatDateTime|toLocaleString|createdAt|updatedAt|Utc|<time/.test(c),
  },
  {
    id: "DETAIL_NO_STATE",
    clause: "3.4 a detail page must show current state",
    when: (_c, route) => isDetail(route),
    fail: (c) => !/status|state|lifecycle|Badge/i.test(c),
  },

  // ---- Any page (contract 3.1) --------------------------------------------
  {
    id: "LONE_VALUE_CARD_WALL",
    clause: "3.1 no wall of cards each holding one number",
    when: () => true,
    // Four or more. Three stat cards is a summary; six is a table someone drew
    // with boxes, at six times the vertical cost.
    // A STATUS BANNER is not a stat card.
    //
    // This counted any Card whose body is a single interpolation, which
    // includes `<Card variant="status" tone="risk">{errorMessage}</Card>` —
    // a conditional error banner. /admin/support-access has five of those,
    // one per independent failure surface, of which at most one or two are
    // ever on screen. It was reported as a wall of one-value cards and it is
    // not one; the page has a single content Card.
    //
    // The clause is about a column of boxes each holding one NUMBER, so the
    // count now skips variant="status".
    fail: (c) =>
      (c.match(
        /<Card(?![^>]*variant="status")[^>]*>\s*(?:<[^>]+>\s*){0,2}\{[a-zA-Z0-9_.?\s]{0,30}\}\s*(?:<\/[^>]+>\s*){0,2}<\/Card>/g,
      ) ?? []).length >= 4,
  },
  {
    id: "DUPLICATE_PRIMARY_ACTION",
    clause: "3.1 one primary action per surface",
    when: () => true,
    fail: (c) => (c.match(/variant="primary"/g) ?? []).length >= 4,
  },
];

const rows = walk(ADMIN_DIR)
  .map((file) => {
    const route = routeOf(file);
    const code = strip(sourceFor(file));
    const failures = CHECKS.filter(
      (chk) => chk.when(code, route) && chk.fail(code, route),
    ).map((chk) => chk.id);
    return {
      route,
      kind: isDetail(route) ? "detail" : isList(code, route) ? "list" : "surface",
      failures,
    };
  })
  .sort(
    (a, b) => b.failures.length - a.failures.length || a.route.localeCompare(b.route),
  );

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total: rows.length, rows, checks: CHECKS.map((c) => ({ id: c.id, clause: c.clause })) }, null, 2));
} else {
  const only = process.argv.includes("--route")
    ? process.argv[process.argv.indexOf("--route") + 1]
    : null;
  const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
  for (const r of rows) {
    if (only && r.route !== only) continue;
    if (r.failures.length === 0 && !only) continue;
    console.log(pad(r.route, 36) + pad(r.kind, 9) + r.failures.join(", "));
  }
  const counts = {};
  for (const r of rows) for (const fl of r.failures) counts[fl] = (counts[fl] ?? 0) + 1;
  const clean = rows.filter((r) => r.failures.length === 0).length;
  console.log(
    `\n${rows.length} pages · ${clean} meet the contract · ${rows.length - clean} do not\n` +
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => {
          const clause = CHECKS.find((c) => c.id === k)?.clause ?? "";
          return `  ${String(v).padStart(3)}  ${k}\n       ${clause}`;
        })
        .join("\n"),
  );
}
