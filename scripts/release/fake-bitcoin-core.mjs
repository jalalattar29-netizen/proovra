/**
 * A Bitcoin Core JSON-RPC stand-in for the worker-image verifier smoke
 * (scripts/release/smoke-worker-bitcoin-verifier.mjs). It answers exactly the
 * header-only methods PROOVRA's verifier uses, with Bitcoin Core's response
 * shapes, behind HTTP Basic authentication against the same password file the
 * worker reads — so the smoke proves the worker's real wiring (mounted
 * password, private-network URL, readiness policy), never a mocked client.
 *
 * It is NOT proof against the real Bitcoin network; that acceptance runs
 * against PROOVRA's synchronized node (see docs/runbooks/ots-degradation.md).
 *
 *   FAKE_SCENARIO        ready | ibd | wrong_chain | stale | header_lag | old_version
 *   FAKE_RPC_USER        the rpc user to accept
 *   FAKE_PASSWORD_FILE   the file holding the password to accept
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

// Bitcoin mainnet genesis: the hash and its raw 80-byte header (public constants).
const GENESIS_HASH = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const GENESIS_RAW =
  "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";

const scenario = process.env.FAKE_SCENARIO ?? "ready";
const user = process.env.FAKE_RPC_USER ?? "";
const password = readFileSync(process.env.FAKE_PASSWORD_FILE ?? "/secrets/password", "utf8").replace(/[\r\n]+$/, "");
const expectedAuth = `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;

function chainInfo() {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    chain: "main",
    blocks: 900_000,
    headers: 900_000,
    bestblockhash: "00000000000000000001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7",
    initialblockdownload: false,
    verificationprogress: 0.99999,
    time: now - 300,
    warnings: "",
  };
  switch (scenario) {
    case "ibd":
      return { ...base, blocks: 512_000, initialblockdownload: true, verificationprogress: 0.41, time: now - 86_400 * 900 };
    case "wrong_chain":
      return { ...base, chain: "test" };
    case "stale":
      return { ...base, time: now - 6 * 3600 };
    case "header_lag":
      return { ...base, headers: base.blocks + 12 };
    default:
      return base;
  }
}

function result(method, params) {
  switch (method) {
    case "getnetworkinfo":
      return { version: scenario === "old_version" ? 250_000 : 280_000, subversion: "/Satoshi:28.0.0/" };
    case "getblockchaininfo":
      return chainInfo();
    case "getblockhash":
      return params?.[0] === 0 ? GENESIS_HASH : null;
    case "getblockheader":
      return params?.[0] === GENESIS_HASH && params?.[1] === false ? GENESIS_RAW : null;
    default:
      return undefined;
  }
}

createServer((req, res) => {
  if (req.headers.authorization !== expectedAuth) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="jsonrpc"' }).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let call;
    try {
      call = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const r = result(call.method, call.params);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        r === undefined
          ? { result: null, error: { code: -32601, message: "Method not found" }, id: call.id }
          : { result: r, error: null, id: call.id },
      ),
    );
  });
}).listen(8332, "0.0.0.0", () => console.log(`fake-bitcoin-core scenario=${scenario} listening`));
