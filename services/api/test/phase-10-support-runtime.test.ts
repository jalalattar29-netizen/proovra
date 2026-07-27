/**
 * PHASE 10 STEP 5 (2026-07-23) — SUPPORT ACCESS RUNTIME (dual identity).
 *
 * Proves the runtime composition layer over the ONE support-access authority:
 *   - READ_ONLY dual-identity request active (both identities carried);
 *   - out-of-scope action denied;
 *   - ELEVATED without approval/step-up denied (authority start path);
 *   - expired / revoked denied + heals out;
 *   - workspace-switch cannot escape scope;
 *   - both identities audited;
 *   - envelope exposes support access;
 *   - ZERO mutation on denial;
 * plus a SOURCE-CONTRACT test: support authorities = 1, no invisible-customer
 * -token path, no alternate authorization engine in the runtime layer.
 *
 * Only the DB + audit process boundaries are mocked; the authority's real
 * evaluation functions run.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit sink — capture dual-identity audit rows.
const AUDIT = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: async (params: Record<string, unknown>) => {
    AUDIT.calls.push(params);
  },
}));
// db.js is imported transitively; the service always receives an explicit
// client in these tests, so a bare stub is enough.
vi.mock("../src/db.js", () => ({ prisma: {} }));

import {
  resolveSupportRuntimeContext,
  authorizeSupportAction,
  assertWorkspaceWithinScope,
  serializeSupportContext,
  deserializeSupportContext,
  buildSupportAccessEnvelopeSection,
} from "../src/services/identity/support-runtime.service.js";
import { startSupportAccess } from "../src/services/identity/support-access.service.js";

// ---------------------------------------------------------------------------
// Mock prisma client — an in-memory grants table with write tracking.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  supportUserId: string;
  organizationId: string;
  teamId: string | null;
  reason: string;
  accessLevel: "READ_ONLY" | "ELEVATED";
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  approvedByUserId: string | null;
  startedAtUtc: Date;
  expiresAtUtc: Date;
  revokedAtUtc: Date | null;
  organization?: { name: string | null };
};

function makeClient(rows: Row[]) {
  const writes: string[] = [];
  const table = {
    findFirst: async (args: {
      where: { supportUserId: string; status: string; organizationId?: string };
    }) => {
      const matches = rows
        .filter(
          (r) =>
            r.supportUserId === args.where.supportUserId &&
            r.status === args.where.status &&
            (args.where.organizationId
              ? r.organizationId === args.where.organizationId
              : true),
        )
        .sort((a, b) => b.startedAtUtc.getTime() - a.startedAtUtc.getTime());
      return matches[0] ?? null;
    },
    findUnique: async (args: { where: { id: string } }) =>
      rows.find((r) => r.id === args.where.id) ?? null,
    create: async () => {
      writes.push("create");
      return {};
    },
    update: async () => {
      writes.push("update");
      return {};
    },
    updateMany: async () => {
      writes.push("updateMany");
      return { count: 0 };
    },
    delete: async () => {
      writes.push("delete");
      return {};
    },
  };
  const client = { supportAccessGrant: table, __writes: writes } as unknown as Parameters<
    typeof authorizeSupportAction
  >[1] & { __writes: string[] };
  return client;
}

const ACTOR = "support-actor-1";
const ORG = "org-customer-1";
const OTHER_ORG = "org-customer-2";
const TEAM_A = "team-a";
const TEAM_B = "team-b";

function activeReadOnlyGrant(overrides: Partial<Row> = {}): Row {
  const now = Date.now();
  return {
    id: "grant-1",
    supportUserId: ACTOR,
    organizationId: ORG,
    teamId: null,
    reason: "investigate support ticket 4821",
    accessLevel: "READ_ONLY",
    status: "ACTIVE",
    approvedByUserId: null,
    startedAtUtc: new Date(now - 60_000),
    expiresAtUtc: new Date(now + 60 * 60_000),
    revokedAtUtc: null,
    organization: { name: "Contoso Ltd" },
    ...overrides,
  };
}

beforeEach(() => {
  AUDIT.calls.length = 0;
});

// ---------------------------------------------------------------------------
// Runtime behavior
// ---------------------------------------------------------------------------

describe("§10.8 runtime — READ_ONLY dual-identity request active", () => {
  it("resolves a dual-identity context carrying BOTH the actor and the org", async () => {
    const client = makeClient([activeReadOnlyGrant()]);
    const res = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG },
      client,
    );
    expect(res.context).not.toBeNull();
    expect(res.context?.supportActorUserId).toBe(ACTOR);
    expect(res.context?.organizationId).toBe(ORG);
    expect(res.context?.mode).toBe("READ_ONLY");
    // Grant scopes access — the actor identity is preserved, never a
    // customer token.
    expect(res.context?.grantId).toBe("grant-1");
  });

  it("allows a read action under READ_ONLY and audits BOTH identities", async () => {
    const client = makeClient([activeReadOnlyGrant()]);
    const { context } = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG },
      client,
    );
    const out = await authorizeSupportAction(
      { context: context!, action: "evidence.read", customerOrganizationId: ORG },
      client,
    );
    expect(out.allowed).toBe(true);
    const audit = AUDIT.calls.at(-1)!;
    expect(audit.userId).toBe(ACTOR); // actor identity
    expect(audit.resourceId).toBe(ORG); // customer identity
    const meta = audit.metadata as Record<string, unknown>;
    expect(meta.supportActorUserId).toBe(ACTOR);
    expect(meta.customerOrganizationId).toBe(ORG);
    expect(meta.decision).toBe("success");
  });
});

describe("§10.8 runtime — out-of-scope action denied", () => {
  it("denies a mutating action under READ_ONLY with ZERO mutation", async () => {
    const client = makeClient([activeReadOnlyGrant()]);
    const { context } = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG },
      client,
    );
    const out = await authorizeSupportAction(
      { context: context!, action: "evidence.update", customerOrganizationId: ORG },
      client,
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("support_read_only");
    expect(client.__writes).toEqual([]); // zero business mutation
  });

  it("denies a FORBIDDEN action even under ELEVATED", async () => {
    const client = makeClient([activeReadOnlyGrant({ accessLevel: "ELEVATED" })]);
    const { context } = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG },
      client,
    );
    const out = await authorizeSupportAction(
      { context: context!, action: "evidence.delete", customerOrganizationId: ORG },
      client,
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("support_forbidden_action");
    expect(client.__writes).toEqual([]);
  });
});

describe("§10.8 runtime — ELEVATED requires approval/step-up", () => {
  it("the authority refuses to mint an ELEVATED grant without an approver", async () => {
    const client = makeClient([]);
    await expect(
      startSupportAccess(
        {
          supportUserId: ACTOR,
          organizationId: ORG,
          reason: "elevated investigation of ticket",
          accessLevel: "ELEVATED",
          approvedByUserId: null,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: "SUPPORT_APPROVAL_REQUIRED" });
    // Nothing was created.
    expect((client as unknown as { __writes: string[] }).__writes).toEqual([]);
  });
});

describe("§10.8 runtime — expired / revoked heal out + deny", () => {
  it("an expired grant heals the context to null", async () => {
    const client = makeClient([
      activeReadOnlyGrant({ expiresAtUtc: new Date(Date.now() - 1000) }),
    ]);
    const res = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG },
      client,
    );
    expect(res.context).toBeNull();
    expect((res as { reason: string }).reason).toBe("expired");
  });

  it("a grant revoked mid-session denies the next action (fresh DB re-check)", async () => {
    const row = activeReadOnlyGrant();
    const client = makeClient([row]);
    const { context } = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG },
      client,
    );
    // Operator revokes the grant after the context was composed.
    row.status = "REVOKED";
    row.revokedAtUtc = new Date();
    const out = await authorizeSupportAction(
      { context: context!, action: "evidence.read", customerOrganizationId: ORG },
      client,
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("revoked");
    expect(client.__writes).toEqual([]);
    // The denial is still audited (both identities).
    const audit = AUDIT.calls.at(-1)!;
    expect(audit.outcome).toBe("denied");
    expect(audit.userId).toBe(ACTOR);
    expect(audit.resourceId).toBe(ORG);
  });
});

describe("§10.8 runtime — workspace switch cannot escape scope", () => {
  it("denies an action targeting a DIFFERENT org than the grant", async () => {
    const client = makeClient([activeReadOnlyGrant()]);
    const { context } = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG },
      client,
    );
    const out = await authorizeSupportAction(
      {
        context: context!,
        action: "evidence.read",
        customerOrganizationId: OTHER_ORG,
      },
      client,
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("org_scope_mismatch");
    expect(client.__writes).toEqual([]);
  });

  it("a workspace-narrowed grant denies a different workspace", async () => {
    const client = makeClient([activeReadOnlyGrant({ teamId: TEAM_A })]);
    const { context } = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG, teamId: TEAM_A },
      client,
    );
    const out = await authorizeSupportAction(
      {
        context: context!,
        action: "evidence.read",
        customerOrganizationId: ORG,
        requestedTeamId: TEAM_B,
      },
      client,
    );
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("workspace_scope_mismatch");
  });

  it("the pure workspace guard rejects an out-of-scope switch", () => {
    const ctx = {
      grantId: "grant-1",
      supportActorUserId: ACTOR,
      organizationId: ORG,
      teamId: TEAM_A,
      mode: "READ_ONLY" as const,
      reason: "x".repeat(9),
      expiresAtUtc: new Date(Date.now() + 60_000).toISOString(),
      approvedByUserId: null,
    };
    expect(
      assertWorkspaceWithinScope({
        context: ctx,
        requestedOrganizationId: ORG,
        requestedTeamId: TEAM_A,
      }).withinScope,
    ).toBe(true);
    expect(
      assertWorkspaceWithinScope({
        context: ctx,
        requestedOrganizationId: OTHER_ORG,
      }).withinScope,
    ).toBe(false);
  });
});

describe("§10.8 runtime — background jobs preserve + re-validate context", () => {
  it("serialize → deserialize round-trips actor + org + grantId and re-validates", async () => {
    const client = makeClient([activeReadOnlyGrant()]);
    const { context } = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG },
      client,
    );
    const blob = serializeSupportContext(context!);
    expect(blob.supportActorUserId).toBe(ACTOR);
    expect(blob.organizationId).toBe(ORG);
    expect(blob.grantId).toBe("grant-1");
    const re = await deserializeSupportContext(blob, client);
    expect(re.context?.supportActorUserId).toBe(ACTOR);
    expect(re.context?.grantId).toBe("grant-1");
  });

  it("a queued job heals out when the grant was revoked before it ran", async () => {
    const row = activeReadOnlyGrant();
    const client = makeClient([row]);
    const { context } = await resolveSupportRuntimeContext(
      { supportActorUserId: ACTOR, organizationId: ORG },
      client,
    );
    const blob = serializeSupportContext(context!);
    row.status = "REVOKED";
    row.revokedAtUtc = new Date();
    const re = await deserializeSupportContext(blob, client);
    expect(re.context).toBeNull();
    expect((re as { reason: string }).reason).toBe("revoked");
  });
});

describe("§10.8 runtime — envelope exposes active support access", () => {
  it("returns the dual-identity section for an active grant", async () => {
    const client = makeClient([activeReadOnlyGrant()]);
    const section = await buildSupportAccessEnvelopeSection(
      { supportActorUserId: ACTOR },
      client,
    );
    expect(section).not.toBeNull();
    expect(section?.active).toBe(true);
    expect(section?.supportActorUserId).toBe(ACTOR);
    expect(section?.organizationId).toBe(ORG);
    expect(section?.organizationName).toBe("Contoso Ltd");
    expect(section?.mode).toBe("READ_ONLY");
  });

  it("returns null when the actor has no active grant", async () => {
    const client = makeClient([]);
    const section = await buildSupportAccessEnvelopeSection(
      { supportActorUserId: ACTOR },
      client,
    );
    expect(section).toBeNull();
  });

  it("returns null (heals out) for an expired grant", async () => {
    const client = makeClient([
      activeReadOnlyGrant({ expiresAtUtc: new Date(Date.now() - 1000) }),
    ]);
    const section = await buildSupportAccessEnvelopeSection(
      { supportActorUserId: ACTOR },
      client,
    );
    expect(section).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Source-contract invariants.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("§10.8 source-contract — one authority, no invisible token, no alt engine", () => {
  const files = walk(SRC);

  it("exactly ONE file declares the support-access authority (startSupportAccess)", () => {
    const authorities = files.filter((f) =>
      /export\s+async\s+function\s+startSupportAccess/.test(readFileSync(f, "utf8")),
    );
    expect(authorities).toHaveLength(1);
    expect(authorities[0]!.replace(/\\/g, "/")).toMatch(
      /services\/identity\/support-access\.service\.ts$/,
    );
  });

  it("the grant-scope evaluator (evaluateSupportAccess) is declared exactly once", () => {
    const decls = files.filter((f) =>
      /export\s+function\s+evaluateSupportAccess/.test(readFileSync(f, "utf8")),
    );
    expect(decls).toHaveLength(1);
  });

  it("the runtime layer defers to the authority — it does NOT re-declare the evaluators", () => {
    const runtime = readFileSync(
      path.join(SRC, "services/identity/support-runtime.service.ts"),
      "utf8",
    );
    // Imports the authority's evaluators.
    expect(runtime).toMatch(/from\s+"\.\/support-access\.service\.js"/);
    expect(runtime).toContain("evaluateSupportAccess");
    // Does NOT declare a parallel authorization engine.
    expect(/function\s+evaluateSupportAccess/.test(runtime)).toBe(false);
    expect(/function\s+evaluateSupportActionAllowed/.test(runtime)).toBe(false);
  });

  it("has NO invisible-customer-token / impersonation path in the support layer", () => {
    for (const rel of [
      "services/identity/support-access.service.ts",
      "services/identity/support-runtime.service.ts",
    ]) {
      const src = readFileSync(path.join(SRC, rel), "utf8");
      // No CALL that impersonates or mints a customer-identity token. (The
      // doc comments use the word "impersonation" to describe what is
      // forbidden — we match call sites, not prose.)
      expect(/\bimpersonate\s*\(/i.test(src)).toBe(false);
      expect(/mintCustomerToken|asCustomerUser\s*\(/i.test(src)).toBe(false);
    }
    // The runtime context always carries the ACTOR identity distinctly.
    const runtime = readFileSync(
      path.join(SRC, "services/identity/support-runtime.service.ts"),
      "utf8",
    );
    expect(runtime).toContain("supportActorUserId");
  });
});
