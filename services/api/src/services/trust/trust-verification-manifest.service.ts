/**
 * PROOVRA Phase 4A — Trust + governance verification-package
 * MANIFEST PREVIEW helpers (API-side).
 *
 * SCOPE
 *   These functions are API-side preview helpers consumed by
 *   GET /v1/trust/verification-package/preview to let operators
 *   inspect the EXACT manifest shapes that ship inside the offline
 *   verification ZIP, without having to generate a full package.
 *
 * RG-20 / PRO-G2-01: the builders live ONCE in @proovra/shared-runtime
 * (trust-verification-manifests.ts) and the Worker's verification package
 * calls the same functions. This module only supplies the API's default
 * Prisma client, so preview and package cannot diverge in scope or shape.
 *
 * Hard rules (enforced by the shared builder):
 *   * NEVER raw article bodies — manifests carry slugs + versions
 *     + publish timestamps only.
 *   * Workspace-anchored on teamId; bounded reads.
 *   * Offline-verifiable.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  AiDisclosureManifestEntry,
  GovernanceManifestEntry,
  MethodologyManifestEntry,
  SubprocessorManifestEntry,
  TrustManifestEntry,
} from "@proovra/shared";
import {
  buildAiDisclosureManifestEntry as sharedAiDisclosure,
  buildGovernanceManifestEntry as sharedGovernance,
  buildMethodologyManifestEntry as sharedMethodology,
  buildSubprocessorManifestEntry as sharedSubprocessor,
  buildTrustManifestEntry as sharedTrust,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";

type Input = { prisma?: PrismaClient; teamId: string };

export async function buildTrustManifestEntry(input: Input): Promise<TrustManifestEntry> {
  return sharedTrust({ prisma: input.prisma ?? defaultPrisma, teamId: input.teamId });
}

export async function buildGovernanceManifestEntry(input: Input): Promise<GovernanceManifestEntry> {
  return sharedGovernance({ prisma: input.prisma ?? defaultPrisma, teamId: input.teamId });
}

export async function buildMethodologyManifestEntry(input: Input): Promise<MethodologyManifestEntry> {
  return sharedMethodology({ prisma: input.prisma ?? defaultPrisma, teamId: input.teamId });
}

export async function buildAiDisclosureManifestEntry(input: Input): Promise<AiDisclosureManifestEntry> {
  return sharedAiDisclosure({ prisma: input.prisma ?? defaultPrisma, teamId: input.teamId });
}

export async function buildSubprocessorManifestEntry(input: Input): Promise<SubprocessorManifestEntry> {
  return sharedSubprocessor({ prisma: input.prisma ?? defaultPrisma, teamId: input.teamId });
}

// ---------------------------------------------------------------------------
// Preview dispatcher — consumed by the /v1/trust/verification-package/preview
// HTTP route in trust-and-governance.routes.ts. Returns the SAME manifest
// shape that the worker emits inside the verification package ZIP for the
// requested kind. Read-only, workspace-anchored.
// ---------------------------------------------------------------------------

export const VERIFICATION_PACKAGE_PREVIEW_KINDS = [
  "trust",
  "governance",
  "methodology",
  "ai-disclosure",
  "subprocessor",
] as const;

export type VerificationPackagePreviewKind =
  (typeof VERIFICATION_PACKAGE_PREVIEW_KINDS)[number];

export type VerificationPackagePreviewEntry =
  | TrustManifestEntry
  | GovernanceManifestEntry
  | MethodologyManifestEntry
  | AiDisclosureManifestEntry
  | SubprocessorManifestEntry;

export async function buildVerificationPackagePreview(input: {
  prisma?: PrismaClient;
  teamId: string;
  kind: VerificationPackagePreviewKind;
}): Promise<VerificationPackagePreviewEntry> {
  switch (input.kind) {
    case "trust":
      return buildTrustManifestEntry({ prisma: input.prisma, teamId: input.teamId });
    case "governance":
      return buildGovernanceManifestEntry({ prisma: input.prisma, teamId: input.teamId });
    case "methodology":
      return buildMethodologyManifestEntry({ prisma: input.prisma, teamId: input.teamId });
    case "ai-disclosure":
      return buildAiDisclosureManifestEntry({ prisma: input.prisma, teamId: input.teamId });
    case "subprocessor":
      return buildSubprocessorManifestEntry({ prisma: input.prisma, teamId: input.teamId });
  }
}
