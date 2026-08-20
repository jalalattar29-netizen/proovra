/**
 * THE canonical answer to "is this destination local?".
 *
 * WHY THIS FILE EXISTS
 *
 * Three places decided it independently: the `--import` outbound guard, the
 * test bootstrap's classifier, and the Point-7 closure gate. Three copies of a
 * host allowlist is three allowlists — and the one that matters is whichever
 * copy the gate happens to read. A destination the guard permitted but the gate
 * did not recognise would fail a hermetic run; one the gate recognised but the
 * guard did not would be blocked at runtime and then credited as fine. Neither
 * failure is visible from any single copy, which is why the definition is
 * stated once here and imported by all three.
 *
 * Plain `.mjs` on purpose: the outbound guard is a Node `--import` preload that
 * runs before any TypeScript transform exists, so the authority has to be
 * loadable with no toolchain at all. `local-hosts.d.mts` gives the TypeScript
 * callers the same shape.
 */

/**
 * Addresses that are local by their own nature, whatever a run declares.
 *
 * `localhost` and `127.0.0.1` are BOTH here and are still two different
 * ORIGINS to a browser — this set answers "is it loopback", never "is it the
 * same origin".
 */
export const LOOPBACK_HOSTS = Object.freeze([
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "localhost",
  "::ffff:127.0.0.1",
]);

const LOOPBACK = new Set(LOOPBACK_HOSTS);

/**
 * Loopback, and only loopback.
 *
 * Deliberately does NOT consult `P7_ALLOWED_HOSTS`: an operator-allowlisted
 * REMOTE host is still remote, and the closure gate has to be able to say so.
 */
export function isLoopbackHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return LOOPBACK.has(h) || h.endsWith(".localhost");
}

/**
 * The extra destinations THIS run explicitly started, as declared in
 * `P7_ALLOWED_HOSTS` (comma-separated).
 *
 * Deliberately not a wildcard: "the disposable services I started" is a short
 * list, and naming them is the operator's job.
 */
export function extraAllowedHosts(env = process.env) {
  return new Set(
    (env.P7_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * What the RUNTIME guards permit: loopback plus this run's declared extras.
 *
 * An empty host is a unix socket or an already-connected handle, which the
 * guards cannot meaningfully refuse.
 */
export function isAllowedHost(host, env = process.env) {
  if (!host) return true;
  const h = String(host).toLowerCase();
  return isLoopbackHost(h) || extraAllowedHosts(env).has(h);
}
