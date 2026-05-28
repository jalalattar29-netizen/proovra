/**
 * Phase P1.1 — Visual SAML attribute mapping service.
 *
 * Surfaces the existing `SsoConnection.samlAttributeMapping` JSON
 * column as a structured, previewable, step-up-gated configuration.
 * The actual assertion-time resolution happens in
 * `saml-user-mapping.service.ts` — this service is the
 * configuration + preview layer.
 *
 * What the mapping covers (per the SsoConnection model):
 *
 *   * NameID source attribute (defaults to NameID itself)
 *   * Email attribute name
 *   * Display name attribute name
 *   * Group claim attribute name (advisory only today — group →
 *     role propagation flows through SCIM)
 *   * Default fallback role (MEMBER or VIEWER)
 *   * Group → role map (per-group target role override)
 *
 * Honest scope: the group claim + group → role map are stored on the
 * connection but the platform's authoritative group propagation
 * happens via SCIM Groups (Phase 26). The mapping here is read at
 * assertion time when SCIM isn't authoritative for that connection
 * (`samlScimManaged === false`). When SCIM IS authoritative, the
 * SAML group claim is ignored.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";

export const SAML_MAPPING_PRIVILEGE_PURPOSE =
  "SAML_MAPPING_PRIVILEGE_UPDATE" as const;

// ---------------------------------------------------------------------------
// Schema (returned by GET /v1/saml/mapping/schema)
// ---------------------------------------------------------------------------

export type SamlMappingFieldKind =
  | "string"
  | "enum"
  | "group_role_map";

export type SamlMappingFieldDescriptor = {
  key: string;
  label: string;
  description: string;
  kind: SamlMappingFieldKind;
  required: boolean;
  /** Suggested attribute names when the operator hasn't customized. */
  suggestions: ReadonlyArray<string>;
  /** Bounded enum values when `kind === "enum"`. */
  enumValues?: ReadonlyArray<string>;
  /** Whether changing this field may grant elevated privileges. */
  privilegeAffecting: boolean;
};

export type SamlMappingSchema = {
  version: 1;
  fields: ReadonlyArray<SamlMappingFieldDescriptor>;
  notes: ReadonlyArray<string>;
};

const EMAIL_SUGGESTIONS = [
  "email",
  "emailaddress",
  "mail",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
] as const;

const NAME_SUGGESTIONS = [
  "displayName",
  "name",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "cn",
] as const;

const GROUP_CLAIM_SUGGESTIONS = [
  "groups",
  "memberOf",
  "http://schemas.xmlsoap.org/claims/Group",
] as const;

export function getSamlMappingSchema(): SamlMappingSchema {
  return {
    version: 1,
    fields: [
      {
        key: "email",
        label: "Email attribute",
        description:
          "IdP attribute name carrying the operator's email address. Used to identify or auto-provision the user.",
        kind: "string",
        required: false,
        suggestions: [...EMAIL_SUGGESTIONS],
        privilegeAffecting: false,
      },
      {
        key: "name",
        label: "Display name attribute",
        description:
          "IdP attribute name carrying the operator-visible name. Used to populate the operator's profile display name on first login.",
        kind: "string",
        required: false,
        suggestions: [...NAME_SUGGESTIONS],
        privilegeAffecting: false,
      },
      {
        key: "externalId",
        label: "External subject attribute (NameID override)",
        description:
          "Optional override for the stable external subject ID. Defaults to the assertion's NameID. Change only when the IdP's NameID is unstable.",
        kind: "string",
        required: false,
        suggestions: [],
        privilegeAffecting: true,
      },
      {
        key: "groupClaim",
        label: "Group claim attribute",
        description:
          "IdP attribute name carrying group memberships (advisory only — authoritative role propagation flows through SCIM Groups when configured).",
        kind: "string",
        required: false,
        suggestions: [...GROUP_CLAIM_SUGGESTIONS],
        privilegeAffecting: true,
      },
      {
        key: "defaultRole",
        label: "Default fallback role",
        description:
          "Role assigned when no group claim matches and the user is being JIT-provisioned. Defaults to MEMBER.",
        kind: "enum",
        required: false,
        suggestions: [],
        enumValues: ["MEMBER", "VIEWER"],
        privilegeAffecting: true,
      },
      {
        key: "groupRoleMap",
        label: "Group → role mapping",
        description:
          "Per-group role override. When an assertion carries a matching group, the user is assigned that role instead of the default. OWNER/ADMIN assignments require step-up.",
        kind: "group_role_map",
        required: false,
        suggestions: [],
        privilegeAffecting: true,
      },
    ],
    notes: [
      "Mappings affect only future logins; existing sessions stay on their current role until they re-authenticate.",
      "Changes that grant OWNER or ADMIN privileges via a new group mapping require step-up.",
      "Group claim resolution is suppressed when SCIM is authoritative for this connection (samlScimManaged === true).",
    ],
  };
}

// ---------------------------------------------------------------------------
// Mapping payload (the JSON we read/write on SsoConnection)
// ---------------------------------------------------------------------------

export type SamlMappingPayload = {
  email?: string | null;
  name?: string | null;
  externalId?: string | null;
  groupClaim?: string | null;
  defaultRole?: "MEMBER" | "VIEWER" | null;
  groupRoleMap?: ReadonlyArray<{
    group: string;
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  }> | null;
};

// ---------------------------------------------------------------------------
// Current mapping read
// ---------------------------------------------------------------------------

export type CurrentSamlMapping = {
  connectionId: string;
  teamId: string;
  provider: string;
  status: string;
  scimManaged: boolean;
  mapping: SamlMappingPayload;
  jitDefaultRole: string | null;
};

export async function getCurrentSamlMapping(
  input: { teamId: string; connectionId: string },
  client: PrismaClient = defaultPrisma,
): Promise<CurrentSamlMapping | null> {
  const conn = await client.ssoConnection.findFirst({
    where: { id: input.connectionId, teamId: input.teamId },
    select: {
      id: true,
      teamId: true,
      provider: true,
      status: true,
      samlScimManaged: true,
      samlAttributeMapping: true,
      jitDefaultRole: true,
    },
  });
  if (!conn) return null;
  const mapping = normaliseMapping(conn.samlAttributeMapping);
  return {
    connectionId: conn.id,
    teamId: conn.teamId,
    provider: conn.provider,
    status: conn.status,
    scimManaged: conn.samlScimManaged ?? false,
    mapping,
    jitDefaultRole: conn.jitDefaultRole ?? null,
  };
}

function normaliseMapping(raw: unknown): SamlMappingPayload {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  return {
    email: typeof obj.email === "string" ? obj.email : null,
    name: typeof obj.name === "string" ? obj.name : null,
    externalId: typeof obj.externalId === "string" ? obj.externalId : null,
    groupClaim: typeof obj.groupClaim === "string" ? obj.groupClaim : null,
    defaultRole:
      obj.defaultRole === "MEMBER" || obj.defaultRole === "VIEWER"
        ? obj.defaultRole
        : null,
    groupRoleMap: Array.isArray(obj.groupRoleMap)
      ? (obj.groupRoleMap as ReadonlyArray<{
          group: string;
          role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
        }>)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export type SamlMappingPreview = {
  /** True when this mapping would grant a role the existing mapping did not. */
  privilegeAffecting: boolean;
  /** Operator-facing diff vs. current mapping. */
  changes: ReadonlyArray<{
    field: string;
    before: string | null;
    after: string | null;
  }>;
  /** Warnings the operator should read before saving. */
  warnings: ReadonlyArray<{
    code:
      | "GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN"
      | "GROUP_ROLE_OVERLAPS_SCIM"
      | "DEFAULT_ROLE_DOWNGRADED"
      | "EMAIL_MAPPING_REMOVED"
      | "EXTERNAL_ID_OVERRIDE_RISKY";
    message: string;
  }>;
  /**
   * Sample resolution — when the operator supplies a sample
   * attribute set, we show what role + display name + email the
   * proposed mapping would resolve to.
   */
  sampleResolution: {
    email: string | null;
    name: string | null;
    externalId: string | null;
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
    matchedGroup: string | null;
  } | null;
};

export type PreviewSamlMappingResult =
  | { ok: true; preview: SamlMappingPreview }
  | { ok: false; code: "connection_not_found" | "invalid_mapping"; message: string };

export async function previewSamlMapping(
  input: {
    teamId: string;
    connectionId: string;
    actorUserId: string;
    mapping: SamlMappingPayload;
    sampleAttributes: Record<string, string>;
  },
  client: PrismaClient = defaultPrisma,
): Promise<PreviewSamlMappingResult> {
  const current = await getCurrentSamlMapping(
    { teamId: input.teamId, connectionId: input.connectionId },
    client,
  );
  if (!current) {
    return {
      ok: false,
      code: "connection_not_found",
      message: "SAML connection not found.",
    };
  }

  // ---- Compute diff ----
  const changes: Array<{ field: string; before: string | null; after: string | null }> = [];
  for (const field of [
    "email",
    "name",
    "externalId",
    "groupClaim",
    "defaultRole",
  ] as const) {
    const before = current.mapping[field] ?? null;
    const after = input.mapping[field] ?? null;
    if (before !== after) {
      changes.push({
        field,
        before: before == null ? null : String(before),
        after: after == null ? null : String(after),
      });
    }
  }
  const beforeMap = JSON.stringify(current.mapping.groupRoleMap ?? []);
  const afterMap = JSON.stringify(input.mapping.groupRoleMap ?? []);
  if (beforeMap !== afterMap) {
    changes.push({ field: "groupRoleMap", before: beforeMap, after: afterMap });
  }

  // ---- Compute warnings + privilege impact ----
  const warnings: Array<{
    code:
      | "GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN"
      | "GROUP_ROLE_OVERLAPS_SCIM"
      | "DEFAULT_ROLE_DOWNGRADED"
      | "EMAIL_MAPPING_REMOVED"
      | "EXTERNAL_ID_OVERRIDE_RISKY";
    message: string;
  }> = [];
  let privilegeAffecting = false;

  // Group map introduces OWNER/ADMIN
  const newRoles = new Set<string>(
    (input.mapping.groupRoleMap ?? []).map((g) => g.role),
  );
  const oldRoles = new Set<string>(
    (current.mapping.groupRoleMap ?? []).map((g) => g.role),
  );
  if (
    (newRoles.has("OWNER") && !oldRoles.has("OWNER")) ||
    (newRoles.has("ADMIN") && !oldRoles.has("ADMIN"))
  ) {
    privilegeAffecting = true;
    warnings.push({
      code: "GROUP_ROLE_INCLUDES_OWNER_OR_ADMIN",
      message:
        "Mapping grants OWNER or ADMIN via a group claim. This change requires step-up confirmation.",
    });
  }

  // SCIM overlap
  if (current.scimManaged && (input.mapping.groupClaim || (input.mapping.groupRoleMap ?? []).length > 0)) {
    warnings.push({
      code: "GROUP_ROLE_OVERLAPS_SCIM",
      message:
        "This connection is SCIM-managed. SAML group claims are ignored at assertion time; the mapping below has no operational effect until SCIM is disabled.",
    });
  }

  // Default-role downgrade
  if (
    current.mapping.defaultRole === "MEMBER" &&
    input.mapping.defaultRole === "VIEWER"
  ) {
    warnings.push({
      code: "DEFAULT_ROLE_DOWNGRADED",
      message:
        "Default fallback role downgraded from MEMBER to VIEWER. New JIT-provisioned users will have reduced privileges.",
    });
  }

  // Email mapping removed
  if (current.mapping.email && !input.mapping.email) {
    warnings.push({
      code: "EMAIL_MAPPING_REMOVED",
      message:
        "Email mapping cleared. Future logins will fall back to the IdP's standard email attribute candidates.",
    });
  }

  // External ID override (changing this can effectively re-identify a user)
  if (
    input.mapping.externalId &&
    input.mapping.externalId !== current.mapping.externalId
  ) {
    privilegeAffecting = true;
    warnings.push({
      code: "EXTERNAL_ID_OVERRIDE_RISKY",
      message:
        "Changing the external subject attribute will re-identify existing operators on next login. Step-up required.",
    });
  }

  // ---- Sample resolution ----
  let sampleResolution: SamlMappingPreview["sampleResolution"] = null;
  if (input.sampleAttributes && Object.keys(input.sampleAttributes).length > 0) {
    const emailAttr = input.mapping.email ?? "email";
    const nameAttr = input.mapping.name ?? "displayName";
    const extIdAttr = input.mapping.externalId;
    const groupAttr = input.mapping.groupClaim;
    const sampleEmail = input.sampleAttributes[emailAttr] ?? null;
    const sampleName = input.sampleAttributes[nameAttr] ?? null;
    const sampleExtId = extIdAttr ? input.sampleAttributes[extIdAttr] ?? null : null;
    const sampleGroup = groupAttr ? input.sampleAttributes[groupAttr] ?? null : null;
    let role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" =
      input.mapping.defaultRole ?? "MEMBER";
    let matchedGroup: string | null = null;
    if (sampleGroup) {
      const mapEntry = (input.mapping.groupRoleMap ?? []).find(
        (g) => g.group === sampleGroup,
      );
      if (mapEntry) {
        role = mapEntry.role;
        matchedGroup = mapEntry.group;
      }
    }
    sampleResolution = {
      email: sampleEmail,
      name: sampleName,
      externalId: sampleExtId,
      role,
      matchedGroup,
    };
  }

  bump("saml_mapping_previewed_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "saml_mapping_previewed",
    severity: privilegeAffecting ? "WARNING" : "INFO",
    details: {
      actorUserId: input.actorUserId,
      connectionId: input.connectionId,
      privilegeAffecting,
      changeCount: changes.length,
    },
  });

  return {
    ok: true,
    preview: { privilegeAffecting, changes, warnings, sampleResolution },
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export type UpdateSamlMappingResult =
  | {
      ok: true;
      connectionId: string;
      updatedAtUtc: string;
      privilegeAffecting: boolean;
    }
  | {
      ok: false;
      code: "connection_not_found" | "invalid_mapping";
      message: string;
    };

export async function updateSamlMapping(
  input: {
    teamId: string;
    connectionId: string;
    actorUserId: string;
    mapping: SamlMappingPayload;
    privilegeAffecting: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<UpdateSamlMappingResult> {
  const conn = await client.ssoConnection.findFirst({
    where: { id: input.connectionId, teamId: input.teamId },
    select: { id: true },
  });
  if (!conn) {
    return {
      ok: false,
      code: "connection_not_found",
      message: "SAML connection not found.",
    };
  }

  // Persist as a clean object (no undefined leaking through).
  const sanitised: Record<string, unknown> = {};
  if (input.mapping.email !== undefined) sanitised.email = input.mapping.email;
  if (input.mapping.name !== undefined) sanitised.name = input.mapping.name;
  if (input.mapping.externalId !== undefined)
    sanitised.externalId = input.mapping.externalId;
  if (input.mapping.groupClaim !== undefined)
    sanitised.groupClaim = input.mapping.groupClaim;
  if (input.mapping.defaultRole !== undefined)
    sanitised.defaultRole = input.mapping.defaultRole;
  if (input.mapping.groupRoleMap !== undefined)
    sanitised.groupRoleMap = input.mapping.groupRoleMap;

  await client.ssoConnection.update({
    where: { id: input.connectionId },
    data: { samlAttributeMapping: sanitised as never },
  });

  bump("saml_mapping_update_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "saml_mapping_updated",
    severity: input.privilegeAffecting ? "WARNING" : "INFO",
    details: {
      actorUserId: input.actorUserId,
      connectionId: input.connectionId,
      privilegeAffecting: input.privilegeAffecting,
    },
  });
  if (input.privilegeAffecting) {
    safeEmitSecurityEvent({
      teamId: input.teamId,
      eventType: "saml_mapping_privilege_warning",
      severity: "WARNING",
      details: {
        actorUserId: input.actorUserId,
        connectionId: input.connectionId,
      },
    });
  }

  return {
    ok: true,
    connectionId: input.connectionId,
    updatedAtUtc: new Date().toISOString(),
    privilegeAffecting: input.privilegeAffecting,
  };
}
