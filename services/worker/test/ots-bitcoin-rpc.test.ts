/**
 * THE BITCOIN CORE JSON-RPC CLIENT, AGAINST A REAL LOOPBACK HTTP SERVER.
 *
 * `BtcRpcClient` (src/ots-bitcoin-rpc.ts) talks over real HTTP to a real
 * `node:http` server bound to 127.0.0.1 on an ephemeral port. Nothing in the
 * client is doubled: the transport, the Authorization header, the size bound,
 * the abort timer and the shape checks all run for real.
 *
 * DOUBLES (labelled):
 *   - MOCK: `../src/db.js` is replaced by an inert object so that importing
 *     src/ots-bitcoin-telemetry.ts does not build a Prisma client/pg pool. The
 *     telemetry function under test (`bitcoinVerifierTelemetryMetadata`) is pure
 *     and never touches it.
 *   - FAKE NODE: the loopback server plays Bitcoin Core. Its answers are canned
 *     JSON-RPC bodies chosen per test.
 *   - SPY (capturing): in the redaction section the worker pino `logger`
 *     methods and `console` methods are spied on and their arguments captured
 *     (output suppressed) during failing calls; restored after each test.
 *
 * SECRET REDACTION: a distinctive username/password pair is used throughout,
 * and every failure is checked for the password, its Basic token, and (for
 * operator surfaces) the username and full URL.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { formatOtsChainVerifier } from "@proovra/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

import { logger } from "../src/logger.js";
import { resolveOtsBitcoinVerifierConfig, rpcPassword } from "../src/ots-bitcoin-config.js";
import { BTC_RPC_MAX_RESPONSE_BYTES, BtcRpcClient, BtcRpcError } from "../src/ots-bitcoin-rpc.js";
import { bitcoinVerifierTelemetryMetadata } from "../src/ots-bitcoin-telemetry.js";
import { getOtsBitcoinVerifierReadiness, probeOtsBitcoinVerifierReadiness } from "../src/ots-bitcoin-verifier.js";

const USER = "rpc-user-xq7";
const PASSWORD = "s3cr3t-PASSWORD-zz9";
const BASIC_TOKEN = Buffer.from(`${USER}:${PASSWORD}`, "utf8").toString("base64");
const HASH_A = "AB".repeat(32);
const RAW_HEADER = "0A".repeat(80);

type Seen = { method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"]; body: string };
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
let seen: Seen[] = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
const ok = (result: unknown) => (_q: IncomingMessage, res: ServerResponse) => json(res, 200, { result, error: null, id: "x" });

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      // One connection per request: no pooled keep-alive socket is carried from
      // one test's canned answer into the next.
      res.setHeader("connection", "close");
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  handler = (_q, res) => json(res, 500, { result: null, error: { code: -32601, message: "no handler" }, id: "x" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function client(opts: { url?: string; timeoutMs?: number } = {}): BtcRpcClient {
  return new BtcRpcClient({ url: opts.url ?? baseUrl, username: USER, password: () => PASSWORD, timeoutMs: opts.timeoutMs ?? 2_000 });
}

async function failure(p: Promise<unknown>): Promise<BtcRpcError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BtcRpcError);
    return err as BtcRpcError;
  }
  throw new Error("expected the call to fail");
}

function assertNoSecret(text: string): void {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(BASIC_TOKEN);
}

function assertErrorClean(err: BtcRpcError): void {
  assertNoSecret(err.message);
  assertNoSecret(String(err.stack ?? ""));
  assertNoSecret(String(err));
  assertNoSecret(JSON.stringify(err));
  assertNoSecret(JSON.stringify({ ...err, message: err.message }));
  expect(err.message.length).toBeLessThanOrEqual(240);
}

describe("BtcRpcClient — success shapes", () => {
  it("getNetworkInfo returns version and subversion", async () => {
    handler = ok({ version: 270000, subversion: "/Satoshi:27.0.0/", protocolversion: 70016 });
    await expect(client().getNetworkInfo()).resolves.toEqual({ version: 270000, subversion: "/Satoshi:27.0.0/" });
  });

  const chainInfo = {
    chain: "main",
    blocks: 860000,
    headers: 860001,
    initialblockdownload: false,
    verificationprogress: 0.99999,
    time: 1_760_000_000,
    bestblockhash: HASH_A,
  };

  it("getBlockchainInfo accepts warnings as a string (older Core) and lowercases the tip hash", async () => {
    handler = ok({ ...chainInfo, warnings: "" });
    const r = await client().getBlockchainInfo();
    expect(r).toEqual({ ...chainInfo, bestblockhash: HASH_A.toLowerCase(), warnings: "" });
  });

  it("getBlockchainInfo accepts warnings as an array of strings (Core 28+)", async () => {
    handler = ok({ ...chainInfo, warnings: ["a", "b"] });
    expect((await client().getBlockchainInfo()).warnings).toEqual(["a", "b"]);
  });

  it("getBlockHash returns the lowercased hash", async () => {
    handler = ok(HASH_A);
    await expect(client().getBlockHash(0)).resolves.toBe(HASH_A.toLowerCase());
  });

  it("getBlockHeaderRaw returns the 80-byte header lowercased", async () => {
    handler = ok(RAW_HEADER);
    await expect(client().getBlockHeaderRaw(HASH_A)).resolves.toBe(RAW_HEADER.toLowerCase());
  });

  it("getBlockHeaderVerbose returns hash/height/confirmations/merkleroot; confirmations -1 (stale) is allowed", async () => {
    handler = ok({ hash: HASH_A, height: 100, confirmations: -1, merkleroot: "CD".repeat(32), nonce: 1 });
    await expect(client().getBlockHeaderVerbose(HASH_A)).resolves.toEqual({
      hash: HASH_A.toLowerCase(),
      height: 100,
      confirmations: -1,
      merkleroot: "cd".repeat(32),
    });
  });
});

describe("BtcRpcClient — the request on the wire", () => {
  it("is a POST with a JSON-RPC body, Basic auth from the separate user/password, and a credential-free path", async () => {
    handler = ok(HASH_A);
    await client().getBlockHash(42);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/");
    expect(req.url).not.toContain("?");
    expect(req.url).not.toContain(PASSWORD);
    expect(req.url).not.toContain(USER);
    expect(req.headers.authorization).toBe(`Basic ${BASIC_TOKEN}`);
    expect(req.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(req.body) as { method: string; params: unknown[]; id: unknown };
    expect(body.method).toBe("getblockhash");
    expect(body.params).toEqual([42]);
    expect(req.body).not.toContain(PASSWORD);
  });

  it("getblockheader is called with verbose=false for raw and verbose=true for the object", async () => {
    handler = ok(RAW_HEADER);
    await client().getBlockHeaderRaw(HASH_A);
    handler = ok({ hash: HASH_A, height: 1, confirmations: 1, merkleroot: HASH_A });
    await client().getBlockHeaderVerbose(HASH_A);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ method: "getblockheader", params: [HASH_A, false] });
    expect(JSON.parse(seen[1]!.body)).toMatchObject({ method: "getblockheader", params: [HASH_A, true] });
  });
});

describe("BtcRpcClient — failures map to bounded codes", () => {
  it("HTTP 401 → BTC_RPC_UNAUTHORIZED", async () => {
    handler = (_q, res) => { res.writeHead(401); res.end(); };
    const err = await failure(client().getNetworkInfo());
    expect(err.code).toBe("BTC_RPC_UNAUTHORIZED");
    expect(err.method).toBe("getnetworkinfo");
  });

  it("HTTP 403 → BTC_RPC_FORBIDDEN", async () => {
    handler = (_q, res) => { res.writeHead(403); res.end(); };
    expect((await failure(client().getNetworkInfo())).code).toBe("BTC_RPC_FORBIDDEN");
  });

  it("no answer within timeoutMs → BTC_RPC_TIMEOUT", async () => {
    handler = () => { /* never answers */ };
    const started = Date.now();
    const err = await failure(client({ timeoutMs: 150 }).getNetworkInfo());
    expect(err.code).toBe("BTC_RPC_TIMEOUT");
    expect(err.message).toContain("150ms");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("connection refused → BTC_RPC_UNAVAILABLE", async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const err = await failure(client({ url: `http://127.0.0.1:${port}/` }).getNetworkInfo());
    expect(err.code).toBe("BTC_RPC_UNAVAILABLE");
    expect(err.message).not.toContain("127.0.0.1");
  });

  it("malformed JSON with HTTP 200 → BTC_RPC_MALFORMED_RESPONSE", async () => {
    handler = (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{not json"); };
    expect((await failure(client().getNetworkInfo())).code).toBe("BTC_RPC_MALFORMED_RESPONSE");
  });

  it("oversized body declared by content-length → BTC_RPC_MALFORMED_RESPONSE", async () => {
    const big = JSON.stringify({ result: "x".repeat(BTC_RPC_MAX_RESPONSE_BYTES + 10), error: null, id: "x" });
    handler = (_q, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(big) });
      res.end(big);
    };
    const err = await failure(client().getBlockHash(1));
    expect(err.code).toBe("BTC_RPC_MALFORMED_RESPONSE");
    expect(err.message).toContain("size bound");
  });

  it("oversized chunked body (no content-length) → BTC_RPC_MALFORMED_RESPONSE", async () => {
    handler = (_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"result":"');
      const chunk = "y".repeat(8 * 1024);
      for (let i = 0; i < 10; i += 1) res.write(chunk);
      res.end('","error":null,"id":"x"}');
    };
    const err = await failure(client().getBlockHash(1));
    expect(seen).toHaveLength(1);
    expect(err.code).toBe("BTC_RPC_MALFORMED_RESPONSE");
    expect(err.message).toContain("size bound");
  });

  it("a JSON-RPC error (HTTP 500, as Bitcoin Core answers) → BTC_RPC_ERROR carrying rpcCode", async () => {
    handler = (_q, res) => json(res, 500, { result: null, error: { code: -5, message: "Block not found" }, id: "x" });
    const err = await failure(client().getBlockHeaderRaw(HASH_A));
    expect(err.code).toBe("BTC_RPC_ERROR");
    expect(err.rpcCode).toBe(-5);
    expect(err.message).toContain("Block not found");
  });

  it("getBlockHash: rpc -8 (height out of range) → null", async () => {
    handler = (_q, res) => json(res, 500, { result: null, error: { code: -8, message: "Block height out of range" }, id: "x" });
    await expect(client().getBlockHash(99_999_999)).resolves.toBeNull();
  });

  it("getBlockHash: any other rpc error still throws", async () => {
    handler = (_q, res) => json(res, 500, { result: null, error: { code: -1, message: "x" }, id: "x" });
    expect((await failure(client().getBlockHash(1))).rpcCode).toBe(-1);
  });

  it("non-JSON HTTP 502 → BTC_RPC_UNAVAILABLE", async () => {
    handler = (_q, res) => { res.writeHead(502, { "content-type": "text/html" }); res.end("<html>Bad Gateway</html>"); };
    const err = await failure(client().getNetworkInfo());
    expect(err.code).toBe("BTC_RPC_UNAVAILABLE");
    expect(err.message).toContain("502");
    expect(err.message).not.toContain("Bad Gateway");
  });

  const malformed: Array<[string, (c: BtcRpcClient) => Promise<unknown>, Handler]> = [
    ["getblockchaininfo missing initialblockdownload", (c) => c.getBlockchainInfo(), ok({ chain: "main", blocks: 1, headers: 1, verificationprogress: 1, time: 1, bestblockhash: HASH_A, warnings: "" })],
    ["getblockchaininfo non-hex bestblockhash", (c) => c.getBlockchainInfo(), ok({ chain: "main", blocks: 1, headers: 1, initialblockdownload: false, verificationprogress: 1, time: 1, bestblockhash: "zz".repeat(32), warnings: "" })],
    ["getblockchaininfo warnings neither string nor string[]", (c) => c.getBlockchainInfo(), ok({ chain: "main", blocks: 1, headers: 1, initialblockdownload: false, verificationprogress: 1, time: 1, bestblockhash: HASH_A, warnings: [1] })],
    ["getnetworkinfo negative version", (c) => c.getNetworkInfo(), ok({ version: -1, subversion: "x" })],
    ["getnetworkinfo result is an array", (c) => c.getNetworkInfo(), ok([1, 2])],
    ["getblockhash non-hex hash", (c) => c.getBlockHash(1), ok("g".repeat(64))],
    ["getblockhash short hash", (c) => c.getBlockHash(1), ok("ab".repeat(31))],
    ["getblockheader raw of the wrong length", (c) => c.getBlockHeaderRaw(HASH_A), ok("ab".repeat(79))],
    ["getblockheader raw not a string", (c) => c.getBlockHeaderRaw(HASH_A), ok({ hex: RAW_HEADER })],
    ["getblockheader verbose non-integer confirmations", (c) => c.getBlockHeaderVerbose(HASH_A), ok({ hash: HASH_A, height: 1, confirmations: 1.5, merkleroot: HASH_A })],
    ["getblockheader verbose bad merkleroot", (c) => c.getBlockHeaderVerbose(HASH_A), ok({ hash: HASH_A, height: 1, confirmations: 1, merkleroot: "nope" })],
    ["no `result` key", (c) => c.getNetworkInfo(), (_q, res) => json(res, 200, { error: null, id: "x" })],
    ["array body", (c) => c.getNetworkInfo(), (_q, res) => json(res, 200, [{ result: { version: 1, subversion: "x" } }])],
    ["JSON null body", (c) => c.getNetworkInfo(), (_q, res) => json(res, 200, null)],
  ];
  for (const [name, call, h] of malformed) {
    it(`${name} → BTC_RPC_MALFORMED_RESPONSE`, async () => {
      handler = h;
      expect((await failure(call(client()))).code).toBe("BTC_RPC_MALFORMED_RESPONSE");
    });
  }
});

describe("SECRET REDACTION — the password never leaves the Authorization header", () => {
  const cases: Array<[string, Handler | null, { timeoutMs?: number; refused?: boolean }]> = [
    ["401", (_q, res) => { res.writeHead(401); res.end(); }, {}],
    ["403", (_q, res) => { res.writeHead(403); res.end(); }, {}],
    ["timeout", () => undefined, { timeoutMs: 150 }],
    ["refused", null, { refused: true }],
    ["malformed JSON", (_q, res) => { res.writeHead(200); res.end("{"); }, {}],
    ["oversized", (_q, res) => { res.writeHead(200); res.end("z".repeat(BTC_RPC_MAX_RESPONSE_BYTES + 1)); }, {}],
    ["rpc error", (_q, res) => json(res, 500, { result: null, error: { code: -5, message: "Block not found" }, id: "x" }), {}],
    ["502", (_q, res) => { res.writeHead(502); res.end("bad gateway"); }, {}],
    ["shape", ok({ version: "x" }), {}],
  ];

  for (const [name, h, opts] of cases) {
    it(`${name}: the error, its stack, its serialisation and the logs carry neither the password nor its Basic token`, async () => {
      const logged: unknown[] = [];
      for (const level of ["info", "warn", "error", "debug", "fatal", "trace"] as const) {
        vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
      }
      const consoleLogged: unknown[] = [];
      for (const level of ["log", "warn", "error", "info", "debug"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleLogged.push(args); });
      }

      let url = baseUrl;
      if (opts.refused) {
        const dead = createServer();
        await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
        url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/`;
        await new Promise<void>((resolve) => dead.close(() => resolve()));
      } else {
        handler = h!;
      }
      const err = await failure(client({ url, timeoutMs: opts.timeoutMs }).getNetworkInfo());
      assertErrorClean(err);
      for (const s of seen) {
        expect(s.url ?? "").not.toContain(PASSWORD);
        expect(s.url ?? "").not.toContain(BASIC_TOKEN);
      }
      const logText = JSON.stringify(logged.map((a) => (a as unknown[]).map((x) => (x instanceof Error ? { m: x.message, s: x.stack } : x))));
      assertNoSecret(logText);
      assertNoSecret(JSON.stringify(consoleLogged));
    });
  }

  it("readiness and its telemetry document carry neither the password, the username nor the RPC URL", async () => {
    handler = (_q, res) => { res.writeHead(401); res.end(); };
    const env = {
      OTS_BITCOIN_VERIFY_ENABLED: "true",
      OTS_BITCOIN_RPC_URL: baseUrl,
      OTS_BITCOIN_RPC_USERNAME: USER,
      OTS_BITCOIN_RPC_PASSWORD: PASSWORD,
      OTS_BITCOIN_EXPECTED_CHAIN: "regtest",
    } as NodeJS.ProcessEnv;
    const config = resolveOtsBitcoinVerifierConfig(env, { productionLike: false });
    expect(config.kind).toBe("enabled");
    if (config.kind !== "enabled") return;
    const rpc = new BtcRpcClient({ url: config.rpcUrl, username: config.username, password: () => rpcPassword(config, env), timeoutMs: config.timeoutMs });

    const probed = await probeOtsBitcoinVerifierReadiness({ config, client: rpc, now: () => new Date("2026-10-15T00:00:00Z") });
    expect(probed.ready).toBe(false);
    expect(probed.code).toBe("BTC_RPC_UNAUTHORIZED");
    expect(seen[0]!.headers.authorization).toBe(`Basic ${BASIC_TOKEN}`);

    const readiness = getOtsBitcoinVerifierReadiness();
    const readinessText = JSON.stringify(readiness);
    const telemetryText = JSON.stringify(bitcoinVerifierTelemetryMetadata(readiness));
    for (const text of [readinessText, telemetryText]) {
      assertNoSecret(text);
      expect(text).not.toContain(USER);
      expect(text).not.toContain(baseUrl);
      expect(text).not.toContain("http://");
    }
    // The endpoint label (host:port) is the only address readiness carries; telemetry carries none.
    expect(readiness.endpoint).toBe(config.rpcEndpointLabel);
    expect(readiness.endpoint).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(telemetryText).not.toContain("127.0.0.1");
  });

  it("readiness on a timeout is equally clean", async () => {
    handler = () => undefined;
    const env = {
      OTS_BITCOIN_VERIFY_ENABLED: "true",
      OTS_BITCOIN_RPC_URL: baseUrl,
      OTS_BITCOIN_RPC_USERNAME: USER,
      OTS_BITCOIN_RPC_PASSWORD: PASSWORD,
      OTS_BITCOIN_EXPECTED_CHAIN: "regtest",
    } as NodeJS.ProcessEnv;
    const config = resolveOtsBitcoinVerifierConfig(env, { productionLike: false });
    if (config.kind !== "enabled") throw new Error("expected enabled");
    const rpc = new BtcRpcClient({ url: config.rpcUrl, username: config.username, password: () => rpcPassword(config, env), timeoutMs: 150 });
    const r = await probeOtsBitcoinVerifierReadiness({ config, client: rpc });
    expect(r.code).toBe("BTC_RPC_TIMEOUT");
    for (const text of [JSON.stringify(getOtsBitcoinVerifierReadiness()), JSON.stringify(bitcoinVerifierTelemetryMetadata(r))]) {
      assertNoSecret(text);
      expect(text).not.toContain(USER);
      expect(text).not.toContain("http://");
    }
  });

  it("the custody verifier string carries only core version, policy minimum and a proof prefix", () => {
    const v = formatOtsChainVerifier({ nodeVersion: 270000, minConfirmations: 6, proofSha256: "ab".repeat(32) });
    expect(v).toMatch(/^proovra-ots-chain\/1;core=270000;min=6;proof=[0-9a-f]{16}$/);
    assertNoSecret(v);
    expect(v).not.toContain(USER);
    expect(v).not.toContain("http");
  });
});
