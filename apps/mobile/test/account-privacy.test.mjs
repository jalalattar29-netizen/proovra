/**
 * ACCOUNT PRIVACY — data export and account closure.
 *
 * Closure is the most consequential control in the product, and three things
 * make it safe. All three come from the server, and none is restated here:
 *
 *   blockers            why it cannot proceed yet
 *   confirmationPhrase  the exact words the route checks
 *   coolingOffDays      that it is not immediate
 *
 * A phrase this client believed in and the route rejected would make closure
 * impossible with no explanation the user could act on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/account-privacy.ts"), "utf8");
const js = ts.transpileModule(SRC.replace(/^import type .*$/m, ""), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const A = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const NOW = Date.parse("2026-09-22T12:00:00.000Z");

/* ------------------------------------------------------------------- export */

test("the paths are the canonical identity endpoints", () => {
  assert.equal(A.DATA_EXPORT_PATH, "/v1/identity/data-export");
  assert.equal(A.ACCOUNT_CLOSURE_PATH, "/v1/identity/account-closure");
  assert.equal(A.buildExportDownloadPath("r1"), "/v1/identity/data-export/r1/download");
  assert.equal(A.buildClosureCancelPath("r1"), "/v1/identity/account-closure/r1/cancel");
});

test("an expired package is not offered, not offered-and-failing", () => {
  const base = { id: "r1", status: "COMPLETED", downloadCount: 0 };
  assert.equal(
    A.isExportDownloadable({ ...base, expiresAtIso: "2026-09-23T00:00:00.000Z" }, NOW),
    true,
  );
  assert.equal(
    A.isExportDownloadable({ ...base, expiresAtIso: "2026-09-21T00:00:00.000Z" }, NOW),
    false,
  );
  // No stated expiry means the server has not expired it.
  assert.equal(A.isExportDownloadable({ ...base, expiresAtIso: null }, NOW), true);
  // And a package that never completed is never downloadable.
  assert.equal(
    A.isExportDownloadable({ ...base, status: "PENDING", expiresAtIso: null }, NOW),
    false,
  );
});

test("an expired export reads as Expired, not as Completed", () => {
  const expired = {
    id: "r1",
    status: "COMPLETED",
    expiresAtIso: "2026-09-21T00:00:00.000Z",
    downloadCount: 0,
  };
  assert.equal(A.exportStatusLabel(expired, NOW), "Expired");
  assert.equal(
    A.exportStatusLabel({ ...expired, expiresAtIso: "2026-09-23T00:00:00.000Z" }, NOW),
    "Completed",
  );
});

test("a request already in flight is recognised so a second is not offered", () => {
  const list = A.parseDataExports({
    requests: [{ id: "r1", status: "PROCESSING" }, { id: "r2", status: "COMPLETED" }],
  });
  assert.equal(A.hasExportInFlight(list), true);
  assert.equal(A.hasExportInFlight(list.filter((r) => r.id === "r2")), false);
});

test("export rows without an id are dropped", () => {
  const list = A.parseDataExports({ requests: [{ id: "r1" }, { status: "DONE" }, null] });
  assert.equal(list.length, 1);
});

/* ------------------------------------------------------------------ closure */

test("the confirmation is checked against the SERVER's phrase", () => {
  const view = A.parseClosure({ confirmationPhrase: "CLOSE MY ACCOUNT", blockers: [] });
  assert.equal(A.confirmationMatches("CLOSE MY ACCOUNT", view), true);
  assert.equal(A.confirmationMatches("  CLOSE MY ACCOUNT  ", view), true);
  assert.equal(A.confirmationMatches("close my account", view), false);
  assert.equal(A.confirmationMatches("DELETE", view), false);

  // With no published phrase, nothing matches — the surface must not invent
  // one, because a phrase the route rejects makes closure impossible.
  const none = A.parseClosure({ blockers: [] });
  assert.equal(A.confirmationMatches("anything", none), false);
});

test("the module declares no confirmation phrase of its own", () => {
  assert.doesNotMatch(SRC, /"CLOSE MY ACCOUNT"|'CLOSE MY ACCOUNT'/);
});

test("blockers come from the server, in either shape, and nothing is invented", () => {
  const view = A.parseClosure({
    blockers: ["You own a workspace with other members.", { message: "An invoice is unpaid." }, {}],
  });
  assert.deepEqual(view.blockers, [
    "You own a workspace with other members.",
    "An invoice is unpaid.",
  ]);

  assert.deepEqual(A.parseClosure({}).blockers, []);
});

test("an active closure is told apart from a finished one", () => {
  assert.equal(A.isClosureActive({ status: "PENDING" }), true);
  assert.equal(A.isClosureActive({ status: "COOLING_OFF" }), true);
  assert.equal(A.isClosureActive({ status: "CANCELLED" }), false);
  assert.equal(A.isClosureActive({ status: "COMPLETED" }), false);
  assert.equal(A.isClosureActive(null), false);
});

test("a pending closure says when, not just that it is pending", () => {
  const view = A.parseClosure({
    request: {
      id: "c1",
      status: "PENDING",
      coolingOffEndsAtUtc: "2026-09-25T12:00:00.000Z",
    },
    blockers: [],
  });
  assert.match(A.closureCountdown(view, NOW), /closes in 3 days unless you cancel/);

  const ended = A.parseClosure({
    request: { id: "c1", status: "PENDING", coolingOffEndsAtUtc: "2026-09-21T12:00:00.000Z" },
  });
  assert.match(A.closureCountdown(ended, NOW), /cooling-off period has ended/);

  // Nothing pending, nothing to say.
  assert.equal(A.closureCountdown(A.parseClosure({}), NOW), null);
});

test("a cancelled closure reads as the good outcome it is", () => {
  assert.equal(A.closureStatusTone("CANCELLED"), "verified");
  assert.equal(A.closureStatusTone("COMPLETED"), "risk");
  assert.equal(A.closureStatusTone("PENDING"), "pending");
});
