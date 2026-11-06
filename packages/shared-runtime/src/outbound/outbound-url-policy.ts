/**
 * THE OUTBOUND URL POLICY — network part (PRO-061 / BILLING-02, PRO-064 /
 * BILLING-05, PRO-067 / BILLING-08).
 *
 * The address rules live in `@proovra/shared/outbound-url-policy` and are
 * re-exported here. This file adds what needs Node:
 *
 *   - `checkOutboundUrlResolved`: the static check, then every address the
 *     name resolves to must be allowed (a pre-flight answer);
 *   - `createGuardedLookup`: a `lookup` for the socket itself, so the address
 *     that is checked is the address the connection is made to, and a DNS
 *     answer that changes between a check and the send (rebinding) cannot
 *     reach a refused address;
 *   - `sendOutboundRequest`: the one send. It repeats the static check at
 *     every send (a row stored before a rule existed is not trusted),
 *     resolves the name ONCE through the guarded lookup, connects on a fresh
 *     socket to exactly that checked literal address (the name is kept as TLS
 *     server name and Host header, so certificates are still verified against
 *     it), never follows a redirect, and reports the status and a byte count —
 *     not the receiver's body — unless a caller explicitly asks for the body.
 *
 * Used at create (static) and at every send by lifecycle webhooks (API and
 * worker), automation webhooks and integration webhooks.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";

import {
  checkOutboundUrlStatic,
  classifyOutboundAddress,
  type OutboundLocalAllowance,
  type OutboundRefusalReason,
  type OutboundUrlCheck,
  type OutboundUrlPolicy,
} from "@proovra/shared/outbound-url-policy";

export * from "@proovra/shared/outbound-url-policy";
// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

/** The shape of `dns.lookup` with `{ all: true }`, injectable for tests. */
export type OutboundResolver = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export const systemResolver: OutboundResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses as LookupAddress[]);
    });
  });

/**
 * Static check, then resolve the name and refuse when ANY answer is refused.
 * Use for a pre-flight answer (OIDC discovery, a create-time probe); the send
 * path does not rely on it, because `sendOutboundRequest` checks the address
 * it connects to.
 */
export async function checkOutboundUrlResolved(
  raw: string,
  policy: OutboundUrlPolicy,
  resolver: OutboundResolver = systemResolver,
): Promise<OutboundUrlCheck> {
  const s = checkOutboundUrlStatic(raw, policy);
  if (!s.ok || s.isIpLiteral) return s;
  let answers: ReadonlyArray<{ address: string; family: number }>;
  try {
    answers = await resolver(s.hostname);
  } catch {
    return { ok: false, reason: "dns_resolution_failed" };
  }
  if (answers.length === 0) return { ok: false, reason: "dns_resolution_failed" };
  for (const a of answers) {
    const reason = classifyOutboundAddress(a.address, policy.localAllowance);
    if (reason) return { ok: false, reason };
  }
  return s;
}

export const OUTBOUND_REFUSED_CODE = "PROOVRA_OUTBOUND_ADDRESS_REFUSED";

export class OutboundAddressRefusedError extends Error {
  readonly code = OUTBOUND_REFUSED_CODE;
  constructor(public readonly reason: OutboundRefusalReason) {
    super(`outbound address refused: ${reason}`);
    this.name = "OutboundAddressRefusedError";
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for `net`/`tls` connections that resolves the name and refuses
 * the connection when any answer is refused. Because the socket connects to
 * the address this function returns, the checked address and the connected
 * address are the same address.
 */
export function createGuardedLookup(
  localAllowance: OutboundLocalAllowance,
  resolver: OutboundResolver = systemResolver,
) {
  return function guardedLookup(
    hostname: string,
    options: { family?: number | string; all?: boolean } | number | LookupCallback,
    maybeCallback?: LookupCallback,
  ): void {
    const callback = (typeof options === "function" ? options : maybeCallback) as LookupCallback;
    const opts = typeof options === "object" && options !== null ? options : {};
    resolver(hostname).then(
      (answers) => {
        const family =
          opts.family === 4 || opts.family === "IPv4"
            ? 4
            : opts.family === 6 || opts.family === "IPv6"
              ? 6
              : 0;
        const usable = family ? answers.filter((a) => a.family === family) : [...answers];
        if (usable.length === 0) {
          const e = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
          e.code = "ENOTFOUND";
          callback(e, "");
          return;
        }
        for (const a of answers) {
          const reason = classifyOutboundAddress(a.address, localAllowance);
          if (reason) {
            callback(new OutboundAddressRefusedError(reason) as unknown as NodeJS.ErrnoException, "");
            return;
          }
        }
        if (opts.all) callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, usable[0]!.address, usable[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
}

// -----------------------------------------------------------------------------
// The send
// -----------------------------------------------------------------------------

export type OutboundSendResult =
  | { kind: "refused"; reason: OutboundRefusalReason }
  | {
      kind: "response";
      status: number;
      /** Bytes of response body read, capped at `maxResponseBytes`. */
      responseBytes: number;
      /** Present only when `captureBody` was set. */
      body?: string;
    }
  | {
      kind: "error";
      /** The transport's error code (ECONNREFUSED, ENOTFOUND, ...), or "timeout". */
      code: string;
      /** True once a connection was established, so bytes may have left. */
      requestWritten: boolean;
    };

export type OutboundSendInput = {
  url: string;
  method?: "POST" | "GET";
  headers: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
  policy: OutboundUrlPolicy;
  resolver?: OutboundResolver;
  /** Read at most this many response bytes, then stop. Default 64 KiB. */
  maxResponseBytes?: number;
  captureBody?: boolean;
};

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Resolve once through the guarded lookup: every answer checked, one chosen.
 * The request is then made to that literal address (with the original name
 * as TLS server name and Host header), so there is no second resolution for
 * a rebinding answer to slip into.
 */
function resolvePinnedAddress(
  hostname: string,
  localAllowance: OutboundLocalAllowance,
  resolver: OutboundResolver | undefined,
): Promise<{ ok: true; address: string } | { ok: false; result: OutboundSendResult }> {
  const lookup = createGuardedLookup(localAllowance, resolver);
  return new Promise((resolve) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        if (err instanceof OutboundAddressRefusedError || err.code === OUTBOUND_REFUSED_CODE) {
          resolve({
            ok: false,
            result: { kind: "refused", reason: (err as unknown as OutboundAddressRefusedError).reason },
          });
          return;
        }
        resolve({
          ok: false,
          result: { kind: "error", code: err.code ?? "ENOTFOUND", requestWritten: false },
        });
        return;
      }
      const list = addresses as LookupAddress[];
      resolve({ ok: true, address: list[0]!.address });
    });
  });
}

export async function sendOutboundRequest(input: OutboundSendInput): Promise<OutboundSendResult> {
  const check = checkOutboundUrlStatic(input.url, input.policy);
  if (!check.ok) return { kind: "refused", reason: check.reason };
  let connectAddress = check.hostname;
  if (!check.isIpLiteral) {
    const pinned = await resolvePinnedAddress(
      check.hostname,
      input.policy.localAllowance,
      input.resolver,
    );
    if (!pinned.ok) return pinned.result;
    connectAddress = pinned.address;
  }
  return requestPinned(input, check, connectAddress);
}

function requestPinned(
  input: OutboundSendInput,
  check: Extract<OutboundUrlCheck, { ok: true }>,
  connectAddress: string,
): Promise<OutboundSendResult> {
  const url = check.url;
  const maxBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const transport = url.protocol === "http:" ? http : https;
  // Defence in depth: the address is a literal, so `net` does not call a
  // lookup; if it ever did, it would get the guarded one.
  const lookup = createGuardedLookup(input.policy.localAllowance, input.resolver);

  return new Promise<OutboundSendResult>((resolve) => {
    let settled = false;
    let connected = false;
    const finish = (r: OutboundSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const headers: Record<string, string> = { ...input.headers, host: url.host };
    if (input.body !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(input.body, "utf8"));
    }
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: connectAddress,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: input.method ?? "POST",
        headers,
        // A fresh connection per request: a pooled socket could have been
        // opened to an address this request never checked.
        agent: false,
        lookup: lookup as unknown as typeof dnsLookup,
        ...(check.isIpLiteral ? {} : { servername: check.hostname }),
      },
      (res) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          const remaining = maxBytes - bytes;
          if (remaining <= 0) return;
          const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
          bytes += slice.length;
          if (input.captureBody) chunks.push(slice);
          if (bytes >= maxBytes) res.destroy();
        });
        const done = () =>
          finish({
            kind: "response",
            status: res.statusCode ?? 0,
            responseBytes: bytes,
            ...(input.captureBody ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
          });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      },
    );
    const timer = setTimeout(() => {
      finish({ kind: "error", code: "timeout", requestWritten: connected });
      req.destroy();
    }, input.timeoutMs);
    req.on("socket", (socket) => {
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
        connected = true;
      });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err instanceof OutboundAddressRefusedError || err.code === OUTBOUND_REFUSED_CODE) {
        finish({ kind: "refused", reason: (err as OutboundAddressRefusedError).reason });
        return;
      }
      finish({ kind: "error", code: err.code ?? "unknown", requestWritten: connected });
    });
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}
