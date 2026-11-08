/**
 * IDENT-019 — A QUARANTINED SESSION KEEPS READS; PRIVILEGED ACTIONS ARE REFUSED
 * ON EVERY ROUTE THAT PERFORMS ONE (decision D13).
 *
 * Before this, the quarantine refusal lived only inside `runtimeAdaptiveGate`,
 * which only admin-identity and reviewer action routes call. Export, report,
 * original-download, retention, legal-hold and membership routes never asked,
 * so a quarantined session could still do all of them.
 *
 * (a) Behaviour of the ONE quarantine authority, `refuseIfSessionQuarantined`,
 *     driven with a fake Prisma client — the same function `runtimeAdaptiveGate`
 *     now calls for its step (1).
 * (b) A source inventory: every gated route still calls the helper with its
 *     declared action, so a later edit cannot silently drop it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const securityEvents: Array<Record<string, unknown>> = [];

vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: (input: Record<string, unknown>) => {
    securityEvents.push(input);
  },
}));
vi.mock("../src/services/ops/metrics.service.js", () => ({ bump: () => undefined }));
vi.mock("../src/services/observability/incident.service.js", () => ({
  recordIncident: async () => undefined,
}));
vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async () => ({ sent: false }),
}));

import {
  refuseIfSessionQuarantined,
  runtimeAdaptiveGate,
} from "../src/services/access-control/adaptive-runtime-gate.service.js";
import { hashSessionId } from "../src/services/identity-security/session-revocation.service.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ROW_ID = "33333333-3333-4333-8333-333333333333";
const SID = "sid-ident-019";

function tokenWithSid(sid: string | null): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify(sid ? { sub: USER_ID, sid } : { sub: USER_ID }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function fakeReq(token: string | null) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as never;
}

function fakeReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    sent: false,
    code(c: number) {
      reply.statusCode = c;
      return reply;
    },
    send(b: unknown) {
      reply.body = b;
      reply.sent = true;
      return reply;
    },
  };
  return reply;
}

type SessionRow = {
  id: string;
  issuedAtUtc: Date;
  quarantinedAtUtc: Date | null;
  quarantineReleaseAtUtc: Date | null;
};

/**
 * Answers the two reads the authority makes: the inventory lookup by
 * (userId, sessionIdHash) and `isSessionQuarantined`'s lookup by id.
 */
function fakeClient(row: SessionRow | null) {
  const calls: unknown[] = [];
  const client = {
    authenticatedSession: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        calls.push(args.where);
        if (!row) return null;
        if (args.where["id"] !== undefined) return args.where["id"] === row.id ? row : null;
        if (
          args.where["userId"] === USER_ID &&
          args.where["sessionIdHash"] === hashSessionId(SID)
        ) {
          return row;
        }
        return null;
      },
    },
  };
  return { client: client as never, calls };
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ROW_ID,
    issuedAtUtc: new Date(),
    quarantinedAtUtc: null,
    quarantineReleaseAtUtc: null,
    ...overrides,
  };
}

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// (a) Behaviour
// ---------------------------------------------------------------------------

describe("IDENT-019 — refuseIfSessionQuarantined", () => {
  const savedFlag = process.env["ADAPTIVE_AUTH_RUNTIME_ENABLED"];
  beforeEach(() => {
    securityEvents.length = 0;
    delete process.env["ADAPTIVE_AUTH_RUNTIME_ENABLED"];
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env["ADAPTIVE_AUTH_RUNTIME_ENABLED"];
    else process.env["ADAPTIVE_AUTH_RUNTIME_ENABLED"] = savedFlag;
  });

  it("refuses a quarantined session with 403 session_quarantined and a security event", async () => {
    const { client } = fakeClient(
      row({ quarantinedAtUtc: new Date(Date.now() - HOUR), quarantineReleaseAtUtc: new Date(Date.now() + HOUR) }),
    );
    const reply = fakeReply();
    const res = await refuseIfSessionQuarantined(
      { req: fakeReq(tokenWithSid(SID)), reply: reply as never, teamId: TEAM_ID, userId: USER_ID, action: "EXPORT_GENERATE_PACKAGE" },
      client,
    );
    expect(res).toEqual({ refused: true });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({
      error: {
        code: "session_quarantined",
        message: "This session is quarantined; privileged actions blocked.",
      },
    });
    expect(securityEvents).toHaveLength(1);
    expect(securityEvents[0]).toMatchObject({
      teamId: TEAM_ID,
      eventType: "privileged_session_blocked",
      details: { sessionId: SESSION_ROW_ID, action: "EXPORT_GENERATE_PACKAGE", reason: "session_quarantined" },
    });
  });

  it("refuses an indefinitely quarantined session (no release time)", async () => {
    const { client } = fakeClient(row({ quarantinedAtUtc: new Date(Date.now() - HOUR) }));
    const reply = fakeReply();
    const res = await refuseIfSessionQuarantined(
      { req: fakeReq(tokenWithSid(SID)), reply: reply as never, teamId: null, userId: USER_ID, action: "MEMBER_ROLE_CHANGE" },
      client,
    );
    expect(res.refused).toBe(true);
    expect(reply.statusCode).toBe(403);
  });

  it("allows a session that is not quarantined, sending nothing", async () => {
    const { client } = fakeClient(row());
    const reply = fakeReply();
    const res = await refuseIfSessionQuarantined(
      { req: fakeReq(tokenWithSid(SID)), reply: reply as never, teamId: TEAM_ID, userId: USER_ID, action: "LEGAL_HOLD_PLACE" },
      client,
    );
    expect(res).toEqual({ refused: false });
    expect(reply.sent).toBe(false);
    expect(securityEvents).toHaveLength(0);
  });

  it("allows once the auto-release time has passed", async () => {
    const { client } = fakeClient(
      row({ quarantinedAtUtc: new Date(Date.now() - 3 * HOUR), quarantineReleaseAtUtc: new Date(Date.now() - 1000) }),
    );
    const reply = fakeReply();
    const res = await refuseIfSessionQuarantined(
      { req: fakeReq(tokenWithSid(SID)), reply: reply as never, teamId: TEAM_ID, userId: USER_ID, action: "ORIGINAL_EVIDENCE_DOWNLOAD" },
      client,
    );
    expect(res.refused).toBe(false);
    expect(reply.sent).toBe(false);
  });

  it("is a no-op when ADAPTIVE_AUTH_RUNTIME_ENABLED=false (no read, nothing sent)", async () => {
    process.env["ADAPTIVE_AUTH_RUNTIME_ENABLED"] = "false";
    const { client, calls } = fakeClient(row({ quarantinedAtUtc: new Date(Date.now() - HOUR) }));
    const reply = fakeReply();
    const res = await refuseIfSessionQuarantined(
      { req: fakeReq(tokenWithSid(SID)), reply: reply as never, teamId: TEAM_ID, userId: USER_ID, action: "MEMBER_SUSPEND" },
      client,
    );
    expect(res.refused).toBe(false);
    expect(reply.sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("keeps the legacy allow paths: no sid claim, and a sid with no inventory row", async () => {
    const quarantined = row({ quarantinedAtUtc: new Date(Date.now() - HOUR) });
    const noSid = fakeClient(quarantined);
    const r1 = fakeReply();
    expect(
      await refuseIfSessionQuarantined(
        { req: fakeReq(tokenWithSid(null)), reply: r1 as never, teamId: TEAM_ID, userId: USER_ID, action: "MEMBER_REVOKE" },
        noSid.client,
      ),
    ).toEqual({ refused: false });
    expect(noSid.calls).toHaveLength(0);
    expect(r1.sent).toBe(false);

    const noRow = fakeClient(null);
    const r2 = fakeReply();
    expect(
      await refuseIfSessionQuarantined(
        { req: fakeReq(tokenWithSid(SID)), reply: r2 as never, teamId: TEAM_ID, userId: USER_ID, action: "MEMBER_REVOKE" },
        noRow.client,
      ),
    ).toEqual({ refused: false });
    expect(r2.sent).toBe(false);
  });

  it("runtimeAdaptiveGate answers a quarantined session through the same authority", async () => {
    const { client } = fakeClient(row({ quarantinedAtUtc: new Date(Date.now() - HOUR) }));
    const reply = fakeReply();
    const res = await runtimeAdaptiveGate(
      { req: fakeReq(tokenWithSid(SID)), reply: reply as never, teamId: TEAM_ID, userId: USER_ID, action: "REVIEWER_APPROVE" },
      client,
    );
    expect(res).toEqual({ allow: false, sent: true, decision: "BLOCK" });
    expect(reply.statusCode).toBe(403);
    expect((reply.body as { error: { code: string } }).error.code).toBe("session_quarantined");
  });
});

// ---------------------------------------------------------------------------
// (b) Source inventory
// ---------------------------------------------------------------------------

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Source with comments removed, so a comment cannot satisfy a check. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/**
 * The handler body of the route registered at `path` with `method`: from the
 * registration to the next `app.<verb>(` registration (or end of file).
 */
function routeBody(src: string, method: string, path: string): string {
  const re = new RegExp(
    `app\\.${method}(?:<[^>]*>)?\\(\\s*"${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
  );
  const m = re.exec(src);
  if (!m) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

const IMPORT_RE =
  /import \{ refuseIfSessionQuarantined \} from "\.\.\/services\/access-control\/adaptive-runtime-gate\.service\.js";/;

type Gated = { file: string; method: string; path: string; actions: string[] };

const GATED: Gated[] = [
  // Membership
  { file: "identity.routes.ts", method: "post", path: "/v1/identity/members/:id/suspend", actions: ["MEMBER_SUSPEND"] },
  { file: "identity.routes.ts", method: "post", path: "/v1/identity/members/:id/revoke", actions: ["MEMBER_REVOKE"] },
  { file: "identity.routes.ts", method: "post", path: "/v1/identity/members/:id/role", actions: ["MEMBER_ROLE_CHANGE"] },
  { file: "teams.routes.ts", method: "patch", path: "/v1/teams/:id/members/:memberId", actions: ["MEMBER_ROLE_CHANGE"] },
  { file: "teams.routes.ts", method: "delete", path: "/v1/teams/:id/members/:memberId", actions: ["MEMBER_REVOKE"] },
  { file: "organizations.routes.ts", method: "patch", path: "/v1/orgs/:id/members/:memberId", actions: ["MEMBER_ROLE_CHANGE"] },
  { file: "organizations.routes.ts", method: "delete", path: "/v1/orgs/:id/members/:memberId", actions: ["MEMBER_REVOKE"] },
  // Legal hold
  { file: "governance.routes.ts", method: "post", path: "/v1/governance/legal-holds", actions: ["LEGAL_HOLD_PLACE"] },
  { file: "governance.routes.ts", method: "post", path: "/v1/governance/legal-holds/:id/release", actions: ["LEGAL_HOLD_RELEASE"] },
  { file: "governance.routes.ts", method: "post", path: "/v1/governance/case-legal-holds", actions: ["LEGAL_HOLD_PLACE"] },
  { file: "governance.routes.ts", method: "post", path: "/v1/governance/case-legal-holds/:id/release", actions: ["LEGAL_HOLD_RELEASE"] },
  { file: "product-and-lifecycle.routes.ts", method: "post", path: "/v1/lifecycle/legal-holds", actions: ["LEGAL_HOLD_PLACE"] },
  { file: "product-and-lifecycle.routes.ts", method: "post", path: "/v1/lifecycle/legal-holds/:id/release", actions: ["LEGAL_HOLD_RELEASE"] },
  { file: "product-and-lifecycle.routes.ts", method: "post", path: "/v1/lifecycle/legal-holds/:id/release-request", actions: ["LEGAL_HOLD_RELEASE"] },
  { file: "product-and-lifecycle.routes.ts", method: "post", path: "/v1/lifecycle/legal-holds/:id/release-approval", actions: ["LEGAL_HOLD_RELEASE"] },
  // Retention
  { file: "governance-lifecycle.routes.ts", method: "post", path: "/v1/governance/retention-policies", actions: ["RETENTION_POLICY_UPDATE"] },
  { file: "governance-lifecycle.routes.ts", method: "patch", path: "/v1/governance/retention-policies/:id", actions: ["RETENTION_POLICY_UPDATE"] },
  { file: "governance-lifecycle.routes.ts", method: "post", path: "/v1/governance/retention-policies/:id/transition", actions: ["RETENTION_POLICY_UPDATE"] },
  { file: "product-and-lifecycle.routes.ts", method: "post", path: "/v1/lifecycle/retention/policies", actions: ["RETENTION_POLICY_UPDATE"] },
  { file: "product-and-lifecycle.routes.ts", method: "post", path: "/v1/lifecycle/retention/policies/:id/release", actions: ["RETENTION_POLICY_UPDATE"] },
  { file: "organizations-governance.routes.ts", method: "post", path: "/v1/orgs/:id/policies/retention", actions: ["RETENTION_POLICY_UPDATE"] },
  // Exports, reports, packages
  // NOT YET: POST /v1/evidence/:id/reports/regenerate and GET
  // /v1/evidence/:id/original (evidence.routes.ts). The Phase 26.75 invariant
  // "evidence.routes.ts does NOT import Phase 26.75 runtime services"
  // (phase26_75-identity-runtime.test.ts) forbids importing the gate there;
  // gating them needs that invariant revisited first.
  { file: "siu.routes.ts", method: "post", path: "/v1/cases/:id/siu-export", actions: ["EXPORT_GENERATE_PACKAGE"] },
  { file: "product-and-lifecycle.routes.ts", method: "post", path: "/v1/exchange/packages", actions: ["EXPORT_GENERATE_PACKAGE"] },
  { file: "product-and-lifecycle.routes.ts", method: "post", path: "/v1/exchange/packages/:id/build", actions: ["EXPORT_GENERATE_PACKAGE"] },
  { file: "organizations.routes.ts", method: "post", path: "/v1/orgs/:id/data-export", actions: ["EXPORT_GENERATE_PACKAGE"] },
  // Original evidence (the presigned links to every stored evidence object)
  { file: "organizations.routes.ts", method: "post", path: "/v1/orgs/:id/data-export/:requestId/links", actions: ["ORIGINAL_EVIDENCE_DOWNLOAD"] },
];

describe("IDENT-019 — every privileged route asks the one quarantine authority", () => {
  for (const g of GATED) {
    it(`${g.method.toUpperCase()} ${g.path} (${g.file}) refuses a quarantined session: ${g.actions.join(" / ")}`, () => {
      const src = code(`../src/routes/${g.file}`);
      expect(src).toMatch(IMPORT_RE);
      const body = routeBody(src, g.method, g.path);
      expect(body).toMatch(/await refuseIfSessionQuarantined\(/);
      expect(body).toMatch(/\.refused\b/);
      for (const action of g.actions) expect(body).toContain(`"${action}"`);
    });
  }

  it("the organization member lifecycle handler refuses a quarantined SUSPEND", () => {
    const src = code("../src/routes/organizations.routes.ts");
    const start = src.indexOf("const membershipLifecycleHandler");
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, src.indexOf("\"/v1/orgs/:id/members/:memberId/suspend\""));
    expect(handler).toMatch(/action === "suspend" &&\s*\(await refuseIfSessionQuarantined\(\{[^}]*action: "MEMBER_SUSPEND"/);
    // ... and that handler is what the suspend route runs.
    expect(src).toMatch(/"\/v1\/orgs\/:id\/members\/:memberId\/suspend",\s*\{[^}]*\},\s*membershipLifecycleHandler\("suspend"\)/);
  });

  it("the helper runs before the step-up challenge is spent on step-up-gated routes", () => {
    for (const g of GATED) {
      const body = routeBody(code(`../src/routes/${g.file}`), g.method, g.path);
      const gate = body.indexOf("refuseIfSessionQuarantined(");
      const stepUp = body.search(/requireStepUpForSensitiveAction\(|verifyAccountStepUp\(/);
      if (stepUp !== -1) expect(gate, `${g.method} ${g.path}`).toBeLessThan(stepUp);
    }
  });

  it("runtimeAdaptiveGate delegates its quarantine step to the shared authority (one copy only)", () => {
    const src = code("../src/services/access-control/adaptive-runtime-gate.service.ts");
    const gateFn = src.slice(src.indexOf("export async function runtimeAdaptiveGate"), src.indexOf("export async function refuseIfSessionQuarantined"));
    expect(gateFn).toMatch(/await checkSessionQuarantine\(input, client\)/);
    expect(gateFn).not.toMatch(/isSessionQuarantined\(/);
    expect(src.match(/code: "session_quarantined"/g)).toHaveLength(1);
    expect(src.match(/isSessionQuarantined\(/g)).toHaveLength(1);
  });
});
