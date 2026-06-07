/**
 * PROOVRA Phase 4A Closure — Security claim drift detection.
 *
 * Per-control drift detection for the Security Documentation Center.
 * Walks each `SECURITY_SECTIONS` control, loads the corresponding
 * SECURITY-kind Trust Center article (when seeded), and verifies
 * whether the `implementationReferences` paths declared on the
 * article actually exist on disk.
 *
 * Hard rules:
 *   * Honest verdicts only — when a referenced module is missing
 *     the projection downgrades the control to PARTIAL / PLANNED /
 *     UNAVAILABLE; we NEVER report IMPLEMENTED for an absent
 *     reference.
 *   * Workspace-anchored: every read + upsert is scoped by teamId.
 *   * Bounded vocabulary from `@proovra/shared/trust-and-governance.ts`.
 *   * Standing limitations for controls whose runtime is intentionally
 *     bounded (for example, SCIM subset support or signing-only KMS)
 *     are recorded explicitly so the Security Center never silently
 *     overstates coverage.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

import type { PrismaClient } from "@prisma/client";
import {
  SECURITY_CONTROL_CONFIDENCE,
  SECURITY_SECTIONS,
  type SecurityClaimCheckProjection,
  type SecurityControlConfidence,
  type SecuritySection,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// ---------------------------------------------------------------------------
// Bounded honest overrides — structural gaps we KNOW about. The
// detector consults this map first; only when no override is
// present does it fall back to pure existsSync-derived confidence.
// ---------------------------------------------------------------------------

type HonestOverride = {
  confidence: SecurityControlConfidence;
  limitation: string;
  /**
   * When set, forces `implemented` regardless of reference scan
   * outcome. Used for controls whose implementation lives outside
   * the repo (e.g. SCIM via IdP) and whose reference list is
   * deliberately empty.
   */
  implementedOverride?: boolean;
};

const HONEST_OVERRIDES: Partial<Record<SecuritySection, HonestOverride>> = {
  SCIM: {
    confidence: "PARTIAL",
    limitation: "scim_subset_routes_require_configuration",
    implementedOverride: true,
  },
  KMS: {
    confidence: "PARTIAL",
    limitation: "kms_signing_supported_storage_cmk_external",
    implementedOverride: true,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RunSecurityClaimChecksInput = {
  prisma?: PrismaClient;
  teamId: string;
  systemUserId?: string | null;
};

export async function runSecurityClaimChecks(
  input: RunSecurityClaimChecksInput,
): Promise<ReadonlyArray<SecurityClaimCheckProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const now = new Date();
  const ownerUserId = input.systemUserId ?? null;

  // Load every SECURITY-kind article in one shot (workspace-anchored)
  // — bounded by the 18-section catalog, so this is small and safe.
  const articles = await prisma.trustCenterArticle.findMany({
    where: { teamId: input.teamId, kind: "SECURITY" },
    select: { section: true, implementationReferences: true },
  });
  const articleBySection = new Map<
    string,
    { implementationReferences: ReadonlyArray<string> }
  >();
  for (const row of articles) {
    articleBySection.set(row.section, {
      implementationReferences: normaliseReferences(
        row.implementationReferences,
      ),
    });
  }

  const projections: SecurityClaimCheckProjection[] = [];

  for (const controlKey of SECURITY_SECTIONS) {
    const article = articleBySection.get(controlKey);
    const documented = !!article;
    const refs = article?.implementationReferences ?? [];
    const refScan = scanReferences(refs);
    const override = HONEST_OVERRIDES[controlKey];

    const implementationReferencesOk =
      refs.length > 0 && refScan.missing.length === 0;

    let implemented: boolean;
    if (override?.implementedOverride !== undefined) {
      implemented = override.implementedOverride;
    } else {
      implemented = refScan.existing.length > 0;
    }

    const confidence: SecurityControlConfidence = override
      ? override.confidence
      : deriveConfidence({
          documented,
          referenceCount: refs.length,
          existingCount: refScan.existing.length,
          missingCount: refScan.missing.length,
        });

    const limitation: string | null = override?.limitation ?? null;

    const projection: SecurityClaimCheckProjection = {
      controlKey,
      documented,
      implemented,
      implementationReferencesOk,
      confidence,
      evidencePaths: refScan.existing,
      limitation,
      ownerUserId,
      lastVerifiedAtUtc: now.toISOString(),
    };

    await prisma.securityClaimCheck.upsert({
      where: {
        teamId_controlKey: {
          teamId: input.teamId,
          controlKey,
        },
      },
      create: {
        teamId: input.teamId,
        controlKey,
        documented,
        implemented,
        implementationReferencesOk,
        evidencePaths: refScan.existing as unknown as never,
        limitation,
        ownerUserId,
        lastVerifiedAt: now,
      },
      update: {
        documented,
        implemented,
        implementationReferencesOk,
        evidencePaths: refScan.existing as unknown as never,
        limitation,
        ownerUserId,
        lastVerifiedAt: now,
      },
    });

    projections.push(projection);
  }

  return projections.sort((a, b) => a.controlKey.localeCompare(b.controlKey));
}

export async function listSecurityClaimChecks(input: {
  prisma?: PrismaClient;
  teamId: string;
}): Promise<ReadonlyArray<SecurityClaimCheckProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.securityClaimCheck.findMany({
    where: { teamId: input.teamId },
    orderBy: { controlKey: "asc" },
  });
  if (rows.length === 0) return [];
  return rows.map((r: (typeof rows)[number]) => {
    const controlKey = r.controlKey as SecuritySection;
    const evidencePaths = Array.isArray(r.evidencePaths)
      ? (r.evidencePaths as ReadonlyArray<string>)
      : [];
    return {
      controlKey,
      documented: r.documented,
      implemented: r.implemented,
      implementationReferencesOk: r.implementationReferencesOk,
      confidence: deriveConfidenceFromRow({
        controlKey,
        documented: r.documented,
        implemented: r.implemented,
        implementationReferencesOk: r.implementationReferencesOk,
        evidencePathsCount: evidencePaths.length,
      }),
      evidencePaths,
      limitation: r.limitation ?? null,
      ownerUserId: r.ownerUserId ?? null,
      // Fall back to creation timestamp when never explicitly verified — keeps projection non-null per SecurityClaimCheckProjection contract.
      lastVerifiedAtUtc: (r.lastVerifiedAt ?? r.createdAt).toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseReferences(raw: unknown): ReadonlyArray<string> {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Strip a `#anchor` suffix (e.g. `schema.prisma#Evidence`) for the
 * existence check — the anchor is documentation-only.
 */
function stripAnchor(reference: string): string {
  const hashIndex = reference.indexOf("#");
  return hashIndex >= 0 ? reference.slice(0, hashIndex) : reference;
}

/**
 * Resolve a workspace-relative reference against the monorepo root.
 * The detector tries `process.cwd()` first, then walks UP THREE
 * LEVELS so it works from either the API service directory
 * (`services/api`) or the monorepo root.
 */
function candidateRoots(): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (p: string) => {
    const resolved = path.resolve(p);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  };

  const cwd = process.cwd();
  add(cwd);
  add(path.resolve(cwd, ".."));
  add(path.resolve(cwd, "..", ".."));
  add(path.resolve(cwd, "..", "..", ".."));

  return out;
}

function referenceExists(reference: string): boolean {
  const cleaned = stripAnchor(reference);
  if (!cleaned) return false;
  // Absolute path: check directly.
  if (path.isAbsolute(cleaned)) {
    return existsSync(cleaned);
  }
  for (const root of candidateRoots()) {
    const candidate = path.resolve(root, cleaned);
    if (existsSync(candidate)) return true;
  }
  return false;
}

function scanReferences(refs: ReadonlyArray<string>): {
  existing: ReadonlyArray<string>;
  missing: ReadonlyArray<string>;
} {
  const existing: string[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    if (referenceExists(ref)) {
      existing.push(ref);
    } else {
      missing.push(ref);
    }
  }
  return { existing, missing };
}

function deriveConfidence(args: {
  documented: boolean;
  referenceCount: number;
  existingCount: number;
  missingCount: number;
}): SecurityControlConfidence {
  if (!args.documented) return "UNAVAILABLE";
  if (args.referenceCount === 0) return "PLANNED";
  if (args.missingCount === 0) return "IMPLEMENTED";
  if (args.existingCount > 0) return "PARTIAL";
  return "PLANNED";
}

function deriveConfidenceFromRow(args: {
  controlKey: SecuritySection;
  documented: boolean;
  implemented: boolean;
  implementationReferencesOk: boolean;
  evidencePathsCount: number;
}): SecurityControlConfidence {
  const override = HONEST_OVERRIDES[args.controlKey];
  if (override) return override.confidence;
  if (!args.documented) return "UNAVAILABLE";
  if (args.implementationReferencesOk && args.evidencePathsCount > 0) {
    return "IMPLEMENTED";
  }
  if (args.evidencePathsCount > 0) return "PARTIAL";
  if (args.implemented) return "PARTIAL";
  return "PLANNED";
}

// Compile-time guard so a future renamed enum trips the typecheck.
function _assertBoundedVocabularyIntact(): void {
  const _c: SecurityControlConfidence = "IMPLEMENTED";
  void _c;
  void SECURITY_CONTROL_CONFIDENCE;
}
void _assertBoundedVocabularyIntact;
