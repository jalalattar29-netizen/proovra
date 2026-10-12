/**
 * The incident SLA cycle authority now lives in `@proovra/shared-runtime`
 * (`ops/incident-sla-cycle.ts`) so the Worker opens and closes the SAME
 * promise for the conditions it records (OPS-09). This module keeps the API's
 * import path and binds the API's own Prisma client as the default.
 */
import type { PrismaClient } from "@prisma/client";
import * as cycles from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";

export type { SlaCycleEndReason } from "@proovra/shared-runtime";
export const policyDigest = cycles.policyDigest;

type Arg<F extends (...a: never[]) => unknown> = Parameters<F>[0];

export const resolveCurrentPolicyVersion = (
  input: Arg<typeof cycles.resolveCurrentPolicyVersion>,
  client: PrismaClient = defaultPrisma,
) => cycles.resolveCurrentPolicyVersion(input, client);
export const openSlaCycle = (input: Arg<typeof cycles.openSlaCycle>, client: PrismaClient = defaultPrisma) =>
  cycles.openSlaCycle(input, client);
export const recordSlaAcknowledgement = (
  input: Arg<typeof cycles.recordSlaAcknowledgement>,
  client: PrismaClient = defaultPrisma,
) => cycles.recordSlaAcknowledgement(input, client);
export const closeSlaCycle = (input: Arg<typeof cycles.closeSlaCycle>, client: PrismaClient = defaultPrisma) =>
  cycles.closeSlaCycle(input, client);
export const suppressSlaCycle = (input: Arg<typeof cycles.suppressSlaCycle>, client: PrismaClient = defaultPrisma) =>
  cycles.suppressSlaCycle(input, client);
export const escalateIncidentSeverity = (
  input: Arg<typeof cycles.escalateIncidentSeverity>,
  client: PrismaClient = defaultPrisma,
) => cycles.escalateIncidentSeverity(input, client);
