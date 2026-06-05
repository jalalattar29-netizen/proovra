/**
 * Phase T — Template identity resolver.
 *
 * Canonical helper that maps an upstream template source (a CaptureSession
 * draft row, an explicit slug+version pair, or a WorkflowIntakeLink) onto
 * the three-column identity trio that Phase T introduced on Evidence and
 * EvidenceReviewWorkflow:
 *
 *   - templateSlug    (VarChar(120), nullable)
 *   - templateVersion (Int,         nullable)
 *   - templateDbId    (UUID FK,     nullable — set only when a DB row backs
 *                                    the slug)
 *
 * Resolution rules:
 *
 *   1. Slug + version come from the caller. For the CaptureSession path,
 *      they come from CaptureSession.templateId (the VarChar(120) slug)
 *      and CaptureSession.templateVersion. For the external-intake path
 *      they come from WorkflowIntakeLink.workflowTemplateSlug /
 *      workflowTemplateVersion. We never invent them.
 *
 *   2. The optional templateDbId is resolved by joining the slug against
 *      EvidenceWorkflowTemplate (workspace_db, then platform_db). The
 *      resolver re-uses listEffectiveWorkflowTemplates() so the merge
 *      precedence stays identical to the rest of the platform. Seed-only
 *      templates have no DB row, so templateDbId stays NULL while slug
 *      and version remain populated.
 *
 *   3. Every lookup is wrapped in try/catch. A resolver failure NEVER
 *      bubbles out — the worst case returns an empty trio so the
 *      Evidence creation path can continue with NULL identity columns.
 *      This honours the Phase T hard rule that propagation failure
 *      cannot break primary lifecycle.
 *
 * What this service does NOT do:
 *
 *   - It never writes to the Evidence row directly. Callers thread the
 *     returned trio into their tx.evidence.create / update payload.
 *   - It never changes policy decisions or business logic — only identity
 *     propagation.
 *   - It never creates new audit tables. Audit emission lives at the
 *     call site, using the existing appendPlatformAuditLog emitter.
 *   - It never introduces a parallel template service, sync job, or
 *     shadow registry. It reuses workflow-template.service.ts as the
 *     single template-source registry.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  getEffectiveWorkflowTemplateBySlug,
} from "../workflow-template.service.js";

// -----------------------------------------------------------------------------
// Public type
// -----------------------------------------------------------------------------

/**
 * The canonical Phase T identity trio. All three fields are nullable so
 * a partial / failed resolution can be represented honestly. The Evidence
 * and EvidenceReviewWorkflow models accept these exact field names.
 */
export type TemplateIdentityTrio = {
  templateSlug: string | null;
  templateVersion: number | null;
  templateDbId: string | null;
};

/** Stable empty trio — returned on every failure path. */
export const EMPTY_TEMPLATE_IDENTITY_TRIO: TemplateIdentityTrio = {
  templateSlug: null,
  templateVersion: null,
  templateDbId: null,
};

// -----------------------------------------------------------------------------
// Sub-client narrowing — accept anything that can read CaptureSession +
// EvidenceWorkflowTemplate. Keeps tests trivial (no full PrismaClient mock
// required) and avoids leaking the global prisma into pure helpers.
// -----------------------------------------------------------------------------

type CaptureSessionLookupClient = {
  captureSession: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id?: true;
        templateId?: true;
        templateVersion?: true;
      };
    }) => Promise<{
      id: string;
      templateId: string | null;
      templateVersion: number | null;
    } | null>;
  };
  evidenceWorkflowTemplate: PrismaClient["evidenceWorkflowTemplate"];
};

// -----------------------------------------------------------------------------
// Core resolver — given a slug + version + workspace, find the optional DB id.
// -----------------------------------------------------------------------------

/**
 * Resolve the templateDbId UUID for a slug, scoped to a workspace.
 *
 * Returns null when:
 *   - the slug is missing,
 *   - the slug resolves only to a platform seed (no DB row),
 *   - any read fails (try/catch wraps the lookup).
 */
export async function resolveTemplateDbIdForSlug(
  slug: string | null,
  teamId: string | null,
  client: Pick<PrismaClient, "evidenceWorkflowTemplate"> = defaultPrisma,
): Promise<string | null> {
  if (!slug) return null;
  try {
    const entry = await getEffectiveWorkflowTemplateBySlug(slug, teamId, client);
    if (!entry) return null;
    // Seed-only templates expose dbId === null. Only DB-backed rows have
    // a UUID. The merge precedence in workflow-template.service.ts
    // already prefers workspace_db > platform_db > platform_seed, so
    // whatever wins is the canonical row for this workspace.
    return entry.dbId ?? null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// CaptureSession-driven resolution.
//
// Reads the CaptureSession draft row, lifts its templateId (which is the
// stable VarChar(120) slug today, per the Phase 1 inventory) plus the
// matching templateVersion, then resolves the optional templateDbId via
// the workspace-scoped lookup above.
// -----------------------------------------------------------------------------

export async function resolveTemplateTrioForCaptureSession(params: {
  captureSessionId: string | null | undefined;
  /**
   * Workspace context for the DB-id lookup. When the Evidence is being
   * created in a TEAM workspace, pass the teamId so the resolver can
   * find workspace-scoped overrides. PERSONAL evidence passes null and
   * only platform-db rows are searched.
   */
  teamId?: string | null;
  client?: CaptureSessionLookupClient;
}): Promise<TemplateIdentityTrio> {
  if (!params.captureSessionId) return EMPTY_TEMPLATE_IDENTITY_TRIO;

  const client = params.client ?? (defaultPrisma as unknown as CaptureSessionLookupClient);

  try {
    const session = await client.captureSession.findUnique({
      where: { id: params.captureSessionId },
      select: {
        id: true,
        templateId: true,
        templateVersion: true,
      },
    });

    if (!session) return EMPTY_TEMPLATE_IDENTITY_TRIO;
    if (!session.templateId) return EMPTY_TEMPLATE_IDENTITY_TRIO;

    const templateSlug = session.templateId;
    const templateVersion = session.templateVersion ?? null;
    const templateDbId = await resolveTemplateDbIdForSlug(
      templateSlug,
      params.teamId ?? null,
      client,
    );

    return {
      templateSlug,
      templateVersion,
      templateDbId,
    };
  } catch {
    return EMPTY_TEMPLATE_IDENTITY_TRIO;
  }
}

// -----------------------------------------------------------------------------
// WorkflowIntakeLink-driven resolution.
//
// External-intake submissions arrive with the link already loaded. The link
// carries workflowTemplateSlug (VarChar(120), required), workflowTemplateVersion
// (Int, required), and workflowTemplateId (UUID, nullable — set when a DB row
// backs the slug). We honour those values verbatim; templateDbId is only
// re-derived if the link's stored id is null (a seed-driven link).
// -----------------------------------------------------------------------------

export async function resolveTemplateTrioForIntakeLink(params: {
  link: {
    workflowTemplateId?: string | null;
    workflowTemplateSlug?: string | null;
    workflowTemplateVersion?: number | null;
    teamId?: string | null;
  };
  client?: Pick<PrismaClient, "evidenceWorkflowTemplate">;
}): Promise<TemplateIdentityTrio> {
  const link = params.link;
  const client = params.client ?? defaultPrisma;

  if (!link.workflowTemplateSlug) return EMPTY_TEMPLATE_IDENTITY_TRIO;

  try {
    const templateSlug = link.workflowTemplateSlug;
    const templateVersion =
      typeof link.workflowTemplateVersion === "number"
        ? link.workflowTemplateVersion
        : null;

    // Prefer the link's own FK when present — that snapshot was already
    // resolved at link-creation time. Only fall back to the lookup when
    // the link's id is null (i.e. the link was created from a platform
    // seed and never gained a DB-backed override).
    let templateDbId: string | null = link.workflowTemplateId ?? null;
    if (!templateDbId) {
      templateDbId = await resolveTemplateDbIdForSlug(
        templateSlug,
        link.teamId ?? null,
        client,
      );
    }

    return {
      templateSlug,
      templateVersion,
      templateDbId,
    };
  } catch {
    return EMPTY_TEMPLATE_IDENTITY_TRIO;
  }
}

// -----------------------------------------------------------------------------
// Audit emission helper — caller invokes after stamping. Bounded metadata,
// reuses the existing appendPlatformAuditLog chain. Wrapped in try/catch
// at the call site (NOT here) because audit emission failure must never
// break Evidence creation.
// -----------------------------------------------------------------------------

export type TemplateIdentityStampSource =
  | "capture"
  | "intake_link"
  | "external_intake"
  | "direct";

export function templateIdentityAuditMetadata(params: {
  evidenceId: string;
  source: TemplateIdentityStampSource;
  trio: TemplateIdentityTrio;
}): Record<string, unknown> {
  return {
    evidenceId: params.evidenceId,
    source: params.source,
    templateSlug: params.trio.templateSlug,
    templateVersion: params.trio.templateVersion,
    templateDbId: params.trio.templateDbId,
  };
}
