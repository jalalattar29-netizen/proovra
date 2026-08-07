/**
 * PHASE 12 CORRECTIVE PASS §1 — THE STRUCTURAL GUARD FOR THE IDENTITY RAIL.
 *
 * What changed, and why this file changed with it
 * ---------------------------------------------------------------------------
 * The previous shape was `resolveWorkspaceSubject` — a helper that READ
 * `User.currentWorkspaceId` and RETURNED it, relying on every caller to
 * authorize on the next line, with this file enforcing that they did. That
 * arrangement was reported by `verify-current-workspace-authority.mjs` as its
 * one outstanding violation, and it was right to: a pointer laundered through
 * a return value is exactly the shape that gate exists to find, and a module
 * whose defence is "another test watches my callers" is arguing with the gate
 * rather than satisfying it.
 *
 * The rail now derives and authorizes in ONE call —
 * `resolveAuthorizedWorkspaceSubject` — so the pointer never leaves the
 * function unproven. There is still exactly one policy evaluation and one
 * permission-decision audit row per request.
 *
 * This file's job therefore inverts. It no longer checks that callers remember
 * to authorize; it checks that the resolver CANNOT be bypassed:
 *
 *   1. the old laundering helper is gone and does not come back;
 *   2. the resolver hands the pointer to the canonical primitive itself;
 *   3. the resolver probes membership before it authorizes, so a non-member
 *      gets 404 rather than a 403 that confirms the workspace exists;
 *   4. no handler in the module reads the pointer directly.
 *
 * (4) is the load-bearing one: it is what makes a NEW handler unable to
 * reintroduce the old shape without this test failing.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/routes/identity.routes.ts",
);

const RESOLVER = "resolveAuthorizedWorkspaceSubject";

describe("§1 — the identity workspace rail authorizes at the point of derivation", () => {
  const source = readFileSync(SRC, "utf8");

  it("the pointer-laundering helper is gone", () => {
    // Only the historical note may mention the old name; no declaration and no
    // call site may.
    expect(source).not.toMatch(/async function resolveWorkspaceSubject\(/);
    expect(source).not.toMatch(/await resolveWorkspaceSubject\(/);
  });

  it(`${RESOLVER} hands the pointer to the canonical primitive itself`, () => {
    const body = new RegExp(`async function ${RESOLVER}\\([\\s\\S]*?\\n}`).exec(
      source,
    );
    expect(body, `${RESOLVER} must exist`).toBeTruthy();
    const text = body![0];
    // Reads the pointer…
    expect(text).toMatch(/select:\s*\{\s*currentWorkspaceId:\s*true\s*\}/);
    // …and authorizes it in the same function, with the candidate id.
    expect(text).toMatch(/authorizeOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?teamId:\s*candidateTeamId/);
    // Membership existence is probed BEFORE authorization so a non-member is
    // concealed as 404 rather than learning the workspace exists.
    const memberAt = text.indexOf("prisma.teamMember.findUnique");
    const authorizeAt = text.indexOf("authorizeOrFail(");
    expect(memberAt, "the membership probe must be present").toBeGreaterThan(-1);
    expect(
      memberAt,
      "membership must be probed before authorization, so denial is 404 not 403",
    ).toBeLessThan(authorizeAt);
  });

  it("every call site consumes the AUTHORIZED result, never a bare id", () => {
    const lines = source.split("\n");
    const callSites: number[] = [];
    lines.forEach((line, i) => {
      if (new RegExp(`=\\s*await ${RESOLVER}\\(`).test(line)) callSites.push(i);
    });

    // Positive control: zero call sites would make this guard inert.
    expect(
      callSites.length,
      "the rail must still have call sites; zero means this guard is inert",
    ).toBeGreaterThan(0);

    const wrong: string[] = [];
    for (const i of callSites) {
      const window = lines.slice(i, i + 6).join("\n");
      // The result is an object that must be null-checked and destructured.
      // Anything else means a handler invented its own use for the value.
      if (!/if \(!resolved\) return;/.test(window)) {
        wrong.push(`${i + 1}: missing null check`);
      }
      if (!/const \{ teamId, actor \} = resolved;/.test(window)) {
        wrong.push(`${i + 1}: does not destructure the authorized result`);
      }
    }
    expect(
      wrong,
      `call sites that do not consume the authorized result:\n${wrong.join("\n")}`,
    ).toEqual([]);
  });

  it("no handler in the module reads the pointer directly", () => {
    // The ONLY permitted read is inside the resolver. Count the reads and
    // require that every one of them sits within the resolver's body — this is
    // what stops a new handler from reintroducing the laundering shape.
    const resolverBody = new RegExp(
      `async function ${RESOLVER}\\([\\s\\S]*?\\n}`,
    ).exec(source);
    expect(resolverBody).toBeTruthy();
    const start = source.indexOf(resolverBody![0]);
    const end = start + resolverBody![0].length;

    const outside: string[] = [];
    for (const m of source.matchAll(/currentWorkspaceId/g)) {
      const at = m.index ?? 0;
      if (at >= start && at < end) continue;
      // A mention inside the historical note is prose, not a read.
      const lineStart = source.lastIndexOf("\n", at) + 1;
      const line = source.slice(lineStart, source.indexOf("\n", at));
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      outside.push(line.trim());
    }
    expect(
      outside,
      `the pointer may only be read inside ${RESOLVER}:\n${outside.join("\n")}`,
    ).toEqual([]);
  });

  it("requireIdentityActor still routes through the canonical primitive", () => {
    // The TARGET-scope path (member ids, service-account ids) still uses it.
    const body = /async function requireIdentityActor\([\s\S]*?\n}/.exec(source);
    expect(body, "requireIdentityActor must exist").toBeTruthy();
    expect(body![0]).toMatch(/authorizeOrFail\(/);
  });
});
