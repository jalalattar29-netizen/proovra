/**
 * GUARD — the AI transparency read.
 *
 * The app used AI-assisted surfaces and could not answer whether AI was on in
 * a workspace, which capabilities, or who decided. These assert the parse is
 * defensive and, more importantly, that an answer this build does not
 * understand is never rendered as "available".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/ai-assistance.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const ENVELOPE = {
  status: "AVAILABLE",
  available: true,
  enabled: true,
  features: [
    { id: "SEMANTIC_SEARCH", label: "Semantic search", description: "Find by meaning.", state: "ENABLED" },
    { id: "CASE_COPILOT", label: "Case copilot", description: "Drafting help.", state: "NOT_INCLUDED" },
    { id: "BROKEN", label: "no state" },
  ],
  processing: { mode: "METADATA_FIRST", rawEvidenceSentByDefault: false, decisions: "ADVISORY_ONLY" },
};

test("the status vocabulary is the server's own projection", () => {
  // ai-assistance-projection.ts:79 — every branch it can return.
  assert.deepEqual(mod.AI_ASSISTANCE_STATUSES, [
    "AVAILABLE",
    "NOT_INCLUDED_IN_PLAN",
    "NOT_PERMITTED_FOR_ROLE",
    "TEMPORARILY_UNAVAILABLE",
    "DISABLED_FOR_WORKSPACE",
  ]);
});

test("parses the envelope and drops a feature with no state", () => {
  const s = mod.parseAiAssistanceSettings(ENVELOPE);
  assert.equal(s.status, "AVAILABLE");
  assert.equal(s.features.length, 2);
  assert.equal(s.features[0].label, "Semantic search");
  assert.equal(s.processing.mode, "METADATA_FIRST");
});

test("a status this build does not know is NOT read as available", () => {
  // "We do not recognise this answer" and "AI is available" are different
  // statements, and only one of them is safe to make by default.
  const s = mod.parseAiAssistanceSettings({ status: "SOMETHING_NEW", available: true });
  assert.equal(s.status, null);
  assert.equal(mod.aiStatusDisplay(s.status).label, "Unknown");
  assert.notEqual(mod.aiStatusDisplay(s.status).label, "Available");
});

test("an empty or malformed payload yields a shape, not a crash", () => {
  for (const payload of [null, undefined, 42, "x", {}, { features: "no" }]) {
    const s = mod.parseAiAssistanceSettings(payload);
    assert.deepEqual(s.features, []);
    assert.equal(s.available, false);
    assert.equal(s.enabled, false);
  }
});

test("not-included and temporarily-unavailable are never collapsed into off", () => {
  // They are different facts with different remedies; one sends a person to
  // billing and the other to nobody at all.
  const plan = mod.aiStatusDisplay("NOT_INCLUDED_IN_PLAN");
  const down = mod.aiStatusDisplay("TEMPORARILY_UNAVAILABLE");
  const off = mod.aiStatusDisplay("DISABLED_FOR_WORKSPACE");
  assert.notEqual(plan.label, down.label);
  assert.notEqual(down.label, off.label);
  assert.equal(down.tone, "pending");
  assert.equal(mod.aiStatusDisplay("AVAILABLE").tone, "verified");
  // And a temporary outage does not imply anything about the evidence.
  assert.match(down.detail, /Nothing is wrong with your evidence/);
});

test("a personal workspace is not told to ask an administrator", () => {
  // There is nobody to ask. Saying so would send a person looking for someone
  // who does not exist.
  assert.doesNotMatch(mod.aiManagedByCopy("PERSONAL"), /administrator/i);
  assert.match(mod.aiManagedByCopy("ORGANIZATION"), /administrators/i);
  assert.ok(mod.aiManagedByCopy(null).length > 0);
});

test("the processing boundary is sentences, never server constants", () => {
  const lines = mod.aiProcessingLines(ENVELOPE.processing);
  assert.ok(!lines.some((l) => l.includes("METADATA_FIRST")));
  assert.ok(!lines.some((l) => l.includes("ADVISORY_ONLY")));
  assert.ok(lines.some((l) => /not sent for processing by default/.test(l)));
  assert.ok(lines.some((l) => /AI never decides anything about a record/.test(l)));
});

test("a workspace that DOES send originals says so plainly", () => {
  const lines = mod.aiProcessingLines({
    mode: "METADATA_FIRST",
    rawEvidenceSentByDefault: true,
    decisions: "ADVISORY_ONLY",
  });
  assert.ok(lines.some((l) => /Original files can be sent/.test(l)));
});

test("an unknown processing vocabulary is shown, not hidden", () => {
  const lines = mod.aiProcessingLines({ mode: "FULL_CONTENT", rawEvidenceSentByDefault: true, decisions: "AUTOMATED" });
  assert.ok(lines.some((l) => l.includes("FULL_CONTENT")));
  assert.ok(lines.some((l) => l.includes("AUTOMATED")));
});

test("the path is the client spelling the alias plugin rewrites", () => {
  // Clients call `/v1/workspaces/…`; `workspace-alias.plugin.ts` turns it into
  // `/v1/teams/…` before routing. Calling the post-rewrite spelling from a
  // client is how this route was dead in production once already.
  assert.equal(
    mod.buildAiAssistanceStatusPath("t 1"),
    "/v1/workspaces/ai-assistance-status?teamId=t%201",
  );
});

test("every feature state has a word and a tone", () => {
  for (const state of ["ENABLED", "DISABLED", "UNAVAILABLE", "NOT_INCLUDED"]) {
    const d = mod.aiFeatureStateDisplay(state);
    assert.ok(d.label.length > 0);
    assert.ok(d.tone.length > 0);
  }
  assert.equal(mod.aiFeatureStateDisplay("ENABLED").tone, "verified");
  assert.equal(mod.aiFeatureStateDisplay("UNAVAILABLE").tone, "pending");
});
