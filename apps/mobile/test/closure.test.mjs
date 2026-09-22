/**
 * CLOSURE — one contract, one projection.
 *
 * An organization and a workspace are closed by the same endpoint shape, so
 * the understanding of it lives once. These tests guard the two things a
 * client must never take into its own hands: the confirmation phrase, and
 * whether the action is offered at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/closure.ts"), "utf8");
const js = ts.transpileModule(SRC, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const C = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("the phrase, the period and the blockers all come from the server", () => {
  const s = C.parseClosureState({
    request: null,
    blockers: [
      { code: "WORKSPACE_MEMBERS_ACTIVE", message: "Other people are still in a workspace.", count: 3 },
      { message: "no code" },
    ],
    confirmationPhrase: "CLOSE MY ORGANIZATION",
    coolingOffDays: 30,
  });
  assert.equal(s.confirmationPhrase, "CLOSE MY ORGANIZATION");
  assert.equal(s.coolingOffDays, 30);
  assert.equal(s.blockers.length, 1);
  assert.equal(s.blockers[0].count, 3);
  // The server wrote the sentence; the client does not paraphrase it.
  assert.equal(s.blockers[0].message, "Other people are still in a workspace.");
});

test("the typed phrase is matched exactly, against the server's", () => {
  const s = C.parseClosureState({ confirmationPhrase: "CLOSE MY ORGANIZATION" });
  assert.equal(C.closurePhraseMatches(s, "CLOSE MY ORGANIZATION"), true);
  // A confirmation a client quietly normalised is not a confirmation.
  assert.equal(C.closurePhraseMatches(s, "close my organization"), false);
  assert.equal(C.closurePhraseMatches(s, " CLOSE MY ORGANIZATION "), false);
});

test("with no phrase from the server, nothing matches", () => {
  // The client holds no copy to fall back on, and that is the point.
  assert.equal(C.closurePhraseMatches(C.parseClosureState({}), "anything"), false);
});

test("closure is offered only when the server listed no blockers", () => {
  assert.equal(C.canRequestClosure(C.parseClosureState({ blockers: [] })), true);
  assert.equal(
    C.canRequestClosure(C.parseClosureState({ blockers: [{ code: "LEGAL_HOLD_ACTIVE", message: "x" }] })),
    false,
  );
});

test("an open request is not another chance to request one", () => {
  const open = C.parseClosureState({ request: { id: "r1", status: "PENDING" }, blockers: [] });
  assert.equal(C.hasOpenClosure(open), true);
  assert.equal(C.canRequestClosure(open), false);
});

test("a cancelled or completed request is not an open one", () => {
  for (const status of ["CANCELLED", "COMPLETED", "FAILED"]) {
    assert.equal(C.hasOpenClosure(C.parseClosureState({ request: { id: "r1", status } })), false);
  }
});

test("the phrase is sent exactly as typed, and an empty reason is absent", () => {
  assert.deepEqual(C.buildClosureBody("CLOSE MY ORGANIZATION"), {
    confirmation: "CLOSE MY ORGANIZATION",
  });
  assert.deepEqual(C.buildClosureBody("X", "   "), { confirmation: "X" });
  assert.deepEqual(C.buildClosureBody("X", " moving on "), {
    confirmation: "X",
    reason: "moving on",
  });
});

test("only a stale-state refusal triggers a reload", () => {
  const f = (code) => C.closureFailureNeedsReload({ body: { error: { code } } });
  assert.equal(f("closure_blocked"), true);
  assert.equal(f("closure_request_active"), true);
  assert.equal(f("confirmation_mismatch"), false);
});
