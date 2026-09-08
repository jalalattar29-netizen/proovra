/**
 * COLLABORATION TEAM — CANONICAL ERROR ENVELOPE + TRANSACTIONAL LEAD INVARIANT.
 *
 * Two families of defect, both invisible to every existing test because both
 * were about the SHAPE of correct-looking code rather than its result.
 *
 * 1. THE ENVELOPE. This router answered domain refusals with two non-canonical
 *    shapes: `{ code, error: "<string>", message }` from `handleServiceError`,
 *    and `{ error: { code }, message }` from the archived-lifecycle guard. The
 *    web client decides how to parse a failure by asking whether
 *    `body.error.code` is a string. Neither shape passes that test the way it
 *    intends: the first has `error` as a STRING, the second has the message
 *    outside `error`. The result was a typed refusal arriving at the console
 *    with no code, or with the placeholder `HTTP 409: API error` as its reason.
 *
 * 2. THE INVARIANT. A Collaboration Team must never be left with zero ACTIVE
 *    LEADs. `suspendMember` counted remaining LEADs INSIDE its transaction;
 *    `changeMemberRole` and `removeMember` counted on the outer client BEFORE
 *    opening theirs. A read-then-write across two snapshots is not a guard:
 *    two concurrent demotions of the last two LEADs each read 2, each passed,
 *    and the team was left with none.
 *
 * These are SOURCE contracts on purpose. The envelope shape and the client that
 * parses it live in two different packages, and the concurrency window cannot
 * be reproduced by a single-threaded functional test without a harness whose
 * scheduling would itself be the thing under test. What is pinned here is the
 * exact property each defect violated.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..", "src");

function read(relative: string): string {
  return readFileSync(join(API_SRC, relative), "utf8");
}

/** Source with block and line comments stripped — so a rule cannot be satisfied
 *  (or broken) by prose that merely mentions the pattern it forbids. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const ROUTES = codeOnly(read("routes/collaboration-teams.routes.ts"));
const AUTHZ = codeOnly(
  read("services/collaboration-team/collaboration-authorization.ts"),
);
const SERVICE = codeOnly(
  read("services/collaboration-team/collaboration-team.service.ts"),
);

describe("collaboration team domain errors use the canonical envelope", () => {
  it("serialises CollaborationTeamError as { error: { code, message, requestId } }", () => {
    const handler = ROUTES.slice(
      ROUTES.indexOf("function handleServiceError"),
      ROUTES.indexOf("async function auditEvent"),
    );
    expect(handler).toContain("err instanceof CollaborationTeamError");
    expect(handler).toMatch(
      /error:\s*\{\s*code:\s*err\.code,\s*message:\s*err\.message,\s*requestId,/,
    );
  });

  it("never sends `error` as a bare string from this router", () => {
    // The exact shape that made the client take its legacy branch.
    expect(ROUTES).not.toMatch(/error:\s*err\.code\b/);
    expect(ROUTES).not.toMatch(/error:\s*"internal_error"/);
  });

  it("puts the archived-lifecycle message INSIDE error, where the client reads it", () => {
    const guard = AUTHZ.slice(
      AUTHZ.indexOf("options.requireActiveTeam"),
      AUTHZ.indexOf("options.requireGroupMembership === false"),
    );
    expect(guard).toContain('code: "collaboration_team_archived"');
    // The message and the code must be siblings under `error`.
    expect(guard).toMatch(
      /error:\s*\{[^}]*code:\s*"collaboration_team_archived",\s*message:\s*"[^"]+"/,
    );
    // And it must not be reintroduced beside `error`.
    expect(guard).not.toMatch(/\}\s*,\s*\n\s*message:/);
  });

  it("keeps the opaque 404 opaque — no message is added to a containment refusal", () => {
    /*
     * Deliberately NOT "fixed". `{ error: { code: "not_found" } }` carries no
     * message because a cross-tenant read and a genuinely missing team must be
     * byte-identical; a reason here would be an enumeration oracle. The client
     * maps 404 by status, so the UX is unaffected.
     */
    expect(AUTHZ).toContain('reply.code(404).send({ error: { code: "not_found" } })');
  });
});

describe("the last ACTIVE LEAD invariant is transactional in all three writers", () => {
  /** The body of one exported service function, up to the next `export`. */
  function fn(name: string): string {
    const start = SERVICE.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const next = SERVICE.indexOf("\nexport ", start + 1);
    return SERVICE.slice(start, next === -1 ? undefined : next);
  }

  /**
   * The property: within this function, the LEAD count must be read from the
   * TRANSACTION client, and no LEAD count may be read from the outer client.
   */
  function assertCountIsTransactional(name: string) {
    const body = fn(name);
    /*
     * Matched in two steps rather than one regex. `suspendMember` narrows its
     * count with `id: { not: member.id }`, whose nested braces defeat any
     * `[^}]*` window — so find every count on this model, then keep the ones
     * whose predicate mentions LEAD.
     */
    const leadCounts = [
      ...body.matchAll(/(\w+)\.collaborationTeamMember\.count\(/g),
    ].filter((m) =>
      body.slice(m.index ?? 0, (m.index ?? 0) + 320).includes('role: "LEAD"'),
    );
    expect(leadCounts.length, `${name} must count ACTIVE LEADs`).toBeGreaterThan(0);
    for (const match of leadCounts) {
      expect(
        match[1],
        `${name} reads the LEAD count from \`${match[1]}\`; it must use the transaction client \`tx\``,
      ).toBe("tx");
    }
    // The count must also sit INSIDE the transaction callback, not merely use a
    // variable called `tx` declared elsewhere.
    const txStart = body.indexOf("$transaction(async (tx)");
    expect(txStart, `${name} must open a transaction`).toBeGreaterThan(-1);
    expect(
      body.indexOf('role: "LEAD"'),
      `${name} counts LEADs before its transaction opens`,
    ).toBeGreaterThan(txStart);
  }

  it("suspendMember counts inside the transaction", () => {
    assertCountIsTransactional("suspendMember");
  });

  it("changeMemberRole counts inside the transaction", () => {
    assertCountIsTransactional("changeMemberRole");
  });

  it("removeMember counts inside the transaction", () => {
    assertCountIsTransactional("removeMember");
  });

  it("each writer refuses with a reason naming its own operation", () => {
    // `team_conflict` is one code for three operations, which is why the web
    // layer renders the SERVER's sentence rather than a fixed mapping.
    expect(fn("suspendMember")).toContain("Cannot suspend the last LEAD");
    expect(fn("changeMemberRole")).toContain("Cannot demote the last LEAD");
    expect(fn("removeMember")).toContain("Cannot remove the last LEAD");
  });

  it("only ACTIVE members satisfy the invariant", () => {
    for (const name of ["suspendMember", "changeMemberRole", "removeMember"]) {
      expect(fn(name)).toMatch(/role:\s*"LEAD",\s*status:\s*"ACTIVE"/);
    }
  });
});

/** The DELETE registration only — bounded by the next route registration. */
function deleteRouteBody(): string {
  const start = ROUTES.indexOf("app.delete<{ Params: { teamId: string } }>");
  expect(start, "delete route not found").toBeGreaterThan(-1);
  const next = ROUTES.indexOf("\n  app.", start + 1);
  return ROUTES.slice(start, next === -1 ? undefined : next);
}

describe("permanent deletion has its own capability", () => {
  it("the delete route no longer rides on team.archive", () => {
    const del = deleteRouteBody();
    expect(del).toContain('groupPermission: "team.delete"');
    expect(del).not.toContain('groupPermission: "team.archive"');
  });

  it("archived teams stay deletable — the lifecycle exception is deliberate", () => {
    const del = deleteRouteBody();
    expect(del).not.toContain("requireActiveTeam: true");
  });

  it("disposability is still re-asserted inside the deleting transaction", () => {
    const body = SERVICE.slice(SERVICE.indexOf("export async function deleteCollaborationTeam("));
    expect(body).toContain("$transaction");
    expect(body).toContain("disposable");
  });
});
