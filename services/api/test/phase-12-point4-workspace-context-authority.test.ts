/**
 * PHASE 12 POINT 4 PASS C5 — a named workspace is never silently replaced.
 *
 * `resolveActiveOperationalWorkspace` is the ONE live workspace-context
 * authority for the collaboration surfaces. When a request named a workspace
 * (`x-team-id`, or a `teamId` query/body field) that produced no ACTIVE
 * membership, the resolver used to fall through to the caller's PERSONAL
 * workspace and report success. The operation then ran against the wrong
 * tenant: a guest invitation, a team mutation or a listing meant for
 * workspace X quietly became a Personal-space one.
 *
 * The rule proven here: a named workspace decides the outcome — ACTIVE
 * membership or nothing. The defaults exist only for a request that named no
 * workspace at all.
 *
 * Only Prisma is faked; the resolver itself runs for real.
 */

import { describe, expect, it } from "vitest";

import { resolveActiveOperationalWorkspace } from "../src/services/access/canonical-workspace-resolver.js";

type MembershipRow = {
  teamId: string;
  team?: { isPersonal: boolean };
} | null;

function makeClient(opts: {
  /** ACTIVE membership for the NAMED workspace, when any. */
  named?: MembershipRow;
  /** The actor's personal workspace, when any. */
  personal?: MembershipRow;
  /** Throw on the named-workspace read (DB unavailable). */
  throwOnNamed?: boolean;
}) {
  const calls: string[] = [];
  const client = {
    teamMember: {
      findFirst: async (args: {
        where: { teamId?: string; team?: { isPersonal?: boolean } };
      }) => {
        if (args.where.teamId) {
          calls.push("named");
          if (opts.throwOnNamed) throw new Error("db down");
          return opts.named ?? null;
        }
        calls.push("personal");
        return opts.personal ?? null;
      },
      findMany: async () => {
        calls.push("single");
        return [];
      },
    },
  } as never;
  return { client, calls };
}

const req = (teamId?: string) =>
  ({
    headers: teamId ? { "x-team-id": teamId } : {},
    query: {},
    body: {},
  }) as never;

const PERSONAL: MembershipRow = { teamId: "ws-personal", team: { isPersonal: true } };

describe("Phase 12 Point 4 — a named workspace is decided, never substituted", () => {
  it("resolves the named workspace when the actor is an ACTIVE member", async () => {
    const { client } = makeClient({
      named: { teamId: "ws-team", team: { isPersonal: false } },
      personal: PERSONAL,
    });
    await expect(
      resolveActiveOperationalWorkspace(req("ws-team"), "user-1", client),
    ).resolves.toEqual({ teamId: "ws-team", kind: "SHARED", source: "header" });
  });

  it("DENIES when the named workspace has no ACTIVE membership — no Personal substitute", async () => {
    const { client, calls } = makeClient({ named: null, personal: PERSONAL });
    await expect(
      resolveActiveOperationalWorkspace(req("ws-foreign"), "user-1", client),
    ).resolves.toBeNull();
    // And it does not even go looking for something else to use.
    expect(calls).toEqual(["named"]);
  });

  it("DENIES when the membership read fails — an outage is not a workspace switch", async () => {
    const { client } = makeClient({ throwOnNamed: true, personal: PERSONAL });
    await expect(
      resolveActiveOperationalWorkspace(req("ws-team"), "user-1", client),
    ).resolves.toBeNull();
  });

  it("a SUSPENDED membership on the named workspace is a denial", async () => {
    // The fake answers the ACTIVE-only query, so a suspended member sees the
    // same "no ACTIVE membership" result — and gets denied, not redirected.
    const { client } = makeClient({ named: null, personal: PERSONAL });
    await expect(
      resolveActiveOperationalWorkspace(req("ws-team"), "user-1", client),
    ).resolves.toBeNull();
  });

  it("still defaults to Personal when the request names NO workspace", async () => {
    const { client } = makeClient({ personal: PERSONAL });
    await expect(
      resolveActiveOperationalWorkspace(req(), "user-1", client),
    ).resolves.toEqual({
      teamId: "ws-personal",
      kind: "SINGLE_OCCUPANT",
      source: "personal-default",
    });
  });

  it("returns null when nothing is named and the actor has no workspace", async () => {
    const { client } = makeClient({});
    await expect(
      resolveActiveOperationalWorkspace(req(), "user-1", client),
    ).resolves.toBeNull();
  });
});
