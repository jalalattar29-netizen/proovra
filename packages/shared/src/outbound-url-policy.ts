/**
 * THE OUTBOUND URL POLICY — pure part (PRO-061 / BILLING-02, PRO-064 /
 * BILLING-05, PRO-067 / BILLING-08).
 *
 * PROOVRA sends HTTP requests to addresses its customers type in: lifecycle
 * webhooks, automation webhooks and integration webhooks. Each of the three
 * stacks used to carry its own idea of what "a public https:// URL" means, and
 * each was wrong in a different way: lifecycle webhooks checked the scheme
 * only; automation webhooks classified IPv6 by string prefix and accepted the
 * hex spelling of IPv4-mapped loopback (`[::ffff:7f00:1]`), `[::]` and NAT64;
 * integration webhooks matched the literal hostname with regexes and accepted
 * `localhost.` and the rest of `0.0.0.0/8`.
 *
 * This file is the one answer for "may PROOVRA connect to this address", by
 * address BYTES, never by spelling, and with no Node dependency so the same
 * rule can be quoted anywhere. The network half — resolution inside the
 * connection, so the address checked is the address connected to, no
 * redirects, no response bodies — is `@proovra/shared-runtime/outbound`, which
 * re-exports this file.
 *
 * Local testing: callers derive a `localAllowance` from their own flag with
 * `resolveLocalAllowance`, which answers "none" unless NODE_ENV is exactly
 * "test" or "development" (so production, and an unset NODE_ENV, can never
 * widen it). Even the widest allowance refuses link-local and the metadata
 * service.
 */

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

export const OUTBOUND_REFUSAL_REASONS = [
  "invalid_url",
  "url_too_long",
  "non_https_scheme",
  "credentials_in_url",
  "non_default_port",
  "localhost",
  "loopback_ip",
  "private_ip",
  "link_local_ip",
  "metadata_service_ip",
  "ipv6_local",
  "reserved_ip",
  "dns_resolution_failed",
] as const;
export type OutboundRefusalReason = (typeof OUTBOUND_REFUSAL_REASONS)[number];

/**
 * How far a non-production process may widen the policy.
 *   - "none": public addresses only (the production value, always).
 *   - "loopback": also 127.0.0.0/8 and ::1, and plain http to a loopback
 *     literal (a local test receiver).
 *   - "private": also RFC 1918, CGNAT and IPv6 unique-local ranges.
 * Link-local and the metadata service are refused at every level.
 */
export type OutboundLocalAllowance = "none" | "loopback" | "private";

export type OutboundUrlPolicy = {
  /** Refuse any explicit port other than 443. */
  requireDefaultPort: boolean;
  localAllowance: OutboundLocalAllowance;
  /** Defaults to 2048. */
  maxUrlLength?: number;
};

const DEFAULT_MAX_URL_LENGTH = 2048;

/**
 * Lifecycle webhooks (Phase 4B): created by the API, sent by the worker. One
 * constant so the two cannot disagree. No local-testing allowance exists on
 * this stack.
 */
export const LIFECYCLE_WEBHOOK_OUTBOUND_POLICY: OutboundUrlPolicy = Object.freeze({
  requireDefaultPort: false,
  localAllowance: "none",
  maxUrlLength: 1024,
});

/**
 * The only way a flag may widen the policy. `NODE_ENV` must be one of the
 * named non-production values; production, an unset value and anything else
 * answer "none".
 */
export function resolveLocalAllowance(input: {
  requested: OutboundLocalAllowance;
  flagEnabled: boolean;
  nodeEnv: string | undefined;
  permittedEnvironments: ReadonlyArray<"test" | "development">;
}): OutboundLocalAllowance {
  if (!input.flagEnabled) return "none";
  const env = input.nodeEnv;
  if (env !== "test" && env !== "development") return "none";
  if (!input.permittedEnvironments.includes(env)) return "none";
  return input.requested;
}

// -----------------------------------------------------------------------------
// Address classification (by bytes)
// -----------------------------------------------------------------------------

type AddressClass =
  | { kind: "public" }
  | { kind: "loopback" }
  | { kind: "private"; reason: "private_ip" | "ipv6_local" }
  | { kind: "never"; reason: OutboundRefusalReason };

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number.parseInt(p, 10);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** 16 bytes, or null. Accepts embedded dotted IPv4 and strips a zone id. */
export function parseIpv6(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip.includes(":") || !/^[0-9a-f:.]+$/.test(ip)) return null;
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(":");
  const last = ip.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    tail = v4;
    ip = ip.slice(0, lastColon + 1) + "0:0";
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  if (tail.length === 4) {
    bytes[12] = tail[0]!;
    bytes[13] = tail[1]!;
    bytes[14] = tail[2]!;
    bytes[15] = tail[3]!;
  }
  return bytes;
}

function classifyV4Bytes(b: ReadonlyArray<number>): AddressClass {
  const [a, c, d, e] = b as [number, number, number, number];
  if (a === 127) return { kind: "loopback" };
  // 0.0.0.0/8 — "this network". Connecting to it reaches the local host.
  if (a === 0) return { kind: "never", reason: "loopback_ip" };
  if (a === 169 && c === 254) {
    if (d === 169 && e === 254) return { kind: "never", reason: "metadata_service_ip" };
    return { kind: "never", reason: "link_local_ip" };
  }
  if (a === 10) return { kind: "private", reason: "private_ip" };
  if (a === 172 && c >= 16 && c <= 31) return { kind: "private", reason: "private_ip" };
  if (a === 192 && c === 168) return { kind: "private", reason: "private_ip" };
  // 100.64.0.0/10 — carrier-grade NAT (also hosts some providers' metadata).
  if (a === 100 && c >= 64 && c <= 127) return { kind: "private", reason: "private_ip" };
  // 192.0.0.0/24 — IETF protocol assignments; 198.18.0.0/15 — benchmarking.
  if (a === 192 && c === 0 && d === 0) return { kind: "never", reason: "private_ip" };
  if (a === 198 && (c === 18 || c === 19)) return { kind: "never", reason: "private_ip" };
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast.
  if (a >= 224) return { kind: "never", reason: "private_ip" };
  return { kind: "public" };
}

function classifyV6Bytes(b: ReadonlyArray<number>): AddressClass {
  const zeroUpTo = (n: number) => b.slice(0, n).every((x) => x === 0);
  const embedded = b.slice(12, 16);
  // ::/128 unspecified and ::1 loopback.
  if (zeroUpTo(15) && b[15] === 0) return { kind: "never", reason: "loopback_ip" };
  if (zeroUpTo(15) && b[15] === 1) return { kind: "loopback" };
  // ::ffff:0:0/96 IPv4-mapped — the address IS the embedded IPv4.
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return classifyV4Bytes(embedded);
  // ::ffff:0:0:0/96 IPv4-translated (SIIT).
  if (zeroUpTo(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return classifyV4Bytes(embedded);
  }
  // ::/96 IPv4-compatible (deprecated): never a legitimate destination.
  if (zeroUpTo(12)) return { kind: "never", reason: "reserved_ip" };
  // 64:ff9b::/96 well-known NAT64 prefix: the embedded IPv4 decides.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return classifyV4Bytes(embedded);
  }
  // 64:ff9b:1::/48 local-use NAT64: a private translator by definition.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) {
    return { kind: "never", reason: "reserved_ip" };
  }
  // 2002::/16 6to4: the next 32 bits are an IPv4 address.
  if (b[0] === 0x20 && b[1] === 0x02) {
    const v4 = classifyV4Bytes(b.slice(2, 6));
    return v4.kind === "public" ? { kind: "public" } : { kind: "never", reason: "reserved_ip" };
  }
  // 2001:0::/32 Teredo: hides an arbitrary IPv4 client address.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    return { kind: "never", reason: "reserved_ip" };
  }
  // fc00::/7 unique local.
  if ((b[0]! & 0xfe) === 0xfc) return { kind: "private", reason: "ipv6_local" };
  // fe80::/10 link-local; fec0::/10 deprecated site-local.
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return { kind: "never", reason: "link_local_ip" };
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return { kind: "never", reason: "ipv6_local" };
  // ff00::/8 multicast.
  if (b[0] === 0xff) return { kind: "never", reason: "private_ip" };
  return { kind: "public" };
}

/** 4, 6, or 0 — the same answer as `net.isIP`, without a Node dependency. */
export function outboundIpVersion(ip: string): 0 | 4 | 6 {
  if (parseIpv4(ip)) return 4;
  if (parseIpv6(ip)) return 6;
  return 0;
}

function classify(ip: string): AddressClass | null {
  const v4 = parseIpv4(ip);
  if (v4) return classifyV4Bytes(v4);
  const v6 = parseIpv6(ip);
  if (v6) return classifyV6Bytes(v6);
  return null;
}

/**
 * The refusal reason for one IP address, or null when the policy allows a
 * connection to it. A string that is not an IP address is refused.
 */
export function classifyOutboundAddress(
  ip: string,
  localAllowance: OutboundLocalAllowance = "none",
): OutboundRefusalReason | null {
  const c = classify(ip);
  if (!c) return "invalid_url";
  switch (c.kind) {
    case "public":
      return null;
    case "loopback":
      return localAllowance === "none" ? "loopback_ip" : null;
    case "private":
      return localAllowance === "private" ? null : c.reason;
    case "never":
      return c.reason;
  }
}

// -----------------------------------------------------------------------------
// URL check (no network)
// -----------------------------------------------------------------------------

export type OutboundUrlCheck =
  | {
      ok: true;
      url: URL;
      /** Lower-case, without IPv6 brackets or trailing dots. */
      hostname: string;
      isIpLiteral: boolean;
      origin: string;
      normalized: string;
    }
  | { ok: false; reason: OutboundRefusalReason };

function canonicalHostname(parsed: URL): string {
  let h = parsed.hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // `localhost.` and `example.com.` are the same names as without the dot.
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

export function checkOutboundUrlStatic(
  raw: string,
  policy: OutboundUrlPolicy,
): OutboundUrlCheck {
  if (typeof raw !== "string") return { ok: false, reason: "invalid_url" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "invalid_url" };
  if (trimmed.length > (policy.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH)) {
    return { ok: false, reason: "url_too_long" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "non_https_scheme" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials_in_url" };
  }
  const hostname = canonicalHostname(parsed);
  if (!hostname) return { ok: false, reason: "invalid_url" };
  const isIpLiteral = outboundIpVersion(hostname) > 0;

  // Plain http is admitted only to a loopback literal under a loopback (or
  // wider) allowance: a local test receiver, never a named host.
  if (parsed.protocol === "http:") {
    const loopbackLiteral =
      isIpLiteral && classify(hostname)?.kind === "loopback";
    if (!(loopbackLiteral && policy.localAllowance !== "none")) {
      return { ok: false, reason: "non_https_scheme" };
    }
  } else if (policy.requireDefaultPort && parsed.port && parsed.port !== "443") {
    const loopbackLiteral =
      isIpLiteral && classify(hostname)?.kind === "loopback";
    if (!(loopbackLiteral && policy.localAllowance !== "none")) {
      return { ok: false, reason: "non_default_port" };
    }
  }

  if (!isIpLiteral) {
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return { ok: false, reason: "localhost" };
    }
  } else {
    const reason = classifyOutboundAddress(hostname, policy.localAllowance);
    if (reason) return { ok: false, reason };
  }
  return {
    ok: true,
    url: parsed,
    hostname,
    isIpLiteral,
    origin: parsed.origin,
    normalized: parsed.toString(),
  };
}

