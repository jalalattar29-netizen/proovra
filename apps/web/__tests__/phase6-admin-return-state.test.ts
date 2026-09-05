/**
 * PHASE 6 §7 — THE INVESTIGATION SURVIVES THE DRILL-DOWN.
 *
 * The loop this closes: filter a list to three rows, open one, act, come back
 * to the unfiltered first page of everything, re-type the filter.
 *
 * The allowlist is the part worth testing hardest. §7 forbids putting secrets,
 * personal data or transient authorization material in a URL, and "carry
 * whatever happens to be in the query" is exactly how a token added to a list
 * URL next year would silently start travelling too.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  RETURN_STATE_PARAM,
  captureListState,
  detailHrefWithReturn,
  returnHrefFor,
} from "../lib/navigation/adminReturnState";

test("a position in a collection travels", () => {
  const state = captureListState("search=acme&status=NEW&page=3");
  assert.ok(state);
  assert.match(state!, /search=acme/);
  assert.match(state!, /status=NEW/);
  assert.match(state!, /page=3/);
});

test("anything that is not a position in a collection is DROPPED", () => {
  /*
   * The names below are the ones that must never reach a URL. They are not
   * hypothetical shapes: `token` and `supportContextToken` are real parameter
   * names elsewhere in this product, and an allowlist is what stops a future
   * list page's private query joining the ride.
   */
  const hostile = [
    "token=abc123",
    "supportContextToken=ey.jwt.value",
    "access_token=secret",
    "password=hunter2",
    "email=someone@example.com",
    "sessionId=abcdef",
    "apiKey=live_123",
  ].join("&");
  const state = captureListState(`search=acme&${hostile}`);
  assert.equal(state, "search=acme");
  for (const name of ["token", "password", "email", "sessionId", "apiKey", "supportContextToken", "access_token"]) {
    assert.ok(!state!.includes(name), `${name} travelled`);
  }
});

test("nothing to carry means no parameter at all", () => {
  assert.equal(captureListState(""), null);
  assert.equal(captureListState(null), null);
  assert.equal(captureListState("token=abc"), null, "a hostile-only query must not produce an empty back=");
  assert.equal(
    detailHrefWithReturn("/admin/customers/abc", "token=abc"),
    "/admin/customers/abc",
    "the detail href gained an empty parameter",
  );
});

test("the round trip restores the list an operator left", () => {
  const listQuery = "search=acme&status=NEW&page=3";
  const detail = detailHrefWithReturn("/admin/customers/c-1", listQuery);
  assert.ok(detail.includes(`${RETURN_STATE_PARAM}=`), "the state did not travel");
  assert.ok(detail.startsWith("/admin/customers/c-1?"), "the canonical route changed");

  const back = returnHrefFor("/admin/customers", detail.split("?")[1]!);
  assert.ok(back.startsWith("/admin/customers?"), "the return lost its collection");
  assert.match(back, /search=acme/);
  assert.match(back, /status=NEW/);
  assert.match(back, /page=3/);
});

test("no state means the honest fallback: the bare collection", () => {
  assert.equal(returnHrefFor("/admin/customers", null), "/admin/customers");
  assert.equal(returnHrefFor("/admin/customers", "other=1"), "/admin/customers");
});

test("a hand-edited return parameter cannot inject anything the list would act on", () => {
  /*
   * The state is re-filtered on the way OUT as well as in. Without that, an
   * operator handed a crafted link would return to a list carrying whatever
   * the sender chose to put in `back=`.
   */
  const crafted = `${RETURN_STATE_PARAM}=${encodeURIComponent("search=ok&token=stolen&redirect=https://evil.example")}`;
  const back = returnHrefFor("/admin/customers", crafted);
  assert.match(back, /search=ok/);
  assert.ok(!back.includes("token"), "an injected token survived the return");
  assert.ok(!back.includes("redirect"), "an injected redirect survived the return");
  assert.ok(!back.includes("evil.example"));
});

test("a pathological value cannot become the URL", () => {
  const huge = `search=${"x".repeat(5000)}`;
  assert.equal(captureListState(huge), null, "an unbounded value was carried");
});

test("the detail page's own query is not disturbed", () => {
  const href = detailHrefWithReturn("/admin/customers/c-1?tab=audit", "search=acme");
  assert.ok(href.startsWith("/admin/customers/c-1?tab=audit&"), "the detail's own parameters were lost");
  assert.ok(href.includes(`${RETURN_STATE_PARAM}=`));
});
