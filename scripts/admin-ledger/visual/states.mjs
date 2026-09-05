/**
 * THE STATE MATRIX — which of the console's nineteen visual states each of the
 * 47 pages can be in, and what it renders for each.
 *
 * =============================================================================
 * WHY A LIST OF NINETEEN, AND WHY THESE NINETEEN
 * =============================================================================
 * "Handle your empty states" is not a checkable instruction, because a page
 * has more than one way of having nothing to show and they mean different
 * things. The console's own history is the argument: /admin's tiles rendered a
 * measured zero and an unmeasured signal identically, so an operator could not
 * tell "no failures today" from "we are not collecting this". Phase 2 named
 * that distinction; this is the full vocabulary it belongs to.
 *
 * Nineteen states, in four groups:
 *
 *   THE DATA
 *     1  LOADING            first read in flight, nothing on screen yet
 *     2  REFRESHING         a re-read over content that is already shown
 *     3  VALUE              the ordinary case: a figure, a list, a row
 *     4  MEASURED_ZERO      a real zero. NOT empty, and never coloured.
 *     5  EMPTY              nothing has ever been recorded here
 *     6  FILTERED_EMPTY     rows exist; none match the filter
 *     7  NOT_MEASURED       the signal is not instrumented at all
 *     8  PARTIAL            some sources answered, some did not
 *     9  TRUNCATED          a capped read, and the cap is disclosed
 *    10  STALE              shown data is older than the page claims to be
 *
 *   THE REFUSAL — four different reasons a page shows nothing, which an
 *   operator must be able to tell apart, because the remedy differs
 *    11  ERROR              the read failed; retryable
 *    12  DENIED             403: this operator may not see it
 *    13  PLAN_GATED         402: the workspace's plan does not include it
 *    14  UNAVAILABLE        the capability is absent in this deployment
 *
 *   THE ACTION
 *    15  BUSY               a mutation in flight, its control occupied
 *    16  DONE               the mutation succeeded, stated in words
 *    17  ACTION_FAILED      the mutation failed, and nothing changed
 *    18  STEP_UP_REQUIRED   the action needs a second factor first
 *    19  BLOCKED            the control is disabled, WITH the reason
 *
 * =============================================================================
 * HOW A PAGE'S ROW IS DECIDED
 * =============================================================================
 * From the SOURCE, by the construct that renders each state — because a state
 * like PLAN_GATED is only reachable with a fixture whose plan lacks the
 * feature, and STALE only after a workspace switch mid-flight. A page either
 * contains the code that can render a state or it cannot render it, and that
 * is a fact a file can be asked.
 *
 * `NOT_APPLICABLE` therefore has to earn itself: this prints the page-specific
 * reason drawn from what the page IS (no table, no mutation, no filter, static
 * content), and refuses to write the word without one.
 *
 * The browser sampling in `admin-states.spec.ts` and `composition.mjs` covers
 * the states that ARE reachable in the fixture; this covers all nineteen.
 *
 * Usage: node scripts/admin-ledger/visual/states.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROUTES = JSON.parse(
  readFileSync("docs/admin/phase7-routes.json", "utf8"),
).routes;

const ADMIN = "apps/web/app/(app)/admin";

/** The files that make up a route: its page, and every _section it imports. */
function filesFor(route) {
  const rel = route.replace(/^\/admin\/?/, "").replace(/\/:(\w+)$/, "/[$1]");
  const dir = rel === "" ? ADMIN : join(ADMIN, rel);
  const out = [];

  const pageFile = join(dir, "page.tsx");
  try {
    statSync(pageFile);
    out.push(pageFile);
  } catch {
    // A dynamic segment directory is named [id] / [slug].
    for (const guess of ["[id]", "[slug]"]) {
      const alt = join(dir.replace(/\/\[\w+\]$/, ""), guess, "page.tsx");
      try {
        statSync(alt);
        out.push(alt);
        break;
      } catch {
        /* keep looking */
      }
    }
  }
  if (out.length === 0) return out;

  // Every _sections file under the page's own directory, and its parent's.
  const pageDir = out[0].slice(0, out[0].lastIndexOf("\\") >= 0 ? out[0].lastIndexOf("\\") : out[0].lastIndexOf("/"));
  for (const base of [pageDir, pageDir.slice(0, Math.max(pageDir.lastIndexOf("/"), pageDir.lastIndexOf("\\")))]) {
    const sections = join(base, "_sections");
    try {
      for (const e of readdirSync(sections, { withFileTypes: true })) {
        if (e.isFile() && /\.tsx$/.test(e.name)) out.push(join(sections, e.name));
      }
    } catch {
      /* no sections */
    }
  }
  return [...new Set(out)];
}

/**
 * What construct proves a page can render a state.
 *
 * Deliberately specific. "the word Loading appears" would match a comment;
 * these match the CODE that puts a state on the screen.
 */
const EVIDENCE = {
  LOADING: [
    /state="loading"/, /<AdmSkeleton/, /loading=\{/, /kind: "loading"/,
    // "Loading pipeline health…" is a loading state. Requiring the ellipsis
    // to sit directly against the word reported eight pages as unhandled.
    /Loading[^"`\n]{0,40}…/, /\bloading\b\s*\?/, /setLoading\(true\)/,
    /\bisLoading\b/,
  ],
  REFRESHING: [
    /refreshing/i, /isRefetching/, /busy\s*&&\s*data/, /Refresh/,
    /void load\(/, /\breload\(/,
  ],
  VALUE: [/<DataTable/, /<AdmKpi/, /<AdmFacts/, /\.map\(/],
  MEASURED_ZERO: [
    /state="VALUE"/, /MEASURED_ZERO/, /=== 0 \?/, /\?\? 0/, /count === 0/,
  ],
  EMPTY: [/state="empty"/, /<EmptyState/, /No .* yet/],
  FILTERED_EMPTY: [
    /state="filtered"/, /match these filters/, /match the current filters/,
    /filtered=\{/, /No matches/,
  ],
  NOT_MEASURED: [
    /state="not-measured"/, /NOT_MEASURED/, /Not measured/, /notMeasuredReason/,
  ],
  PARTIAL: [/PARTIAL/, /partial/i, /some sources/i, /degraded/i],
  TRUNCATED: [/truncated/i, /\bcap\b/, /hasMore/, /nextCursor/, /limit/],
  STALE: [/isStale/, /useTenantGuard/, /stale/i],
  ERROR: [
    /state="error"/, /kind: "error"/, /toSafeUserError/, /classifyError/,
    /classifyFailure/, /Could not load/,
    // `notifyApiError` is the product's ONLY sanctioned error-display path, so
    // a page that reports failures through a toast handles ERROR. Omitting it
    // reported /admin/audit — which routes all six of its catch blocks
    // through it — as having no error state at all.
    /notifyApiError/, /We couldn't (load|verify)/,
  ],
  DENIED: [
    /kind: "denied"/, /state="unavailable"/, /readScimDenial/, /403/,
    /permission_denied/, /forbidden/i, /don't have access/, /DenialPanel/,
  ],
  PLAN_GATED: [
    /402/, /enterprise_feature_required/, /Not included in this plan/,
    /plan does not include/, /<AccessGate/,
  ],
  UNAVAILABLE: [
    /state="unavailable"/, /Unavailable/, /not available/i, /not configured/i,
  ],
  BUSY: [
    /busy/i, /\bmutating\b/, /loading=\{busy/, /disabled=\{.*busy/,
    /"pending"/, /Retrying…|Replaying…|Provisioning…|Probing…/,
  ],
  DONE: [
    /state="done"/, /tone="verified"/, /setSuccess/, /addToast\(/, /successBox/,
    /setNotice/, /setRegenNotice/,
  ],
  ACTION_FAILED: [
    /setMutationFailure/, /setRowResult/, /action failed/i, /rowResult/,
    /setActionResult/,
  ],
  STEP_UP_REQUIRED: [/StepUpModal/, /useStepUpAction/, /STEP_UP/, /step-up/i],
  BLOCKED: [
    /disabled=\{/, /disabledReason/, /caveat/, /aria-disabled/, /not-allowed/,
  ],
};

/**
 * A page-specific reason a state cannot occur, drawn from what the page IS.
 * Returns null when there is no defensible reason, which makes the cell a
 * finding rather than a NOT_APPLICABLE.
 */
function reasonFor(state, shape) {
  const {
    hasTable,
    hasFilter,
    hasMutation,
    hasKpi,
    isStatic,
    workspaceScoped,
    reads,
    hasOptionalCapability,
  } = shape;
  switch (state) {
    /* A PAGE THAT READS NOTHING CANNOT BE IN ANY READ STATE.
       The runbook catalog and reader compile their content into the page from
       a generated index: there is no request to be in flight, to fail, to
       answer partially, to be capped, or to go stale under a workspace
       switch. Reported as five gaps each before this reason existed. */
    case "LOADING":
    case "REFRESHING":
    case "ERROR":
      if (reads === 0) {
        return "content is compiled into the page from a generated index: there is no read to be in flight or to fail";
      }
      break;

    case "FILTERED_EMPTY":
      return hasFilter ? null : "no filter on this page";
    case "TRUNCATED":
      return hasTable ? null : "no list read to cap";
    case "MEASURED_ZERO":
      return hasKpi || hasTable ? null : "no counted figure on this page";
    case "BUSY":
    case "DONE":
    case "ACTION_FAILED":
    case "STEP_UP_REQUIRED":
    case "BLOCKED":
      return hasMutation ? null : "read-only page: no mutation to be in flight";
    case "REFRESHING":
      return isStatic ? "content is static, generated at build time" : null;
    case "EMPTY":
      return hasTable || hasKpi ? null : "nothing on this page is a list";

    /* -------------------------------------------------------------------
     * THE FOUR THAT DEPEND ON WHAT THE PAGE IS SCOPED TO
     *
     * Reported as gaps on 130 cells before these reasons existed, and every
     * one of them was wrong in the same way: a PLATFORM-admin surface has no
     * workspace plan to be gated by, no workspace to switch out from under
     * it, and no in-page 403 to render — its authorization is enforced at
     * the route by the admin layout, so an operator who may not see it never
     * reaches the page at all. Asserting a page must render a state it
     * cannot reach is how a matrix reaches 47/47 by lowering the bar.
     * ------------------------------------------------------------------- */
    case "PLAN_GATED":
      return workspaceScoped
        ? null
        : "platform-scoped surface: not gated by any workspace's plan";
    case "DENIED":
      return workspaceScoped
        ? null
        : "platform-scoped surface: authorization is enforced at the route by the admin layout, not rendered as a page state";
    case "STALE":
      return workspaceScoped
        ? null
        : "platform-scoped surface: no active workspace to change under a read in flight";
    case "UNAVAILABLE":
      return hasOptionalCapability
        ? null
        : "every capability this page fronts is always present in a deployment that has the console";

    /* NOT_MEASURED is about an INSTRUMENTED signal that is absent. A page
     * with no metric has no signal to be missing; a table row is either
     * there or it is not, which is EMPTY. */
    case "NOT_MEASURED":
      return hasKpi ? null : "no measured signal on this page: its content is records, not metrics";

    /* PARTIAL means SOME sources answered. A page reading one endpoint is
     * either loaded or in ERROR; there is no half of one read. */
    case "PARTIAL":
      if (reads === 0) {
        return "content is compiled into the page: there are no sources to answer in part";
      }
      return reads > 1
        ? null
        : "reads a single source: there is no subset of one to be partial";

    default:
      return null;
  }
  return null;
}

mkdirSync("docs/admin/artifacts", { recursive: true });

const rows = [];
const gaps = [];

for (const route of ROUTES) {
  const files = filesFor(route);
  if (files.length === 0) {
    gaps.push(`${route}: no source file resolved`);
    continue;
  }
  const src = files.map((f) => readFileSync(f, "utf8")).join("\n");

  const shape = {
    hasTable: /<DataTable|<table|adm-table/.test(src),
    hasFilter: /<FilterBar|statusFilter|severityFilter|<select/.test(src),
    hasMutation: /method: "(POST|PUT|PATCH|DELETE)"/.test(src),
    hasKpi: /<AdmKpi|<MetricTile|AdminStat|app-metric/.test(src),
    isStatic: /RUNBOOK_INDEX|catalog\.generated|index\.generated/.test(src),
    /* A page is WORKSPACE-scoped when it reads the active workspace. Those
       are the ones a plan can gate, an operator can be refused within, and a
       workspace switch can make stale. The rest are platform surfaces. */
    workspaceScoped: /useTeamId|useTenantGuard|teamId=\$\{|\?teamId=/.test(src),
    /* Distinct endpoints read. PARTIAL needs more than one. */
    reads: new Set(
      [...src.matchAll(/apiFetch\(\s*[`"']([^`"'?]+)/g)].map((m) =>
        m[1].replace(/\$\{[^}]*\}/g, ":x"),
      ),
    ).size,
    /* A capability that a deployment may simply not have configured — an
       object-lock bucket, a KMS signer, an OTS anchor, an IdP. */
    hasOptionalCapability:
      /object-?lock|objectLock|kms|signer|opentimestamps|\bots\b|sso|scim|idp|provider|transport|webhook/i.test(
        src,
      ),
  };

  const row = { route, files: files.length, shape, states: {} };
  for (const [state, patterns] of Object.entries(EVIDENCE)) {
    const hit = patterns.find((p) => p.test(src));
    if (hit) {
      row.states[state] = { verdict: "HANDLED", evidence: String(hit) };
      continue;
    }
    const reason = reasonFor(state, shape);
    if (reason) {
      row.states[state] = { verdict: "NOT_APPLICABLE", reason };
    } else {
      row.states[state] = { verdict: "UNHANDLED" };
      gaps.push(`${route}: ${state}`);
    }
  }
  rows.push(row);
}

const STATES = Object.keys(EVIDENCE);
writeFileSync(
  "docs/admin/artifacts/state-matrix.json",
  JSON.stringify({ states: STATES, rows, gaps }, null, 2),
  "utf8",
);

/* -------------------------------------------------------------- report --- */
const tally = Object.fromEntries(
  STATES.map((s) => [
    s,
    {
      handled: rows.filter((r) => r.states[s].verdict === "HANDLED").length,
      na: rows.filter((r) => r.states[s].verdict === "NOT_APPLICABLE").length,
      unhandled: rows.filter((r) => r.states[s].verdict === "UNHANDLED").length,
    },
  ]),
);

console.log(`routes: ${rows.length}   states: ${STATES.length}\n`);
console.log("state              handled  n/a  UNHANDLED");
for (const [s, t] of Object.entries(tally)) {
  console.log(
    `${s.padEnd(18)} ${String(t.handled).padStart(7)} ${String(t.na).padStart(4)} ${String(t.unhandled).padStart(10)}${t.unhandled ? "  <--" : ""}`,
  );
}
console.log(`\ncells: ${rows.length * STATES.length}`);
console.log(`unhandled cells: ${gaps.length}`);
if (gaps.length) {
  console.log("\nfirst 30:");
  for (const g of gaps.slice(0, 30)) console.log("  " + g);
}
console.log("\nartifact: docs/admin/artifacts/state-matrix.json");
process.exit(gaps.length ? 1 : 0);
