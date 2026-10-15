/**
 * AUD-021 — exact parsing of a request's Host header.
 *
 * The middleware used to decide "is this local development or a preview?" with
 * `host.includes("localhost")` / `host.includes("127.0.0.1")`, so a hostname
 * such as `localhost.attacker.example` or `127.0.0.1.nip.io` was treated as
 * local and skipped the production host routing. A hostname is compared
 * exactly, never by substring.
 */

/** The bare, lower-cased hostname of a Host header: port and IPv6 brackets removed. */
export function hostnameOf(host: string | null | undefined): string {
  const raw = (host ?? "").trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw;
  }
  return raw.replace(/:\d+$/, "");
}

/** Loopback development hosts and single-label Vercel preview deployments. */
export function isLocalOrPreviewHost(host: string | null | undefined): boolean {
  const name = hostnameOf(host);
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "::1" ||
    name.endsWith(".localhost") ||
    /^[a-z0-9-]+\.vercel\.app$/.test(name)
  );
}
