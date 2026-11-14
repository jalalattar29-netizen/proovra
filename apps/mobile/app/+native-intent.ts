/**
 * expo-router's hook for every incoming system URL (cold and warm starts).
 *
 * Free audit F-13 — links DeepLinkGate routes are taken away from the router
 * so each link is opened once, by one owner, after the gate's own checks
 * (sign-in deferral, server resolve, capture-busy). See
 * src/deep-link/link-ownership.ts.
 */
import { routerPathForIncomingLink } from "../src/deep-link/link-ownership";

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  return routerPathForIncomingLink(path, initial);
}
