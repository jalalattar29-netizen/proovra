import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMERCIAL_REQUEST_STATUSES,
  COMMERCIAL_REQUEST_TRANSITIONS,
  commercialTransitionRule,
  commercialTransitionsFrom,
  isCommercialTransitionAllowed,
  isTerminalCommercialStatus,
} from "../dist/commercial-request-transitions.js";

test("NEW is never a destination", () => {
  for (const from of COMMERCIAL_REQUEST_STATUSES) {
    assert.equal(isCommercialTransitionAllowed(from, "NEW"), false, `${from} -> NEW`);
  }
});

test("a status cannot transition to itself", () => {
  for (const s of COMMERCIAL_REQUEST_STATUSES) {
    assert.equal(commercialTransitionRule(s, s), null);
  }
});

test("every edge names a known status on both ends and carries an effect", () => {
  for (const r of COMMERCIAL_REQUEST_TRANSITIONS) {
    assert.ok(COMMERCIAL_REQUEST_STATUSES.includes(r.from), r.from);
    assert.ok(COMMERCIAL_REQUEST_STATUSES.includes(r.to), r.to);
    assert.ok(r.effect.length >= 30, `${r.from}->${r.to} effect is too short to inform anyone`);
    assert.ok(["ROUTINE", "CONSEQUENTIAL"].includes(r.consequence));
  }
});

test("closing, rejecting and reopening are consequential; internal triage is routine", () => {
  const consequential = (from, to) => commercialTransitionRule(from, to)?.consequence;
  assert.equal(consequential("NEW", "REVIEWED"), "ROUTINE");
  assert.equal(consequential("REVIEWED", "CONTACTED"), "ROUTINE");
  assert.equal(consequential("CONTACTED", "REVIEWED"), "ROUTINE");
  for (const from of ["NEW", "REVIEWED", "CONTACTED"]) {
    assert.equal(consequential(from, "REJECTED"), "CONSEQUENTIAL", `${from} -> REJECTED`);
    assert.equal(consequential(from, "ARCHIVED"), "CONSEQUENTIAL", `${from} -> ARCHIVED`);
  }
  assert.equal(consequential("REVIEWED", "QUALIFIED"), "CONSEQUENTIAL");
  assert.equal(consequential("CONTACTED", "QUALIFIED"), "CONSEQUENTIAL");
  // Every way out of a terminal state is consequential.
  for (const from of COMMERCIAL_REQUEST_STATUSES.filter(isTerminalCommercialStatus)) {
    for (const r of commercialTransitionsFrom(from)) {
      assert.equal(r.consequence, "CONSEQUENTIAL", `${from} -> ${r.to}`);
    }
  }
});

test("a terminal state can only be left through an explicit reopen edge", () => {
  assert.equal(isCommercialTransitionAllowed("QUALIFIED", "REJECTED"), false);
  assert.equal(isCommercialTransitionAllowed("REJECTED", "QUALIFIED"), false);
  assert.equal(isCommercialTransitionAllowed("ARCHIVED", "QUALIFIED"), false);
  assert.equal(isCommercialTransitionAllowed("ARCHIVED", "CONTACTED"), false);
  assert.equal(isCommercialTransitionAllowed("REJECTED", "REVIEWED"), true);
  assert.equal(isCommercialTransitionAllowed("ARCHIVED", "REVIEWED"), true);
  assert.equal(isCommercialTransitionAllowed("QUALIFIED", "CONTACTED"), true);
});

test("NEW cannot jump straight to QUALIFIED", () => {
  assert.equal(isCommercialTransitionAllowed("NEW", "QUALIFIED"), false);
});
