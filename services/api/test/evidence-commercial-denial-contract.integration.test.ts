/**
 * ONE COMMERCIAL REFUSAL, TWO ENTRY POINTS, AGAINST LIVE POSTGRESQL 16.
 *
 * THE DEFECT THIS PINS
 * ---------------------------------------------------------------------------
 * Reported from production on 2026-09-05 (support id cd2f011d-…): a
 * contributor opened an External Intake link, accepted the consent, chose a
 * file and was told "We hit a problem on our side. Please try again in a
 * moment."
 *
 * Nothing was wrong on our side. The receiving workspace had used every
 * evidence record its plan includes, and `assertWorkspaceAllowsEvidenceCreation`
 * refused — correctly, and in the canonical way: a `DomainError` carrying
 * httpStatus 409, publicCode EVIDENCE_RECORD_LIMIT_REACHED and
 * `reportability: "EXPECTED_DENIAL"`.
 *
 * The SAME refusal, raised by the SAME authority from the SAME `createEvidence`
 * call, reached authenticated Capture as a 409 with that code, because nothing
 * intercepted it and the central error handler answered it from its own
 * declaration. The public intake route's catch-all got there first and
 * flattened it to 500 INTERNAL_ERROR — so a deliberate commercial decision
 * became a false server fault, a false 5xx, a false infrastructure alert, and
 * the bounded reason was discarded at the boundary.
 *
 * WHY BOTH HALVES ARE IN ONE SUITE
 * ---------------------------------------------------------------------------
 * The bug was never in either path alone; it was in the two paths DISAGREEING
 * about the same error. Proving them separately would let them drift apart
 * again. One workspace, one commercial state, both entry points, in that order.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * The booted production app, the real entitlement row, the real record count,
 * the real creation gate, the real intake-link creation route and the real
 * unauthenticated public intake endpoints — bootstrap, consent, part creation.
 * Nothing about the commercial decision is stubbed: the workspace genuinely
 * holds its plan's full allowance.
 *
 * WHAT IS NOT COVERED HERE, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * Byte upload, hashing, signing and submit are not exercised — they run after
 * the decision this suite is about, and the end-to-end journey is proven
 * separately against the local fixture stack. This suite owns the ERROR
 * CONTRACT, not the integrity envelope.
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

/** The published PRO lifetime allowance. Read from the catalog, never typed in. */
let PRO_RECORD_CAP: number;

describe("EVIDENCE — commercial denial contract across creation flows", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let tenant: PersonalTenant;

  const inject = (opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    payload?: unknown;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  /** Records the enforcement gate counts for this tenant, by its own predicate. */
  const heldRecords = async () =>
    prisma.evidence.count({
      where: {
        ownerUserId: tenant.owner.userId,
        deletedAt: null,
        lifecycleState: { not: "DESTROYED" },
        OR: [{ teamId: null }, { teamId: tenant.personalTeamId }],
      },
    });

  /**
   * Hold exactly `count` records.
   *
   * Seeded directly: the interesting states are "one below the cap" and "at
   * the cap", and driving a hundred full creation requests to reach them would
   * buy no coverage the two interesting requests do not already give.
   */
  async function holdExactly(count: number) {
    const have = await heldRecords();
    if (have < count) {
      await prisma.evidence.createMany({
        data: Array.from({ length: count - have }, () => ({
          ownerUserId: tenant.owner.userId,
          teamId: tenant.personalTeamId,
          organizationId: tenant.personalOrganizationId,
          type: "PHOTO" as const,
        })),
      });
    } else if (have > count) {
      const excess = await prisma.evidence.findMany({
        where: { ownerUserId: tenant.owner.userId, deletedAt: null },
        select: { id: true },
        take: have - count,
        orderBy: { createdAt: "desc" },
      });
      await prisma.evidence.updateMany({
        where: { id: { in: excess.map((e) => e.id) } },
        data: { deletedAt: new Date() },
      });
    }
    expect(await heldRecords()).toBe(count);
  }

  /** Create an intake link on the tenant's own workspace, through the real route. */
  async function createIntakeLink(): Promise<string> {
    const res = await inject({
      method: "POST",
      url: "/v1/workflow/intake-links",
      token: tenant.owner.token,
      payload: {
        teamId: tenant.personalTeamId,
        workflowTemplateSlug: "compliance-audit",
        intakeMode: "EXTERNAL_REUSABLE",
        recipientLabel: "Contract regression",
        expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (JSON.parse(res.body) as { rawToken: string }).rawToken;
  }

  /**
   * Walk the contributor's journey as far as part creation — unauthenticated,
   * exactly as the public page does — and return that final response.
   */
  async function contributorReachesPartCreation(rawToken: string) {
    const boot = await inject({
      method: "GET",
      url: `/v1/external-intake/${encodeURIComponent(rawToken)}`,
    });
    expect(boot.statusCode, boot.body).toBe(200);
    const opened = JSON.parse(boot.body) as {
      session: { id: string };
      link: { consentPolicyVersion: string | null; consentDisclosureText: string | null };
    };

    const consent = await inject({
      method: "POST",
      url: `/v1/external-intake/${encodeURIComponent(rawToken)}/sessions/${opened.session.id}/consent`,
      payload: {
        consent: {
          acceptedAtUtc: new Date().toISOString(),
          policyVersion: opened.link.consentPolicyVersion || "v1",
          disclosureTextHash: createHash("sha256")
            .update(opened.link.consentDisclosureText ?? "")
            .digest("hex"),
          termsAcknowledged: true,
          identityDisclosed: true,
          ipHash: null,
          userAgent: null,
        },
      },
    });
    expect(consent.statusCode, consent.body).toBe(200);

    const body = Buffer.from(`regression-${randomUUID()}`);
    return inject({
      method: "POST",
      url: `/v1/external-intake/${encodeURIComponent(rawToken)}/sessions/${opened.session.id}/parts`,
      payload: {
        partIndex: 0,
        mimeType: "text/plain",
        originalFileName: "contribution.txt",
        checksumSha256Base64: createHash("sha256").update(body).digest("base64"),
        webkitRelativePath: null,
      },
    });
  }

  beforeAll(async () => {
    /*
     * The intake feature is off unless configured, and its token secret must be
     * at least 32 characters. Set BEFORE the app boots; both are read from the
     * environment on every call, and neither is a credential — the secret is a
     * throwaway HMAC key for tokens this suite mints and discards.
     */
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ??
      "integration-only-intake-secret-0123456789abcdef";

    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    const { getPlanCapabilities } = await import("@proovra/shared-billing");
    PRO_RECORD_CAP = getPlanCapabilities("PRO").maxEvidenceRecords!;
    expect(
      typeof PRO_RECORD_CAP === "number" && PRO_RECORD_CAP > 0,
      "PRO must publish a lifetime record allowance for this suite to mean anything",
    ).toBe(true);

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `ecdc-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };

    tenant = await seedPersonalTenant(deps, "PRO");
  });

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // =========================================================================
  // UNDER THE LIMIT — both entry points work, and this is the control.
  // =========================================================================
  describe("under the limit", () => {
    beforeAll(async () => {
      await holdExactly(PRO_RECORD_CAP - 1);
    });

    it("authenticated Capture creates the record", async () => {
      const before = await heldRecords();
      const res = await inject({
        method: "POST",
        url: "/v1/evidence",
        token: tenant.owner.token,
        payload: { type: "DOCUMENT", teamId: tenant.personalTeamId, mimeType: "text/plain" },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(await heldRecords()).toBe(before + 1);
    });

    it("External Intake creates the part and returns an upload target", async () => {
      // The record the Capture case just created is the tenant's last one, so
      // the intake case gets its own slot rather than inheriting a full
      // workspace and proving nothing.
      await holdExactly(PRO_RECORD_CAP - 1);
      const res = await contributorReachesPartCreation(await createIntakeLink());
      expect(res.statusCode, res.body).toBe(201);
      const body = JSON.parse(res.body) as { upload?: { putUrl?: string } };
      expect(typeof body.upload?.putUrl).toBe("string");
    });
  });

  // =========================================================================
  // AT THE LIMIT — the refusal is the same decision, told two ways.
  // =========================================================================
  describe("at the limit", () => {
    beforeAll(async () => {
      await holdExactly(PRO_RECORD_CAP);
    });

    it("authenticated Capture is refused 409 with the canonical code", async () => {
      const before = await heldRecords();
      const res = await inject({
        method: "POST",
        url: "/v1/evidence",
        token: tenant.owner.token,
        payload: { type: "DOCUMENT", teamId: tenant.personalTeamId, mimeType: "text/plain" },
      });
      expect(res.statusCode, res.body).toBe(409);
      const body = JSON.parse(res.body) as { code?: string; error?: { code?: string } };
      expect(body.code ?? body.error?.code).toBe("EVIDENCE_RECORD_LIMIT_REACHED");
      // The refusal is a refusal: nothing was written on the way to it.
      expect(await heldRecords()).toBe(before);
    });

    it("External Intake is refused WITHOUT becoming a server fault", async () => {
      const before = await heldRecords();
      const res = await contributorReachesPartCreation(await createIntakeLink());

      /*
       * THE REGRESSION, STATED THREE WAYS. Each of these was false in
       * production, and each is a different consequence of the same flatten:
       * the status made it an availability incident, the code made it our
       * fault, and together they cost the contributor the one fact that says
       * what to do.
       */
      expect(res.statusCode, res.body).toBeLessThan(500);
      const body = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).not.toBe("INTERNAL_ERROR");
      expect(body.error?.code).toBe("INTAKE_NOT_ACCEPTING_EVIDENCE");

      // And the status the commercial authority chose survives the boundary.
      expect(res.statusCode).toBe(409);

      expect(await heldRecords()).toBe(before);
    });

    it("tells the contributor nothing about the sender's commercial position", async () => {
      const res = await contributorReachesPartCreation(await createIntakeLink());
      /*
       * The canonical `publicMessage` for this denial — "buy evidence credits
       * or upgrade to add more" — is addressed to the ACCOUNT HOLDER. This
       * endpoint is unauthenticated: the caller holds a link and nothing else,
       * so the plan, the allowance, the usage and the remedy are all facts
       * about a third party that must not cross this boundary.
       */
      expect(res.body).not.toMatch(
        /\b(plan|credits?|upgrade|billing|subscription|allowance|quota|PRO|FREE|TEAM)\b/i,
      );
      // Nor the internal code, which names the commercial condition outright.
      expect(res.body).not.toContain("EVIDENCE_RECORD_LIMIT_REACHED");
    });

    it("records the refusal where the SENDER can find it", async () => {
      /*
       * A contributor told to "contact the sender" is only helped if the sender
       * can then discover what happened. Before this, nothing internal recorded
       * an intake refusal at all — the workspace's audit trail went quiet at
       * exactly the moment its capacity ran out.
       *
       * The row carries the canonical reason, which is the half the contributor
       * deliberately does not get.
       */
      const before = new Date();
      await contributorReachesPartCreation(await createIntakeLink());

      const rows = await prisma.adminAuditLog.findMany({
        where: {
          action: "evidence.create",
          outcome: "denied",
          workspaceId: tenant.personalTeamId,
          createdAt: { gte: before },
        },
        select: { severity: true, metadata: true },
      });
      expect(rows.length).toBeGreaterThan(0);
      const meta = rows[0].metadata as Record<string, unknown> | null;
      expect(meta?.reason).toBe("EVIDENCE_RECORD_LIMIT_REACHED");
      expect(meta?.source).toBe("external_intake");
      // An expected denial, audited as one. Never `critical`.
      expect(rows[0].severity).toBe("warning");
    });
  });
});
