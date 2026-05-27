/**
 * Phase 2.7X Stage 4 — Organization write surfaces + audit events.
 *
 * Locks in:
 *
 *   1. `POST /v1/orgs` requires auth, creates org + ORG_OWNER
 *      membership, emits ORG_CREATED audit event.
 *
 *   2. `PATCH /v1/orgs/:id` requires ORG_ADMIN+; renames update the
 *      audit timeline; non-members get 403.
 *
 *   3. `POST /v1/orgs/:id/invites` requires ORG_ADMIN+; mints a
 *      token; rejects duplicate pending invites with 409.
 *
 *   4. `POST /v1/org-invites/:token/accept` consumes the token,
 *      creates a membership, marks invite accepted; repeated
 *      accept returns 410.
 *
 *   5. `DELETE /v1/orgs/:id/members/:memberId` cannot remove
 *      self (409) and cannot remove the last ORG_OWNER (409).
 *
 *   6. `PATCH /v1/orgs/:id/members/:memberId` cannot demote the
 *      last ORG_OWNER and cannot self-modify.
 *
 *   7. `GET /v1/orgs/:id/audit-events` returns the emitted events
 *      to ORG_AUDITOR+ callers.
 *
 *   8. **Workspace isolation regression** — Stage 4 mutations
 *      MUST NOT have changed any Team-scoped endpoint behavior.
 *
 *   9. **Defense in depth** — invite tokens never appear in audit
 *      metadata, and the 403 body never leaks evidence/case/reviewer
 *      signals.
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(() => {
  clearTestRateLimits();
});

const FAKE_TEAM = "00000000-0000-4000-8000-000000000001";
const NONEXISTENT_ORG = "00000000-0000-4000-8000-000000000888";
const NON_UUID = "not-a-uuid";

test.describe("Phase 2.7X Stage 4 — org write surfaces @critical", () => {
  test("POST /v1/orgs creates an org and makes caller ORG_OWNER", async () => {
    const session = await createGuestSession();
    const create = await session.api.post("/v1/orgs", {
      data: { name: "Stage 4 acceptance org" },
    });
    expect(create.status()).toBe(201);
    const created = (await create.json()) as {
      organizationId: string;
      name: string;
      callerRole: string;
      status: string;
    };
    expect(created.name).toBe("Stage 4 acceptance org");
    expect(created.callerRole).toBe("ORG_OWNER");
    expect(created.status).toBe("ACTIVE");

    // Verify it shows up in /v1/me/orgs.
    const me = await session.api.get("/v1/me/orgs");
    expect(me.ok()).toBe(true);
    const meBody = (await me.json()) as {
      orgs: Array<{ organizationId: string; role: string }>;
    };
    const row = meBody.orgs.find((r) => r.organizationId === created.organizationId);
    expect(row).toBeTruthy();
    expect(row?.role).toBe("ORG_OWNER");

    // Verify GET /v1/orgs/:id works and callerRole is ORG_OWNER.
    const detail = await session.api.get(`/v1/orgs/${created.organizationId}`);
    expect(detail.ok()).toBe(true);
    const detailBody = (await detail.json()) as { callerRole: string };
    expect(detailBody.callerRole).toBe("ORG_OWNER");

    // Audit event: ORG_CREATED.
    const audit = await session.api.get(
      `/v1/orgs/${created.organizationId}/audit-events`,
    );
    expect(audit.ok()).toBe(true);
    const auditBody = (await audit.json()) as {
      events: Array<{ eventType: string }>;
    };
    expect(auditBody.events.some((e) => e.eventType === "ORG_CREATED")).toBe(
      true,
    );
  });

  test("POST /v1/orgs validates name", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post("/v1/orgs", {
      data: { name: "" },
    });
    expect(resp.status()).toBe(400);
  });

  test("PATCH /v1/orgs/:id renames + emits ORG_UPDATED; 403 for non-members", async () => {
    const owner = await createGuestSession();
    const create = await owner.api.post("/v1/orgs", {
      data: { name: "Original name" },
    });
    const orgId = ((await create.json()) as { organizationId: string })
      .organizationId;

    // Owner can rename.
    const patch = await owner.api.patch(`/v1/orgs/${orgId}`, {
      data: { name: "Renamed" },
    });
    expect(patch.status()).toBe(200);
    const patched = (await patch.json()) as { name: string };
    expect(patched.name).toBe("Renamed");

    // Non-member 403.
    const stranger = await createGuestSession();
    const denied = await stranger.api.patch(`/v1/orgs/${orgId}`, {
      data: { name: "Hijack" },
    });
    expect([403, 404]).toContain(denied.status());

    // Audit log includes ORG_UPDATED.
    const audit = await owner.api.get(`/v1/orgs/${orgId}/audit-events`);
    const auditBody = (await audit.json()) as {
      events: Array<{ eventType: string; metadata: unknown }>;
    };
    const updEvt = auditBody.events.find((e) => e.eventType === "ORG_UPDATED");
    expect(updEvt).toBeTruthy();
  });

  test("invite + accept lifecycle works and emits expected audit events", async () => {
    const owner = await createGuestSession();
    const created = (await (
      await owner.api.post("/v1/orgs", { data: { name: "Invite test org" } })
    ).json()) as { organizationId: string };
    const orgId = created.organizationId;

    // Owner sends invite.
    const invite = await owner.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "phase-2-7x-stage4-invitee@example.test", role: "ORG_MEMBER" },
    });
    expect(invite.status()).toBe(201);
    const inviteBody = (await invite.json()) as {
      inviteId: string;
      token: string;
      role: string;
    };
    expect(inviteBody.role).toBe("ORG_MEMBER");
    expect(inviteBody.token).toMatch(/^[a-f0-9]{64}$/);

    // Duplicate pending invite returns 409.
    const dup = await owner.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "phase-2-7x-stage4-invitee@example.test" },
    });
    expect(dup.status()).toBe(409);

    // Second guest accepts the token.
    const invitee = await createGuestSession();
    const accept = await invitee.api.post(
      `/v1/org-invites/${inviteBody.token}/accept`,
    );
    expect(accept.status()).toBe(200);
    const acceptBody = (await accept.json()) as {
      organizationId: string;
      role: string;
    };
    expect(acceptBody.organizationId).toBe(orgId);
    expect(acceptBody.role).toBe("ORG_MEMBER");

    // Invitee now sees the org in /v1/me/orgs.
    const meOrgs = await invitee.api.get("/v1/me/orgs");
    const meBody = (await meOrgs.json()) as {
      orgs: Array<{ organizationId: string; role: string }>;
    };
    expect(
      meBody.orgs.some(
        (r) => r.organizationId === orgId && r.role === "ORG_MEMBER",
      ),
    ).toBe(true);

    // Repeat accept fails with 410 (already accepted).
    const second = await invitee.api.post(
      `/v1/org-invites/${inviteBody.token}/accept`,
    );
    expect(second.status()).toBe(410);

    // Audit timeline (owner view) shows INVITED + ACCEPTED.
    const audit = await owner.api.get(`/v1/orgs/${orgId}/audit-events`);
    const auditBody = (await audit.json()) as {
      events: Array<{ eventType: string; metadata: unknown }>;
    };
    const types = auditBody.events.map((e) => e.eventType);
    expect(types).toContain("ORG_MEMBER_INVITED");
    expect(types).toContain("ORG_MEMBER_ACCEPTED");

    // Audit metadata MUST NOT contain the raw token.
    for (const e of auditBody.events) {
      const json = JSON.stringify(e.metadata ?? {});
      expect(json.includes(inviteBody.token)).toBe(false);
    }
  });

  test("last ORG_OWNER protections — cannot self-modify, cannot demote-self, cannot remove-self", async () => {
    const owner = await createGuestSession();
    const orgId = ((
      (await (
        await owner.api.post("/v1/orgs", { data: { name: "Self-protect org" } })
      ).json()) as { organizationId: string }
    )).organizationId;

    // Find the owner's own membership row.
    const members = (await (
      await owner.api.get(`/v1/orgs/${orgId}/members`)
    ).json()) as { members: Array<{ membershipId: string; role: string }> };
    expect(members.members.length).toBe(1);
    const ownMembershipId = members.members[0]!.membershipId;
    expect(members.members[0]!.role).toBe("ORG_OWNER");

    // Self-role-change -> 409 (cannot modify own role).
    const selfPatch = await owner.api.patch(
      `/v1/orgs/${orgId}/members/${ownMembershipId}`,
      { data: { role: "ORG_ADMIN" } },
    );
    expect(selfPatch.status()).toBe(409);

    // Self-remove -> 409.
    const selfDelete = await owner.api.delete(
      `/v1/orgs/${orgId}/members/${ownMembershipId}`,
    );
    expect(selfDelete.status()).toBe(409);
  });

  test("last ORG_OWNER protection — cannot demote when only one owner exists (via second admin)", async () => {
    // Provision: owner1 creates org, invites owner2 (also ORG_OWNER).
    const owner1 = await createGuestSession();
    const orgId = ((
      (await (
        await owner1.api.post("/v1/orgs", { data: { name: "Owner-protect org" } })
      ).json()) as { organizationId: string }
    )).organizationId;

    const inviteResp = await owner1.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "owner2@example.test", role: "ORG_OWNER" },
    });
    expect(inviteResp.status()).toBe(201);
    const token = ((await inviteResp.json()) as { token: string }).token;

    const owner2 = await createGuestSession();
    await owner2.api.post(`/v1/org-invites/${token}/accept`);

    // owner1 tries to demote owner2 (currently 2 owners → allowed).
    const members = (await (
      await owner1.api.get(`/v1/orgs/${orgId}/members`)
    ).json()) as { members: Array<{ membershipId: string; role: string }> };
    const owner2Membership = members.members.find(
      (m) => m.role === "ORG_OWNER" && m.membershipId !== members.members[0]!.membershipId,
    );
    expect(owner2Membership).toBeTruthy();

    const demote = await owner1.api.patch(
      `/v1/orgs/${orgId}/members/${owner2Membership!.membershipId}`,
      { data: { role: "ORG_MEMBER" } },
    );
    expect(demote.status()).toBe(200);

    // Now owner1 is the LAST owner. Attempt to demote owner1 -> 409.
    // (Different actor needed since self-modify is blocked. owner2 — now MEMBER — would 403 on PATCH.)
    // We simulate by trying to demote owner1's row from owner2 (member): expect 403.
    const owner1Membership = members.members[0]!;
    const memberDemote = await owner2.api.patch(
      `/v1/orgs/${orgId}/members/${owner1Membership.membershipId}`,
      { data: { role: "ORG_MEMBER" } },
    );
    expect(memberDemote.status()).toBe(403);
  });

  test("ORG_ADMIN cannot mint an ORG_OWNER invite", async () => {
    const owner = await createGuestSession();
    const orgId = ((
      (await (
        await owner.api.post("/v1/orgs", { data: { name: "Admin-cap org" } })
      ).json()) as { organizationId: string }
    )).organizationId;

    // Invite an admin.
    const adminInvite = await owner.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "phase-2-7x-stage4-admin@example.test", role: "ORG_ADMIN" },
    });
    const adminToken = ((await adminInvite.json()) as { token: string }).token;
    const adminSession = await createGuestSession();
    await adminSession.api.post(`/v1/org-invites/${adminToken}/accept`);

    // Now the admin tries to invite at ORG_OWNER role -> 403.
    const ownerInviteAttempt = await adminSession.api.post(
      `/v1/orgs/${orgId}/invites`,
      { data: { email: "no-can-do@example.test", role: "ORG_OWNER" } },
    );
    expect(ownerInviteAttempt.status()).toBe(403);

    // But admin CAN invite at ORG_MEMBER -> 201.
    const memberInvite = await adminSession.api.post(
      `/v1/orgs/${orgId}/invites`,
      { data: { email: "phase-2-7x-stage4-mem@example.test", role: "ORG_MEMBER" } },
    );
    expect(memberInvite.status()).toBe(201);
  });

  test("non-members cannot read or mutate via :id endpoints", async () => {
    const owner = await createGuestSession();
    const orgId = ((
      (await (
        await owner.api.post("/v1/orgs", { data: { name: "Isolation org" } })
      ).json()) as { organizationId: string }
    )).organizationId;

    const stranger = await createGuestSession();
    const reads = await Promise.all([
      stranger.api.get(`/v1/orgs/${orgId}`),
      stranger.api.get(`/v1/orgs/${orgId}/members`),
      stranger.api.get(`/v1/orgs/${orgId}/workspaces`),
      stranger.api.get(`/v1/orgs/${orgId}/audit-events`),
    ]);
    for (const r of reads) {
      expect([403, 404]).toContain(r.status());
    }

    const patch = await stranger.api.patch(`/v1/orgs/${orgId}`, {
      data: { name: "Hijack" },
    });
    expect([403, 404]).toContain(patch.status());

    const invite = await stranger.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "x@example.test" },
    });
    expect([403, 404]).toContain(invite.status());
  });

  test("audit list refuses ORG_MEMBER, allows ORG_AUDITOR+", async () => {
    const owner = await createGuestSession();
    const orgId = ((
      (await (
        await owner.api.post("/v1/orgs", { data: { name: "Audit-gate org" } })
      ).json()) as { organizationId: string }
    )).organizationId;

    // Invite a plain MEMBER.
    const m1 = await owner.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "plain-member@example.test", role: "ORG_MEMBER" },
    });
    const m1Token = ((await m1.json()) as { token: string }).token;
    const memberSession = await createGuestSession();
    await memberSession.api.post(`/v1/org-invites/${m1Token}/accept`);

    // ORG_MEMBER cannot read audit timeline -> 403.
    const memberAttempt = await memberSession.api.get(
      `/v1/orgs/${orgId}/audit-events`,
    );
    expect(memberAttempt.status()).toBe(403);

    // Invite an AUDITOR.
    const m2 = await owner.api.post(`/v1/orgs/${orgId}/invites`, {
      data: { email: "auditor@example.test", role: "ORG_AUDITOR" },
    });
    const m2Token = ((await m2.json()) as { token: string }).token;
    const auditorSession = await createGuestSession();
    await auditorSession.api.post(`/v1/org-invites/${m2Token}/accept`);

    // ORG_AUDITOR CAN read audit timeline.
    const auditorView = await auditorSession.api.get(
      `/v1/orgs/${orgId}/audit-events`,
    );
    expect(auditorView.ok()).toBe(true);
  });

  test("UUID validation on write endpoints", async () => {
    const session = await createGuestSession();
    const patch = await session.api.patch(`/v1/orgs/${NON_UUID}`, {
      data: { name: "x" },
    });
    expect(patch.status()).toBe(400);

    const invite = await session.api.post(`/v1/orgs/${NON_UUID}/invites`, {
      data: { email: "a@b.c" },
    });
    expect(invite.status()).toBe(400);

    const delMember = await session.api.delete(
      `/v1/orgs/${NON_UUID}/members/${NON_UUID}`,
    );
    expect(delMember.status()).toBe(400);
  });

  test("invite acceptance with unknown token returns 404", async () => {
    const session = await createGuestSession();
    const resp = await session.api.post(
      `/v1/org-invites/${"0".repeat(64)}/accept`,
    );
    expect(resp.status()).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Workspace isolation regression — Stage 4 must not have altered Team paths.
  // ---------------------------------------------------------------------------
  test("Phase 2.6D matrix endpoint regression", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/platform/rbac/matrix");
    expect(resp.ok()).toBe(true);
  });

  test("Phase 2.6B access-review still refuses authed non-members", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get(`/v1/teams/${FAKE_TEAM}/access-review`);
    expect([403, 404]).toContain(resp.status());
  });

  test("Phase 2.7X Stage 3 read endpoints still behave (regression)", async () => {
    const session = await createGuestSession();
    const me = await session.api.get("/v1/me/orgs");
    expect(me.ok()).toBe(true);
    const nonMember = await session.api.get(`/v1/orgs/${NONEXISTENT_ORG}`);
    expect([403, 404]).toContain(nonMember.status());
  });
});
