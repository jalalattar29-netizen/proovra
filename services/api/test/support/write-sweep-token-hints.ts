/* eslint-disable @typescript-eslint/no-explicit-any -- recipes read Prisma delegates of many shapes. */
/**
 * Routes reached by something other than a session, with a real credential of each
 * kind: a deployment secret, an API key, a SCIM token, an invitation or a capability
 * token in the path, a portal session. Each credential is minted on its own side, so
 * the attacker's is a valid credential of the wrong tenant.
 */
import { createHash, randomUUID } from "node:crypto";

import type { Actor, RouteHint, RowSet } from "./write-sweep-engine.js";

export const MACHINE_SECRETS: Record<string, string> = {
  NOTIFICATION_CRON_SECRET: "sweep-notification-secret-0123456789",
  INTEGRATION_CRON_SECRET: "sweep-integration-secret-0123456789",
  SEARCH_REINDEX_SECRET: "sweep-reindex-secret-0123456789",
  REVIEWER_OPS_CRON_SECRET: "sweep-reviewer-ops-secret-0123456789",
  INTERNAL_SERVICE_TOKEN: "sweep-internal-service-token-0123456789",
};

const machine = (header: string, secretEnv: string, extra: Partial<RouteHint> = {}): RouteHint => ({
  klass: "token",
  machine: true,
  credential: async () => ({ [header]: MACHINE_SECRETS[secretEnv] as string }),
  ...extra,
});

const integration = (extra: Partial<RouteHint> = {}) =>
  machine("x-proovra-integration-cron-secret", "INTEGRATION_CRON_SECRET", extra);
const notification = (extra: Partial<RouteHint> = {}) =>
  machine("x-proovra-cron-secret", "NOTIFICATION_CRON_SECRET", extra);
const internalService = (extra: Partial<RouteHint> = {}) =>
  machine("x-internal-service-token", "INTERNAL_SERVICE_TOKEN", extra);

const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** The invitation routes hash a token their own way. */
const orgInviteHash = async (raw: string): Promise<string> => {
  const { hashInviteToken } = await import("../../src/routes/organizations.routes.js");
  return hashInviteToken(raw);
};

// -----------------------------------------------------------------------------
// A SCIM token and an API key, minted by their own services
// -----------------------------------------------------------------------------

const ALL_SCIM = ["users.read", "users.write", "users.deactivate", "groups.read", "groups.write"];

async function scimToken(s: RowSet): Promise<Record<string, string>> {
  const { createScimToken } = await import("../../src/services/access-control/scim.service.js");
  const made = (await createScimToken(
    { teamId: s.tenant.teamId, name: `sweep ${randomUUID().slice(0, 8)}`, scopes: ALL_SCIM, actorUserId: s.tenant.owner.id } as never,
    s.prisma,
  )) as any;
  return { authorization: `Bearer ${made.tokenOnce}` };
}

async function apiKey(s: RowSet, scopes: string[]): Promise<Record<string, string>> {
  const { createApiCredential } = await import("../../src/services/integrations/api-keys.service.js");
  const made = (await createApiCredential(
    { teamId: s.tenant.teamId, name: `sweep ${randomUUID().slice(0, 8)}`, scopes, actorUserId: s.tenant.owner.id },
    s.prisma,
  )) as any;
  return { authorization: `Bearer ${made.rawKey}` };
}

const SCIM: Partial<RouteHint> = { klass: "token", credential: scimToken };

const scimUser = () => `sweep-${randomUUID().slice(0, 8)}@test.proovra.local`;

/** A provisioned person of this tenant, by the SCIM service itself. */
const scimUserRow = async (s: RowSet): Promise<void> => {
  const res = await s.factory.tools.inject({
    method: "POST",
    url: "/v2/scim/Users",
    headers: await scimToken(s),
    payload: (() => {
      const userName = scimUser();
      return { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName, emails: [{ value: userName, primary: true }], active: true };
    })(),
  });
  const body = res.json() as any;
  if (!body?.id) throw new Error(`scim user setup ${res.statusCode} ${JSON.stringify(body).slice(0, 200)}`);
  s.put("ScimUser", String(body.id));
};

const scimGroupRow = async (s: RowSet): Promise<void> => {
  const res = await s.factory.tools.inject({
    method: "POST",
    url: "/v2/scim/Groups",
    headers: await scimToken(s),
    payload: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: `sweep ${randomUUID().slice(0, 8)}`, members: [] },
  });
  s.put("ScimGroupRow", String((res.json() as any).id));
};

// -----------------------------------------------------------------------------
// An invitation is for one person: the control is that person
// -----------------------------------------------------------------------------

const invitee = async (s: RowSet): Promise<Actor> => {
  const made = await s.factory.tools.newPerson();
  await s.prisma.user.update({ where: { id: made.id }, data: { emailVerifiedAt: new Date() } });
  s.put("InviteeEmail", made.email);
  return made;
};

/** On the attack sides nobody accepts: the invitation is for a stranger. */
const inviteeEmail = (s: RowSet) => s.known("InviteeEmail") ?? `stranger-${randomUUID().slice(0, 8)}@test.proovra.local`;

// -----------------------------------------------------------------------------
// A portal session, opened the way a reviewer opens one
// -----------------------------------------------------------------------------

async function portalGrant(s: RowSet): Promise<void> {
  const { issueInvitation } = await import("../../src/services/external-review/portal-invitation.service.js");
  const evidenceId = (await s.id("Evidence")) as string;
  const workflowId = (await s.id("EvidenceReviewWorkflow")) as string;
  const issued = (await issueInvitation({
    teamId: s.tenant.teamId,
    invitedByUserId: s.tenant.owner.id,
    reviewerEmail: `rev-${randomUUID().slice(0, 8)}@test.proovra.local`,
    role: "EXTERNAL_REVIEWER",
    scope: { kind: "EVIDENCE", evidenceId },
    expiresAtUtc: new Date(Date.now() + 86_400_000).toISOString(),
    prisma: s.prisma,
  } as never)) as any;
  if (!issued.ok) throw new Error(`portal invitation refused: ${JSON.stringify(issued).slice(0, 160)}`);
  s.put("PortalRaw", issued.rawToken);
  s.put("PortalWorkflow", workflowId);
}

async function portalSession(s: RowSet): Promise<Record<string, string>> {
  const raw = (await s.id("PortalRaw")) as string;
  const res = await s.factory.tools.inject({ method: "POST", url: "/v1/portal/auth", payload: { token: raw } });
  const sessionId = (res.json() as any).sessionId as string;
  return { authorization: `Bearer ${raw}`, "x-portal-session": sessionId };
}

const PORTAL: Partial<RouteHint> = { klass: "token", setup: portalGrant, credential: portalSession, path: ["$PortalWorkflow"] };

/** A contributor's open session, on a link minted through the API key route. */
async function intakeSession(s: RowSet): Promise<void> {
  const { tools } = s.factory;
  const made = await tools.inject({
    method: "POST",
    url: "/v1/integrations/api/intake-links",
    headers: await apiKey(s, ["integration.intake_link.create"]),
    payload: {
      workflowTemplateSlug: "general-evidence-record",
      intakeMode: "EXTERNAL_REUSABLE",
      maxUses: 5,
      expiresAtUtc: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  const raw = (made.json() as any).rawToken as string;
  const opened = await tools.inject({ method: "GET", url: `/v1/external-intake/${raw}` });
  s.put("IntakeRaw", raw);
  s.put("IntakeSession", (opened.json() as any).session.id as string);
}

const INTAKE: Partial<RouteHint> = {
  klass: "token",
  credential: async () => ({}),
  setup: intakeSession,
  path: ["$IntakeRaw", "$IntakeSession"],
};

const ACCEPT = { acceptTerms: true };

export const REQUIRED_RECIPES: Record<string, RouteHint> = {
  "POST /v1/automation/runs/process": integration(),
  "POST /v1/communications/process-retries": integration(),
  "POST /v1/governance/reconcile-retention": integration(),
  "POST /v1/integrations/process-secret-cleanup": integration(),
  "POST /v1/integrations/process-webhook-retries": integration(),
  "POST /v1/integrations/webhooks/cleanup-deliveries": integration(),
  "POST /v1/ops/reconcile": integration(),
  "POST /v1/org-invite-deliveries/process": integration(),
  "POST /v1/reliability/reconcile": integration(),
  "POST /v1/review-operations/reconcile-slas": integration(),
  "POST /v1/internal/lifecycle/run": integration(),
  "POST /v1/notifications/process-retries": notification(),
  "POST /v1/notifications/run-digests": notification(),
  "POST /v1/notifications/run-reminders": notification(),
  "POST /v1/internal/search/reindex": machine("x-internal-secret", "SEARCH_REINDEX_SECRET", { body: { teamId: "$Team" } }),
  "POST /v1/reviewer-ops/reconcile": machine("x-cron-secret", "REVIEWER_OPS_CRON_SECRET", { body: { teamId: "$Team" } }),
  "POST /v1/internal/media-intelligence/extract": internalService({
    body: { teamId: "$Team", evidenceId: "$Evidence", kind: "analyze_metadata" },
  }),
  "POST /v1/uploads/sessions/:p/parts/:p/verified": internalService({
    rows: {
      EvidenceUploadSession: {
        evidenceId: "$Evidence",
        actorUserId: "$Actor",
        expectedPartCount: 1,
        state: "UPLOADING",
        multipartUploadId: () => randomUUID(),
        storageBucket: "b",
        storageKey: "k",
      },
    },
    make: { SessionPart: { model: "EvidenceUploadSessionPart", data: { sessionId: "$EvidenceUploadSession", partIndex: 0 } } },
    ensure: ["SessionPart"],
    path: ["$EvidenceUploadSession", "0"],
    body: { teamId: "$Team", serverSha256: "a".repeat(64) },
  }),

  // Contributor intake
  "POST /v1/external-intake/:p/sessions/:p/identity": { ...INTAKE, body: { pseudonym: "sweep" } },
  "POST /v1/external-intake/:p/sessions/:p/consent": { ...INTAKE },
  "POST /v1/external-intake/:p/sessions/:p/parts": { ...INTAKE, unreachable: "Presigns an upload for bytes the sweep does not hold." },
  "PATCH /v1/external-intake/:p/sessions/:p/parts/:p": { ...INTAKE, path: ["$IntakeRaw", "$IntakeSession", randomUUID()], unreachable: "Needs a part with stored bytes." },
  "POST /v1/external-intake/:p/sessions/:p/submit": { ...INTAKE, unreachable: "Needs a part with stored bytes." },

  // SCIM
  "POST /v2/scim/Users": {
    ...SCIM,
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: (s: RowSet) => {
        const name = scimUser();
        s.put("ScimName", name);
        return name;
      },
      emails: (s: RowSet) => [{ value: s.known("ScimName"), primary: true }],
      active: true,
    },
  },
  "PATCH /v2/scim/Users/:p": {
    ...SCIM,
    setup: scimUserRow,
    path: ["$ScimUser"],
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "displayName", value: "Renamed" }],
    },
  },
  "DELETE /v2/scim/Users/:p": { ...SCIM, setup: scimUserRow, path: ["$ScimUser"] },
  "POST /v2/scim/Groups": {
    ...SCIM,
    body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: () => `sweep ${randomUUID().slice(0, 8)}`, members: [] },
  },
  "PATCH /v2/scim/Groups/:p": {
    ...SCIM,
    setup: scimGroupRow,
    path: ["$ScimGroupRow"],
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "displayName", value: "Renamed" }],
    },
  },
  "DELETE /v2/scim/Groups/:p": { ...SCIM, setup: scimGroupRow, path: ["$ScimGroupRow"] },
  "POST /v1/scim/sync-failures/:p/replay": { klass: "tenant", unreachable: "Needs a recorded directory sync failure." },
  "POST /v1/scim/reconciliation/execute": { klass: "tenant", unreachable: "Needs a preview built from a live directory." },

  // API keys
  "POST /v1/integrations/api/intake-links": {
    klass: "token",
    credential: (s) => apiKey(s, ["integration.intake_link.create"]),
    body: {
      workflowTemplateSlug: "general-evidence-record",
      intakeMode: "EXTERNAL_ONE_TIME",
      expiresAtUtc: () => new Date(Date.now() + 86_400_000).toISOString(),
    },
  },
  "POST /v1/integrations/api/evidence-requests": {
    klass: "token",
    credential: (s) => apiKey(s, ["integration.evidence_request.create"]),
    body: { requestType: "OTHER", title: "sweep request", recipientMode: "EXTERNAL_EMAIL", recipientEmail: "r@test.proovra.local" },
  },

  // Invitations
  "POST /v1/teams/invites/:p/accept": {
    klass: "token",
    session: invitee,
    make: {
      Invite: {
        model: "TeamInvite",
        data: {
          email: inviteeEmail,
          role: "VIEWER",
          tokenHash: (s: RowSet) => {
            const raw = `sweep-${randomUUID()}`;
            s.put("Raw", raw);
            return sha256(raw);
          },
          invitedByUserId: "$Owner",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      },
    },
    ensure: ["Invite"],
    path: ["$Raw"],
  },
  "POST /v1/teams/invites/lookup": {
    klass: "public",
  },
  "POST /v1/org-invites/lookup": {
    klass: "public",
  },
  "POST /v1/collaboration-team-invites/accept": {
    klass: "token",
    session: async (s) => {
      const person = await invitee(s);
      await s.prisma.teamMember.create({ data: { teamId: s.tenant.teamId, userId: person.id, role: "MEMBER", status: "ACTIVE" } });
      return person;
    },
    rows: {
      CollaborationTeamInvite: {
        channel: "EMAIL",
        email: inviteeEmail,
        tokenHash: (s: RowSet) => {
          const raw = `sweep-${randomUUID()}`;
          s.put("Raw", raw);
          return sha256(raw);
        },
        expiresAtUtc: new Date(Date.now() + 86_400_000),
        createdByUserId: "$Owner",
        status: "PENDING",
      },
    },
    ensure: ["CollaborationTeamInvite"],
    body: { token: "$Raw" },
  },
  "POST /v1/org-invites/:p/accept": {
    klass: "token",
    session: invitee,
    make: {
      Invite: {
        model: "OrganizationInvite",
        data: {
          email: inviteeEmail,
          role: "ORG_MEMBER",
          tokenHash: async (s: RowSet) => {
            const raw = `sweep-${randomUUID()}`;
            s.put("Raw", raw);
            return orgInviteHash(raw);
          },
          invitedByUserId: "$Owner",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      },
    },
    ensure: ["Invite"],
    path: ["$Raw"],
  },
  "POST /v1/collaboration-team-invites/:p/accept": {
    klass: "token",
    session: async (s) => {
      const person = await invitee(s);
      await s.prisma.teamMember.create({ data: { teamId: s.tenant.teamId, userId: person.id, role: "MEMBER", status: "ACTIVE" } });
      return person;
    },
    rows: {
      CollaborationTeamInvite: {
        channel: "EMAIL",
        email: inviteeEmail,
        tokenHash: (s: RowSet) => {
          const raw = `sweep-${randomUUID()}`;
          s.put("Raw", raw);
          return sha256(raw);
        },
        expiresAtUtc: new Date(Date.now() + 86_400_000),
        createdByUserId: "$Owner",
        status: "PENDING",
      },
    },
    ensure: ["CollaborationTeamInvite"],
    path: ["$Raw"],
  },

  // External reviewer
  "POST /v1/portal/work/:p/view": { ...PORTAL },
  "POST /v1/portal/work/:p/comments": { ...PORTAL, body: { body: "sweep comment" } },
  "POST /v1/portal/work/:p/decision": { ...PORTAL, body: { verdict: "APPROVE" } },
  "POST /v1/portal/logout": { klass: "token", setup: portalGrant, credential: portalSession },
  "POST /v1/portal/auth": { klass: "public" },
  "POST /v1/portal/sso/callback": { klass: "public" },
  "POST /v1/portal/sso/start/:p": { klass: "public" },
  "POST /v1/external-review/access/:p": {
    klass: "token",
    credential: async () => ({}),
    setup: portalGrant,
    path: ["$PortalRaw"],
    body: ACCEPT,
  },
};
