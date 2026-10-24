/**
 * Phase 31.22 — register the API's PrismaClient with the
 * @proovra/shared-runtime registry.
 *
 * Side-effect module: importing it executes the registration.
 * `src/index.ts` imports it BEFORE any code that calls into shared-runtime
 * business logic, so default-arg `getRegisteredPrisma()` calls resolve to
 * the api's canonical client in the running server.
 *
 * The test harness does NOT import it: `test/setup/safe-environment.ts`
 * registers nothing, and only the integration files that need the registry
 * import this module themselves. API code calling a shared-runtime function
 * must therefore pass its `prisma` explicitly rather than rely on the
 * registered default, or it fails under test (and in standalone scripts)
 * while working in the server.
 */

import { registerPrisma } from "@proovra/shared-runtime";

import { prisma } from "./db.js";

registerPrisma(prisma);
