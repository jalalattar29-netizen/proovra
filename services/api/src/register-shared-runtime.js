/**
 * Phase 31.22 — register the API's PrismaClient with the
 * @proovra/shared-runtime registry.
 *
 * Side-effect module: importing it executes the registration. The
 * api/index.ts and api/test/setup file both import this BEFORE any
 * code that calls into shared-runtime business logic, so default-
 * arg `getRegisteredPrisma()` calls resolve to the api's canonical
 * client.
 */
import { registerPrisma } from "@proovra/shared-runtime";
import { prisma } from "./db.js";
registerPrisma(prisma);
