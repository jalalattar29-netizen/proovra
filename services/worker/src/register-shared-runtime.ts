/**
 * Phase 31.22 — register the Worker's PrismaClient with the
 * @proovra/shared-runtime registry.
 *
 * Side-effect module: importing it executes the registration. The
 * worker/index.ts imports this BEFORE any processor module that
 * calls into shared-runtime business logic.
 */

import { registerPrisma } from "@proovra/shared-runtime";

import { prisma } from "./db.js";

registerPrisma(prisma);
