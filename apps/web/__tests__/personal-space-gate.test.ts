/**
 * PHASE 10 CLOSURE — FIX 3 (2026-07-23) — pure-function contract tests for
 * the canonical client no-Personal gate
 * (lib/platform-context/personalSpaceGate.ts).
 *
 * This module is the ONE place the client decides "is Personal Space
 * currently reachable" — it reads ONLY the server-projected
 * `personalSpaceAllowed` boolean and never re-derives
 * identityMode/ssoRequired/managed-status. These tests pin that contract
 * plus the heal-target selection and unavailable fallback.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isPersonalSpaceDisallowed,
  firstAvailableNonPersonalWorkspaceId,
  resolvePersonalSpaceGate,
  type PersonalSpaceGateEnvelopeInput,
} from "../lib/platform-context/personalSpaceGate";

// ---------------------------------------------------------------------------
// isPersonalSpaceDisallowed
// ---------------------------------------------------------------------------

test("isPersonalSpaceDisallowed: only an EXPLICIT false is disallowed", () => {
  assert.equal(isPersonalSpaceDisallowed({ personalSpaceAllowed: false }), true);
  assert.equal(isPersonalSpaceDisallowed({ personalSpaceAllowed: true }), false);
  assert.equal(isPersonalSpaceDisallowed({}), false, "absent field defaults to allowed");
  assert.equal(
    isPersonalSpaceDisallowed({ personalSpaceAllowed: undefined }),
    false,
    "undefined defaults to allowed",
  );
});

// ---------------------------------------------------------------------------
// firstAvailableNonPersonalWorkspaceId
// ---------------------------------------------------------------------------

test("firstAvailableNonPersonalWorkspaceId: prefers an owned workspace over an organization workspace", () => {
  const target = firstAvailableNonPersonalWorkspaceId({
    personalSpace: null,
    ownedWorkspaces: [
      { workspaceId: "owned-1", name: "Mine", kind: "OWNED", role: "OWNER", lifecycleStatus: "active" },
    ],
    organizations: [
      {
        organizationId: "org-1",
        organizationName: "Acme",
        workspaces: [
          { workspaceId: "org-ws-1", workspaceName: "Acme WS", kind: "ORGANIZATION", workspaceRole: "MEMBER", lifecycleStatus: "active" },
        ],
      },
    ],
    activeContext: { workspaceId: "owned-1", kind: "OWNED", organizationId: null, displayName: "Mine" },
  });
  assert.equal(target, "owned-1");
});

test("firstAvailableNonPersonalWorkspaceId: falls back to the first organization workspace when no owned workspace exists", () => {
  const target = firstAvailableNonPersonalWorkspaceId({
    personalSpace: null,
    ownedWorkspaces: [],
    organizations: [
      {
        organizationId: "org-1",
        organizationName: "Acme",
        workspaces: [
          { workspaceId: "org-ws-1", workspaceName: "Acme WS", kind: "ORGANIZATION", workspaceRole: "MEMBER", lifecycleStatus: "active" },
        ],
      },
    ],
    activeContext: { workspaceId: "org-ws-1", kind: "ORGANIZATION", organizationId: "org-1", displayName: "Acme WS" },
  });
  assert.equal(target, "org-ws-1");
});

test("firstAvailableNonPersonalWorkspaceId: null when there is no alternative — never fabricates a target", () => {
  assert.equal(
    firstAvailableNonPersonalWorkspaceId({
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: null, kind: "PERSONAL", organizationId: null, displayName: null },
    }),
    null,
  );
  assert.equal(firstAvailableNonPersonalWorkspaceId(null), null);
  assert.equal(firstAvailableNonPersonalWorkspaceId(undefined), null);
});

// ---------------------------------------------------------------------------
// resolvePersonalSpaceGate
// ---------------------------------------------------------------------------

function envelope(overrides: Partial<PersonalSpaceGateEnvelopeInput>): PersonalSpaceGateEnvelopeInput {
  return {
    activeSpace: { type: "PERSONAL", id: "p-1", displayName: "Personal Space", roleLabel: "Owner" },
    personalSpaceAllowed: false,
    contextOptions: null,
    ...overrides,
  };
}

test("resolvePersonalSpaceGate: allowed identity is always 'none', even with an active Personal context", () => {
  const result = resolvePersonalSpaceGate(envelope({ personalSpaceAllowed: true }));
  assert.deepEqual(result, { action: "none" });
});

test("resolvePersonalSpaceGate: absent personalSpaceAllowed is always 'none' (legacy/STANDARD default)", () => {
  const result = resolvePersonalSpaceGate(envelope({ personalSpaceAllowed: undefined }));
  assert.deepEqual(result, { action: "none" });
});

test("resolvePersonalSpaceGate: disallowed but active context is already non-Personal is 'none'", () => {
  const result = resolvePersonalSpaceGate(
    envelope({
      personalSpaceAllowed: false,
      activeSpace: { type: "ORGANIZATION", id: "org-ws-1", displayName: "Acme", roleLabel: "MEMBER" },
    }),
  );
  assert.deepEqual(result, { action: "none" });
});

test("resolvePersonalSpaceGate: disallowed + active Personal + an alternative exists → 'heal' to that REAL workspace (never a fabricated tenant)", () => {
  const result = resolvePersonalSpaceGate(
    envelope({
      personalSpaceAllowed: false,
      contextOptions: {
        personalSpace: null,
        ownedWorkspaces: [
          { workspaceId: "owned-1", name: "Mine", kind: "OWNED", role: "OWNER", lifecycleStatus: "active" },
        ],
        organizations: [],
        activeContext: { workspaceId: "p-1", kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
      },
    }),
  );
  assert.deepEqual(result, { action: "heal", targetWorkspaceId: "owned-1" });
});

test("resolvePersonalSpaceGate: disallowed + active Personal + NO alternative → 'unavailable' (never silently renders Personal content)", () => {
  const result = resolvePersonalSpaceGate(
    envelope({
      personalSpaceAllowed: false,
      contextOptions: {
        personalSpace: null,
        ownedWorkspaces: [],
        organizations: [],
        activeContext: { workspaceId: "p-1", kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
      },
    }),
  );
  assert.deepEqual(result, { action: "unavailable" });
});

test("resolvePersonalSpaceGate: disallowed + active Personal + missing contextOptions → 'unavailable' (fail closed, not fabricate)", () => {
  const result = resolvePersonalSpaceGate(
    envelope({ personalSpaceAllowed: false, contextOptions: null }),
  );
  assert.deepEqual(result, { action: "unavailable" });
});

// ---------------------------------------------------------------------------
// No client policy inference — this module reads ONLY personalSpaceAllowed
// off the envelope shape; grep its own source for banned literals.
// ---------------------------------------------------------------------------

test("source contract: personalSpaceGate.ts never references identityMode/ssoRequired/managed-status literals", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(resolve(root, "lib/platform-context/personalSpaceGate.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /identityMode|ssoRequired|MANAGED_ENTERPRISE|managingOrganizationId/i);
});
