/**
 * PRO-114, PRO-115, PRO-117 — the API side of three mobile flows, driven with
 * the mobile app's OWN request builders (apps/mobile/src/product/*) against the
 * real routes on a disposable PostgreSQL, so a builder and a route schema can
 * never drift apart again unnoticed.
 *
 *   PRO-114  Settings › Privacy: closure posted `confirmationPhrase` (the route
 *            reads `confirmation`), export and download needed step-up, and the
 *            download is POST-only.
 *   PRO-115  an intake reopen resumes only with `x-proovra-intake-session`.
 *   PRO-117  a retried send must carry the same idempotency key.
 *
 * Mail goes to the recording provider; no provider is called.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACCOUNT_CLOSURE_PATH,
  DATA_EXPORT_PATH,
  EXPORT_DOWNLOAD_METHOD,
  buildClosureCancelPath,
  buildClosureRequestBody,
  buildExportDownloadPath,
  buildExportStepUpBody,
  parseClosure,
} from "../../../apps/mobile/src/product/account-privacy.js";
import {
  INTAKE_SESSION_HEADER,
  buildIntakeValidatePath,
  intakeResumeHeaders,
  parseValidatedIntake,
} from "../../../apps/mobile/src/product/external-intake.js";
import { buildIntakeSendBody, createIntakeSendKeys } from "../../../apps/mobile/src/product/intake-links.js";
import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit } from "./support/coverage-actors.js";
import { customerKit, type Customer } from "./support/coverage-customer.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = import("@prisma/client").PrismaClient;
const PASSWORD = "Mobile-Contract-Pass-2026!";

describe("mobile request builders against the real routes (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let a: Customer;

  const call = (method: "GET" | "POST", url: string, token: string | null, payload?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });

  /** A verified password account with current legal acceptance, as the app's user is. */
  async function passwordUser() {
    const { hashPassword } = await import("../src/services/email-password-auth.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `mobile-contract-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: {
        email,
        firstName: "Mobile",
        lastName: "Contract",
        provider: "EMAIL",
        providerUserId: email,
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
      } as never,
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "mobile-contract",
      })),
    });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }
  const proof = { method: "password" as const, currentPassword: PASSWORD };

  beforeAll(async () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = "integration-only-api-key-secret-0123456789abcdef";
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "integration-only-intake-secret-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    kit = await coverageKit(h);
    stepUp = createStepUpCeremony({ prisma, inject: h.app.inject.bind(h.app) as never });
    a = await (await customerKit(h, prisma)).customer();
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  describe("PRO-114 — privacy", () => {
    it("closure: the old field is refused; the app's body asks for step-up, then opens the cooling-off window", async () => {
      const u = await passwordUser();
      const view = parseClosure((await call("GET", ACCOUNT_CLOSURE_PATH, u.token)).json());
      expect(view.confirmationPhrase).toBe("close my account");

      // Negative control: what the app used to send.
      const legacy = await call("POST", ACCOUNT_CLOSURE_PATH, u.token, { confirmationPhrase: view.confirmationPhrase });
      expect(legacy.statusCode).toBe(400);

      const first = await call("POST", ACCOUNT_CLOSURE_PATH, u.token, buildClosureRequestBody(view.confirmationPhrase!, "", null));
      expect(first.statusCode, first.body).toBe(401);
      expect(first.json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED", methods: ["password"] } });
      expect(await prisma.accountClosureRequest.count({ where: { userId: u.id } })).toBe(0);

      const second = await call("POST", ACCOUNT_CLOSURE_PATH, u.token, buildClosureRequestBody(view.confirmationPhrase!, "leaving", proof));
      expect(second.statusCode, second.body).toBe(201);
      const row = await prisma.accountClosureRequest.findFirstOrThrow({ where: { userId: u.id } });
      expect(row.status).toBe("COOLING_OFF");
      expect(row.reason).toBe("leaving");

      const cancelled = await call("POST", buildClosureCancelPath(row.id), u.token, {});
      expect(cancelled.statusCode).toBe(200);
      expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("CANCELLED");
    });

    it("export and download: step-up on both, download only by POST, and a READY package is returned and counted", async () => {
      const u = await passwordUser();
      expect((await call("POST", DATA_EXPORT_PATH, u.token, buildExportStepUpBody(null))).statusCode).toBe(401);
      const created = await call("POST", DATA_EXPORT_PATH, u.token, buildExportStepUpBody(proof));
      expect(created.statusCode, created.body).toBe(201);
      const id = (created.json() as { request: { id: string } }).request.id;

      // What the app used to do: a GET in the system browser.
      expect((await call("GET", buildExportDownloadPath(id), u.token)).statusCode).toBe(404);
      expect(EXPORT_DOWNLOAD_METHOD).toBe("POST");
      expect((await call("POST", buildExportDownloadPath(id), u.token, buildExportStepUpBody(null))).statusCode).toBe(401);
      expect((await call("POST", buildExportDownloadPath(id), u.token, buildExportStepUpBody(proof))).statusCode).toBe(409);

      // The worker's outcome, set directly: READY with a package.
      await prisma.accountDataExportRequest.update({
        where: { id },
        data: { status: "READY", packageJson: JSON.stringify({ schema: "proovra.account-export.v1", userId: u.id }), packageSha256: "a".repeat(64), expiresAtUtc: new Date(Date.now() + 86_400_000), completedAtUtc: new Date() },
      });
      const dl = await call("POST", buildExportDownloadPath(id), u.token, buildExportStepUpBody(proof));
      expect(dl.statusCode, dl.body).toBe(200);
      expect(dl.json()).toMatchObject({ userId: u.id });
      expect((await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id } })).downloadCount).toBe(1);

      // Another user cannot download it, even with their own valid proof.
      const other = await passwordUser();
      expect((await call("POST", buildExportDownloadPath(id), other.token, buildExportStepUpBody(proof))).statusCode).toBe(404);
    });
  });

  describe("PRO-115 / PRO-117 — intake links", () => {
    let raw: string;
    let link: { id: string; token: string };

    beforeAll(async () => {
      const header = await stepUp.approvedHeader({
        token: a.owner.token,
        userId: a.owner.userId,
        teamId: a.workspaceId,
        purpose: "INTEGRATION_API_KEY_CREATE",
        resourceKind: "team",
        resourceId: a.workspaceId,
      });
      const key = await kit.call(
        "POST",
        "/v1/integrations/api-keys",
        { token: a.owner.token },
        { teamId: a.workspaceId, name: `key ${kit.tag()}`, scopes: ["integration.intake_link.create"] },
        header,
      );
      expect(key.statusCode, key.body).toBe(201);
      raw = key.json().rawKey as string;
      const res = await kit.call("POST", "/v1/integrations/api/intake-links", { token: raw }, {
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_REUSABLE",
        maxUses: 5,
        recipientEmail: `contributor-${kit.tag()}@test.proovra.local`,
        expiresAtUtc: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(res.statusCode, res.body).toBe(201);
      link = { id: res.json().intakeLink.id as string, token: res.json().rawToken as string };
    });

    it("PRO-115: the app's reopen presents its session in the header and resumes it; without it a second session opens", async () => {
      expect(INTAKE_SESSION_HEADER).toBe("x-proovra-intake-session");
      const first = parseValidatedIntake((await call("GET", buildIntakeValidatePath(link.token), null)).json());
      expect(first?.session?.id).toBeTruthy();
      expect(first?.resumed).toBe(false);

      const reopened = parseValidatedIntake(
        (await call("GET", buildIntakeValidatePath(link.token), null, undefined, intakeResumeHeaders(first!.session!.id))).json(),
      );
      expect(reopened?.resumed).toBe(true);
      expect(reopened?.session?.id).toBe(first!.session!.id);
      expect(await prisma.workflowIntakeSession.count({ where: { intakeLinkId: link.id } })).toBe(1);

      // Negative control: what the app used to do.
      const fresh = parseValidatedIntake((await call("GET", buildIntakeValidatePath(link.token), null, undefined, intakeResumeHeaders(null))).json());
      expect(fresh?.resumed).toBe(false);
      expect(fresh?.session?.id).not.toBe(first!.session!.id);
    });

    it("PRO-117: a retried send with the app's held key is one message; a confirmed-then-deliberate resend is a new one", async () => {
      let n = 0;
      const keys = createIntakeSendKeys(link.id, () => `n${++n}-${kit.tag()}`);
      const send = () =>
        call(
          "POST",
          `/v1/workflow/intake-links/${link.id}/send`,
          a.owner.token,
          buildIntakeSendBody({ channel: "EMAIL", rawToken: link.token, intakeUrl: `https://www.proovra.com/intake/${link.token}`, idempotencyKey: keys.keyFor("EMAIL") }),
        );
      const before = await prisma.communicationMessage.count({ where: { teamId: a.workspaceId } });
      const first = await send();
      expect(first.statusCode, first.body).toBe(200);
      const retried = await send(); // the reply to the first was "lost"; the key is still held
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().communicationMessageId).toBe(first.json().communicationMessageId);
      expect(await prisma.communicationMessage.count({ where: { teamId: a.workspaceId } })).toBe(before + 1);

      keys.confirmed("EMAIL");
      const deliberate = await send();
      expect(deliberate.json().communicationMessageId).not.toBe(first.json().communicationMessageId);
      expect(await prisma.communicationMessage.count({ where: { teamId: a.workspaceId } })).toBe(before + 2);
    });
  });
});
