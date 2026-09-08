/**
 * COLLABORATION TEAM DOMAIN REFUSALS MUST REACH THE OPERATOR.
 *
 * Two refusals in this domain answered with a real, already user-safe reason
 * and the console showed "We couldn't complete that action. Please try again.
 * Your evidence data has not been changed." — a sentence about evidence
 * custody, in response to suspending a team member.
 *
 * There were THREE independent losses on the path, and fixing any one alone
 * would still have produced the generic toast:
 *
 *   1. the archived guard sent `{ error: { code }, message }` — the message
 *      OUTSIDE `error`, where `apiFetch` does not look, so it substituted the
 *      synthetic `HTTP 409: API error`;
 *   2. `CollaborationTeamError` sent `{ code, error: "team_conflict", message }`
 *      with `error` as a STRING, so `apiFetch` took its legacy branch and threw
 *      a plain Error — and every tab's `err instanceof ApiError` check was then
 *      false, replacing the message with its own;
 *   3. `toSafeUserError` resolves by CODE or by STATUS and never reads
 *      `message`, so even a preserved sentence was dropped for GENERIC.
 *
 * These drive the REAL `apiFetch` and the REAL `toSafeUserError` against the
 * exact bytes the API now sends. A source-shape assertion would pass against
 * the broken code, which is the whole reason the defect survived this long.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { apiFetch, ApiError } from "../lib/api";
import { toSafeUserError } from "../lib/feedback/toSafeUserError";

function stubFetch(status: number, body: unknown) {
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return () => {
    (globalThis as { fetch: unknown }).fetch = original;
  };
}

async function thrownFrom(status: number, body: unknown): Promise<unknown> {
  const restore = stubFetch(status, body);
  try {
    await apiFetch("/v1/fixture");
    assert.fail("apiFetch resolved on a non-2xx response");
  } catch (err) {
    return err;
  } finally {
    restore();
  }
}

/** The exact envelope `authorizeCollaborationTeam` now sends. */
const ARCHIVED_BODY = {
  error: {
    code: "collaboration_team_archived",
    message: "This team is archived. Reopen it before making changes.",
    requestId: "req-archived",
  },
};

/** The exact envelope `handleServiceError` now sends for a domain conflict. */
const LAST_LEAD_BODY = {
  error: {
    code: "team_conflict",
    message: "Cannot suspend the last LEAD. Transfer leadership first.",
    requestId: "req-conflict",
  },
};

// ---------------------------------------------------------------------------
// The client must keep the error's identity.
// ---------------------------------------------------------------------------

test("archived refusal survives apiFetch with code, message, status and requestId", async () => {
  const err = (await thrownFrom(409, ARCHIVED_BODY)) as ApiError;
  assert.ok(err instanceof ApiError, "a canonical envelope must throw ApiError");
  assert.equal(err.code, "collaboration_team_archived");
  assert.equal(err.statusCode, 409);
  assert.equal(err.requestId, "req-archived");
  // The specific failure this replaces: the message used to arrive as the
  // synthetic placeholder because it was read from `body.error.message` and
  // the server had put it beside `error`, not inside it.
  assert.equal(err.message, "This team is archived. Reopen it before making changes.");
  assert.doesNotMatch(err.message, /^HTTP \d{3}: API error$/);
});

test("last-Lead conflict survives apiFetch as a typed ApiError", async () => {
  const err = (await thrownFrom(409, LAST_LEAD_BODY)) as ApiError;
  // Previously a plain Error, which is what made every `instanceof ApiError`
  // branch in the console fall through to its own hardcoded sentence.
  assert.ok(err instanceof ApiError, "a canonical envelope must throw ApiError");
  assert.equal(err.code, "team_conflict");
  assert.equal(err.statusCode, 409);
  assert.equal(err.requestId, "req-conflict");
  assert.equal(err.message, "Cannot suspend the last LEAD. Transfer leadership first.");
});

// ---------------------------------------------------------------------------
// The safe-error boundary must not collapse them to GENERIC.
// ---------------------------------------------------------------------------

const GENERIC_TITLE = "We couldn't complete that action";
const EVIDENCE_SENTENCE = /evidence data has not been changed/;

test("archived refusal renders its own copy, not the generic fallback", async () => {
  const err = await thrownFrom(409, ARCHIVED_BODY);
  const safe = toSafeUserError(err);
  assert.equal(safe.title, "This team is archived");
  assert.match(safe.message, /Reopen this team before making changes/);
  assert.notEqual(safe.title, GENERIC_TITLE);
  // An action on team membership must never be answered with a reassurance
  // about evidence custody.
  assert.doesNotMatch(safe.message, EVIDENCE_SENTENCE);
});

test("last-Lead conflict shows the server's reason, which names the operation", async () => {
  const err = await thrownFrom(409, LAST_LEAD_BODY);
  const safe = toSafeUserError(err);
  assert.notEqual(safe.title, GENERIC_TITLE);
  assert.doesNotMatch(safe.message, EVIDENCE_SENTENCE);
  // `team_conflict` is raised for suspend, remove AND demote with a different
  // sentence each; a fixed mapping here would be wrong for two of the three,
  // so the server's own message is what renders.
  assert.equal(safe.message, "Cannot suspend the last LEAD. Transfer leadership first.");
  assert.equal(safe.supportReference, "req-conflict");
});

test("the same code renders the REMOVE sentence when that is what the server said", async () => {
  const err = await thrownFrom(409, {
    error: {
      code: "team_conflict",
      message: "Cannot remove the last LEAD. Transfer leadership first.",
    },
  });
  const safe = toSafeUserError(err);
  assert.equal(safe.message, "Cannot remove the last LEAD. Transfer leadership first.");
});

// ---------------------------------------------------------------------------
// The trusted-message channel is bounded. It is the one place a backend string
// reaches a user, so its guards are worth pinning.
// ---------------------------------------------------------------------------

test("a code NOT on the trusted list never renders its server message", async () => {
  const err = await thrownFrom(409, {
    error: { code: "some_other_conflict", message: "Raw internal detail." },
  });
  const safe = toSafeUserError(err);
  assert.doesNotMatch(safe.message, /Raw internal detail/);
});

test("the synthetic placeholder is never rendered as a reason", async () => {
  // A trusted code arriving with no message: `apiFetch` fills in
  // `HTTP 409: API error`, which must not be shown as though it explained
  // anything.
  const err = await thrownFrom(409, { error: { code: "team_conflict" } });
  const safe = toSafeUserError(err);
  assert.doesNotMatch(safe.message, /HTTP \d{3}: API error/);
});

test("a trusted message is length-bounded", async () => {
  const err = await thrownFrom(409, {
    error: { code: "team_conflict", message: "x".repeat(4000) },
  });
  const safe = toSafeUserError(err);
  assert.ok(
    safe.message.length <= 240,
    `expected a bounded message, got ${safe.message.length} characters`,
  );
});
