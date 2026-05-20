/**
 * @proovra/shared-runtime — Prisma-using business logic that
 * both services/api and services/worker import.
 *
 * This package replaces the direct cross-imports between api and
 * worker that violated the service boundary (Phase 31.21 audit).
 *
 * Both hosts MUST call `registerPrisma(prisma)` at process startup
 * before any function from this package is invoked.
 */

export { registerPrisma, getRegisteredPrisma } from "./prisma-registry.js";

export * from "./media-intelligence/index.js";
export * from "./graph/index.js";
export * from "./ops/index.js";
