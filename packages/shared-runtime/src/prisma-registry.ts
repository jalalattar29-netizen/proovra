/**
 * Phase 31.22 — Prisma client registry for shared-runtime.
 *
 * The shared-runtime business-logic services (analyzer, graph
 * builder, derived-assets persistence, etc.) accept a `PrismaClient`
 * as an explicit parameter. Both services/api and services/worker
 * own their OWN PrismaClient instance (via their own `db.ts`), and
 * each registers it with this module at process startup.
 *
 * This decoupling is the architectural fix for the Phase 31.21 audit
 * — shared-runtime NEVER constructs its own Prisma client. The
 * registry is purely a way to set a process-local default so the
 * existing call sites (which rely on the default-param pattern) keep
 * working after the move from services/api/src into the package.
 *
 * Hard rules:
 *   * NEVER instantiates Prisma here.
 *   * Default-arg evaluation NEVER throws. When no Prisma is
 *     registered, `getRegisteredPrisma()` returns a lazy Proxy that
 *     throws ONLY on first method access — so tests that early-
 *     return (e.g. `if (!teamId) return null`) before any DB call
 *     keep working without a registration step.
 *   * Test-only helpers permit injecting a stub PrismaClient.
 */

import type { PrismaClient } from "@prisma/client";

let registered: PrismaClient | null = null;

/**
 * Register the process's PrismaClient. Both services/api and
 * services/worker MUST call this exactly once at startup, passing
 * their own canonical Prisma instance.
 */
export function registerPrisma(client: PrismaClient): void {
  registered = client;
}

/**
 * Resolve the registered PrismaClient. When nobody has registered
 * yet, returns a lazy Proxy whose every property access throws.
 * That keeps default-arg evaluation cheap (no throw at function
 * entry) while still surfacing the boot-wiring miss loudly on the
 * first DB call.
 */
export function getRegisteredPrisma(): PrismaClient {
  if (registered !== null) return registered;
  // Lazy Proxy — only throws on actual property access.
  return new Proxy({} as PrismaClient, {
    get(_target, prop) {
      // Avoid breaking accidental `await` patterns or shallow
      // structural checks; only PROPERTY ACCESS throws.
      if (prop === "then") return undefined;
      throw new Error(
        `shared-runtime: PrismaClient method '${String(prop)}' accessed before registerPrisma() was called. ` +
          "Each host (services/api or services/worker) must call registerPrisma(prisma) at process startup.",
      );
    },
  });
}

/** Test-only — clear the registry between unit tests. */
export function __resetPrismaRegistryForTests(): void {
  registered = null;
}
