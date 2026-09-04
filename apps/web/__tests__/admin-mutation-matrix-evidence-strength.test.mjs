/**
 * A SERVER-BEHAVIOUR CLAIM MAY NOT BE SETTLED BY READING THE SOURCE.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * The mutation matrix rates thirteen dimensions per Admin mutation. Six of
 * them are claims about what the SERVER DOES when the request lands:
 * authorization, refusal of the wrong caller, persistence, concurrency,
 * audit, tenant isolation. The other seven are claims about what the PAGE
 * renders, which source text can legitimately settle.
 *
 * `backendAuthorization` used to be settled from source: the handler named an
 * authority function, so the cell read PROVEN. Running the routes found three
 * separate mutations where the source said one thing and the server did
 * another:
 *
 *   * `POST /v1/admin/identity/sessions/:id/score` named `requireIdentityAdmin`
 *     and passed the scan, while enforcing `identity.org_policy.read` — a
 *     READ permission on a route that rewrites a session's risk score.
 *   * `POST /v1/operations/queues/:queueName/jobs/:jobId/replay` imported the
 *     step-up middleware and called it only when the CALLER supplied a
 *     job-name hint. Omitting the hint skipped the gate. The sibling `retry`
 *     route imported it and never called it at all, while its comment said
 *     the action service did.
 *   * `createSsoConnection` had an unremarkable handler that could never
 *     succeed: it re-validated its own actor field against a `.strict()`
 *     schema, so every SSO provider creation threw a 500.
 *
 * All three read as correct in the source. So the generator now reports a
 * server-behaviour cell backed only by SOURCE as MISSING and refuses to
 * finish, and this test holds that rule in place — including the part that is
 * easy to lose, which is that the OTHER seven dimensions are still allowed to
 * be settled from source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const GENERATOR = join(REPO, "apps", "web", "scripts", "admin-mutation-matrix.mjs");
const MATRIX = join(REPO, "docs", "admin", "evidence", "mutation-matrix.json");

const source = readFileSync(GENERATOR, "utf8");

/** The six dimensions that are claims about server behaviour. */
const SERVER_BEHAVIOUR = [
  "backendAuthorization",
  "unauthorizedRefused",
  "persistedEffect",
  "concurrency",
  "auditOutput",
  "tenantIsolation",
];

/** The seven that source text may legitimately settle. */
const RENDER_DIMENSIONS = [
  "discoverable",
  "explainsScope",
  "confirmation",
  "request",
  "refreshFromServer",
  "noOptimisticSuccess",
  "failureLeavesStateCorrect",
];

test("the generator declares every server-behaviour dimension", () => {
  const declared = source.match(
    /const SERVER_BEHAVIOUR_CHECKS = new Set\(\[([\s\S]*?)\]\)/,
  );
  assert.ok(declared, "SERVER_BEHAVIOUR_CHECKS is not declared");
  for (const dimension of SERVER_BEHAVIOUR) {
    assert.match(
      declared[1],
      new RegExp(`"${dimension}"`),
      `${dimension} is a claim about what the server does and must be listed`,
    );
  }
  for (const dimension of RENDER_DIMENSIONS) {
    assert.doesNotMatch(
      declared[1],
      new RegExp(`"${dimension}"`),
      `${dimension} is a claim about what the page renders — source may settle it`,
    );
  }
});

test("only executed evidence kinds count as executed", () => {
  const executed = source.match(/const EXECUTED_KINDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(executed, "EXECUTED_KINDS is not declared");
  assert.match(executed[1], /"API"/);
  assert.match(executed[1], /"E2E"/);
  // RENDER mounts the page in jsdom against a stubbed fetch. It is real
  // evidence about the PAGE and none at all about the server, so it must not
  // be able to satisfy a server-behaviour cell.
  assert.doesNotMatch(
    executed[1],
    /"RENDER"/,
    "a jsdom render test never reaches the server and cannot prove its behaviour",
  );
  assert.doesNotMatch(
    executed[1],
    /"SOURCE"/,
    "source text is the thing this rule exists to reject",
  );
});

test("a server-behaviour cell with no executed proof is downgraded to MISSING", () => {
  // The rule has to DOWNGRADE, not merely warn: a cell left PROVEN while a
  // problem is logged is exactly how the matrix reported 49 authorization
  // cells as proven from source text.
  const rule = source.match(
    /if \(SERVER_BEHAVIOUR_CHECKS\.has\(check\) && final === "PROVEN"\)[\s\S]*?\n {4}\}/,
  );
  assert.ok(rule, "the server-behaviour evidence rule is missing from the cell resolver");
  assert.match(rule[0], /EXECUTED_KINDS\.has\(p\.kind\)/);
  assert.match(rule[0], /final: "MISSING"/, "the rule must downgrade the cell, not just warn");
  assert.match(rule[0], /problems\.push/, "the rule must also fail the run");
});

test("the committed matrix carries executed evidence for every server-behaviour cell", () => {
  const matrix = JSON.parse(readFileSync(MATRIX, "utf8"));
  const rows = matrix.rows ?? matrix.mutations ?? [];
  assert.ok(rows.length > 0, "the committed matrix has no rows");

  const offenders = [];
  for (const row of rows) {
    for (const dimension of SERVER_BEHAVIOUR) {
      const cellValue = row.checks?.[dimension];
      if (!cellValue || cellValue.final !== "PROVEN") continue;
      const executed = (cellValue.proofs ?? []).some(
        (p) => p.kind === "API" || p.kind === "E2E",
      );
      if (!executed) offenders.push(`${row.key}/${dimension}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these cells claim PROVEN with no executed proof:\n${offenders.join("\n")}`,
  );
});
