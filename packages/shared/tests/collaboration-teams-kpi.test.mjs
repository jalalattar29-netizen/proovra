/**
 * Members experience B — the "Collaboration Teams" figure on Members & Access,
 * worded once for web and mobile. Every state has one honest sentence; an
 * unknown figure is never a zero, and the owner never holds a Team position.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { describeCollaborationTeamsKpi } from "../dist/index.js";

const stat = (o) => ({ featureIncluded: true, active: 1, limit: 2, limitSource: "PLAN_CATALOG", membersPerTeam: 5, ...o });

test("PRO: active Teams against 2, five per Team, owner not counted", () => {
  const k = describeCollaborationTeamsKpi(stat());
  assert.equal(k.value, "1 of 2");
  assert.match(k.meta, /up to 5 members per Team, owner not counted/);
  assert.equal(k.tone, "info");
});

test("TEAM: against 5, ten per Team", () => {
  const k = describeCollaborationTeamsKpi(stat({ limit: 5, membersPerTeam: 10 }));
  assert.equal(k.value, "1 of 5");
  assert.match(k.meta, /up to 10 members per Team/);
});

test("at the limit the card warns", () => {
  assert.equal(describeCollaborationTeamsKpi(stat({ active: 2 })).tone, "warning");
});

test("Enterprise: the contract's figure, said to be the contract's", () => {
  const k = describeCollaborationTeamsKpi(stat({ active: 3, limit: 12, limitSource: "ENTERPRISE_CONTRACT", membersPerTeam: 40 }));
  assert.equal(k.value, "3 of 12");
  assert.match(k.meta, /set by your contract/);
});

test("FREE / PAYG: Not included — never 'No limit', never a seat count", () => {
  const k = describeCollaborationTeamsKpi(stat({ featureIncluded: false, active: 0, limit: 0, membersPerTeam: 0 }));
  assert.equal(k.value, "Not included");
  assert.doesNotMatch(`${k.value} ${k.meta}`, /No limit|Seats? available|unlimited/i);
});

test("a contract without Teams says so in its own words", () => {
  const k = describeCollaborationTeamsKpi(stat({ featureIncluded: false, limit: 0, limitSource: "ENTERPRISE_CONTRACT" }));
  assert.equal(k.value, "Not included");
  assert.match(k.meta, /Enterprise contract does not include/);
});

test("unknown is '—', never 0", () => {
  const k = describeCollaborationTeamsKpi(null);
  assert.equal(k.value, "—");
  assert.equal(k.tone, "neutral");
});
