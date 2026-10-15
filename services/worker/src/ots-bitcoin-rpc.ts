/**
 * BITCOIN CORE JSON-RPC CLIENT — the one worker-owned client, used ONLY by the
 * OpenTimestamps chain verifier (ots-bitcoin-verifier.ts).
 *
 * The node is the dedicated verification-only Bitcoin Core (pruned,
 * txindex=0, wallet disabled), so only header and chain-state methods are ever
 * called: getnetworkinfo, getblockchaininfo, getblockhash, getblockheader.
 * Never getblock, getrawtransaction, wallet or index methods.
 *
 * SECRETS: the password is passed in as a function result per request (so a
 * rotated secret is picked up) and placed ONLY in the Authorization header.
 * It never appears in a URL, a thrown message, a log line, Sentry context or
 * returned value. Errors carry a bounded code and a bounded, credential-free
 * detail; raw responses are never logged or returned.
 */

export const BTC_RPC_MAX_RESPONSE_BYTES = 64 * 1024;

export type BtcRpcErrorCode =
  | "BTC_RPC_TIMEOUT"
  | "BTC_RPC_UNAUTHORIZED"
  | "BTC_RPC_FORBIDDEN"
  | "BTC_RPC_UNAVAILABLE"
  | "BTC_RPC_ERROR"
  | "BTC_RPC_MALFORMED_RESPONSE";

export class BtcRpcError extends Error {
  readonly code: BtcRpcErrorCode;
  /** The JSON-RPC error code when the node answered with one. */
  readonly rpcCode: number | null;
  readonly method: string;
  constructor(code: BtcRpcErrorCode, method: string, detail: string, rpcCode: number | null = null) {
    // Bounded and credential-free by construction: only codes, the method name
    // and a short detail built here (never a response body or a URL).
    super(`${code}: ${method}: ${detail}`.slice(0, 240));
    this.name = "BtcRpcError";
    this.code = code;
    this.rpcCode = rpcCode;
    this.method = method;
  }
}

export type BtcRpcClientOptions = {
  /** http(s)://host:port/ — validated by ots-bitcoin-config (no userinfo). */
  url: string;
  username: string;
  password: () => string;
  timeoutMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

type JsonRpcResponse = { result?: unknown; error?: { code?: unknown; message?: unknown } | null; id?: unknown };

async function readBounded(res: Response, method: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > BTC_RPC_MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new BtcRpcError("BTC_RPC_MALFORMED_RESPONSE", method, "response exceeds the size bound");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BTC_RPC_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BtcRpcError("BTC_RPC_MALFORMED_RESPONSE", method, "response exceeds the size bound");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export class BtcRpcClient {
  private id = 0;
  constructor(private readonly opts: BtcRpcClientOptions) {}

  /** One JSON-RPC call. Throws BtcRpcError only. */
  async call(method: string, params: unknown[] = []): Promise<unknown> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const auth = `Basic ${Buffer.from(`${this.opts.username}:${this.opts.password()}`, "utf8").toString("base64")}`;
    this.id += 1;
    let res: Response;
    try {
      res = await fetchImpl(this.opts.url, {
        method: "POST",
        signal: controller.signal,
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json", authorization: auth },
        body: JSON.stringify({ jsonrpc: "1.0", id: `proovra-${this.id}`, method, params }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted || (err as { name?: string })?.name === "AbortError") {
        throw new BtcRpcError("BTC_RPC_TIMEOUT", method, `no response within ${this.opts.timeoutMs}ms`);
      }
      // Connection refused, DNS, reset… never echo the error text (it can carry the URL).
      const code = (err as { cause?: { code?: unknown } })?.cause?.code;
      throw new BtcRpcError("BTC_RPC_UNAVAILABLE", method, typeof code === "string" ? code.slice(0, 40) : "connection failed");
    }
    try {
      if (res.status === 401 || res.status === 403) {
        // Release the connection: the body of a refusal is never read.
        await res.body?.cancel().catch(() => undefined);
        throw res.status === 401
          ? new BtcRpcError("BTC_RPC_UNAUTHORIZED", method, "HTTP 401")
          : new BtcRpcError("BTC_RPC_FORBIDDEN", method, "HTTP 403");
      }
      let text: string;
      try {
        text = await readBounded(res, method);
      } catch (err) {
        if (err instanceof BtcRpcError) throw err;
        if (controller.signal.aborted) throw new BtcRpcError("BTC_RPC_TIMEOUT", method, `no response within ${this.opts.timeoutMs}ms`);
        throw new BtcRpcError("BTC_RPC_UNAVAILABLE", method, "response body could not be read");
      }
      let body: JsonRpcResponse;
      try {
        body = JSON.parse(text) as JsonRpcResponse;
      } catch {
        throw new BtcRpcError(
          res.ok ? "BTC_RPC_MALFORMED_RESPONSE" : "BTC_RPC_UNAVAILABLE",
          method,
          res.ok ? "response is not JSON" : `HTTP ${res.status}`,
        );
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new BtcRpcError("BTC_RPC_MALFORMED_RESPONSE", method, "response is not a JSON-RPC object");
      }
      if (body.error) {
        const rpcCode = typeof body.error.code === "number" ? body.error.code : null;
        // The node's own message is bounded and stripped of anything non-printable.
        const msg = typeof body.error.message === "string" ? body.error.message.replace(/[^\x20-\x7e]/g, "?").slice(0, 80) : "error";
        throw new BtcRpcError("BTC_RPC_ERROR", method, `rpc ${rpcCode ?? "?"} ${msg}`, rpcCode);
      }
      if (!res.ok) throw new BtcRpcError("BTC_RPC_UNAVAILABLE", method, `HTTP ${res.status}`);
      if (!("result" in body)) throw new BtcRpcError("BTC_RPC_MALFORMED_RESPONSE", method, "response has no result");
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- typed, shape-checked methods ----------------------------------------

  async getNetworkInfo(): Promise<{ version: number; subversion: string }> {
    const r = obj(await this.call("getnetworkinfo"), "getnetworkinfo");
    return { version: int(r.version, "getnetworkinfo", "version"), subversion: str(r.subversion, "getnetworkinfo", "subversion", 128) };
  }

  async getBlockchainInfo(): Promise<{
    chain: string;
    blocks: number;
    headers: number;
    initialblockdownload: boolean;
    verificationprogress: number;
    time: number;
    bestblockhash: string;
    warnings: string | string[];
  }> {
    const m = "getblockchaininfo";
    const r = obj(await this.call(m), m);
    if (typeof r.initialblockdownload !== "boolean") throw shape(m, "initialblockdownload");
    if (typeof r.verificationprogress !== "number" || !Number.isFinite(r.verificationprogress)) throw shape(m, "verificationprogress");
    const warnings = r.warnings;
    if (!(typeof warnings === "string" || (Array.isArray(warnings) && warnings.every((w) => typeof w === "string")))) {
      throw shape(m, "warnings");
    }
    return {
      chain: str(r.chain, m, "chain", 32),
      blocks: int(r.blocks, m, "blocks"),
      headers: int(r.headers, m, "headers"),
      initialblockdownload: r.initialblockdownload,
      verificationprogress: r.verificationprogress,
      time: int(r.time, m, "time"),
      bestblockhash: hash(r.bestblockhash, m, "bestblockhash"),
      warnings: warnings as string | string[],
    };
  }

  /** null when the height is beyond the active tip (RPC -8). */
  async getBlockHash(height: number): Promise<string | null> {
    try {
      return hash(await this.call("getblockhash", [height]), "getblockhash", "result");
    } catch (err) {
      if (err instanceof BtcRpcError && err.code === "BTC_RPC_ERROR" && err.rpcCode === -8) return null;
      throw err;
    }
  }

  /** The raw 80-byte header, hex. */
  async getBlockHeaderRaw(blockHash: string): Promise<string> {
    const r = await this.call("getblockheader", [blockHash, false]);
    if (typeof r !== "string" || !/^[0-9a-f]{160}$/i.test(r)) throw shape("getblockheader", "raw header");
    return r.toLowerCase();
  }

  async getBlockHeaderVerbose(blockHash: string): Promise<{ hash: string; height: number; confirmations: number; merkleroot: string }> {
    const m = "getblockheader";
    const r = obj(await this.call(m, [blockHash, true]), m);
    if (typeof r.confirmations !== "number" || !Number.isInteger(r.confirmations)) throw shape(m, "confirmations");
    return { hash: hash(r.hash, m, "hash"), height: int(r.height, m, "height"), confirmations: r.confirmations, merkleroot: hash(r.merkleroot, m, "merkleroot") };
  }
}

function shape(method: string, field: string): BtcRpcError {
  return new BtcRpcError("BTC_RPC_MALFORMED_RESPONSE", method, `unexpected ${field}`);
}
function obj(v: unknown, method: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw shape(method, "result");
  return v as Record<string, unknown>;
}
function int(v: unknown, method: string, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw shape(method, field);
  return v;
}
function str(v: unknown, method: string, field: string, max: number): string {
  if (typeof v !== "string" || v.length > max) throw shape(method, field);
  return v;
}
function hash(v: unknown, method: string, field: string): string {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/i.test(v)) throw shape(method, field);
  return v.toLowerCase();
}
