/**
 * Types for the canonical local-host authority.
 *
 * The implementation is `.mjs` because the outbound guard is a Node `--import`
 * preload that runs before any TypeScript transform exists. This declaration
 * lets the closure gate import the SAME module rather than restate it.
 */
export declare const LOOPBACK_HOSTS: readonly string[];
export declare function isLoopbackHost(host: string | null | undefined): boolean;
export declare function extraAllowedHosts(
  env?: Record<string, string | undefined>,
): Set<string>;
export declare function isAllowedHost(
  host: string | null | undefined,
  env?: Record<string, string | undefined>,
): boolean;
