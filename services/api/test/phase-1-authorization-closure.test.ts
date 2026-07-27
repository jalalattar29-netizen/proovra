/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — static-enforcement contract.
 *
 * Machine-enforced allowlist: every route/service file that contains a
 * membership-based authorization gate (`teamMember.findUnique/findFirst`)
 * MUST be one of:
 *   (a) CANONICAL — composes the canonical primitive (`authorizeOrFail` /
 *       `requireAuthorize` / `evaluateMemberAccess` / a wrapper that calls
 *       it) OR performs an explicit ACTIVE-status membership check; or
 *   (b) EXCEPTION — a registered legitimate non-membership flow; or
 *   (c) PENDING   — a known, tracked, not-yet-migrated gate.
 *
 * A NEW gate-bearing file that is none of the above fails this test —
 * preventing silent introduction of a status-blind gate.
 *
 * FALSE-POSITIVE HANDLING: the scanner only inspects files that literally
 * call `teamMember.findUnique`/`findFirst` (the authorization-gate shape).
 * Ordinary list/aggregate queries (`findMany`/`count`) and non-gate reads
 * are not flagged. A file that reads a member row for DISPLAY (not
 * authorization) and is wrongly flagged should be added to EXCEPTIONS with
 * an explicit "informational, not an authorization gate" reason.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  AUTHORIZATION_EXCEPTIONS,
  PENDING_AUTHORIZATION_MIGRATIONS,
} from "../src/services/identity/authorization-allowlist.js";

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const GATE_RE = /teamMember\.(findUnique|findFirst)\b/;
// A file is CANONICAL if it composes the primitive OR checks ACTIVE status.
const CANONICAL_RE =
  /authorizeOrFail|requireAuthorize|evaluateMemberAccess|requireOpsActor|requireReviewerActor|resolveMemberContext|status:\s*"ACTIVE"|status\s*!==\s*"ACTIVE"|status\s*===\s*"ACTIVE"|TeamMemberStatus\.ACTIVE|teamMemberStatusGrantsAccess|access-policy/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("Phase 1 — authorization allowlist is coherent", () => {
  it("every registered EXCEPTION and PENDING file exists on disk", () => {
    const all = new Set(walk(API_SRC).map((p) => p.replace(/\\/g, "/")));
    const exists = (base: string) =>
      [...all].some((p) => p.endsWith(`/${base}`));
    for (const e of AUTHORIZATION_EXCEPTIONS) {
      expect(exists(e.file), `EXCEPTION file missing: ${e.file}`).toBe(true);
    }
    for (const p of PENDING_AUTHORIZATION_MIGRATIONS) {
      expect(exists(p.file), `PENDING file missing: ${p.file}`).toBe(true);
    }
  });

  it("no duplicate PENDING entries", () => {
    const files = PENDING_AUTHORIZATION_MIGRATIONS.map((p) => p.file);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("Phase 1 — no unclassified membership authorization gate", () => {
  it("every gate-bearing file is CANONICAL, EXCEPTION, or PENDING", () => {
    const exceptionFiles = new Set(AUTHORIZATION_EXCEPTIONS.map((e) => e.file));
    const pendingFiles = new Set(
      PENDING_AUTHORIZATION_MIGRATIONS.map((p) => p.file),
    );

    const unclassified: string[] = [];
    for (const file of walk(API_SRC)) {
      const base = file.split(/[\\/]/).pop()!;
      const src = readFileSync(file, "utf8");
      if (!GATE_RE.test(src)) continue; // not an authorization-gate shape
      if (CANONICAL_RE.test(src)) continue; // composes primitive / ACTIVE check
      if (exceptionFiles.has(base)) continue;
      if (pendingFiles.has(base)) continue;
      unclassified.push(base);
    }

    expect(
      unclassified.sort(),
      `Unclassified membership authorization gate(s) found. Migrate to the ` +
        `canonical primitive (authorizeOrFail/requireAuthorize) or register ` +
        `in AUTHORIZATION_EXCEPTIONS / PENDING_AUTHORIZATION_MIGRATIONS.`,
    ).toEqual([]);
  });
});

describe("Phase 1 — migration progress ledger (informational tripwire)", () => {
  // This asserts the CURRENT known-debt count. When a domain is migrated,
  // its PENDING entry is removed and this number MUST be updated in the same
  // change — making debt reduction intentional and reviewable.
  it("pending-migration count matches the ledger", () => {
    // Update this number ONLY when adding/removing a PENDING entry.
    // 26 initial − 12 migrated (ALL CRITICAL + AI closed):
    //   retention/destruction/legal-hold (4): governance-lifecycle.routes.ts,
    //     destructive-action-gate.service.ts, governance.routes.ts,
    //     governance-operations.routes.ts
    //   AI-over-evidence (5): ai-evidence, ai-case, ai-reviewer, ai-search,
    //     ai-operations .routes.ts
    //   evidence-review / redaction / evidence-requests (3):
    //     review-operations.routes.ts, redaction-rbac.service.ts,
    //     evidence-requests.routes.ts
    //   + HIGH tier (7): workflow-intake-links, workspace-ai-policy,
    //     automation, automation-webhooks, integrations, workflow, security.
    //   + MEDIUM tier (6) + LOW tier (1): evidence.saved-views,
    //     analytics-operations, notifications, notification-preferences,
    //     reliability, reviewer-criteria, presence.
    // = 0 remaining. PHASE 1 DoD: PENDING is empty.
    const EXPECTED_PENDING = 0;
    expect(PENDING_AUTHORIZATION_MIGRATIONS.length).toBe(EXPECTED_PENDING);
  });
});
