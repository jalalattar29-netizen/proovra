#!/usr/bin/env node
/**
 * DO THE ENDPOINTS OUR RUNBOOKS TELL AN OPERATOR TO CALL ACTUALLY EXIST?
 *
 * =============================================================================
 * WHY THIS GATE EXISTS (ADM-P2-001)
 * =============================================================================
 * `docs/runbooks/*.md` is compiled into `apps/web/lib/runbooks/catalog.generated.ts`
 * and rendered verbatim at `/admin/platform/runbooks/:slug`. An operator reads it
 * mid-incident and types what it says.
 *
 * A freshness gate already exists and it compares the markdown to the generated
 * catalog — so the console can never show a stale procedure while the repository
 * shows a corrected one. Nothing compared either to the route table. Checking
 * every `/v1/...` citation against the real registrations found five that
 * resolve to nothing:
 *
 *   GET  /v1/admin/reports/:id                                 no such route, anywhere
 *   GET  /v1/governance/export/eligibility?evidenceId=          the real path is
 *                                                               /v1/governance/export-eligibility
 *                                                               (a hyphen, not a segment) AND it
 *                                                               requires teamId, which the curl omitted
 *   POST /v1/internal/governance/retention-reconciliation/run   no HTTP trigger exists; it is a worker cron
 *   GET  /v1/ops/audit/verify                                   the verifier is /v1/admin/audit-log/verify
 *   POST /v1/reviewer-ops/policy                                the real path is /v1/reviewer-ops/sla-policy
 *
 * Two of those are one character out, which is exactly why prose is not a
 * substitute for a check.
 *
 * =============================================================================
 * IT DOES NOT PARSE ROUTES
 * =============================================================================
 * There is one route authority in this repository —
 * `generate-runtime-capability-map.mjs`, which parses the real TypeScript with
 * the compiler API — and its output is
 * `docs/architecture/current-runtime-capability-map.json`. A second text scanner
 * is how the tree ended up with two disagreeing answers before; this gate reads
 * the map.
 *
 * =============================================================================
 * WHAT IT ACCEPTS
 * =============================================================================
 * A citation must resolve to a registered route with a matching method. Path
 * parameters match any segment, so `/v1/ops/incidents/:id/resolve` matches the
 * registration whatever the parameter is called.
 *
 * A citation that is deliberately NOT an HTTP call — a shape being described, a
 * path that names a worker rather than a route — must be listed in
 * `NON_HTTP_CITATIONS` below WITH A REASON. Nothing is exempt by pattern.
 *
 * Where a runbook shows a `curl`, every query parameter the route REQUIRES must
 * be present in the example, because an operator pastes the example.
 *
 * Usage:
 *   node services/api/scripts/verify-runbook-endpoints.mjs
 *   node services/api/scripts/verify-runbook-endpoints.mjs --json
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const RUNBOOKS = path.join(REPO, "docs", "runbooks");
const MAP = path.join(
  REPO,
  "docs",
  "architecture",
  "current-runtime-capability-map.json",
);

/**
 * Citations that are deliberately not calls to a registered HTTP route.
 *
 * Each needs a REASON, and the reason has to say why an operator reading it
 * will not try to call it. "It is only an example" is not one of those.
 */
const NON_HTTP_CITATIONS = new Map([
  [
    "/v1/internal/governance/retention-reconciliation/run",
    "RETIRED CITATION — kept here only so the gate explains itself if it " +
      "reappears. Retention reconciliation has no HTTP trigger: it is a worker " +
      "cron (services/worker/src/index.ts, withCronLock). retention-precedence.md " +
      "now says so and names the real operator path.",
  ],
]);

/**
 * Query parameters a route REQUIRES, for the citations that show a curl.
 *
 * Only routes whose absence of a parameter produces a 400 belong here — this is
 * about an example an operator can paste, not about documenting every optional
 * filter.
 */
const REQUIRED_QUERY = new Map([
  ["GET /v1/governance/export-eligibility", ["teamId", "evidenceId"]],
]);

function loadRoutes() {
  const map = JSON.parse(readFileSync(MAP, "utf8"));
  const routes = Array.isArray(map.routes) ? map.routes : [];
  if (routes.length === 0) {
    throw new Error(
      `the capability map at ${MAP} lists no routes — regenerate it before running this gate`,
    );
  }
  return routes
    .filter((r) => r.productionRegistered !== false)
    .map((r) => ({
      method: String(r.method || "").toUpperCase(),
      path: String(r.path || ""),
      re: new RegExp(
        "^" +
          String(r.path || "")
            .split("/")
            .map((seg) =>
              seg.startsWith(":")
                ? "[^/]+"
                : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join("/") +
          "$",
      ),
    }));
}

/**
 * Every executable `/v1/...` citation in a runbook, with the method the prose
 * gives it.
 *
 * The method comes from the sentence — "GET /v1/x", "POST /v1/y", or a
 * `curl -X POST` above the URL. A citation with no stated method is read as GET,
 * which is what an operator would assume.
 */
function citationsIn(markdown, file) {
  const out = [];
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, i) => {
    /*
     * THE QUERY STRING IS PART OF THE CITATION.
     *
     * An earlier version of this character class stopped at `?`, so the query
     * never reached the `MISSING_REQUIRED_QUERY` check below and that check
     * could not fail — the same shape of vacuous assertion this phase exists to
     * remove. Caught by mutating a runbook to drop a required parameter and
     * watching the gate stay green.
     *
     * `?`, `=`, `&`, `<`, `>` are all inside the class now, so a curl example
     * is captured whole. Trailing prose punctuation is trimmed below.
     */
    const re =
      /(?:\b(GET|POST|PUT|PATCH|DELETE)\s+)?(\/v1\/[A-Za-z0-9/_:.\-{}?=&<>]*)/g;
    let m;
    while ((m = re.exec(line))) {
      const raw = m[2].replace(/[.,)`'"]+$/, "");
      if (!raw.startsWith("/v1/")) continue;
      let method = m[1];
      if (!method) {
        // A curl block states its method above the URL.
        const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
        const cm = window.match(/curl[^\n]*-X\s+([A-Z]+)/);
        method = cm ? cm[1] : "GET";
      }
      out.push({ file, line: i + 1, method, raw });
    }
  });
  return out;
}

const routes = loadRoutes();
const problems = [];
const checked = [];

for (const name of readdirSync(RUNBOOKS).filter((n) => n.endsWith(".md"))) {
  const md = readFileSync(path.join(RUNBOOKS, name), "utf8");
  for (const c of citationsIn(md, name)) {
    const [pathOnly, query = ""] = c.raw.split("?");
    // `:id` in prose, `<id>` in a curl, `{id}` in a template — all parameters.
    const normalised = pathOnly
      .split("/")
      .map((s) => (s.startsWith(":") || /^[<{]/.test(s) ? ":p" : s))
      .join("/")
      .replace(/\/$/, "");

    const exempt = NON_HTTP_CITATIONS.get(normalised);
    if (exempt) {
      checked.push({ ...c, verdict: "EXEMPT", reason: exempt });
      continue;
    }

    const candidates = routes.filter((r) => r.re.test(normalised));
    if (candidates.length === 0) {
      problems.push({
        ...c,
        kind: "NO_SUCH_ROUTE",
        detail: `no registered route matches ${normalised}`,
      });
      continue;
    }
    if (!candidates.some((r) => r.method === c.method)) {
      problems.push({
        ...c,
        kind: "WRONG_METHOD",
        detail: `${c.method} is not registered; the route answers ${[
          ...new Set(candidates.map((r) => r.method)),
        ].join(", ")}`,
      });
      continue;
    }

    const matched = candidates.find((r) => r.method === c.method);
    const required = REQUIRED_QUERY.get(`${c.method} ${matched.path}`) ?? [];
    const missing = required.filter((q) => !query.includes(`${q}=`));
    // Only an example an operator pastes must be complete. A citation with no
    // query at all is a reference to the route, not a command.
    if (query.length > 0 && missing.length > 0) {
      problems.push({
        ...c,
        kind: "MISSING_REQUIRED_QUERY",
        detail: `the example omits required parameter(s): ${missing.join(", ")}`,
      });
      continue;
    }
    checked.push({ ...c, verdict: "OK", route: matched.path });
  }
}

if (process.argv.includes("--json")) {
  process.stdout.write(
    JSON.stringify({ checked: checked.length, problems }, null, 1) + "\n",
  );
} else {
  process.stdout.write(
    `runbook endpoint integrity — ${checked.length} citation(s) checked against ` +
      `${routes.length} registered routes\n`,
  );
  for (const p of problems) {
    process.stdout.write(
      `  ${p.kind}  ${p.file}:${p.line}  ${p.method} ${p.raw}\n      ${p.detail}\n`,
    );
  }
  if (problems.length === 0) {
    process.stdout.write("  every cited endpoint resolves.\n");
  }
}

process.exit(problems.length === 0 ? 0 : 1);
