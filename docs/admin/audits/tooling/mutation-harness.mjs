/**
 * STAGE 2 — execute every UI-reachable mutation action and record a truthful
 * disposition for each.
 *
 * HOW A PAYLOAD IS OBTAINED WITHOUT INVENTING ONE
 * ---------------------------------------------------------------------------
 * These endpoints validate with Zod and report, in the 400 body, the exact
 * field paths and expected types they rejected. So the harness does not guess
 * a payload: it sends an empty body, READS the contract out of the refusal,
 * fills each named field from the seeded fixture (a real workspace id, a real
 * evidence id, a real user id — chosen by field name and expected type), and
 * sends it again. What the endpoint told us it wanted is what it gets.
 *
 * WHAT COUNTS AS PROVEN
 * ---------------------------------------------------------------------------
 * A 2xx is an execution. Anything else is recorded as the branch it is —
 * authority, entitlement, step-up, validation, conflict — and is NOT counted
 * as a pass. An action whose success branch was never reached is BLOCKED with
 * the reason named, which the brief requires to be excluded from the pass
 * count rather than quietly folded into it.
 *
 * Step-up is satisfied for real where required: an SMS contact factor enrolled
 * through the product's own route, the code read back from the fixture's
 * recording transport, and the verified challenge id presented in the header
 * the middleware reads.
 *
 * Every target is a row in a disposable database. Nothing here runs anywhere
 * else: the API base is asserted to be loopback before the first request.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const API = process.env.PV_API ?? "http://localhost:8490";
const PG_CONTAINER = process.env.PV_PG ?? "pv3-pg";
const PG_DB = process.env.PV_DB ?? "proovra_safety_test";
const RECORDER = "D:/pv-safety/.p7tmp/recorded-messages.jsonl";

// ---------------------------------------------------------------------------
// Refuse to run against anything but loopback.
// ---------------------------------------------------------------------------
{
  const h = new URL(API).hostname;
  if (!/^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(h)) {
    throw new Error(`mutation-harness: API base must be loopback, got "${h}"`);
  }
}

const ACTIONS = JSON.parse(readFileSync("ui-reachable-actions.json", "utf8"));
const PW = "fixture-local-only-password";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sql(q) {
  return execFileSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", "pv", "-d", PG_DB, "-A", "-t", "-c", q],
    { encoding: "utf8" },
  ).trim();
}

// ---------------------------------------------------------------------------
// Fixture identifiers, read from the database rather than hard-coded.
// ---------------------------------------------------------------------------
const FX = {
  teamId: sql("select id from teams where name='Northwind Legal' limit 1"),
  otherTeamId: sql("select id from teams where name='Quiet Chambers' limit 1"),
  personalTeamId: sql("select id from teams where name='Personal Space' limit 1"),
  orgId: sql("select id from organizations where name='Northwind Legal' limit 1"),
  userId: sql("select id from users where email='workspace-admin@fixture.local' limit 1"),
  actorId: sql("select id from users where email='platform-admin@fixture.local' limit 1"),
  evidenceId: sql("select id from evidence order by created_at limit 1"),
  caseId: sql("select id from cases limit 1"),
  incidentId: sql("select id from operational_incidents where status='OPEN' limit 1"),
};

let TOKEN = null;
let lastLoginDetail = "";
/**
 * Sign in, completing the MFA challenge when the account has a factor.
 *
 * The harness enrols an SMS contact factor in order to satisfy step-up, which
 * means every subsequent sign-in for that account is MFA-gated. Handling the
 * challenge here keeps the run going and exercises the challenge path with a
 * real one-time code, read from the fixture's recording transport.
 */
async function login() {
  // The login limiter is keyed by IP at ten per sixty seconds and every
  // request here arrives as 127.0.0.1. A 429 is the limiter doing its job,
  // not a failure of the run — wait it out rather than abandoning 554 actions.
  let r;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    r = await fetch(`${API}/v1/auth/email/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "platform-admin@fixture.local", password: PW }),
    });
    if (r.status !== 429) break;
    lastLoginDetail = `rate limited, waiting (attempt ${attempt + 1})`;
    console.log(`  login rate-limited; waiting 65s`);
    await sleep(65_000);
  }
  const j = await r.json().catch(() => ({}));
  if (j.token) { TOKEN = j.token; return r.status; }

  if (j.mfaRequired && j.mfaPendingToken) {
    // The pending token is the CREDENTIAL for the challenge — it goes in the
    // Authorization header, and the body carries only the one-time code
    // (ChallengeVerifyBody accepts `code` xor `recoveryCode`).
    await sleep(500);
    const v = await fetch(`${API}/v1/identity/mfa/challenge/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${j.mfaPendingToken}`, "content-type": "application/json" },
      body: JSON.stringify({ code: latestCode() }),
    });
    const vj = await v.json().catch(() => ({}));
    if (vj.token) { TOKEN = vj.token; return v.status; }
    lastLoginDetail = `mfa verify ${v.status}: ${JSON.stringify(vj).slice(0, 160)}`;
  }
  TOKEN = null;
  return r.status;
}

const H = (extra = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  ...extra,
});

// ---------------------------------------------------------------------------
// Fill a concrete path from the fixture.
// ---------------------------------------------------------------------------
/**
 * A REAL id of the right KIND for the resource the path names.
 *
 * Substituting one valid UUID everywhere makes the endpoint answer 404 —
 * truthfully, since that row is not a session/token/connection — and the
 * result reads as "refused" when nothing about authorization was tested. The
 * id therefore comes from the table the segment names, and only falls back to
 * a generic row when there is no such table populated.
 */
const idCache = new Map();
function firstIdFrom(table, where = "") {
  const key = `${table}|${where}`;
  if (idCache.has(key)) return idCache.get(key);
  let v = null;
  try { v = sql(`select id from ${table} ${where} limit 1`) || null; } catch { v = null; }
  idCache.set(key, v);
  return v;
}
function concretePath(p) {
  return p
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg;
      const n = seg.slice(1).toLowerCase();
      if (n.includes("team") || n.includes("workspace")) return FX.teamId;
      if (n.includes("org")) return FX.orgId;
      if (n.includes("user") || n.includes("member")) return FX.userId;
      if (n.includes("evidence")) return FX.evidenceId;
      if (n.includes("case")) return FX.caseId;
      if (n.includes("incident")) return FX.incidentId;
      if (n === "token") return "fixture-token";
      if (n === "slug") return "tsa-timestamp-failure";
      // Resource-kind lookups, cheapest first.
      const byKind = [
        [/session/, "authenticated_sessions"],
        [/connection|sso/, "sso_connections"],
        [/scim|provisioning/, "scim_provisioning_tokens"],
        [/policy|retention/, "evidence_retention_policies"],
        [/hold/, "evidence_legal_holds"],
        [/review|campaign/, "access_reviews"],
        [/request/, "mfa_recovery_requests"],
        [/grant/, "support_access_grants"],
        [/report/, "reports"],
        [/package/, "verification_packages"],
        [/factor/, "mfa_factors"],
        [/domain/, "organization_domains"],
        [/rule|automation/, "automation_rules"],
        [/webhook/, "webhook_endpoints"],
        [/invite|invitation/, "organization_invites"],
      ];
      for (const [re, table] of byKind) {
        if (re.test(n)) {
          const v = firstIdFrom(table);
          if (v) return v;
        }
      }
      return FX.evidenceId; // a real UUID, so the shape is at least valid
    })
    .join("/");
}

/**
 * Build a value for one field the server asked for, from its NAME and the
 * type it said it expected. Never a fabricated UUID: every id here is a row
 * that exists in the fixture.
 */
function valueFor(path, message) {
  const n = String(path).toLowerCase();
  const wantsNumber = /expected number/i.test(message);
  const wantsBoolean = /expected boolean/i.test(message);
  const wantsArray = /expected array/i.test(message);
  const options = /expected one of (.+)$/i.exec(message ?? "");

  if (options) {
    const first = options[1].split("|")[0].replace(/["'`]/g, "").trim();
    if (first) return first;
  }
  if (wantsArray) return [];
  if (wantsBoolean) return true;
  if (wantsNumber) return 1;
  if (n.includes("teamid") || n.includes("workspaceid")) return FX.teamId;
  if (n.includes("organizationid") || n.includes("orgid")) return FX.orgId;
  if (n.includes("evidenceid")) return FX.evidenceId;
  if (n.includes("caseid")) return FX.caseId;
  if (n.includes("userid") || n.includes("memberid") || n.includes("subject")) return FX.userId;
  if (n.includes("email")) return "fixture-target@fixture.local";
  if (n.includes("reason") || n.includes("note") || n.includes("justification")) {
    return "Audit completion pass — disposable fixture.";
  }
  if (n.includes("name") || n.includes("label") || n.includes("title")) return "audit-fixture";
  if (n.includes("url")) return "http://localhost:59900/fixture";
  if (n.includes("id")) return FX.evidenceId;
  return "audit-fixture";
}

function setDeep(obj, path, value) {
  const parts = String(path).split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur[parts[i]] ??= {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Read the field contract out of a 400 body.
 *
 * Three shapes are in use across this API and all three carry the same
 * information. Reading only the first one made a third of the refusals look
 * like "the server would not say what it wanted", which was a property of the
 * reader, not of the server.
 */
function contractFrom(body) {
  try {
    const j = JSON.parse(body);

    // 1. { error: { fields: [{ path, message }] } }
    const fields = j?.error?.fields;
    if (Array.isArray(fields) && fields.length) {
      return fields.map((f) => ({ path: f.path ?? "", message: f.message ?? "" }));
    }

    // 2. Zod flatten(): { error: { detail: { fieldErrors: { name: [msg] } } } }
    const fe = j?.error?.detail?.fieldErrors ?? j?.error?.details?.fieldErrors;
    if (fe && typeof fe === "object") {
      const out = Object.entries(fe).map(([path, msgs]) => ({
        path, message: Array.isArray(msgs) ? msgs.join(" ") : String(msgs),
      }));
      if (out.length) return out;
    }

    // 3. A single message: "Invalid input: teamId — Invalid input: expected string"
    const m = /Invalid input: ([A-Za-z0-9_.]+) — (.+)$/.exec(j?.error?.message ?? "");
    if (m) return [{ path: m[1], message: m[2] }];
  } catch { /* not JSON */ }
  return [];
}

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------
function latestCode() {
  if (!existsSync(RECORDER)) return null;
  const lines = readFileSync(RECORDER, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = JSON.parse(lines[i]);
    if (row.code) return row.code;
  }
  return null;
}
let contactFactorReady = false;
async function ensureContactFactor() {
  if (contactFactorReady) return true;
  const start = await fetch(`${API}/v1/identity-security/contact-factors/enroll/start`, {
    method: "POST", headers: H(),
    body: JSON.stringify({ teamId: FX.teamId, channel: "SMS", destination: "+15555550199" }),
  });
  const sb = await start.json().catch(() => ({}));
  if (start.status < 400 && sb.factor) {
    await sleep(350);
    await fetch(`${API}/v1/identity-security/contact-factors/enroll/verify`, {
      method: "POST", headers: H(),
      body: JSON.stringify({
        teamId: FX.teamId, factorId: sb.factor.factorId,
        verificationAttemptId: sb.verificationAttemptId, code: latestCode(),
      }),
    });
  }
  contactFactorReady = true;
  return true;
}
async function elevate(purpose, resourceKind, resourceId) {
  await ensureContactFactor();
  const start = await fetch(`${API}/v1/identity-security/step-up/start`, {
    method: "POST", headers: H(),
    body: JSON.stringify({
      teamId: FX.teamId, purpose,
      ...(resourceKind ? { resourceKind } : {}),
      ...(resourceId ? { resourceId } : {}),
    }),
  });
  if (start.status >= 400) return null;
  const s = await start.json();
  const challengeId = s.challengeId ?? s.challenge?.id ?? s.id ?? null;
  await sleep(300);
  const check = await fetch(`${API}/v1/identity-security/step-up/check`, {
    method: "POST", headers: H(),
    body: JSON.stringify({ teamId: FX.teamId, challengeId, code: latestCode() }),
  });
  return check.status < 400 ? challengeId : null;
}

// ---------------------------------------------------------------------------
// Execute one action
// ---------------------------------------------------------------------------
async function execute(action) {
  const path = concretePath(action.path);
  const attempts = [];
  let body = { teamId: FX.teamId };

  for (let round = 0; round < 4; round += 1) {
    const res = await fetch(API + path, {
      method: action.method, headers: H(),
      body: action.method === "DELETE" && round === 0 ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    attempts.push({ round, status: res.status, body: text.slice(0, 200).replace(/\s+/g, " ") });

    if (res.status < 400) return { ok: true, status: res.status, attempts, payload: body };

    // Session died (a revoke-all we just fired). Re-authenticate and retry once.
    if (res.status === 401 && !text.includes("STEP_UP")) {
      if (round === 0) { await login(); continue; }
      return { ok: false, status: res.status, attempts, payload: body, branch: "UNAUTHENTICATED" };
    }
    if (res.status === 401 && text.includes("STEP_UP_REQUIRED")) {
      let d = {};
      try { d = JSON.parse(text).error?.details ?? {}; } catch {}
      const cid = await elevate(d.purpose, d.resourceKind, d.resourceId);
      if (!cid) return { ok: false, status: res.status, attempts, payload: body, branch: "STEP_UP_UNSATISFIED" };
      const retry = await fetch(API + path, {
        method: action.method,
        headers: H({ "x-proovra-step-up-challenge-id": cid }),
        body: JSON.stringify(body),
      });
      const rt = await retry.text();
      attempts.push({ round: `${round}+stepup`, status: retry.status, body: rt.slice(0, 200).replace(/\s+/g, " ") });
      if (retry.status < 400) return { ok: true, status: retry.status, attempts, payload: body, stepUp: true };
      return { ok: false, status: retry.status, attempts, payload: body, branch: "REFUSED_AFTER_STEP_UP" };
    }
    if (res.status === 400) {
      const contract = contractFrom(text);
      if (contract.length === 0) {
        return { ok: false, status: 400, attempts, payload: body, branch: "VALIDATION_CONTRACT_UNREADABLE" };
      }
      let changed = false;
      for (const f of contract) {
        if (!f.path) continue;
        setDeep(body, f.path, valueFor(f.path, f.message));
        changed = true;
      }
      if (!changed) {
        return { ok: false, status: 400, attempts, payload: body, branch: "VALIDATION_CONTRACT_UNREADABLE" };
      }
      continue; // try again with what the server asked for
    }
    // 402 / 403 / 404 / 409 / 5xx — a real branch, recorded as itself.
    return {
      ok: false, status: res.status, attempts, payload: body,
      branch: res.status === 402 ? "ENTITLEMENT_REFUSED"
        : res.status === 403 ? "AUTHORITY_REFUSED"
        : res.status === 404 ? "NOT_FOUND_OR_CONCEALED"
        : res.status === 409 ? "CONFLICT_REFUSED"
        : res.status >= 500 ? "SERVER_ERROR"
        : "OTHER_REFUSAL",
    };
  }
  return { ok: false, status: attempts.at(-1)?.status ?? 0, attempts, payload: body, branch: "VALIDATION_NOT_SATISFIED" };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const loginStatus = await login();
if (!TOKEN) { console.error(`sign-in failed: ${loginStatus} ${lastLoginDetail}`); process.exit(1); }
console.log(`signed in; fixture team=${FX.teamId.slice(0, 8)} evidence=${FX.evidenceId?.slice(0, 8)}`);

const START = Number(process.env.PV_FROM ?? 0);
const END = Number(process.env.PV_TO ?? ACTIONS.length);
const slice = ACTIONS.slice(START, END);
const results = [];
let n = 0;
for (const action of slice) {
  n += 1;
  let r;
  try { r = await execute(action); }
  catch (e) { r = { ok: false, status: 0, attempts: [], branch: "HARNESS_ERROR", error: String(e).slice(0, 160) }; }

  const disposition = r.ok
    ? "RUNTIME_PROVEN_PASS"
    : r.branch === "SERVER_ERROR"
      ? "RUNTIME_PROVEN_DEFECT"
      : ["AUTHORITY_REFUSED", "ENTITLEMENT_REFUSED", "NOT_FOUND_OR_CONCEALED", "CONFLICT_REFUSED", "OTHER_REFUSAL"].includes(r.branch)
        ? "RUNTIME_PROVEN_REFUSAL_ONLY"
        : "BLOCKED_SUCCESS_BRANCH_UNREACHED";

  results.push({ ...action, concretePath: concretePath(action.path), ...r, disposition });
  if (n % 25 === 0) {
    console.log(`  ${START + n}/${END}  pass=${results.filter((x) => x.disposition === "RUNTIME_PROVEN_PASS").length} refusal=${results.filter((x) => x.disposition === "RUNTIME_PROVEN_REFUSAL_ONLY").length} blocked=${results.filter((x) => x.disposition.startsWith("BLOCKED")).length} defect=${results.filter((x) => x.disposition === "RUNTIME_PROVEN_DEFECT").length}`);
    writeFileSync(`mutation-results-${START}-${END}.json`, JSON.stringify({ from: START, to: END, done: n, results }, null, 2));
  }
}
writeFileSync(`mutation-results-${START}-${END}.json`, JSON.stringify({ from: START, to: END, done: n, results }, null, 2));

const by = {};
for (const r of results) by[r.disposition] = (by[r.disposition] || 0) + 1;
console.log(`\nexecuted ${results.length} actions`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
const defects = results.filter((r) => r.disposition === "RUNTIME_PROVEN_DEFECT");
if (defects.length) {
  console.log(`\nSERVER ERRORS (candidate defects):`);
  for (const d of defects.slice(0, 20)) console.log(`   ${d.status} ${d.method} ${d.path}  ${d.attempts.at(-1)?.body?.slice(0, 110)}`);
}
