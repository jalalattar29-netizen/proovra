/**
 * A caller's input mistake is answered as one, never as a 500 with an
 * operational alert (live PostgreSQL).
 *
 *   AUD-0052  a malformed member id on the Collaboration Team member routes
 *             (empty or not a UUID) reached the lookup and answered 500
 *   AUD-0029  saving or renaming a case (SIU) view onto a name the person
 *             already used hit the unique constraint and answered 500 with a
 *             critical alert
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("input errors are answered, not escalated (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const call = (method: "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "x-proovra-workspace-id": h.fixtures.teamA.teamId },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });

  it("AUD-0052 — a malformed member id is a 400, on PATCH and DELETE", async () => {
    const A = h.fixtures.teamA;
    await prisma.collaborationTeam.updateMany({
      where: { workspaceId: A.teamId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
    const group = await ct.createCollaborationTeam({ workspaceId: A.teamId, actorUserId: A.ownerUserId, name: `input ${randomUUID().slice(0, 8)}` });
    for (const [method, memberId, payload] of [
      ["PATCH", "not-a-uuid", { role: "MEMBER" }],
      ["DELETE", "not-a-uuid", undefined],
      ["PATCH", "123", { role: "MEMBER" }],
    ] as const) {
      const res = await call(method, `/v1/collaboration-teams/${group.id}/members/${memberId}`, A.ownerToken, payload);
      expect(res.statusCode, `${method} ${memberId}: ${res.body}`).toBe(400);
      expect(res.json().error.code).toBe("invalid_member_id");
    }
    // Control: a well-formed id that is not a member is still the route's own answer, not a 400.
    const missing = await call("DELETE", `/v1/collaboration-teams/${group.id}/members/${randomUUID()}`, A.ownerToken);
    expect(missing.statusCode).not.toBe(400);
    expect(missing.statusCode).toBeLessThan(500);
  });

  it("AUD-0029 — a duplicate saved view name is a 409 on save and on rename; the first view is kept", async () => {
    const A = h.fixtures.teamA;
    const name = `SIU dup ${randomUUID().slice(0, 8)}`;
    const body = (n: string) => ({
      teamId: A.teamId,
      name: n,
      filter: { investigationStatus: ["review"] },
      sort: { key: "updatedAtUtc", direction: "desc" },
      visibility: "private",
    });
    const first = await call("POST", "/v1/siu/saved-views", A.memberToken, body(name));
    expect(first.statusCode, first.body).toBe(201);
    const dup = await call("POST", "/v1/siu/saved-views", A.memberToken, body(name));
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().error.code).toBe("saved_view_name_taken");

    const other = await call("POST", "/v1/siu/saved-views", A.memberToken, body(`${name} b`));
    expect(other.statusCode, other.body).toBe(201);
    const otherId = (other.json() as { view: { id: string } }).view.id;
    const rename = await call("PATCH", `/v1/siu/saved-views/${otherId}?teamId=${A.teamId}`, A.memberToken, { name });
    expect(rename.statusCode, rename.body).toBe(409);
    expect(rename.json().error.code).toBe("saved_view_name_taken");
    expect(await prisma.caseSiuSavedView.count({ where: { teamId: A.teamId, name } })).toBe(1);
  });
});
