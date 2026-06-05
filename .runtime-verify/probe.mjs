import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const SECRET = "audit_local_jwt_secret_do_not_use_in_prod_0123456789abcdef0123456789";
const OWNER = "a727521b-8fb4-4631-983b-f1864f574c88";
const TEAM = "337e16c6-5814-45f8-9b75-2400f050d97e";
const BASE = "http://127.0.0.1:8081";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function signJwt(payload, secret, ttlSec) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSec;
  const sid = randomBytes(16).toString("hex");
  const full = { ...payload, iat: now, exp, sid };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(full));
  const sig = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

const token = signJwt({ sub: OWNER, provider: "local", email: "owner@dev.local" }, SECRET, 60 * 60);

async function probe(label, path) {
  const url = `${BASE}${path}`;
  let res, body;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = text; }
  } catch (err) {
    console.log(`--- ${label} ${path}`);
    console.log("  ERR", err.message);
    return;
  }
  console.log(`--- ${label} ${path} status=${res.status}`);
  const j = JSON.stringify(body);
  console.log(j.length > 4000 ? j.slice(0, 4000) + "...(truncated)" : j);
}

(async () => {
  await probe("capabilities", `/v1/intelligence/capabilities?teamId=${TEAM}`);
  await probe("diagnostics", `/v1/investigation/diagnostics?teamId=${TEAM}`);
  await probe("overview", `/v1/investigation/overview?teamId=${TEAM}`);
  await probe("reviewers", `/v1/investigation/reviewers?teamId=${TEAM}`);
  await probe("graph-seeds", `/v1/graph/seeds?teamId=${TEAM}`);
  await probe("graph-timeline", `/v1/graph/timeline?teamId=${TEAM}`);
  await probe("graph-duplicates", `/v1/graph/duplicates?teamId=${TEAM}`);
})().catch(e => { console.error("fatal", e); process.exit(1); });
