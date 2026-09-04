/**
 * WHAT THE AI SETTINGS PAGE TELLS EACH KIND OF USER.
 *
 * The page previously rendered the workspace policy row and nothing else, so a
 * deployment with no AI provider showed "enabled" with green toggles while
 * every request failed. The status is now resolved by the API from the same
 * evaluator that gates provider calls; this file covers the copy layer, which
 * is all the client is allowed to decide.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aiStatusCopy,
  managedByCopy,
  resolveManagedBy,
  type AiAssistanceStatus,
} from "../lib/ai/assistanceStatus";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALL: AiAssistanceStatus[] = [
  "AVAILABLE",
  "DISABLED_FOR_WORKSPACE",
  "NOT_INCLUDED_IN_PLAN",
  "NOT_PERMITTED_FOR_ROLE",
  "TEMPORARILY_UNAVAILABLE",
];

// ===========================================================================
// COPY — truthful, and never a diagnostic
// ===========================================================================
test("every status has distinct, non-empty copy", () => {
  const seen = new Set<string>();
  for (const s of ALL) {
    const c = aiStatusCopy(s);
    assert.ok(c.label.length > 0 && c.detail.length > 0, `${s} needs copy`);
    seen.add(`${c.label}|${c.detail}`);
  }
  assert.equal(seen.size, ALL.length, "two statuses must not share one sentence");
});

test("no status leaks an internal code, variable or provider name", () => {
  for (const s of ALL) {
    const c = aiStatusCopy(s);
    const text = `${c.label} ${c.detail}`;
    assert.doesNotMatch(
      text,
      /OPENAI|API[_ ]key|GLOBAL_DISABLED|PROVIDER_NOT_CONFIGURED|environment variable|provider/i,
      s,
    );
  }
});

test("a deliberate configuration is never painted as a fault", () => {
  // A workspace that switched AI off, a plan that never included it and a role
  // restriction are all working systems saying no. Only a platform outage is a
  // problem, and only it may be amber.
  for (const s of ["DISABLED_FOR_WORKSPACE", "NOT_INCLUDED_IN_PLAN", "NOT_PERMITTED_FOR_ROLE"] as const) {
    assert.equal(aiStatusCopy(s).tone, "slate", s);
  }
  assert.equal(aiStatusCopy("AVAILABLE").tone, "green");
  assert.equal(aiStatusCopy("TEMPORARILY_UNAVAILABLE").tone, "amber");
});

test("the not-included copy says core workflows are unaffected", () => {
  // The reassurance the brief asks for: losing AI loses nothing that matters.
  assert.match(
    aiStatusCopy("NOT_INCLUDED_IN_PLAN").detail,
    /capture, custody, verification and reporting/i,
  );
});

test("an outage never blames the reader or asks them to fix it", () => {
  const c = aiStatusCopy("TEMPORARILY_UNAVAILABLE");
  assert.doesNotMatch(c.detail, /you (must|should|need)|contact|configure|enable/i);
  assert.match(c.detail, /unaffected/i);
});

// ===========================================================================
// THE CONTEXT MATRIX — who is told to take it up with whom
// ===========================================================================
test("a personal owner who can manage is told they manage it", () => {
  assert.equal(
    resolveManagedBy({ status: "AVAILABLE", workspaceKind: "PERSONAL", canManage: true }),
    "YOU",
  );
});

test("an organization member without authority is pointed at the organization", () => {
  assert.equal(
    resolveManagedBy({
      status: "DISABLED_FOR_WORKSPACE",
      workspaceKind: "ORGANIZATION",
      canManage: false,
    }),
    "ORGANIZATION",
  );
});

test("an organization admin is pointed at workspace administrators, not upward", () => {
  // There is no org-level lock in the backend, so an admin must not be told
  // something above them decided this. They did.
  assert.equal(
    resolveManagedBy({ status: "AVAILABLE", workspaceKind: "ORGANIZATION", canManage: true }),
    "WORKSPACE_ADMINS",
  );
});

test("a member of a personal-kind workspace without authority is not told 'you'", () => {
  assert.equal(
    resolveManagedBy({ status: "AVAILABLE", workspaceKind: "PERSONAL", canManage: false }),
    "WORKSPACE_ADMINS",
  );
});

test("an unresolved capability fails closed to read-only, never to 'you'", () => {
  // `canManage: null` is the envelope loading or degraded. It must not read as
  // authority the user may not have.
  for (const kind of ["PERSONAL", "ORGANIZATION", null] as const) {
    const r = resolveManagedBy({ status: "AVAILABLE", workspaceKind: kind, canManage: null });
    assert.notEqual(r, "YOU", `${kind} with unknown capability must not claim authority`);
  }
});

test("platform and plan outrank workspace authority in the explanation", () => {
  // Telling an owner "managed by you" while the platform is down would send
  // them to a switch that changes nothing.
  assert.equal(
    resolveManagedBy({
      status: "TEMPORARILY_UNAVAILABLE",
      workspaceKind: "PERSONAL",
      canManage: true,
    }),
    "PLATFORM",
  );
  assert.equal(
    resolveManagedBy({
      status: "NOT_INCLUDED_IN_PLAN",
      workspaceKind: "ORGANIZATION",
      canManage: true,
    }),
    "PLAN",
  );
});

test("every authority has readable copy", () => {
  for (const m of ["YOU", "WORKSPACE_ADMINS", "ORGANIZATION", "PLAN", "PLATFORM"] as const) {
    assert.ok(managedByCopy(m).length > 0, m);
  }
  assert.match(managedByCopy("ORGANIZATION"), /organization/i);
});

// ===========================================================================
// THE PAGE ITSELF
// ===========================================================================
const SECTION = readFileSync(
  resolve(APP, "app/(app)/settings/_sections/AiSection.tsx"),
  "utf8",
);
const ROW = readFileSync(
  resolve(APP, "app/(app)/settings/_sections/AiStatusRow.tsx"),
  "utf8",
);

test("the status row renders in all three views, not only for admins", () => {
  // The live capability table already existed but rendered for `canEdit` only,
  // so personal users and org members — most readers of this page — had no way
  // to learn whether AI actually worked.
  const uses = SECTION.match(/<AiStatusRow/g) ?? [];
  assert.equal(uses.length, 3, "not-included, personal, and organization");
});

test("the page does not decide availability itself", () => {
  // It must render the API's resolved status. If this page ever computes it,
  // it can disagree with the gate that enforces it.
  assert.match(SECTION, /envelopeState\.assistance\.status/);
  assert.doesNotMatch(ROW, /isPlatformAiGlobally|OPENAI_|providerConfigured/);
});

test("the status is a word, not only a colour", () => {
  // AppStatusText always renders its text, so the state survives greyscale and
  // a screen reader.
  assert.match(ROW, /AppStatusText/);
  assert.match(ROW, /\{copy\.label\}/);
});

test("the status card can shrink inside the organization view's grid", () => {
  /*
   * MEASURED DEFECT, not a precaution.
   *
   * The organization view places this card in a CSS grid. A grid item defaults
   * to `min-width: auto` and refuses to shrink below its own max-content width,
   * so at 375px the single track measured 806px and every line was clipped —
   * while `documentElement.scrollWidth` stayed at 375, which made it look like
   * missing text rather than an overflow.
   *
   * Asserted as a property because jsdom performs no layout; the width was
   * measured in the browser, and this stops the fix being dropped later.
   */
  assert.match(ROW, /minInlineSize:\s*0/);
});

// ===========================================================================
// THE MEMBER-SAFE READ-ONLY VIEW
// ===========================================================================
const READONLY = readFileSync(
  resolve(APP, "app/(app)/settings/_sections/AiReadOnlyView.tsx"),
  "utf8",
);

test("the read-only view is exactly the four required cards", () => {
  const cards = [...READONLY.matchAll(/data-cc-ai-card="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cards, ["assistance", "features", "data", "governance"]);
});

test("a member is offered no control at all, not even a disabled one", () => {
  // A greyed-out switch invites a click and then refuses it. A sentence saying
  // who decides is a better answer than a control that does nothing.
  assert.doesNotMatch(READONLY, /<input\b/);
  assert.doesNotMatch(READONLY, /<button\b/);
  // The ATTRIBUTE, not the word: "Disabled" is a legitimate status label for a
  // feature the workspace switched off, and asserting on the word failed on
  // the very copy this view exists to show.
  assert.doesNotMatch(READONLY, /\bdisabled=/);
});

test("the read-only view states the data boundary in the policy's own terms", () => {
  assert.match(READONLY, /Metadata first/);
  assert.match(READONLY, /Not sent to the AI provider by default/);
  assert.match(READONLY, /Advisory only/);
});

test("it does not strengthen the no-training claim", () => {
  // Code-proven for evidence content, but config- and contract-dependent for
  // the provider posture. Settings must not assert what the AI Use Policy
  // carefully qualifies.
  assert.doesNotMatch(READONLY, /never used|not used to train|no training/i);
});

test("it links the AI Use Policy through the authenticated reader", () => {
  // app/(app) must never link the public /legal route.
  assert.match(READONLY, /\/settings\/legal\/ai-use-policy/);
  assert.doesNotMatch(READONLY, /href="\/legal\//);
});

test("it exposes no policy keys, operation labels or provider detail", () => {
  for (const forbidden of [
    "EVIDENCE_COPILOT",
    "EVIDENCE_CATEGORIZATION",
    "SUPPORT_CHAT",
    "GLOBAL_DISABLED",
    "PROVIDER_NOT_CONFIGURED",
    "OPENAI",
    "aiEnabled",
  ]) {
    assert.doesNotMatch(READONLY, new RegExp(forbidden), forbidden);
  }
});

test("every card can shrink, so nothing clips on a narrow screen", () => {
  // The measured 806px overflow came from flex/grid items defaulting to
  // `min-width: auto`. Each card and each status row opts out.
  const cards = (READONLY.match(/className="set-card"/g) ?? []).length;
  const optOuts = (READONLY.match(/minInlineSize: 0/g) ?? []).length;
  assert.equal(cards, 4);
  assert.ok(optOuts >= cards, `expected every card to opt out, got ${optOuts} for ${cards}`);
});

test("the section clears prior workspace state before loading the next", () => {
  // A member switching from a workspace they administer to one they do not
  // must not keep rendering the previous workspace's editable policy.
  // The LOADING effect, located by its own body — the file has several
  // useEffects and the first one is not this one.
  const loadEffectStart = SECTION.lastIndexOf("useEffect(() => {", SECTION.indexOf("void load()"));
  const effect = SECTION.slice(loadEffectStart, SECTION.indexOf("void load()") + 200);
  const clearIdx = effect.indexOf("setEnvelopeState(null)");
  const loadIdx = effect.indexOf("void load()");
  assert.ok(clearIdx > -1, "state must be cleared on workspace change");
  assert.ok(clearIdx < loadIdx, "cleared BEFORE the next load, not after");
  // Substring, not a regex: these contain parentheses, and escaping them into
  // a pattern is a step that can be got wrong for no benefit — the check is
  // "does this literal text appear", which `includes` says exactly.
  for (const setter of ["setDraft(null)", "setReadOnly(null)", "setUsage(null)"]) {
    assert.ok(effect.includes(setter), `${setter} must be cleared on workspace change`);
  }
});

test("the viewer fallback is driven by the server's refusal, not a role check", () => {
  assert.match(SECTION, /statusCode === 403/);
  assert.match(SECTION, /ai-assistance-status/);
  assert.doesNotMatch(SECTION, /role === "VIEWER"/);
});
