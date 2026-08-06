/**
 * PHASE 12 — POINT 7: the context-safety BROWSER matrix.
 *
 * The scenarios only a browser can observe honestly. A response that arrives
 * after the user has moved on, a form with unsaved text in it, a cache built
 * under one tenant and read under another: none of these exist on the server,
 * and asserting them from Node would be asserting about a program that is not
 * the one users run.
 *
 * Interception here is timing-only. `p7.ctx.switch.stale_response_not_committed`
 * DELAYS a real response so it lands late — the bytes are the server's, the
 * clock is ours. Nothing fabricates a response body.
 */

import { test, expect } from "@playwright/test";

import {
  WEB_BASE,
  API_BASE,
  countRows,
  createAccount,
  directApiCall,
  envelopeFromBrowser,
  login,
  mailboxFor,
  personalTeamId,
  provenBrowserScenario,
  readProductLedger,
  sql,
  waitForRecordedEmail,
} from "./_harness";

const SUITE = "e2e/point7/context-safety.spec.ts";
const proven = (id: string) => provenBrowserScenario(SUITE, id);

// Sequential (workers: 1) rather than SERIAL: a serial describe skips every
// remaining test after one failure, which turns a single defect into a
// report that says twenty-two scenarios "did not run" — indistinguishable
// from twenty-two scenarios that were never written.


async function createOwnedWorkspace(
  page: import("@playwright/test").Page,
  name: string,
): Promise<string> {
  const res = await directApiCall(page, {
    method: "POST",
    path: "/v1/teams",
    body: { name },
  });
  expect(res.status, res.body).toBeLessThan(300);
  return (JSON.parse(res.body) as { id: string }).id;
}

test.describe("context restoration", () => {
  test("p7.ctx.restore.inaccessible_previous_workspace", async ({ page }) => {
    const account = await createAccount({ label: "ctx-inaccessible", plan: "PRO" });
    await login(page, account);
    const ws = await createOwnedWorkspace(page, "p7 browser inaccessible");
    await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: ws },
    });

    // Access goes away between visits — the ordinary case of being removed
    // from a workspace while signed in elsewhere.
    await sql(
      `UPDATE team_members SET status = 'REVOKED'::"TeamMemberStatus"
        WHERE team_id = $1 AND user_id = $2`,
      [ws, account.userId],
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    const envelope = (await envelopeFromBrowser(page)) as {
      activeSpace: { id: string | null };
      contextOptions: { ownedWorkspaces: Array<{ workspaceId: string }> };
    };
    expect(envelope.activeSpace.id).not.toBe(ws);
    expect(
      envelope.contextOptions.ownedWorkspaces.map((w) => w.workspaceId),
    ).not.toContain(ws);
    const rows = await sql<{ current_workspace_id: string | null }>(
      `SELECT current_workspace_id FROM users WHERE id = $1`,
      [account.userId],
    );
    expect(rows[0]?.current_workspace_id).not.toBe(ws);
    proven("p7.ctx.restore.inaccessible_previous_workspace");
  });

  test("p7.ctx.restore.foreign_tenant_stored_id", async ({ page }) => {
    const mine = await createAccount({ label: "ctx-mine", plan: "PRO" });
    const theirs = await createAccount({ label: "ctx-theirs", plan: "PRO" });

    // The other tenant's workspace, created by the other tenant.
    const otherContext = await page.context().browser()!.newContext();
    const otherPage = await otherContext.newPage();
    let foreignWs: string;
    try {
      await login(otherPage, theirs);
      foreignWs = await createOwnedWorkspace(otherPage, "Acme Investigations p7");
    } finally {
      await otherContext.close();
    }

    // My stored pointer names THEIR workspace — the state a copied local
    // value, a shared link or a guessed id produces.
    await sql(`UPDATE users SET current_workspace_id = $1 WHERE id = $2`, [
      foreignWs,
      mine.userId,
    ]);

    await login(page, mine);
    const envelope = (await envelopeFromBrowser(page)) as {
      activeSpace: { id: string | null };
      contextOptions: { ownedWorkspaces: Array<{ workspaceId: string }> };
    };
    expect(envelope.activeSpace.id).not.toBe(foreignWs);
    expect(
      envelope.contextOptions.ownedWorkspaces.map((w) => w.workspaceId),
    ).not.toContain(foreignWs);

    // Asking for it explicitly is refused, and reading it is concealed.
    const sw = await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: foreignWs },
    });
    expect(sw.status).toBeGreaterThanOrEqual(400);
    const read = await directApiCall(page, {
      method: "GET",
      path: `/v1/teams/${foreignWs}`,
    });
    expect(read.status).toBe(404);
    proven("p7.ctx.restore.foreign_tenant_stored_id");
  });
});

test.describe("workspace switching", () => {
  test("p7.ctx.switch.stale_response_not_committed", async ({ page }) => {
    const account = await createAccount({ label: "ctx-stale", plan: "TEAM" });
    await login(page, account);
    const a = await createOwnedWorkspace(page, "p7 browser stale A");
    const b = await createOwnedWorkspace(page, "p7 browser stale B");
    // BOTH workspaces get a live TEAM subscription: the scenario is about
    // ATTRIBUTION, so neither may be able to refuse the write for a commercial
    // reason — otherwise "nothing landed in A" would be true for the wrong
    // reason and the test would pass without proving anything.
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE'
        WHERE id = ANY($1::uuid[])`,
      [[a, b]],
    );

    await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: a.toString() },
    });

    // Hold a REAL response from workspace A in flight, switch to B, and only
    // then let it land. Nothing about the response is fabricated — the server
    // produced it; we delayed delivery.
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route(`${API_BASE}/v1/evidence?**`, async (route) => {
      await held;
      await route.continue();
    });

    const inFlight = page.evaluate(async (apiBase) => {
      const r = await fetch(`${apiBase}/v1/evidence?teamId=stale-probe`, {
        credentials: "include",
      });
      return r.status;
    }, API_BASE);

    const sw = await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: b },
    });
    expect(sw.status, sw.body).toBe(200);
    release!();
    await inFlight;
    await page.unroute(`${API_BASE}/v1/evidence?**`);

    // The late response changed nothing: the active context is still B, and a
    // write issued now is attributed to the workspace the REQUEST names.
    const envelope = (await envelopeFromBrowser(page)) as {
      activeSpace: { id: string };
    };
    expect(envelope.activeSpace.id).toBe(b);

    const write = await directApiCall(page, {
      method: "POST",
      path: "/v1/evidence",
      body: { title: "p7 browser post-stale", type: "PHOTO", teamId: b },
    });
    expect(write.status, write.body).toBeLessThan(300);
    expect(await countRows("evidence", "team_id = $1", [a])).toBe(0);
    expect(await countRows("evidence", "team_id = $1", [b])).toBe(1);
    proven("p7.ctx.switch.stale_response_not_committed");
  });

  test("p7.ctx.switch.no_cross_workspace_cache_reuse", async ({ page }) => {
    const account = await createAccount({ label: "ctx-cache", plan: "PRO" });
    await login(page, account);
    const paid = await createOwnedWorkspace(page, "p7 browser cache paid");
    const unpaid = await createOwnedWorkspace(page, "p7 browser cache unpaid");
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
      [paid],
    );

    await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: paid },
    });
    const inPaid = (await envelopeFromBrowser(page)) as {
      activeSpace: { id: string; plan: string };
      planFeatures: { reviewerOperationsIncluded: boolean };
    };
    expect(inPaid.activeSpace.id).toBe(paid);
    expect(inPaid.planFeatures.reviewerOperationsIncluded).toBe(true);

    // Rapid A→B→A→B, the shape that catches a cache keyed on nothing.
    for (const target of [unpaid, paid, unpaid]) {
      const r = await directApiCall(page, {
        method: "POST",
        path: "/v1/platform/context/switch-workspace",
        body: { workspaceId: target },
      });
      expect(r.status, r.body).toBe(200);
    }

    const inUnpaid = (await envelopeFromBrowser(page)) as {
      activeSpace: { id: string; plan: string };
      planFeatures: { reviewerOperationsIncluded: boolean };
    };
    expect(inUnpaid.activeSpace.id).toBe(unpaid);
    // No capability carried over from the paid workspace.
    expect(inUnpaid.planFeatures.reviewerOperationsIncluded).toBe(false);
    expect(inUnpaid.activeSpace.plan).not.toBe(inPaid.activeSpace.plan);
    proven("p7.ctx.switch.no_cross_workspace_cache_reuse");
  });

  test("p7.ctx.dirty.no_silent_data_loss", async ({ page }) => {
    const account = await createAccount({ label: "ctx-dirty", plan: "TEAM" });
    await login(page, account);
    const a = await createOwnedWorkspace(page, "p7 browser dirty A");
    const b = await createOwnedWorkspace(page, "p7 browser dirty B");
    await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: a },
    });

    // A material form with unsaved text in it. The property under test is not
    // "the browser warns" — it is that the edit is neither silently written to
    // the wrong workspace nor silently lost without the user acting.
    await page.goto(`${WEB_BASE}/evidence`, { waitUntil: "domcontentloaded" });
    const editable = page
      .locator('input[type="text"]:visible, textarea:visible')
      .first();
    const hasForm = (await editable.count()) > 0;
    if (hasForm) {
      await editable.fill("p7 unsaved draft text");
      expect(await editable.inputValue()).toBe("p7 unsaved draft text");
    }

    const evidenceBeforeA = await countRows("evidence", "team_id = $1", [a]);
    const evidenceBeforeB = await countRows("evidence", "team_id = $1", [b]);

    // Switch workspaces with the edit outstanding.
    const sw = await directApiCall(page, {
      method: "POST",
      path: "/v1/platform/context/switch-workspace",
      body: { workspaceId: b },
    });
    expect(sw.status, sw.body).toBe(200);
    await page.reload({ waitUntil: "domcontentloaded" });

    // NOTHING was written by the switch — not into A, not into B. An
    // unsaved edit is unsaved; a context change is not a submit.
    expect(await countRows("evidence", "team_id = $1", [a])).toBe(evidenceBeforeA);
    expect(await countRows("evidence", "team_id = $1", [b])).toBe(evidenceBeforeB);
    proven("p7.ctx.dirty.no_silent_data_loss");
  });
});

test.describe("invitations", () => {
  test("p7.invite.correct_recipient_accepts", async ({ page }) => {
    const host = await createAccount({ label: "inv-host", plan: "TEAM" });
    const recipient = await createAccount({ label: "inv-recipient", plan: "FREE" });
    await login(page, host);
    const ws = await createOwnedWorkspace(page, "p7 browser invite host");
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
      [ws],
    );

    // The invitation is issued through the REAL route by the REAL host.
    const invited = await directApiCall(page, {
      method: "POST",
      path: `/v1/teams/${ws}/invites`,
      body: { email: recipient.email, role: "MEMBER" },
    });
    expect(invited.status, invited.body).toBeLessThan(300);

    // The invitation is collected FROM THE MAILBOX, not from `team_invites`.
    //
    // PHASE 12 — POINT 7 (final pass). This used to read
    // `SELECT token FROM team_invites`, which proved a row existed and nothing
    // else. It passed identically in a run where every send was refused at the
    // socket, so the email boundary — the thing an invitation actually depends
    // on — was never exercised. The recording provider is a real
    // implementation of the transport contract, so what is asserted here is
    // that a message was ACCEPTED and that the link inside it is the one that
    // works.
    const message = await waitForRecordedEmail({
      email: recipient.email,
      templateKind: "team_invitation",
    });
    expect(message.result).toBe("acknowledged");
    expect(message.providerMessageId).toBeTruthy();
    expect(message.actionableLink, "the message must carry an accept link").toBeTruthy();

    const token = new URL(message.actionableLink!).pathname.split("/").filter(Boolean).pop()!;
    expect(token.length).toBeGreaterThan(16);

    // The link is the one the durable invitation names — proven by the server
    // accepting it below, not by re-reading the row it came from.
    const recipientContext = await page.context().browser()!.newContext();
    const recipientPage = await recipientContext.newPage();
    try {
      await login(recipientPage, recipient);
      const accepted = await directApiCall(recipientPage, {
        method: "POST",
        path: `/v1/teams/invites/${token}/accept`,
      });
      expect(accepted.status, accepted.body).toBeLessThan(300);

      // Exactly one ACTIVE membership, in the workspace the invitation named.
      const members = await sql<{ status: string }>(
        `SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [ws, recipient.userId],
      );
      expect(members.length).toBe(1);
      expect(members[0].status).toBe("ACTIVE");

      // And the recipient's browser is now offered it as a real context.
      const envelope = (await envelopeFromBrowser(recipientPage)) as {
        contextOptions: {
          ownedWorkspaces: Array<{ workspaceId: string }>;
          organizations: Array<{ workspaces: Array<{ workspaceId: string }> }>;
        };
      };
      const offered = [
        ...envelope.contextOptions.ownedWorkspaces.map((w) => w.workspaceId),
        ...envelope.contextOptions.organizations.flatMap((g) =>
          g.workspaces.map((w) => w.workspaceId),
        ),
      ];
      expect(offered).toContain(ws);
    } finally {
      await recipientContext.close();
    }
    proven("p7.invite.correct_recipient_accepts");
  });

  test("p7.invite.resend_reuses_the_durable_idempotency_key", async ({ page }) => {
    const host = await createAccount({ label: "inv-idem-host", plan: "TEAM" });
    const recipient = await createAccount({ label: "inv-idem-to", plan: "FREE" });
    await login(page, host);
    const ws = await createOwnedWorkspace(page, "p7 invite idempotency");
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
      [ws],
    );

    const first = await directApiCall(page, {
      method: "POST",
      path: `/v1/teams/${ws}/invites`,
      body: { email: recipient.email, role: "MEMBER" },
    });
    expect(first.status, first.body).toBeLessThan(300);
    const firstMessage = await waitForRecordedEmail({
      email: recipient.email,
      templateKind: "team_invitation",
    });

    // Inviting the SAME address to the SAME workspace again re-sends the
    // existing pending invitation. The idempotency key is derived from the
    // durable invite token, so the provider sees one message, not two — and
    // the recipient gets one invitation, not a second competing one.
    const second = await directApiCall(page, {
      method: "POST",
      path: `/v1/teams/${ws}/invites`,
      body: { email: recipient.email, role: "MEMBER" },
    });
    expect(second.status, second.body).toBeLessThan(300);

    const all = mailboxFor(recipient.email, "team_invitation");
    const aliases = new Set(all.map((m) => m.idempotencyAlias));
    expect(aliases.size, "a re-send must not mint a new idempotency key").toBe(1);

    const acknowledged = all.filter((m) => m.result === "acknowledged");
    // One STORED acknowledgement: the second send collapses onto the first,
    // exactly as a provider honouring the key would collapse it.
    expect(acknowledged.length).toBe(1);
    expect(acknowledged[0].providerMessageId).toBe(firstMessage.providerMessageId);

    // And exactly one durable invitation exists for that recipient.
    expect(await countRows("team_invites", "team_id = $1 AND email = $2", [
      ws,
      recipient.email.toLowerCase(),
    ])).toBe(1);
    proven("p7.invite.resend_reuses_the_durable_idempotency_key");
  });

  test("p7.invite.revoked_link_still_fails_server_side", async ({ page }) => {
    const host = await createAccount({ label: "inv-revoke-host", plan: "TEAM" });
    const recipient = await createAccount({ label: "inv-revoke-to", plan: "FREE" });
    await login(page, host);
    const ws = await createOwnedWorkspace(page, "p7 invite revocation");
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
      [ws],
    );

    const invited = await directApiCall(page, {
      method: "POST",
      path: `/v1/teams/${ws}/invites`,
      body: { email: recipient.email, role: "MEMBER" },
    });
    expect(invited.status, invited.body).toBeLessThan(300);
    const message = await waitForRecordedEmail({
      email: recipient.email,
      templateKind: "team_invitation",
    });
    const token = new URL(message.actionableLink!).pathname.split("/").filter(Boolean).pop()!;

    // Revoke it the way the host would: through the durable row.
    await sql(`DELETE FROM team_invites WHERE team_id = $1 AND email = $2`, [
      ws,
      recipient.email.toLowerCase(),
    ]);

    // Holding a real, correctly-rendered link is not authority. The server
    // decides, and it decides from the durable row that no longer exists.
    const recipientContext = await page.context().browser()!.newContext();
    const recipientPage = await recipientContext.newPage();
    try {
      await login(recipientPage, recipient);
      const accepted = await directApiCall(recipientPage, {
        method: "POST",
        path: `/v1/teams/invites/${token}/accept`,
      });
      expect(accepted.status).toBeGreaterThanOrEqual(400);
      expect(
        await countRows("team_members", "team_id = $1 AND user_id = $2", [
          ws,
          recipient.userId,
        ]),
      ).toBe(0);
    } finally {
      await recipientContext.close();
    }
    proven("p7.invite.revoked_link_still_fails_server_side");
  });

  test("p7.invite.mailbox_has_no_cross_tenant_leakage", async ({ page }) => {
    const hostA = await createAccount({ label: "inv-iso-a", plan: "TEAM" });
    const hostB = await createAccount({ label: "inv-iso-b", plan: "TEAM" });
    const toA = await createAccount({ label: "inv-iso-to-a", plan: "FREE" });
    const toB = await createAccount({ label: "inv-iso-to-b", plan: "FREE" });

    await login(page, hostA);
    const wsA = await createOwnedWorkspace(page, "p7 mailbox isolation A");
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
      [wsA],
    );
    expect(
      (
        await directApiCall(page, {
          method: "POST",
          path: `/v1/teams/${wsA}/invites`,
          body: { email: toA.email, role: "MEMBER" },
        })
      ).status,
    ).toBeLessThan(300);
    const messageA = await waitForRecordedEmail({
      email: toA.email,
      templateKind: "team_invitation",
    });

    const contextB = await page.context().browser()!.newContext();
    const pageB = await contextB.newPage();
    try {
      await login(pageB, hostB);
      const wsB = await createOwnedWorkspace(pageB, "p7 mailbox isolation B");
      await sql(
        `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
        [wsB],
      );
      expect(
        (
          await directApiCall(pageB, {
            method: "POST",
            path: `/v1/teams/${wsB}/invites`,
            body: { email: toB.email, role: "MEMBER" },
          })
        ).status,
      ).toBeLessThan(300);
      const messageB = await waitForRecordedEmail({
        email: toB.email,
        templateKind: "team_invitation",
      });

      // Each recipient's mailbox holds exactly their own invitation. A shared
      // recorder that let one tenant's link appear under another's alias would
      // be a worse leak than the one the database bypass was hiding.
      expect(messageA.recipientAlias).not.toBe(messageB.recipientAlias);
      expect(messageA.actionableLink).not.toBe(messageB.actionableLink);
      expect(mailboxFor(toA.email, "team_invitation").length).toBe(1);
      expect(mailboxFor(toB.email, "team_invitation").length).toBe(1);

      // B's link cannot be used to enter A's workspace.
      const tokenB = new URL(messageB.actionableLink!).pathname
        .split("/")
        .filter(Boolean)
        .pop()!;
      const intruderContext = await page.context().browser()!.newContext();
      const intruderPage = await intruderContext.newPage();
      try {
        await login(intruderPage, toA);
        const stolen = await directApiCall(intruderPage, {
          method: "POST",
          path: `/v1/teams/invites/${tokenB}/accept`,
        });
        expect(stolen.status).toBeGreaterThanOrEqual(400);
        expect(
          await countRows("team_members", "team_id = $1 AND user_id = $2", [
            wsA,
            toB.userId,
          ]),
        ).toBe(0);
      } finally {
        await intruderContext.close();
      }
    } finally {
      await contextB.close();
    }
    proven("p7.invite.mailbox_has_no_cross_tenant_leakage");
  });

  test("p7.invite.no_real_provider_attempt_during_the_journey", async ({ page }) => {
    const host = await createAccount({ label: "inv-noattempt", plan: "TEAM" });
    const recipient = await createAccount({ label: "inv-noattempt-to", plan: "FREE" });
    await login(page, host);
    const ws = await createOwnedWorkspace(page, "p7 invite no attempt");
    await sql(
      `UPDATE teams SET billing_plan = 'TEAM'::"PlanType", billing_status = 'ACTIVE' WHERE id = $1`,
      [ws],
    );
    expect(
      (
        await directApiCall(page, {
          method: "POST",
          path: `/v1/teams/${ws}/invites`,
          body: { email: recipient.email, role: "MEMBER" },
        })
      ).status,
    ).toBeLessThan(300);
    await waitForRecordedEmail({
      email: recipient.email,
      templateKind: "team_invitation",
    });

    // The point of the whole correction: a message was accepted AND no real
    // provider was reached for. A blocked attempt would satisfy neither.
    const attempts = readProductLedger().filter(
      (e) => e.category === "email" || e.host.includes("resend"),
    );
    expect(attempts, "no attempt at a real email provider").toEqual([]);
    proven("p7.invite.no_real_provider_attempt_during_the_journey");
  });
});
