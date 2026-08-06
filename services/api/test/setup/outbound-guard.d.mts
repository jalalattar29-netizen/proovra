/**
 * Types for the outbound-network deny guard. The guard itself is `.mjs` so it
 * can be used as a `node --import` preload for the API and worker processes
 * without a compile step — see `outbound-guard.mjs` for why it exists.
 */
export declare function installOutboundGuard(): void;
