/**
 * Phase 31.22 — shim. Original implementation moved to
 * @proovra/shared-runtime/ops. The api process gets its own per-
 * process counter state because Node module loading creates one
 * instance per process — moving the file did not break per-process
 * isolation.
 */
export * from "@proovra/shared-runtime/ops";
