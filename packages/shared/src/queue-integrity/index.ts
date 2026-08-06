/**
 * PHASE 12 — POINT 5: the ONE public import surface for queue/worker integrity.
 *
 * Everything an asynchronous operation needs to be tenant-safe, policy-safe,
 * replay-safe and recoverable is declared under this directory and re-exported
 * here, so both the api and the worker import the same definitions:
 *
 *   names.ts        — queue names, job names, sweep names, families
 *   payload.ts      — the canonical payload, strict decode, terminal vocabulary
 *   legacy.ts       — bounded per-family compatibility with registered removal
 *   job-id.ts       — deterministic ids and composite command ids
 *   retry-policy.ts — named retry and recovery policies
 *   enqueue.ts      — the single enqueue authority
 *   registry.ts     — every unit of work, mapped to one family
 *   integrity.ts    — registry self-checks and the operator diagnostics shape
 *
 * There is no second surface. A module that needs a queue name imports it from
 * `@proovra/shared`; a literal that is not declared here cannot be imported
 * from here, which is what makes the closure gate's "no inline job name" check
 * enforceable rather than advisory.
 */

export * from "./names.js";
export * from "./payload.js";
export * from "./legacy.js";
export * from "./job-id.js";
export * from "./retry-policy.js";
export * from "./enqueue.js";
export * from "./registry.js";
export * from "./integrity.js";
