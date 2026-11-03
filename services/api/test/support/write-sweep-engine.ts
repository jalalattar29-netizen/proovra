/* eslint-disable @typescript-eslint/no-explicit-any -- test support reads Prisma delegates and JSON bodies of many shapes. */
/**
 * THE WRITE-ROUTE AUTHORIZATION SWEEP ENGINE.
 *
 * The audit's sweep aimed most write routes at random ids, so a refusal showed
 * only that an unknown id is rejected. This engine aims every route at real rows:
 *
 *   1. CONTROL. A fresh throwaway tenant's OWNER calls the route on that tenant's
 *      own fresh rows. Validation issues are read from Zod itself, whatever error
 *      shape the route answers with, and the body is repaired until the route
 *      answers or stops asking. A 2xx proves the request is valid and the route
 *      open to an authorized actor. Anything else is recorded as what it is:
 *      bad payload, feature off, precondition, missing fixture, unavailable.
 *
 *   2. ATTACK. The same request, with the victim's real rows, sent by an equally
 *      privileged owner of another tenant: path and body aimed at the victim, the
 *      victim's workspace claimed, own path with victim ids in the body, an own
 *      plus victim bulk array, and nested parent and child from different tenants.
 *      Inside the victim tenant: a VIEWER, a member off a restricted Case, a
 *      removed member. Anonymous as well.
 *
 *   3. EFFECT. Every table carries a trigger that logs each written row. An attack
 *      has landed when a row it wrote names a victim marker, or a response carries
 *      one. No hand-kept snapshot bounds what can be seen. That is what catches the
 *      GOV-001 class, where the request row sits in the attacker's own tenant and
 *      only its evidence id list names the victim.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { IntegrationHarness } from "../integration-harness.js";
import { createStepUpCeremony } from "./step-up-ceremony.js";

// ---------------------------------------------------------------------------
// Live inventory
// ---------------------------------------------------------------------------

export type LiveRoute = { method: string; url: string; key: string };

export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** One normal form for live routes, the audit's route table and its CSVs. */
export function normalizeRoutePath(path: string): string {
  let s = path.split("?")[0];
  s = s.replace(/\$\{[^}]*\}/g, ":p").replace(/:[A-Za-z0-9_]+(\|:[A-Za-z0-9_]+)*/g, ":p");
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s.replace(/^\/v1\/workspaces(\/|$)/, "/v1/teams$1");
}

/** Reads Fastify's route tree. A segment shared by several param names prints `:a|:b`. */
export function liveRoutes(printed: string): LiveRoute[] {
  const out = new Map<string, LiveRoute>();
  const stack: string[] = [];
  for (const line of printed.split(/\r?\n/)) {
    const m = line.match(/^([\u2502 ]*)(?:\u251C\u2500\u2500|\u2514\u2500\u2500)\s?(.*)$/);
    if (!m) continue;
    const depth = m[1].length / 4;
    const mm = m[2].match(/^(.*?)\s\(([A-Z, ]+)\)\s*$/);
    stack.length = depth;
    stack[depth] = mm ? mm[1] : m[2];
    if (!mm) continue;
    const url = stack.join("");
    for (const method of mm[2].split(",").map((x) => x.trim())) {
      const key = `${method} ${normalizeRoutePath(url)}`;
      out.set(key, { method, url, key });
    }
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Route classes
// ---------------------------------------------------------------------------

export type RouteClass =
  | "tenant" // session actor, tenant resources: full attack set
  | "platform" // operator-only: a customer owner must be refused; control is an operator
  | "token" // reached by a capability, API key, SCIM or machine secret, not a session
  | "public" // anonymous by design, or the credential ceremony itself
  | "retired"; // answers 410 to everyone

const PUBLIC = [
  /^\/webhooks\//,
  /^\/v1\/auth\//,
  /^\/v1\/oauth\//,
  /^\/v1\/saml\//,
  /^\/v1\/contact-sales/,
  /^\/v1\/demo-requests/,
  /^\/v1\/deep-link/,
  /^\/v1\/_test/,
];
const TOKEN = [
  /^\/v2\/scim\//,
  /^\/v1\/scim\//,
  /^\/v1\/internal\//,
  /^\/v1\/external-intake\//,
  /^\/v1\/external-review\/access\//,
  /^\/v1\/intake\/citizen\//,
  /^\/v1\/portal\//,
  /^\/v1\/org-invites\/:p/,
  /^\/v1\/teams\/invites\/:p/,
  /^\/v1\/collaboration-team-invites\/:p/,
  /^\/v1\/integrations\/api\//,
];
const PLATFORM = [
  /^\/v1\/admin\//,
  /^\/v1\/platform\//,
  /^\/v1\/operations\//,
  /^\/v1\/break-glass/,
  /^\/v1\/support-access/,
  /^\/v1\/trust\//,
];

export function routeClass(route: LiveRoute): RouteClass {
  const path = normalizeRoutePath(route.url);
  if (/^\/v1\/api-keys/.test(path)) return "retired";
  if (PUBLIC.some((p) => p.test(path))) return "public";
  if (TOKEN.some((p) => p.test(path))) return "token";
  if (PLATFORM.some((p) => p.test(path))) return "platform";
  return "tenant";
}

// ---------------------------------------------------------------------------
// Which row a path parameter names
// ---------------------------------------------------------------------------

const SEGMENT_MODELS: Record<string, string> = {
  evidence: "Evidence",
  cases: "Case",
  "saved-views": "EvidenceSavedView",
  "collaboration-teams": "CollaborationTeam",
  "collaboration-team-notifications": "CollaborationTeamNotification",
  threads: "DiscussionThread",
  "evidence-requests": "EvidenceRequest",
  deliverables: "EvidenceRequestDeliverable",
  responses: "EvidenceRequestResponse",
  deliveries: "NotificationDelivery",
  "chain-transfers": "ChainTransfer",
  packages: "EvidenceExchangePackage",
  grants: "ExternalReviewGrant",
  invitations: "ExternalReviewGrant",
  campaigns: "AccessReviewCampaign",
  "case-legal-holds": "EvidenceLegalHold",
  "legal-holds": "EvidenceLegalHold",
  "cross-org-review": "CrossOrgReviewGrant",
  departments: "Department",
  memberships: "DepartmentMembership",
  "destruction-reviews": "DestructionReview",
  notifications: "GovernanceNotification",
  "retention-policies": "EvidenceRetentionPolicy",
  requests: "DestructionRequest",
  rules: "AutomationRule",
  "batch-analysis": "BatchAnalysisJob",
  devices: "Device",
  "direct-sessions": "CaptureSession",
  schemas: "CodingSchema",
  messages: "CommunicationMessage",
  duplicates: "InvestigationGraphEdge",
  manual: "ManualRelationship",
  capabilities: "MemberCapabilityGrant",
  "external-mappings": "ExternalIdentityMapping",
  members: "TeamMember",
  "service-accounts": "ApiCredential",
  "my-sessions": "AuthenticatedSession",
  passkeys: "MfaFactor",
  factors: "MfaFactor",
  "recovery-requests": "MfaRecoveryRequest",
  "api-keys": "ApiCredential",
  "webhook-deliveries": "IntegrationWebhookDelivery",
  webhooks: "WebhookEndpoint",
  endpoints: "LifecycleWebhookEndpoint",
  "lifecycle-deliveries": "LifecycleWebhookDelivery",
  corrections: "ReviewerCorrection",
  signals: "MediaIntelligenceSignal",
  orgs: "Organization",
  domains: "OrganizationDomain",
  invites: "TeamInvite",
  workspaces: "Team",
  teams: "Team",
  work: "EvidenceReviewWorkflow",
  reviews: "EvidenceReviewWorkflow",
  workspace: "EvidenceReviewWorkflow",
  workflow: "EvidenceReviewWorkflow",
  derivatives: "RedactionDerivative",
  detections: "RedactionDetection",
  policies: "RedactionPolicy",
  "policy-assignments": "RedactionPolicyAssignment",
  "policy-versions": "RedactionPolicyVersion",
  projects: "RedactionProject",
  regions: "RedactionRegion",
  versions: "RedactionVersion",
  "video-tracks": "VideoTrack",
  videos: "Evidence",
  "upload-sessions": "Evidence",
  "reviewer-criteria": "ReviewerCriteriaSet",
  escalations: "ReviewEscalation",
  annotations: "EvidenceAnnotation",
  disagreements: "ReviewerDisagreement",
  samples: "QcSample",
  "external-grants": "ExternalReviewGrant",
  sessions: "EvidenceUploadSession",
  "intake-links": "WorkflowIntakeLink",
  templates: "EvidenceWorkflowTemplate",
  instances: "EvidenceWorkflowInstance",
  "copilot-runs": "AiCopilotRun",
  payments: "Payment",
  "checkout-attempts": "BillingCheckoutAttempt",
  subscriptions: "Subscription",
  links: "UserIdentityLink",
  "account-closure": "AccountClosureRequest",
  "data-export": "AccountDataExportRequest",
};

const PREFIXED_SEGMENT_MODELS: Record<string, string> = {
  "collaboration-teams|collaboration-teams": "CollaborationTeam",
  "external-review|invitations": "ExternalReviewerRoleAssignment",
  "ops|incidents": "OperationalIncident",
  "admin|incidents": "OperationalIncident",
  "ops|workflows": "OperationalWorkflow",
  "ops|runs": "MediaIntelligenceRun",
  "admin|sessions": "AuthenticatedSession",
  "admin|providers": "SsoConnection",
  "admin|groups": "ScimGroup",
  "admin|tokens": "ScimProvisioningToken",
  "admin|contact-sales": "ContactSalesRequest",
  "admin|demo-requests": "DemoRequest",
  "identity|contributor-sessions": "CaptureSession",
  "evidence|comments": "EvidenceReviewerComment",
  "evidence|legal-notes": "EvidenceLegalNote",
  "evidence|annotations": "EvidenceAnnotation",
  "evidence|relationships": "EvidenceRelationship",
  "evidence|verify-links": "VerificationShareToken",
  "cases|access": "CaseAccess",
  "cases|assignments": "CaseAssignment",
  "cases|checklist": "CaseSiuChecklistItem",
  "cases|comments": "CaseComment",
  "cases|evidence-links": "CaseEvidenceLink",
  "cases|follow-ups": "CaseSiuFollowUp",
  "cases|team-access": "CollaborationTeam",
  "collaboration-teams|access-review": "CollaborationTeamAccessReview",
  "collaboration-teams|assignments": "CollaborationTeamAssignment",
  "collaboration-teams|comments": "CollaborationTeamComment",
  "collaboration-teams|guests": "CollaborationTeamGuest",
  "collaboration-teams|invites": "CollaborationTeamInvite",
  "collaboration-teams|items": "CollaborationTeamAccessReviewItem",
  "collaboration-teams|members": "CollaborationTeamMember",
  "governance|items": "AccessReviewItem",
  "governance|delegated-admin": "DelegatedAdminGrant",
  "governance|policies": "GovernancePolicy",
  "identity|access-reviews": "AccessReview",
  "identity|delegated-admin": "MemberDelegatedAdminScope",
  "identity-security|devices": "TrustedDevice",
  "lifecycle|policies": "RetentionPolicyConfig",
  "automation|webhooks": "AutomationWebhookDestination",
  "capture|sessions": "CaptureSession",
  "reviewer-ops|saved-views": "SavedSearchView",
  "search|saved-views": "SavedSearchView",
  "siu|saved-views": "CaseSiuSavedView",
  "orgs|invites": "OrganizationInvite",
  "orgs|members": "OrganizationMembership",
  "orgs|closure": "OrganizationClosureRequest",
  "teams|closure": "WorkspaceClosureRequest",
  "evidence-requests|deliveries": "NotificationDelivery",
  "exchange|deliveries": "EvidenceExchangePackageDelivery",
  "ops|saved-views": "SavedSearchView",
};

const PARAM_MODELS: Record<string, string> = {
  evidenceId: "Evidence",
  caseId: "Case",
  workflowId: "EvidenceReviewWorkflow",
  teamId: "Team",
  workspaceId: "Team",
  orgId: "Organization",
  userId: "User",
  memberId: "TeamMember",
  packageId: "EvidenceExchangePackage",
  requestId: "MfaRecoveryRequest",
};

export type PathParam = { name: string; model: string | null };

export function pathParams(url: string): PathParam[] {
  const parts = url.split("/").filter(Boolean);
  const area = parts[0] === "v1" || parts[0] === "v2" ? parts[1] : parts[0];
  const out: PathParam[] = [];
  parts.forEach((part, i) => {
    if (!part.startsWith(":")) return;
    const names = part.split("|").map((p) => p.replace(/^:/, ""));
    const before = parts[i - 1] ?? "";
    const model =
      (before === ":type" ? "Organization" : undefined) ??
      PREFIXED_SEGMENT_MODELS[`${area}|${before}`] ??
      names.map((n) => PARAM_MODELS[n]).find(Boolean) ??
      SEGMENT_MODELS[before] ??
      null;
    out.push({ name: part, model });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Tenants and rows
// ---------------------------------------------------------------------------

export type Actor = { id: string; email: string; token: string };
export type Tenant = {
  teamId: string;
  orgId: string;
  owner: Actor;
  admin: Actor;
  admin2: Actor;
  approver: Actor;
  member: Actor;
  viewer: Actor;
};

type Dmmf = { models: ReadonlyArray<DmmfModel>; enums: ReadonlyArray<{ name: string; values: ReadonlyArray<{ name: string }> }> };
type DmmfField = {
  name: string;
  kind: string;
  type: string;
  isList: boolean;
  isRequired: boolean;
  isId: boolean;
  hasDefaultValue: boolean;
  isUpdatedAt?: boolean;
  relationFromFields?: ReadonlyArray<string>;
  nativeType?: [string, unknown] | null;
};
type DmmfModel = { name: string; fields: ReadonlyArray<DmmfField> };

/** The runtime client carries a slimmed model, so the schema file is the source. */
function readSchema(): Dmmf {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(path.resolve(here, "..", "..", "prisma", "schema.prisma"), "utf8");
  const enums = [...text.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({
    name: m[1],
    values: m[2]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[A-Za-z_]\w*$/.test(l))
      .map((name) => ({ name })),
  }));
  const enumNames = new Set(enums.map((e) => e.name));
  const blocks = [...text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
  const modelNames = new Set(blocks.map((m) => m[1]));
  const models = blocks.map((m) => ({
    name: m[1],
    fields: m[2]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
      .flatMap((line): DmmfField[] => {
        const f = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
        if (!f) return [];
        const [, name, type, list, optional, rest] = f;
        const relationFields = rest.match(/@relation\([^)]*fields:\s*\[([^\]]*)\]/);
        return [
          {
            name,
            type,
            kind: modelNames.has(type) ? "object" : enumNames.has(type) ? "enum" : "scalar",
            isList: Boolean(list),
            isRequired: !optional && !list,
            isId: /@id\b/.test(rest),
            hasDefaultValue: /@default\(/.test(rest),
            isUpdatedAt: /@updatedAt/.test(rest),
            relationFromFields: relationFields ? relationFields[1].split(",").map((x) => x.trim()) : [],
            nativeType: /@db\.Uuid/.test(rest) ? ["Uuid", []] : null,
          },
        ];
      }),
  }));
  return { models, enums };
}

const TENANT_FIELDS = new Set(["teamId", "workspaceId", "ownerTeamId"]);
const ORG_FIELDS = new Set(["organizationId", "orgId"]);

/** Per-model facts the schema cannot state: check constraints and state a route wants. */
const ROW_OVERRIDES: Record<string, (t: Tenant) => Record<string, unknown>> = {
  Evidence: () => ({ status: "SIGNED", type: "PHOTO", sizeBytes: 1000n, lifecycleState: "ACTIVE", title: "sweep record" }),
  ManualRelationship: () => ({ edgeType: "MANUALLY_LINKED_TO", status: "ACTIVE" }),
  AutomationRule: () => ({ actionType: "NOTIFY_USER", triggerType: "EVIDENCE_CREATED" }),
  // A project names its record by a plain column, with no foreign key.
  RedactionProject: () => ({ evidenceId: "$Evidence", artifactKind: "IMAGE" }),
  RedactionVersion: () => ({ versionOrdinal: 1 }),
  ExternalReviewGrant: () => ({
    expiresAtUtc: new Date(Date.now() + 86_400_000),
    scopeKind: "EVIDENCE",
    evidenceId: "$Evidence",
  }),
  EvidenceLegalHold: () => ({ scope: "EVIDENCE", evidenceId: "$Evidence", caseId: null, status: "ACTIVE" }),
  MediaIntelligenceSignal: () => ({ signalType: "EXIF_MISSING" }),
  MediaIntelligenceRun: () => ({ kind: "analyze_metadata" }),
  DestructionRequest: (t) => ({
    state: "PENDING_APPROVAL",
    evidenceIds: [],
    approverUserIds: [t.approver.id],
    requestedByUserId: t.owner.id,
  }),
  EvidenceUploadSession: () => ({ expiresAtUtc: new Date(Date.now() + 86_400_000) }),
  InvestigationGraphEdge: () => ({ edgeType: "SAME_HASH_AS" }),
  EvidenceTrashed: () => ({ status: "SIGNED", type: "PHOTO", sizeBytes: 1000n, lifecycleState: "TRASHED", deletedAt: new Date() }),
  Case: () => ({ name: `sweep-${randomUUID().slice(0, 8)}` }),
  EvidenceReviewWorkflow: () => ({ status: "NOT_STARTED", workspaceType: "TEAM" }),
  EvidenceWorkflowTemplate: () => ({ name: `sweep-${randomUUID().slice(0, 8)}` }),
  SsoConnection: () => ({ provider: "GENERIC_SAML", allowedEmailDomains: [], status: "ACTIVE" }),
  ScimProvisioningToken: () => ({ scopes: [], ipAllowlist: [], status: "ACTIVE", tokenPrefix: "sweep" }),
  EvidenceRequestDeliverable: () => ({ acceptedKinds: [], status: "PENDING" }),
  WorkflowIntakeLink: () => ({
    workflowTemplateSlug: "general-evidence-record",
    workflowTemplateVersion: 1,
    workflowTemplateSnapshot: {},
    intakeMode: "EXTERNAL_ONE_TIME",
    expiresAtUtc: new Date(Date.now() + 86_400_000),
    allowedAcceptedKinds: [],
    ipAllowlistCidrs: [],
  }),
};

/** What a route's setup may need beyond rows: a real authenticator on a person. */
export type SideTools = {
  enrollTotp: (userId: string) => Promise<void>;
  totpCode: (userId: string) => Promise<string>;
  /** Someone with an account and no membership here. */
  newPerson: () => Promise<Actor>;
  inject: (request: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }) => Promise<{ statusCode: number; json: () => unknown }>;
};
const noTool = async (): Promise<never> => {
  throw new Error("this row factory has no tools");
};
const NO_TOOLS: SideTools = { enrollTotp: noTool, totpCode: noTool, newPerson: noTool, inject: noTool };

export class RowFactory {
  private readonly models: Map<string, DmmfModel>;
  private readonly enums: Map<string, string>;
  readonly failures = new Map<string, string>();

  constructor(
    private readonly prisma: any,
    dmmf: Dmmf = readSchema(),
    readonly tools: SideTools = NO_TOOLS,
  ) {
    this.models = new Map(dmmf.models.map((m) => [m.name, m]));
    this.enums = new Map(dmmf.enums.map((e) => [e.name, e.values[0]?.name ?? ""]));
  }

  private accessor(model: string): any {
    return this.prisma[model.charAt(0).toLowerCase() + model.slice(1)];
  }

  private scalar(field: DmmfField): unknown {
    if (field.kind === "enum") return this.enums.get(field.type);
    const native = field.nativeType?.[0];
    switch (field.type) {
      case "String":
        if (native === "Uuid") return randomUUID();
        return `s${randomUUID().slice(0, 7)}`;
      case "Int":
        return 1;
      case "BigInt":
        return 1n;
      case "Float":
      case "Decimal":
        return 1;
      case "Boolean":
        return false;
      case "DateTime":
        return new Date();
      case "Json":
        return {};
      case "Bytes":
        return Buffer.from("sweep");
      default:
        return undefined;
    }
  }

  /** One row of `model` owned by the row set's tenant, with parents made as needed. */
  async make(set: RowSet, model: string, alias?: string, extra?: Record<string, unknown>): Promise<string | null> {
    const shape = this.models.get(model);
    if (!shape) {
      this.failures.set(model, "no such model");
      return null;
    }
    const tenant = set.tenant;
    const data: Record<string, unknown> = {};
    const fromRelation = new Set<string>();
    for (const field of shape.fields) {
      if (field.kind !== "object") continue;
      const fks = field.relationFromFields ?? [];
      if (fks.length === 0) continue;
      const required = fks.some((fk) => shape.fields.find((f) => f.name === fk)?.isRequired);
      const tenantLinked = fks.some((fk) => TENANT_FIELDS.has(fk) || ORG_FIELDS.has(fk));
      if (!required && !tenantLinked) continue;
      fks.forEach((fk) => fromRelation.add(fk));
      if (fks.length !== 1) continue;
      // A row's author or owner is the tenant's owner, who runs the control.
      const parent = field.type === "User" ? set.actorId : await set.id(field.type);
      if (parent === null) {
        if (required) return null;
        continue;
      }
      data[fks[0]] = parent;
    }
    for (const field of shape.fields) {
      if (field.kind === "object" || field.isUpdatedAt || data[field.name] !== undefined) continue;
      if (TENANT_FIELDS.has(field.name) && field.type === "String") {
        data[field.name] = tenant.teamId;
        continue;
      }
      if (ORG_FIELDS.has(field.name) && field.type === "String") {
        data[field.name] = tenant.orgId;
        continue;
      }
      if (!field.isRequired || field.hasDefaultValue || field.isList) continue;
      if (fromRelation.has(field.name)) continue;
      if (/UserId$/.test(field.name) && field.type === "String") {
        data[field.name] = set.actorId;
        continue;
      }
      if (field.name === "id") continue;
      data[field.name] = this.scalar(field);
    }
    const patches = [
      ROW_OVERRIDES[model]?.(tenant),
      alias && alias !== model ? ROW_OVERRIDES[alias]?.(tenant) : undefined,
      set.rowPatch(model),
      alias && alias !== model ? set.rowPatch(alias) : undefined,
      extra,
    ];
    for (const patch of patches) {
      for (const [key, value] of Object.entries(patch ?? {})) data[key] = await materialize(value, set);
    }
    try {
      const row = await this.accessor(model).create({ data });
      return (row.id as string) ?? null;
    } catch (err) {
      this.failures.set(alias ?? model, String((err as Error).message).replace(/\s+/g, " ").slice(-240));
      return null;
    }
  }
}

/** The rows one side of one request stands on. Fresh for every route, made on demand. */
export class RowSet {
  private readonly ids = new Map<string, string | null>();
  private restrictedCaseId: string | null = null;

  /** Who stands for this side: authors of its rows, the person a row calls "mine". */
  actorId: string;
  private prepared = false;

  constructor(
    readonly factory: RowFactory,
    readonly prisma: any,
    readonly tenant: Tenant,
    private readonly opts: { restricted?: boolean; hint?: RouteHint } = {},
  ) {
    this.actorId = tenant.owner.id;
  }

  rowPatch(name: string): Record<string, unknown> | undefined {
    return this.opts.hint?.rows?.[name];
  }

  /** A named value a route's setup made, read later as `$name`. */
  put(name: string, id: string): void {
    this.ids.set(name, id);
  }

  /** A named value, if this side has made it. */
  known(name: string): string | null {
    return this.ids.get(name) ?? null;
  }

  /** Makes what the route needs to exist before any request names it. */
  async prepare(): Promise<void> {
    if (this.prepared) return;
    this.prepared = true;
    await this.opts.hint?.setup?.(this);
    for (const name of this.opts.hint?.ensure ?? []) await this.id(name);
  }

  /** The ids this set made, which are what an effect is searched for. */
  markers(): string[] {
    // Rows only: a name or a raw token a recipe noted is not a row of this side.
    return [...this.ids.values()].filter((v): v is string => typeof v === "string" && UUID.test(v));
  }

  async id(model: string): Promise<string | null> {
    if (this.ids.has(model)) return this.ids.get(model) ?? null;
    const made = await this.resolve(model);
    this.ids.set(model, made);
    return made;
  }

  private async resolve(model: string): Promise<string | null> {
    const t = this.tenant;
    const named = this.opts.hint?.make?.[model];
    if (named) return this.factory.make(this, named.model, model, named.data);
    if (model === "Actor") return this.actorId;
    if (model === "Owner") return t.owner.id;
    if (model === "Team") return t.teamId;
    if (model === "Organization") return t.orgId;
    if (model === "User") return t.member.id;
    if (model === "Admin") return t.admin.id;
    if (model === "Admin2") return t.admin2.id;
    if (model === "Approver") return t.approver.id;
    if (model === "TeamMember") {
      const row = await this.prisma.teamMember.findFirst({
        where: { teamId: t.teamId, userId: t.member.id },
        select: { id: true },
      });
      return row?.id ?? t.member.id;
    }
    if (model === "OrganizationMembership") {
      const row = await this.prisma.organizationMembership.findFirst({
        where: { organizationId: t.orgId, userId: t.member.id },
        select: { id: true },
      });
      return row?.id ?? null;
    }
    if (model === "EvidenceTrashed") return this.factory.make(this, "Evidence", "EvidenceTrashed");
    const id = await this.factory.make(this, model);
    if (id && this.opts.restricted && model === "Case") {
      await this.prisma.case.update({ where: { id }, data: { restrictedAtUtc: new Date() } });
      this.restrictedCaseId = id;
    }
    if (id && this.opts.restricted && model === "Evidence") {
      const caseId = await this.id("Case");
      if (caseId) await this.prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: id, teamId: t.teamId } });
    }
    return id;
  }
}

// ---------------------------------------------------------------------------
// Bodies: symbols stand for rows until a request is sent
// ---------------------------------------------------------------------------

type Json = unknown;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYMBOL = /^\$([A-Za-z]+)$/;

/** Field name to the row it most likely names. */
function modelForField(name: string): string | null {
  const stem = name.replace(/Ids?$/, "");
  const direct: Record<string, string> = {
    evidence: "Evidence",
    record: "Evidence",
    case: "Case",
    matter: "Case",
    workflow: "EvidenceReviewWorkflow",
    review: "EvidenceReviewWorkflow",
    annotation: "EvidenceAnnotation",
    comment: "EvidenceReviewerComment",
    package: "EvidenceExchangePackage",
    template: "EvidenceWorkflowTemplate",
    collaborationTeam: "CollaborationTeam",
    thread: "DiscussionThread",
    schema: "CodingSchema",
    policy: "GovernancePolicy",
    department: "Department",
    project: "RedactionProject",
    version: "RedactionVersion",
    report: "Report",
    hold: "EvidenceLegalHold",
    legalHold: "EvidenceLegalHold",
    escalation: "ReviewEscalation",
    criteriaSet: "ReviewerCriteriaSet",
  };
  return direct[stem] ?? null;
}

function fillField(name: string, issue: CapturedIssue | null): Json {
  const expected = issue?.expected;
  if (issue?.values && issue.values.length > 0) return issue.values[0];
  if (issue?.code === "too_small" && issue.origin === "array") {
    const inner = fillField(name.replace(/s$/, ""), null);
    return Array.from({ length: Math.max(1, Number(issue.minimum ?? 1)) }, () => inner);
  }
  if (issue?.code === "too_small" && issue.origin === "number") return Number(issue.minimum ?? 1);
  if (issue?.code === "too_big" && issue.origin === "string") return "sweep";
  if (issue?.format === "uuid") return randomUUID();
  if (issue?.format === "email") return `sweep-${randomUUID().slice(0, 8)}@test.proovra.local`;
  if (issue?.format === "url") return "https://sweep.test/hook";
  if (issue?.format === "datetime") return new Date(Date.now() + 86_400_000).toISOString();
  if (issue?.format === "regex") return /[Ss]lug|[Kk]ey|[Cc]ode/.test(name) ? "sweep-value" : "sweep";
  if (/^(teamId|workspaceId)$/.test(name)) return "$Team";
  if (/^(organizationId|orgId)$/.test(name)) return "$Organization";
  if (/UserIds$/.test(name) || /^(userIds|memberIds|assigneeIds)$/.test(name)) return ["$User"];
  if (/(UserId|^userId|^memberId|^assigneeId|^reviewerId)$/.test(name)) return "$User";
  const model = modelForField(name);
  if (/Ids$/.test(name)) return model ? [`$${model}`] : [randomUUID()];
  if (/Id$/.test(name)) return model ? `$${model}` : randomUUID();
  if (expected === "array") return [];
  if (expected === "object" || expected === "record") return {};
  if (expected === "number" || expected === "int") return 1;
  if (expected === "boolean") return true;
  if (expected === "date" || /(At|AtUtc|Date|Until|Utc)$/.test(name)) return new Date(Date.now() + 86_400_000).toISOString();
  if (/email/i.test(name)) return `sweep-${randomUUID().slice(0, 8)}@test.proovra.local`;
  if (/(url|Url|uri|Uri|href)$/.test(name)) return "https://sweep.test/hook";
  if (/(sha256|hash|Hash)$/.test(name)) return "a".repeat(64);
  return "sweep value long enough for a minimum length";
}

type CapturedIssue = {
  code: string;
  path: Array<string | number>;
  expected?: string;
  values?: unknown[];
  keys?: string[];
  origin?: string;
  minimum?: number | bigint;
  format?: string;
};

export function installZodCapture(): { take: () => CapturedIssue[] } {
  let issues: CapturedIssue[] = [];
  z.config({
    customError: (iss: unknown) => {
      const raw = iss as CapturedIssue;
      issues.push({
        code: raw.code,
        path: (raw.path ?? []) as Array<string | number>,
        expected: raw.expected,
        values: raw.values,
        keys: raw.keys,
        origin: raw.origin,
        minimum: raw.minimum,
        format: raw.format,
      });
      return undefined;
    },
  });
  return {
    take: () => {
      const taken = issues;
      issues = [];
      return taken;
    },
  };
}

function setAt(target: Record<string, Json>, path: Array<string | number>, value: Json): void {
  let cursor: any = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = path[i + 1];
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== "object") {
      cursor[key] = typeof next === "number" ? [] : {};
    }
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

function deleteAt(target: Record<string, Json>, key: string): void {
  delete target[key];
}

export type RequestShape = {
  body: Record<string, Json>;
  query: Record<string, Json>;
};

/**
 * What one route needs that schema and Zod cannot say. Every side gets the same
 * recipe, so the attacker meets the victim's row in the state the control proved
 * valid. `$Name` is a row or a person; a function is computed per side.
 */
export type RouteHint = Partial<RequestShape> & {
  /** The route's true audience, where its prefix misleads. */
  klass?: RouteClass;
  /** Who runs the control. Defaults to the class's actor. */
  actor?: "owner" | "operator" | "member";
  /** The control's person, when the route is theirs alone (an invitee). */
  session?: (set: RowSet) => Promise<Actor>;
  /** Field overrides on a model, or on a name from `make`. */
  rows?: Record<string, Record<string, unknown>>;
  /** Further rows, readable as `$Name`. */
  make?: Record<string, { model: string; data?: Record<string, unknown> }>;
  /** Names that must exist before the request, though nothing in it says so. */
  ensure?: string[];
  /** Path values by position: `$Name` or a literal. */
  path?: string[];
  setup?: (set: RowSet) => Promise<void>;
  /** A credential that is not a session: headers for this side's rows. */
  credential?: (set: RowSet) => Promise<Record<string, string>>;
  /** The credential is one deployment secret, with no tenant in it. */
  machine?: boolean;
  /** Why no control can succeed here. Attacks still run; the route stays unproven. */
  unreachable?: string;
};

const isPlainObject = (value: unknown): value is Record<string, Json> =>
  Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

async function materialize(value: Json, set: RowSet): Promise<Json> {
  if (typeof value === "function") return (value as (s: RowSet) => unknown)(set);
  if (typeof value === "string") {
    const m = value.match(SYMBOL);
    if (!m) return value;
    return (await set.id(m[1])) ?? randomUUID();
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => materialize(v, set)));
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await materialize(v, set);
    return out;
  }
  return value;
}

/** The bulk form: each array of symbols holds the actor's row and the victim's. */
async function materializeBulk(value: Json, own: RowSet, victim: RowSet): Promise<Json> {
  if (typeof value === "string" || typeof value === "function") return materialize(value, victim);
  if (Array.isArray(value)) {
    const allSymbols = value.length > 0 && value.every((v) => typeof v === "string" && SYMBOL.test(v));
    if (allSymbols) return [...(await materialize(value, own)) as Json[], ...(await materialize(value, victim)) as Json[]];
    return Promise.all(value.map((v) => materializeBulk(v, own, victim)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await materializeBulk(v, own, victim);
    return out;
  }
  return value;
}

function containsSymbol(value: Json, predicate: (name: string) => boolean): boolean {
  if (typeof value === "string") {
    const m = value.match(SYMBOL);
    return Boolean(m && predicate(m[1]));
  }
  if (Array.isArray(value)) return value.some((v) => containsSymbol(v, predicate));
  if (value && typeof value === "object") return Object.values(value).some((v) => containsSymbol(v, predicate));
  return false;
}

const hasArrayOfSymbols = (value: Json): boolean => {
  if (Array.isArray(value)) {
    return value.some((v) => typeof v === "string" && SYMBOL.test(v)) || value.some(hasArrayOfSymbols);
  }
  if (value && typeof value === "object") return Object.values(value).some(hasArrayOfSymbols);
  return false;
};

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type Sent = { status: number; code: string; body: string };

function codeOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as any;
    if (typeof parsed?.error === "string") return parsed.error;
    return String(parsed?.error?.code ?? parsed?.code ?? parsed?.denial ?? "");
  } catch {
    return "";
  }
}

function pathFor(url: string, values: string[]): string {
  let i = 0;
  return url
    .split("/")
    .map((part) => (part.startsWith(":") ? encodeURIComponent(values[i++]) : part))
    .join("/")
    .replace(/\*$/, "sweep");
}

function queryString(query: Record<string, Json>): string {
  const pairs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type AttackVariant =
  | "anonymous"
  | "cross-tenant"
  | "claimed-workspace"
  | "mixed-body"
  | "bulk-array"
  | "nested-parent-own"
  | "nested-child-own"
  | "viewer"
  | "off-list"
  | "removed-member"
  | "wrong-credential";

export type AttackResult = {
  variant: AttackVariant;
  status: number;
  code: string;
  outcome: "REFUSED" | "REFUSED_BUT_WROTE" | "BAD_PAYLOAD" | "GATED" | "ACCEPTED_NO_EFFECT" | "ACCEPTED_EFFECT" | "LEAK" | "SERVER_ERROR" | "OTHER";
  effectTables?: string[];
  excerpt?: string;
};

export type ControlOutcome =
  | "AUTHORIZED_2XX"
  | "BAD_PAYLOAD"
  | "FEATURE_OR_PLAN"
  | "PRECONDITION"
  | "MISSING_FIXTURE"
  | "UNAVAILABLE"
  | "DENIED"
  | "SERVER_ERROR"
  | "RETIRED"
  | "NOT_RUN";

export type RouteResult = {
  key: string;
  klass: RouteClass;
  params: PathParam[];
  missingRows: string[];
  control: { status: number; code: string; outcome: ControlOutcome; attempts: number; shape: RequestShape; issues?: unknown; excerpt?: string };
  attacks: AttackResult[];
  disposition: string;
};

function controlOutcome(status: number, code: string, missingRows: string[]): ControlOutcome {
  if (status >= 200 && status < 300) return "AUTHORIZED_2XX";
  if (status === 410) return "RETIRED";
  if (status === 400 || status === 422) return "BAD_PAYLOAD";
  if (status === 402) return "FEATURE_OR_PLAN";
  if (status === 403 && /ENTITLEMENT|FEATURE|PLAN|CONTRACT|feature|plan|contract/.test(code)) return "FEATURE_OR_PLAN";
  if (status === 409) return /ENTITLEMENT|CONTRACT/.test(code) ? "FEATURE_OR_PLAN" : "PRECONDITION";
  if (status === 404) return missingRows.length > 0 ? "MISSING_FIXTURE" : "MISSING_FIXTURE";
  if (status === 401 || status === 403) return "DENIED";
  if (status === 501 || status === 503) return "UNAVAILABLE";
  if (status >= 500) return "SERVER_ERROR";
  return "PRECONDITION";
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** Written by a refusal on purpose; a victim id in these is the refusal being recorded. */
export const REFUSAL_LOG_TABLES = new Set([
  "security_events",
  "access_anomalies",
  "risk_signals",
  "analytics_events",
  "analytics_sessions",
  "AnalyticsEvent",
  "admin_audit_logs",
  "governance_policy_audits",
  "intelligence_activity_events",
  "step_up_challenges",
  "organization_audit_events",
  "sweep_write_log",
]);

/** A refusal by a validating lookup: the row is not this tenant's, or the person is not its member. */
const NAMED_REFUSAL =
  /NOT_FOUND|not_found|NOT_MEMBER|not_workspace_member|NOT_A_MEMBER|invalid_assignee|NOT_ELIGIBLE|INVALID_EVIDENCE|mismatch|REGION_INVALID|POLICY_REJECTED|indexing_failed|NOT_IN_WORKSPACE|grant_issue_denied|duplicate_or_invalid_relationship|code_invalid|stale_evidence_revision|NONCE_MISMATCH|current_password_invalid|no_password_set|DERIVATIVE_NOT_READY|token_unknown|transfer_target_not_active_member/;

const SESSION_ENDING = [
  /^POST \/v1\/auth\/logout/,
  /^POST \/v1\/identity-security\/my-sessions/,
  /^POST \/v1\/users\/me\/sessions/,
  /^DELETE \/v1\/users\/me$/,
];

export type SweepDeps = {
  h: IntegrationHarness;
  prisma: any;
  signToken: (user: { id: string; email: string }) => string;
  /** Attacker and victim tenants stay untouched by controls. */
  attacker: Tenant;
  victim: Tenant;
  throwaway: () => Promise<Tenant>;
  removedFromVictim: Actor;
  newMember: (teamId: string, role: string) => Promise<Actor>;
  newPerson: () => Promise<Actor>;
  restoreAttacker: () => Promise<void>;
  newOperator: () => Promise<{ token: string; userId: string }>;
  /** Body seeds for routes whose valid shape repair cannot find. */
  hints: Record<string, RouteHint | undefined>;
};

export async function installWriteLog(prisma: any): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS sweep_write_log (id bigserial PRIMARY KEY, tbl text NOT NULL, op text NOT NULL, doc text NOT NULL)`,
  );
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION sweep_log_write() RETURNS trigger AS $body$
    BEGIN
      INSERT INTO sweep_write_log (tbl, op, doc)
      VALUES (TG_TABLE_NAME, TG_OP, CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD)::text ELSE row_to_json(NEW)::text END);
      RETURN NULL;
    END $body$ LANGUAGE plpgsql`);
  const tables = (await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('sweep_write_log', '_prisma_migrations')`,
  )) as Array<{ tablename: string }>;
  for (const { tablename } of tables) {
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER sweep_log AFTER INSERT OR UPDATE OR DELETE ON "${tablename}" FOR EACH ROW EXECUTE FUNCTION sweep_log_write()`,
    );
  }
}

async function drainWrites(prisma: any): Promise<Array<{ tbl: string; doc: string }>> {
  const rows = (await prisma.$queryRawUnsafe(`SELECT tbl, doc FROM sweep_write_log`)) as Array<{ tbl: string; doc: string }>;
  await prisma.$executeRawUnsafe(`TRUNCATE sweep_write_log`);
  return rows;
}

export class WriteSweep {
  readonly stepUpFailures = new Map<string, string>();
  private readonly zod = installZodCapture();
  private readonly factory: RowFactory;
  private readonly stepUp: ReturnType<typeof createStepUpCeremony>;

  constructor(private readonly deps: SweepDeps) {
    this.stepUp = createStepUpCeremony({
      prisma: deps.prisma,
      inject: (o) => deps.h.app.inject(o as never) as never,
    });
    this.factory = new RowFactory(deps.prisma, undefined, {
      enrollTotp: (userId) => this.stepUp.enroll(userId),
      totpCode: (userId) => this.stepUp.freshCode(userId),
      newPerson: () => deps.newPerson(),
      inject: (request) => deps.h.app.inject(request as never) as never,
    });
  }

  get fixtureFailures(): Map<string, string> {
    return this.factory.failures;
  }

  private async send(
    route: LiveRoute,
    pathValues: string[],
    shape: { body: Json; query: Record<string, Json> },
    actor: { id?: string; token: string } | null,
    headers: Record<string, string>,
    extra?: { stepUpTeamId?: string },
  ): Promise<Sent> {
    const url = pathFor(route.url, pathValues) + queryString(shape.query);
    let payload = shape.body;
    const inject = async (more: Record<string, string>) => {
      const res = await this.deps.h.app.inject({
        method: route.method as never,
        url,
        headers: {
          ...(actor ? { authorization: `Bearer ${actor.token}` } : {}),
          ...headers,
          ...more,
        },
        ...(route.method === "DELETE" && Object.keys(payload as object).length === 0
          ? {}
          : { payload: payload as never }),
      });
      return { status: res.statusCode, code: codeOf(res.body), body: res.body };
    };
    let sent = await inject({});
    // The account tier asks for a proof in the body, not a challenge.
    if (sent.code === "STEP_UP_REQUIRED" && actor?.id && extra?.stepUpTeamId && this.isAccountStepUp(sent.body)) {
      await this.stepUp.enroll(actor.id);
      payload = { ...(shape.body as object), stepUp: { method: "mfa", code: await this.stepUp.freshCode(actor.id) } };
      sent = await inject({});
    }
    if (sent.code === "STEP_UP_REQUIRED" && actor?.id && extra?.stepUpTeamId) {
      const purpose = this.purposeFrom(sent.body);
      if (purpose) {
        try {
          const details = (JSON.parse(sent.body) as any).error ?? {};
          const header = await this.stepUp.approvedHeader({
            token: actor.token,
            userId: actor.id,
            teamId: extra.stepUpTeamId,
            purpose,
            ...(details.resourceKind ? { resourceKind: details.resourceKind } : {}),
            ...(details.resourceId ? { resourceId: details.resourceId } : {}),
          });
          sent = await inject(header);
        } catch (err) {
          // A ceremony that will not complete leaves the STEP_UP_REQUIRED answer.
          this.stepUpFailures.set(purpose, String((err as Error).message).slice(0, 200));
        }
      }
    }
    return sent;
  }

  private isAccountStepUp(body: string): boolean {
    try {
      return Array.isArray((JSON.parse(body) as any)?.error?.methods);
    } catch {
      return false;
    }
  }

  private purposeFrom(body: string): string | null {
    try {
      const parsed = JSON.parse(body) as any;
      return parsed?.error?.purpose ?? parsed?.error?.details?.purpose ?? parsed?.purpose ?? null;
    } catch {
      return null;
    }
  }

  private async pathValues(params: PathParam[], set: RowSet, missing?: string[], hint?: RouteHint): Promise<string[]> {
    const out: string[] = [];
    if (hint?.path) {
      for (const value of hint.path) out.push(String(await materialize(value, set)));
      return out;
    }
    for (const p of params) {
      if (p.name === ":type") {
        out.push("ORGANIZATION");
        continue;
      }
      const id = p.model ? await set.id(p.model) : null;
      if (!id) {
        missing?.push(p.model ?? `unmapped:${p.name}`);
        out.push(randomUUID());
      } else out.push(id);
    }
    return out;
  }

  /** Discovers a valid request as an authorized actor, on rows nobody else needs. */
  private async runControl(route: LiveRoute, params: PathParam[], klass: RouteClass, missing: string[]) {
    const tenant = await this.deps.throwaway();
    const hint = this.deps.hints[route.key];
    const set = new RowSet(this.factory, this.deps.prisma, tenant, { hint });
    const shape: RequestShape = {
      body: { ...(hint?.body ?? {}) },
      // A collaboration route's own :teamId is the group, so the workspace travels in
      // the header there and a `teamId` query would name something else.
      query: { ...(route.url.startsWith("/v1/collaboration-teams/:") ? {} : { teamId: "$Team" }), ...(hint?.query ?? {}) },
    };
    const who = hint?.actor ?? (klass === "platform" ? "operator" : "owner");
    const operator = who === "operator" ? await this.deps.newOperator() : null;
    if (operator) {
      await this.deps.prisma.teamMember.create({
        data: { teamId: tenant.teamId, userId: operator.userId, role: "ADMIN", status: "ACTIVE" },
      });
    }
    const personal = hint?.session ? await hint.session(set) : null;
    const actor: { id: string; token: string } | null = hint?.credential
      ? null
      : personal ?? (operator ? { id: operator.userId, token: operator.token } : who === "member" ? tenant.member : tenant.owner);
    if (actor) set.actorId = actor.id;
    await set.prepare();
    const values = await this.pathValues(params, set, missing, hint);
    const headers = {
      "x-proovra-workspace-id": tenant.teamId,
      ...(hint?.credential ? await hint.credential(set) : {}),
    };
    let sent: Sent = { status: 0, code: "", body: "" };
    let attempts = 0;
    let lastIssues: CapturedIssue[] = [];
    for (; attempts < 12; attempts++) {
      const materialized = {
        body: await materialize(shape.body, set),
        query: (await materialize(shape.query, set)) as Record<string, Json>,
      };
      this.zod.take();
      sent = await this.send(route, values, materialized, actor, headers, { stepUpTeamId: tenant.teamId });
      await this.deps.h.handlersSettled();
      if (sent.status !== 400 && sent.status !== 422) break;
      const issues = this.zod.take();
      lastIssues = issues;
      if (issues.length === 0) break;
      let changed = false;
      for (const issue of issues) {
        if (issue.code === "unrecognized_keys") {
          for (const key of issue.keys ?? []) {
            if (key in shape.query) {
              delete shape.query[key];
              changed = true;
            }
            if (issue.path.length === 0 && key in shape.body) {
              deleteAt(shape.body, key);
              changed = true;
            }
          }
          continue;
        }
        if (issue.path.length === 0) continue;
        const name = String([...issue.path].reverse().find((p) => typeof p === "string") ?? "");
        const value = fillField(name, issue);
        const key = String(issue.path[0]);
        if (issue.path.length === 1 && key in shape.body && !(key in shape.query) && route.method !== "GET") {
          // Already sent in the body and still missing: the route reads it from the query.
          if (JSON.stringify(shape.body[key]) === JSON.stringify(value)) {
            shape.query[key] = value;
            changed = true;
            continue;
          }
        }
        setAt(shape.body, issue.path, value);
        changed = true;
      }
      if (!changed) break;
    }
    return { sent, attempts: attempts + 1, shape, tenant, set, lastIssues };
  }

  private async attack(
    variant: AttackVariant,
    route: LiveRoute,
    pathValues: string[],
    payload: { body: Json; query: Record<string, Json> },
    actor: Actor | null,
    headers: Record<string, string>,
    markers: string[],
    stepUpTeamId?: string,
  ): Promise<AttackResult> {
    await drainWrites(this.deps.prisma);
    const sent = await this.send(route, pathValues, payload, actor, headers, stepUpTeamId ? { stepUpTeamId } : undefined);
    await this.deps.h.handlersSettled();
    const insider = variant === "viewer";
    // An id the request itself carried, echoed in a per-item refusal, discloses nothing.
    const sentText = `${pathValues.join(" ")} ${JSON.stringify(payload)}`;
    const leakable = markers.filter((m) => !sentText.includes(m));
    const writes = await drainWrites(this.deps.prisma);
    const hits = writes.filter((w) => !REFUSAL_LOG_TABLES.has(w.tbl) && markers.some((m) => w.doc.includes(m)));
    const effectTables = [...new Set(hits.map((w) => w.tbl))];
    const ok = sent.status >= 200 && sent.status < 300;
    let outcome: AttackResult["outcome"];
    if (ok && hits.length > 0) outcome = "ACCEPTED_EFFECT";
    else if (hits.length > 0) outcome = "REFUSED_BUT_WROTE";
    else if (ok && !insider && leakable.some((m) => sent.body.includes(m))) outcome = "LEAK";
    else if (ok) outcome = "ACCEPTED_NO_EFFECT";
    else if (sent.status >= 500 && sent.status !== 503 && sent.status !== 501) outcome = "SERVER_ERROR";
    else if ([401, 403, 404].includes(sent.status)) outcome = "REFUSED";
    else if ([400, 409, 422].includes(sent.status) && NAMED_REFUSAL.test(sent.code)) outcome = "REFUSED";
    else if (sent.status === 400 || sent.status === 422) outcome = "BAD_PAYLOAD";
    else if ([402, 409, 410, 412, 429, 501, 503].includes(sent.status)) outcome = "GATED";
    else outcome = "OTHER";
    return {
      variant,
      status: sent.status,
      code: sent.code,
      outcome,
      ...(effectTables.length ? { effectTables } : {}),
      ...(outcome === "LEAK" || outcome === "ACCEPTED_EFFECT" ? { excerpt: sent.body.slice(0, 300) } : {}),
    };
  }

  async sweepRoute(route: LiveRoute): Promise<RouteResult> {
    const { prisma, attacker: fixedAttacker, victim: fixedVictim } = this.deps;
    // A route may end the actor's own session or membership (`/leave`, revoke-all),
    // so each route gets its own inside actors and a newly signed attacker session.
    const attacker: Tenant = {
      ...fixedAttacker,
      owner: { ...fixedAttacker.owner, token: this.deps.signToken(fixedAttacker.owner) },
    };
    const viewer = await this.deps.newMember(fixedVictim.teamId, "VIEWER");
    const offList = await this.deps.newMember(fixedVictim.teamId, "ADMIN");
    const victim: Tenant = { ...fixedVictim, viewer };
    await this.deps.restoreAttacker();
    const hint = this.deps.hints[route.key];
    const klass = hint?.klass ?? routeClass(route);
    const params = pathParams(route.url);
    const missing: string[] = [];
    await prisma.user.update({ where: { id: attacker.owner.id }, data: { currentWorkspaceId: attacker.teamId } });

    const empty: RequestShape = { body: {}, query: {} };
    const result: RouteResult = {
      key: route.key,
      klass,
      params,
      missingRows: [],
      control: { status: 0, code: "", outcome: "NOT_RUN", attempts: 0, shape: empty },
      attacks: [],
      disposition: "",
    };

    if (klass === "public") {
      result.disposition = "NOT_APPLICABLE_PUBLIC_OR_CREDENTIAL_CEREMONY";
      return result;
    }
    if (SESSION_ENDING.some((r) => r.test(route.key))) {
      result.disposition = "NOT_APPLICABLE_ACTOR_SESSION";
      return result;
    }

    const hasControl = klass === "token" ? Boolean(hint?.credential ?? hint?.session) : klass !== "retired";
    const control = hasControl ? await this.runControl(route, params, klass, missing) : null;
    if (control) {
      result.control = {
        status: control.sent.status,
        code: control.sent.code,
        outcome: controlOutcome(control.sent.status, control.sent.code, missing),
        attempts: control.attempts,
        shape: control.shape,
        ...(control.sent.status >= 300 ? { excerpt: control.sent.body.slice(0, 200), issues: control.lastIssues } : {}),
      };
    }
    const shape = control?.shape ?? { body: {}, query: { teamId: "$Team" } };
    result.missingRows = [...new Set(missing)];

    // Rows on each side for this route.
    const victimRows = new RowSet(this.factory, prisma, victim, { hint });
    const ownRows = new RowSet(this.factory, prisma, attacker, { hint });
    const restrictedRows = new RowSet(this.factory, prisma, victim, { restricted: true, hint });
    await victimRows.prepare();
    await ownRows.prepare();
    const victimPath = await this.pathValues(params, victimRows, undefined, hint);
    const ownPath = await this.pathValues(params, ownRows, undefined, hint);
    const victimBody = await materialize(shape.body, victimRows);
    const victimQuery = (await materialize(shape.query, victimRows)) as Record<string, Json>;
    const ownBody = await materialize(shape.body, ownRows);
    const ownQuery = (await materialize(shape.query, ownRows)) as Record<string, Json>;
    const mixedBody = { ...(victimBody as object), ...this.pickTenant(ownBody) };
    const markers = [
      ...victimRows.markers(),
      victim.teamId,
      victim.orgId,
      victim.owner.id,
    ];
    const ownHeaders = { "x-proovra-workspace-id": attacker.teamId };
    const claimHeaders = { "x-proovra-workspace-id": victim.teamId, "x-team-id": victim.teamId };

    const namesRows = params.some((p) => p.model && p.model !== "Team" && p.model !== "User");
    const bodyNamesRows = containsSymbol(shape.body, (n) => n !== "Team" && n !== "Organization");
    const aimed = params.length > 0 || containsSymbol(shape.body, () => true) || containsSymbol(shape.query, () => true);

    const run = (a: Promise<AttackResult>) => a.then((r) => result.attacks.push(r));

    await run(this.attack("anonymous", route, victimPath, { body: victimBody, query: victimQuery }, null, {}, markers));

    if (klass === "retired") {
      result.disposition = "RETIRED";
      return result;
    }

    // A credential that is not a session: the attacker's own on the victim's row, or,
    // for a deployment secret with no tenant in it, a wrong one and a plain session.
    if (hint?.credential && Object.keys(await hint.credential(ownRows)).length === 0) {
      // The capability is the path itself: a session adds nothing, and the attacker's
      // session on the victim's capability is the same request anyone holding it makes.
      await run(this.attack("claimed-workspace", route, await this.pathValues(params, ownRows, undefined, hint), { body: ownBody, query: ownQuery }, attacker.owner, claimHeaders, markers, attacker.teamId));
      if (params.length >= 2) {
        // The attacker's own capability, aimed at the victim's child.
        await run(this.attack("nested-parent-own", route, [ownPath[0], ...victimPath.slice(1)], { body: ownBody, query: ownQuery }, null, {}, markers));
      }
      result.disposition = this.dispose(result, true, true);
      return result;
    }
    if (hint?.credential) {
      const wrong = Object.fromEntries(
        Object.keys(await hint.credential(ownRows)).map((k) => [k, `sweep-wrong-${randomUUID()}`]),
      );
      await run(this.attack("wrong-credential", route, victimPath, { body: victimBody, query: victimQuery }, null, wrong, markers));
      if (!hint.machine) {
        const theirs = await hint.credential(ownRows);
        await run(this.attack("cross-tenant", route, victimPath, { body: mixedBody, query: ownQuery }, null, theirs, markers));
      }
      await run(this.attack("claimed-workspace", route, victimPath, { body: victimBody, query: victimQuery }, attacker.owner, claimHeaders, markers, attacker.teamId));
      result.disposition = this.dispose(result, true, true);
      return result;
    }

    await run(
      this.attack("cross-tenant", route, victimPath, { body: mixedBody, query: ownQuery }, attacker.owner, ownHeaders, markers, attacker.teamId),
    );
    await run(
      this.attack("claimed-workspace", route, victimPath, { body: victimBody, query: victimQuery }, attacker.owner, claimHeaders, markers, attacker.teamId),
    );
    // One foreign field at a time, the rest the attacker's own. Aiming every field at
    // the victim lets an unrelated check refuse first and hide a missing guard: that
    // is how GOV-001 stayed hidden behind the approver check.
    for (const [field, value] of Object.entries(shape.body)) {
      if (!containsSymbol(value, (n) => n !== "Team" && n !== "Organization")) continue;
      const own = ownBody as Record<string, Json>;
      const foreign = (victimBody as Record<string, Json>)[field];
      await run(
        this.attack("mixed-body", route, ownPath, { body: { ...own, [field]: foreign }, query: ownQuery }, attacker.owner, ownHeaders, markers, attacker.teamId),
      );
      if (hasArrayOfSymbols(value)) {
        const bulk = await materializeBulk(value, ownRows, victimRows);
        await run(
          this.attack("bulk-array", route, ownPath, { body: { ...own, [field]: bulk }, query: ownQuery }, attacker.owner, ownHeaders, markers, attacker.teamId),
        );
      }
    }
    if (params.length >= 2) {
      const parentOwn = [ownPath[0], ...victimPath.slice(1)];
      const childOwn = [...victimPath.slice(0, -1), ownPath[ownPath.length - 1]];
      await run(this.attack("nested-parent-own", route, parentOwn, { body: ownBody, query: ownQuery }, attacker.owner, ownHeaders, markers, attacker.teamId));
      await run(this.attack("nested-child-own", route, childOwn, { body: ownBody, query: ownQuery }, attacker.owner, ownHeaders, markers, attacker.teamId));
    }
    if (klass === "tenant" && aimed) {
      const inHeaders = { "x-proovra-workspace-id": victim.teamId };
      await run(this.attack("removed-member", route, victimPath, { body: victimBody, query: victimQuery }, this.deps.removedFromVictim, inHeaders, markers));
      await run(this.attack("viewer", route, victimPath, { body: victimBody, query: victimQuery }, victim.viewer, inHeaders, markers, victim.teamId));
      if (params.some((p) => p.model === "Evidence" || p.model === "Case") || containsSymbol(shape.body, (n) => n === "Evidence" || n === "Case")) {
        await restrictedRows.prepare();
        const restrictedPath = await this.pathValues(params, restrictedRows, undefined, hint);
        const restrictedBody = await materialize(shape.body, restrictedRows);
        const restrictedQuery = (await materialize(shape.query, restrictedRows)) as Record<string, Json>;
        const restrictedMarkers = restrictedRows.markers().filter((m) => m !== victim.teamId && m !== victim.orgId);
        await run(this.attack("off-list", route, restrictedPath, { body: restrictedBody, query: restrictedQuery }, offList, inHeaders, restrictedMarkers, victim.teamId));
      }
    }

    result.disposition = this.dispose(result, aimed, namesRows || bodyNamesRows);
    return result;
  }

  /** A recipe that throws is a gap in this sweep, recorded as one, and the run goes on. */
  failedRoute(route: LiveRoute, err: Error): RouteResult {
    return {
      key: route.key,
      klass: routeClass(route),
      params: pathParams(route.url),
      missingRows: [],
      control: { status: 0, code: String(err.message).slice(-160), outcome: "NOT_RUN", attempts: 0, shape: { body: {}, query: {} } },
      attacks: [],
      disposition: "SWEEP_RECIPE_ERROR",
    };
  }

  private pickTenant(body: Json): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const key of ["teamId", "workspaceId", "organizationId", "orgId"]) {
      const value = (body as Record<string, Json>)[key];
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  private dispose(r: RouteResult, aimed: boolean, namesRows: boolean): string {
    const cross = r.attacks.filter((a) => a.variant !== "viewer");
    if (r.attacks.some((a) => a.outcome === "ACCEPTED_EFFECT" || a.outcome === "LEAK")) return "EFFECT";
    if (cross.some((a) => a.outcome === "SERVER_ERROR")) return "SERVER_ERROR_ON_ATTACK";
    if (!aimed) return "ACTOR_SCOPED_NO_TARGET";
    const proven = r.control.outcome === "AUTHORIZED_2XX";
    const held = cross.every((a) => a.outcome === "REFUSED" || a.outcome === "ACCEPTED_NO_EFFECT");
    if (r.klass === "token") {
      if (r.attacks.length > 0 && r.attacks.every((a) => a.status === 410)) return "RETIRED";
      if (!proven) return "TOKEN_ROUTE_SESSION_REFUSED";
      if (!held) return "CONTROL_OK_ATTACK_NOT_REFUSED_CLEANLY";
      return this.deps.hints[r.key]?.machine ? "PROVEN_MACHINE_SECRET" : "PROVEN_TOKEN";
    }
    if (proven && held) return namesRows ? "PROVEN_REAL_ROWS" : "PROVEN_TENANT_SCOPE";
    if (proven) return "CONTROL_OK_ATTACK_NOT_REFUSED_CLEANLY";
    if (this.deps.hints[r.key]?.unreachable) return "NO_CONTROL_POSSIBLE";
    return `UNPROVEN_${r.control.outcome}`;
  }
}
