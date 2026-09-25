/**
 * GUARD — native intake-links projection (Master Program §9, F). Parses the
 * enriched list (item.link.*, lifecycle fallback), maps status→tone, and NEVER
 * surfaces a link URL/token (a server secret). Pure module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
// The shared envelope reader is substituted FOR REAL, never stubbed: whether
// an unreadable response refuses instead of reporting an empty list is exactly
// what these tests are for.
const ENVELOPE_URL =
  "data:text/javascript," +
  encodeURIComponent(
    ts.transpileModule(readFileSync(resolve(HERE, "../src/product/envelope.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );

// The delivery vocabulary the Details read is the real one, too.
const DELIVERY_URL =
  "data:text/javascript," +
  encodeURIComponent(
    ts.transpileModule(readFileSync(resolve(HERE, "../src/product/intake-delivery.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );

const src = readFileSync(resolve(HERE, "../src/product/intake-links.ts"), "utf8")
  .replace('from "./envelope"', `from "${ENVELOPE_URL}"`)
  .replace('from "./intake-delivery"', `from "${DELIVERY_URL}"`)
  .replace(/^import type .*$/m, "")
  .replace(/^import \{ humanizeEnum \}.*$/m, "function humanizeEnum(v){return v.charAt(0)+v.slice(1).toLowerCase().replace(/_/g,' ');}");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const TONES = new Set(["verified", "pending", "risk", "neutral", "governance", "info"]);

test("parses enriched items (item.link + delivery + activity), drops rows without an id", () => {
  const rows = mod.parseIntakeLinks({
    items: [
      {
        link: { id: "l1", workflowTemplateName: "Incident intake", recipientLabel: "Acme", status: "ACTIVE", usedCount: 1, maxUses: 3, expiresAtUtc: "2099-10-01T00:00:00Z", intakeMode: "EXTERNAL_REUSABLE" },
        delivery: { latestStatus: "DELIVERED", latestChannel: "EMAIL", attemptCount: 2, channelsAttempted: ["EMAIL"] },
        activity: { sessionsOpened: 1, sessionsStarted: 0, sessionsSubmitted: 0, evidenceCount: 0 },
      },
      { link: { workflowTemplateName: "no id" } },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].templateName, "Incident intake");
  assert.equal(rows[0].status, "ACTIVE");
  assert.equal(rows[0].maxUses, 3);
  assert.equal(rows[0].detail.delivery.attemptCount, 2);
  assert.equal(mod.intakeModeLabel(rows[0].detail.intakeMode), "Reusable link");
});

/*
 * THE DEFECT: the parser read `item.lifecycle.state`, a key the server never
 * sends (it sends `computedLifecycle`), so every row fell back to the raw DB
 * status. An archived link, a used-up link and a link past its expiry all read
 * "ACTIVE". The state is now derived from the link's own fields, as the web
 * derives it (lib/intake-links/state-model.ts getLinkOperationalState).
 */
test("the row state is the web's operational state, derived from the link itself", () => {
  const row = (link) => mod.parseIntakeLinks({ items: [{ link: { id: "l", status: "ACTIVE", usedCount: 0, maxUses: 3, expiresAtUtc: "2099-01-01T00:00:00Z", ...link } }] })[0];
  assert.equal(row({ archivedAtUtc: "2026-09-01T00:00:00Z" }).status, "ARCHIVED");
  assert.equal(row({ revokedAtUtc: "2026-09-01T00:00:00Z" }).status, "REVOKED");
  assert.equal(row({ expiresAtUtc: "2020-01-01T00:00:00Z" }).status, "EXPIRED", "a link past its expiry read ACTIVE");
  assert.equal(row({ usedCount: 3 }).status, "EXPIRED", "a used-up link read ACTIVE");
  assert.equal(row({}).status, "ACTIVE");
  assert.equal(mod.LINK_STATE_VOCABULARY.REVOKED.label, "Link disabled");
});

test("delivery presentation: no record is Manual; the latest status uses the history's vocabulary", () => {
  const d = (x) => ({ latestStatus: null, latestChannel: null, latestAtUtc: null, latestSentAtUtc: null, latestErrorCode: null, attemptCount: 0, channelsAttempted: [], ...x });
  assert.equal(mod.deliveryPresentation(d({})).label, "Manual");
  assert.equal(mod.deliveryPresentation(d({ attemptCount: 1, latestChannel: "SMS", latestStatus: "UNDELIVERED" })).label, "Failed");
  assert.equal(mod.deliveryAttemptLine(d({ attemptCount: 3, channelsAttempted: ["EMAIL", "SMS"] })), "3 attempts across 2 channels.");
  assert.equal(mod.intakeChannelLabel(null), "Copy link");
});

test("the projection carries NO url/token field (server secret)", () => {
  const rows = mod.parseIntakeLinks({ items: [{ link: { id: "l1", status: "ACTIVE" } }] });
  const keys = Object.keys(rows[0]);
  assert.ok(!keys.some((k) => /url|token|secret/i.test(k)), `no url/token key: ${keys.join(",")}`);
});

test("status maps to a legal tone; revoked is risk; unknown neutral", () => {
  assert.ok(TONES.has(mod.intakeStatusDisplay("SENT").tone));
  assert.equal(mod.intakeStatusDisplay("REVOKED").tone, "risk");
  assert.equal(mod.intakeStatusDisplay("SUBMITTED").tone, "verified");
  assert.equal(mod.intakeStatusDisplay("WHATEVER").tone, "neutral");
});

test("empty/garbage envelope → empty list", () => {
  assert.deepEqual(mod.parseIntakeLinks(null), []);
  assert.deepEqual(mod.parseIntakeLinks({}), []);
});

/* ------------------------------------- submissions, archive, send, reveal */

/**
 * The recipient-contact reveal is the ONLY place a raw address leaves the API.
 * Every projection ships the masked form for everybody; asking here needs a
 * capability and is recorded at WARNING severity. The surface says that before
 * the tap, not after it appears in an audit log.
 */
test("the action paths are the canonical ones", () => {
  assert.equal(mod.buildIntakeSubmissionsPath("l1"), "/v1/workflow/intake-links/l1/submissions");
  assert.equal(mod.buildIntakeArchivePath("l1", false), "/v1/workflow/intake-links/l1/archive");
  assert.equal(mod.buildIntakeArchivePath("l1", true), "/v1/workflow/intake-links/l1/unarchive");
  assert.equal(mod.buildIntakeSendPath("l1"), "/v1/workflow/intake-links/l1/send");
  assert.equal(mod.buildIntakeRevealPath("l1"), "/v1/workflow/intake-links/l1/recipient-contact");
});

test("submissions carry only the MASKED contact previews", () => {
  const [s] = mod.parseIntakeSubmissions({
    // The route answers { link, sessions, totals }. It has never sent a
    // "submissions" key, which is what the parser used to read.
    link: {
      id: "l1",
      teamId: "t1",
      intakeMode: "EXTERNAL_IDENTIFIED",
      recipientLabel: "Sam",
      workflowTemplateSlug: "incident",
      workflowTemplateName: "Incident intake",
    },
    totals: { sessions: 1, submitted: 1, inProgress: 0, evidenceProduced: 1 },
    sessions: [
      {
        id: "s1",
        status: "SUBMITTED",
        submitterDisplayName: "Sam",
        submitterEmailPreview: "s***@example.com",
        submitterPhonePreview: "***4321",
        submittedAtUtc: "2026-09-01T00:00:00.000Z",
      },
    ],
  });
  assert.equal(s.submitterEmailPreview, "s***@example.com");
  // There is no un-masked field on the projection at all.
  assert.equal("submitterEmail" in s, false);
  assert.equal("submitterPhone" in s, false);
});

test("an anonymous submission falls back to its pseudonym", () => {
  const [s] = mod.parseIntakeSubmissions({
    sessions: [{ id: "s1", pseudonym: "Contributor 4", submitterDisplayName: null }],
  });
  assert.equal(s.submitterName, null);
  assert.equal(s.pseudonym, "Contributor 4");
});

test("an envelope we cannot read refuses instead of reporting no submissions", () => {
  // THE DEFECT. The parser read "submissions" - a key the route has never
  // sent - then fell through to the bare payload and returned []. Every link
  // with submissions on it showed "No submissions yet", which is a false
  // statement about a real intake and indistinguishable from an empty one.
  assert.equal(mod.parseIntakeSubmissions({ sessions: [{ id: "s1" }] }).length, 1);
  assert.deepEqual(mod.parseIntakeSubmissions({ sessions: [] }), []);
  for (const bad of [null, undefined, 7, { link: {}, totals: {} }, { sessions: {} }]) {
    assert.throws(() => mod.parseIntakeSubmissions(bad), /Unreadable list response/);
  }
});

test("a submission with no id is dropped", () => {
  assert.equal(mod.parseIntakeSubmissions({ sessions: [{ id: "s1" }, {}, null] }).length, 1);
});

test("resending is offered only when the raw token is in hand", () => {
  // The API never persists it, so after a relaunch a resend cannot be formed.
  assert.equal(mod.canResendIntakeLink("abcdefgh"), true);
  assert.equal(mod.canResendIntakeLink("short"), false);
  assert.equal(mod.canResendIntakeLink(null), false);
  assert.equal(mod.canResendIntakeLink(undefined), false);
});

test("the send body names only the channels that remain", () => {
  assert.deepEqual([...mod.INTAKE_SEND_CHANNELS], ["SMS", "EMAIL"]);
  const body = mod.buildIntakeSendBody({
    channel: "EMAIL",
    rawToken: "abcdefgh",
    intakeUrl: "https://x/intake/abcdefgh",
  });
  assert.equal(body.channel, "EMAIL");
  // No nonce sent when none was given; with one, tapping twice is not two
  // provider calls.
  assert.equal("idempotencyKey" in body, false);
  assert.equal(
    mod.buildIntakeSendBody({
      channel: "SMS",
      rawToken: "abcdefgh",
      intakeUrl: "https://x",
      idempotencyKey: "k1",
    }).idempotencyKey,
    "k1",
  );
});

test("the reveal consequence is stated in the words the user sees", () => {
  assert.match(mod.INTAKE_REVEAL_CONSEQUENCE, /recorded against your account/i);
  assert.match(mod.INTAKE_REVEAL_CONSEQUENCE, /stays masked/i);
});

test("a reveal with no contact on file is not an empty string", () => {
  assert.deepEqual(mod.parseRevealedContact({}), { email: null, phone: null });
  assert.deepEqual(
    mod.parseRevealedContact({ recipientContact: { recipientEmail: "a@b.test", recipientPhone: "" } }),
    { email: "a@b.test", phone: null },
  );
});
