/**
 * THE INVITATION READ PATH — disclosure contract.
 *
 * `lookupWorkspaceInvitation` was added so the public `/invite/[token]` page
 * could describe an invitation without consuming it. Before it, the invitation
 * domain was mutation-only and the page accepted from a `useEffect` on mount:
 * opening the email link WAS accepting.
 *
 * A read endpoint on a bearer token is a disclosure surface, so what it does
 * NOT say matters more than what it does. These tests are about that: no
 * internal identifier, no workspace name on a token that is spent, revoked or
 * expired, a masked address, and the same workspace-liveness answer `accept`
 * gives rather than a convenient lie about expiry.
 *
 * Driven by a fake client rather than a database. Every branch is a decision
 * about disclosure, and a decision about disclosure should be provable without
 * provisioning PostgreSQL.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { lookupWorkspaceInvitation } from "../src/services/identity/workspace-invitation.service.js";

// The service hashes the raw token exactly this way; the fake client matches
// on the hash so the tests exercise the real lookup path rather than a stub.
const hash = (raw: string) =>
  createHash("sha256").update(raw).digest("hex");

const TOKEN = "wsit_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type InviteRow = {
  email: string;
  role: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  teamId: string;
};

type TeamRow = {
  name: string;
  closedAtUtc: Date | null;
  workspaceKind: string;
  organization: { name: string; status: string } | null;
};

/**
 * Enough of PrismaClient for this one function, and nothing more. A partial
 * double is a hazard when it can reach a real socket — it cannot here: the two
 * methods the service calls are the two methods that exist.
 */
function fakeClient(opts: { invite: InviteRow | null; team?: TeamRow | null }) {
  return {
    teamInvite: {
      findFirst: async ({ where }: { where: { tokenHash: string } }) =>
        opts.invite && where.tokenHash === hash(TOKEN) ? opts.invite : null,
    },
    team: {
      findUnique: async () => opts.team ?? null,
    },
  } as never;
}

const future = () => new Date(Date.now() + 72 * 3600 * 1000);
const past = () => new Date(Date.now() - 3600 * 1000);

const pendingInvite = (over: Partial<InviteRow> = {}): InviteRow => ({
  email: "Jalal.Attar@northgate.example",
  role: "MEMBER",
  expiresAt: future(),
  acceptedAt: null,
  revokedAt: null,
  teamId: "11111111-1111-4111-8111-111111111111",
  ...over,
});

const liveTeam = (over: Partial<TeamRow> = {}): TeamRow => ({
  name: "Northgate Investigations",
  closedAtUtc: null,
  workspaceKind: "ORGANIZATION",
  organization: { name: "Northgate Group", status: "ACTIVE" },
  ...over,
});

/** Every identifier that must never appear in a lookup response. */
const FORBIDDEN_KEYS = [
  "id",
  "inviteId",
  "teamId",
  "workspaceId",
  "organizationId",
  "userId",
  "acceptedByUserId",
  "tokenHash",
  "token",
  "email",
];

function assertNoIdentifiers(value: unknown): void {
  const seen = JSON.stringify(value ?? {});
  for (const key of FORBIDDEN_KEYS) {
    expect(
      new RegExp(`"${key}"`).test(seen),
      `the lookup response must not carry "${key}"`,
    ).toBe(false);
  }
  // And no UUID anywhere, whatever it is called.
  expect(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(seen),
    "a UUID reached the public projection",
  ).toBe(false);
}

describe("lookupWorkspaceInvitation — what it says", () => {
  it("describes a LIVE invitation, with context and no identifiers", async () => {
    const view = await lookupWorkspaceInvitation(
      { rawToken: TOKEN },
      fakeClient({ invite: pendingInvite(), team: liveTeam() }),
    );

    expect(view?.state).toBe("PENDING");
    expect(view?.context?.workspaceName).toBe("Northgate Investigations");
    expect(view?.context?.organizationName).toBe("Northgate Group");
    expect(view?.context?.role).toBe("MEMBER");
    // MASKED — recognisable, not harvestable. One leading character, then a
    // BOUNDED run of bullets (3..6) so the mask does not report the exact
    // length of the local part, then the domain the recipient already knows.
    expect(view?.context?.invitedEmailMasked).toBe("J••••••@northgate.example");
    expect(view?.context?.invitedEmailMasked).not.toContain("Jalal.Attar");
    const bullets = (view?.context?.invitedEmailMasked ?? "").match(/•+/)?.[0] ?? "";
    expect(bullets.length).toBeLessThanOrEqual(6);
    expect(bullets.length).toBeGreaterThanOrEqual(3);
    expect(view?.context?.expiresAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    assertNoIdentifiers(view);
  });

  it("omits the organization name when it is not a second fact", async () => {
    // A personal/owned workspace is backed by an internal SYSTEM container
    // whose name is not a customer-facing organization.
    const personal = await lookupWorkspaceInvitation(
      { rawToken: TOKEN },
      fakeClient({
        invite: pendingInvite(),
        team: liveTeam({
          workspaceKind: "PERSONAL",
          organization: { name: "SYSTEM-container-7", status: "ACTIVE" },
        }),
      }),
    );
    expect(personal?.state).toBe("PENDING");
    expect(personal?.context?.organizationName).toBeNull();
    // The internal container name must not leak as an "organization".
    expect(JSON.stringify(personal)).not.toContain("SYSTEM-container-7");

    // And when the two names are the same string, it is rendered once.
    const same = await lookupWorkspaceInvitation(
      { rawToken: TOKEN },
      fakeClient({
        invite: pendingInvite(),
        team: liveTeam({
          name: "Northgate Group",
          organization: { name: "Northgate Group", status: "ACTIVE" },
        }),
      }),
    );
    expect(same?.context?.organizationName).toBeNull();
  });
});

describe("lookupWorkspaceInvitation — what it withholds", () => {
  it("an unknown token is a single opaque answer", async () => {
    const view = await lookupWorkspaceInvitation(
      { rawToken: "wsit_v1_this-token-does-not-exist" },
      fakeClient({ invite: pendingInvite(), team: liveTeam() }),
    );
    // `null`, not a shape that differs from a spent invitation's — so the
    // response cannot be used to test whether an invitation ever existed.
    expect(view).toBeNull();
  });

  it.each([
    ["ACCEPTED", { acceptedAt: new Date() }],
    ["REVOKED", { revokedAt: new Date() }],
    ["EXPIRED", { expiresAt: past() }],
  ] as const)(
    "a %s token states its status and nothing about the workspace",
    async (expected, over) => {
      const view = await lookupWorkspaceInvitation(
        { rawToken: TOKEN },
        fakeClient({ invite: pendingInvite(over), team: liveTeam() }),
      );
      expect(view?.state).toBe(expected);
      // Truthful about WHICH terminal state — the page needs to distinguish
      // expired from revoked — and silent about everything else.
      expect(view?.context).toBeNull();
      expect(JSON.stringify(view)).not.toContain("Northgate");
      assertNoIdentifiers(view);
    },
  );

  it("status precedence matches the accept path exactly", async () => {
    // `invitationStatus` checks acceptedAt, then revokedAt, then expiry. A
    // token that is all three reports ACCEPTED in both paths, so the page and
    // the mutation can never disagree about what happened.
    const view = await lookupWorkspaceInvitation(
      { rawToken: TOKEN },
      fakeClient({
        invite: pendingInvite({
          acceptedAt: new Date(),
          revokedAt: new Date(),
          expiresAt: past(),
        }),
        team: liveTeam(),
      }),
    );
    expect(view?.state).toBe("ACCEPTED");
  });
});

describe("lookupWorkspaceInvitation — workspace lifecycle", () => {
  it("a closed workspace is NOT reported as expired", async () => {
    const view = await lookupWorkspaceInvitation(
      { rawToken: TOKEN },
      fakeClient({
        invite: pendingInvite(),
        team: liveTeam({ closedAtUtc: new Date() }),
      }),
    );
    // The same answer `accept` gives (WORKSPACE_NOT_ACCEPTING_MEMBERS).
    expect(view?.state).toBe("NOT_ACCEPTING_MEMBERS");
    expect(view?.state).not.toBe("EXPIRED");
    expect(view?.context).toBeNull();
  });

  it("a non-ACTIVE customer organization refuses, and names nothing", async () => {
    for (const status of ["SUSPENDED", "PENDING", "CLOSED"]) {
      const view = await lookupWorkspaceInvitation(
        { rawToken: TOKEN },
        fakeClient({
          invite: pendingInvite(),
          team: liveTeam({
            organization: { name: "Northgate Group", status },
          }),
        }),
      );
      expect(view?.state, status).toBe("NOT_ACCEPTING_MEMBERS");
      expect(JSON.stringify(view)).not.toContain("Northgate");
    }
  });

  it("a PERSONAL workspace is not judged on an organization it does not have", async () => {
    // `organizationLifecycleApplies` is the same predicate the access policy
    // uses; a personal workspace backed by a non-ACTIVE internal container
    // must still accept, or every personal invitation breaks.
    const view = await lookupWorkspaceInvitation(
      { rawToken: TOKEN },
      fakeClient({
        invite: pendingInvite(),
        team: liveTeam({
          workspaceKind: "PERSONAL",
          organization: { name: "SYSTEM", status: "SUSPENDED" },
        }),
      }),
    );
    expect(view?.state).toBe("PENDING");
  });

  it("a missing workspace row refuses rather than throwing", async () => {
    const view = await lookupWorkspaceInvitation(
      { rawToken: TOKEN },
      fakeClient({ invite: pendingInvite(), team: null }),
    );
    expect(view?.state).toBe("NOT_ACCEPTING_MEMBERS");
  });
});

describe("lookupWorkspaceInvitation — it is a READ", () => {
  it("touches no writer at all", async () => {
    /*
      The whole justification for this function is that arriving at the page
      must not mutate anything. A client exposing ONLY the two read methods
      proves it structurally: if the service ever added an update, a claim or a
      provisioning call, this test would throw rather than quietly pass.
    */
    const calls: string[] = [];
    const client = {
      teamInvite: {
        findFirst: async () => {
          calls.push("teamInvite.findFirst");
          return pendingInvite();
        },
        // Any of these being reached is the defect.
        updateMany: () => {
          throw new Error("lookup must not write");
        },
        update: () => {
          throw new Error("lookup must not write");
        },
      },
      team: {
        findUnique: async () => {
          calls.push("team.findUnique");
          return liveTeam();
        },
      },
      teamMember: {
        create: () => {
          throw new Error("lookup must not provision membership");
        },
        upsert: () => {
          throw new Error("lookup must not provision membership");
        },
      },
      $transaction: () => {
        throw new Error("lookup must not open a transaction");
      },
      $queryRaw: () => {
        throw new Error("lookup must not take a lock");
      },
    } as never;

    const view = await lookupWorkspaceInvitation({ rawToken: TOKEN }, client);
    expect(view?.state).toBe("PENDING");
    expect(calls).toEqual(["teamInvite.findFirst", "team.findUnique"]);
  });
});
