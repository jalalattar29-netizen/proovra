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

export * from "./signing/index.js";

export * from "./media-intelligence/index.js";
export * from "./graph/index.js";
export * from "./ops/index.js";
export * from "./notifications/index.js";
// PHASE 12 REMEDIATION §6.1 (2026-08-06) — the ONE seat/member occupancy
// authority, shared by API and worker so their arithmetic cannot diverge.
export * from "./billing/seat-occupancy.js";
// PHASE 12 CORRECTIVE PASS §4 (SEC-004, 2026-08-06) — the ONE secrets
// authority. It lived in services/api, so the Worker could not use it and the
// two processes of one deployment could resolve secrets from different
// stores. Both now call the same `initSecretsAuthority` and report the same
// readiness contract.
export * from "./config/secrets-authority.js";
export * from "./config/secrets-recording-provider.js";
