/**
 * Provenance Chain projection — API entry point.
 *
 * Delegates to THE implementation in @proovra/shared-runtime
 * (`loadProvenanceChain`), which the Worker's verification-package builder
 * also uses, so the chain an operator reads, the chain public Verify
 * summarises and the chain a package ships cannot diverge.
 *
 * UC-0 — the mode comes only from `Evidence.acquisitionMode`; the former
 * `isIntake` hint and the `uploadSource` / `captureMethod` fallbacks are gone
 * (see the shared-runtime module for why).
 *
 * Read-only. The caller authorizes.
 */

import type { PrismaClient } from "@prisma/client";
import type { ProvenanceChain } from "@proovra/shared";
import { loadProvenanceChain } from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";

export type ProvenanceProjectionInput = {
  prisma?: PrismaClient;
  evidenceId: string;
};

export async function projectProvenanceChain(
  input: ProvenanceProjectionInput,
): Promise<ProvenanceChain> {
  return loadProvenanceChain(input.prisma ?? defaultPrisma, input.evidenceId);
}
