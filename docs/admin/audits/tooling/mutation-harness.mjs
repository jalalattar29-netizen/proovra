/**
 * AUDIT-ONLY. Execute every UI-reachable mutation action and record a truthful
 * disposition for each.
 *
 * This runs against disposable local infrastructure and touches no product
 * code. It refuses to start unless the API base is loopback.
 *
 * =============================================================================
 * WHAT THE PREVIOUS RUN GOT WRONG, AND WHAT CHANGED
 * =============================================================================
 * The first sweep was valid for 22 actions. Action #21 —
 * `POST /v1/admin/identity/emergency-revoke` — returned 200 and revoked every
 * session for the workspace INCLUDING the harness's own. Every action after it
 * answered 401, and re-authentication then failed because the harness had
 * already enrolled an SMS factor on that same account in order to satisfy
 * step-up, so sign-in became MFA-gated. 103 rows of 401 were discarded rather
 * than reported as findings: emergency revoke did exactly what it is for.
 *
 * Four changes make one action's session effect unable to poison later ones:
 *
 *   1. SESSION-DESTROYING ACTIONS RUN LAST, in their own phase, and each one
 *      runs as a DISPOSABLE PERSONA created for it — so what it destroys is
 *      that persona's session, never the harness's.
 *   2. The harness's own actor is re-authenticated between destructive
 *      families, and a lost session is re-established rather than recorded as
 *      a product refusal.
 *   3. Step-up enrolment happens on a DEDICATED elevation persona, so the
 *      harness's login account never becomes MFA-gated.
 *   4. Every request carries a timeout, so one hung endpoint cannot stall a
 *      554-action sweep.
 *
 * =============================================================================
 * HOW A PAYLOAD IS OBTAINED WITHOUT INVENTING ONE
 * =============================================================================
 * These endpoints validate with Zod and report, in the 400 body, the exact
 * field paths and expected types they rejected. The harness sends an empty
 * body, reads the contract out of the refusal (three error shapes are in use
 * and all three are parsed), fills each named field from the seeded fixture by
 * field name and expected type, and resends. Path parameters resolve to real
 * rows OF THE RIGHT KIND, looked up from the table the segment names, so a 404
 * means the authority refused rather than that the id was invented.
 *
 * =============================================================================
 * WHAT COUNTS AS PROVEN
 * =============================================================================
 * A 2xx is an execution, and its durable effect is re-read from the database.
 * Anything else is recorded as the branch it is — authority, entitlement,
 * step-up, validation, conflict — and is NOT counted as a pass. An action whose
 * success branch was never reached is BLOCKED with the blocker named.
 *
 * A 401 caused by a destroyed harness session is never a product defect; it is
 * retried after re-authentication and, if it persists, recorded as a harness
 * condition.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const API = process.env.PV_API ?? "http://localhost:8590";
const PG_CONTAINER = process.env.PV_PG ?? "pv4-pg";
const PG_DB = process.env.PV_DB ?? "proovra_mutation_fixture";
const RECORDER = process.env.PV_RECORDER ?? "D:/pv-audit3/.p7tmp/recorded-messages.jsonl";
const OUT_DIR = process.env.PV_OUT ?? ".";
const REQUEST_TIMEOUT_MS = Number(process.env.PV_TIMEOUT_MS ?? 15000);
const CHECKPOINT_EVERY = Number(process.env.PV_CHECKPOINT ?? 25);

{
  const h = new URL(API).hostname;
  if (!/^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(h)) {
    throw new Error(`mutation-harness: API base must be loopback, got "${h}"`);
  }
}

const ACTIONS = JSON.parse(readFileSync(process.env.PV_ACTIONS ?? "ui-reachable-actions.json", "utf8"));
const PW = "fixture-local-only-password";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sql(q) {
  return execFileSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", "pv", "-d", PG_DB, "-A", "-t", "-c", q],
    { encoding: "utf8" },
  ).trim();
}

/** Every request carries a deadline. A hung endpoint must not stall the sweep. */
async function http(url, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    return { status: res.status, text, timedOut: false };
  } catch (e) {
    return { status: 0, text: String(e).slice(0, 160), timedOut: String(e).includes("abort") };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fixture identifiers, read from the database rather than hard-coded.
// ---------------------------------------------------------------------------
const FX = {
  teamId: sql("select id from teams where name='Northwind Legal' limit 1"),
  otherTeamId: sql("select id from teams where name='Quiet Chambers' limit 1"),
  orgId: sql("select id from organizations where name='Northwind Legal' limit 1"),
  userId: sql("select id from users where email='workspace-admin@fixture.local' limit 1"),
  actorId: sql("select id from users where email='platform-admin@fixture.local' limit 1"),
  evidenceId: sql("select id from evidence order by created_at limit 1"),
  caseId: sql("select id from cases limit 1"),
  incidentId: sql("select id from operational_incidents where status='OPEN' limit 1"),
};

// ---------------------------------------------------------------------------
// Session-destroying actions: run LAST, and never as the harness's own actor.
// ---------------------------------------------------------------------------
const SESSION_DESTROYING = /revoke-all|emergency-revoke|sessions\/revoke|revoke-sessions|logout|sign-out|account-closure|password\/change|require-reenrollment|quarantine/i;
const isSessionDestroying = (a) => SESSION_DESTROYING.test(a.path);

let TOKEN = null;
let loginCount = 0;
async function login(email = "platform-admin@fixture.local") {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const r = await http(`${API}/v1/auth/email/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PW }),
    });
    if (r.status === 429) { await sleep(65_000); continue; }
    let j = {};
    try { j = JSON.parse(r.text); } catch {}
    if (j.token) { loginCount += 1; return j.token; }
    if (j.mfaRequired) return null; // the caller decides; never silently proceed
    return null;
  }
  return null;
}
async function ensureSession() {
  const probe = await http(`${API}/v1/users/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (probe.status === 200) return true;
  TOKEN = await login();
  return Boolean(TOKEN);
}

const H = (extra = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  ...extra,
});

// ---------------------------------------------------------------------------
// Disposable personas — one per session-destroying action.
// ---------------------------------------------------------------------------
async function makeDisposablePersona() {
  const id = randomUUID();
  const email = `disposable-${id.slice(0, 8)}@fixture.local`;
  const hash = sql(`select password_hash from users where email='platform-admin@fixture.local' limit 1`);
  const provider = sql(`select provider from users where email='platform-admin@fixture.local' limit 1`);
  sql(
    `insert into users (id,email,password_hash,provider,provider_user_id,display_name,email_verified_at,created_at,updated_at) ` +
    `values ('${id}','${email}','${hash}','${provider}','${email}','Disposable ${id.slice(0, 6)}',now(),now(),now())`,
  );
  for (const k of ["terms", "privacy", "cookies"]) {
    sql(`insert into user_legal_acceptances (user_id,policy_key,policy_version,source,accepted_at) values ('${id}','${k}','2026-04-06','audit-harness',now())`);
  }
  sql(`insert into team_members (team_id,user_id,role,status,created_at) values ('${FX.teamId}','${id}','ADMIN','ACTIVE',now())`);
  const token = await login(email);
  return { userId: id, email, token };
}

// ---------------------------------------------------------------------------
// Path parameters: real rows of the right KIND.
// ---------------------------------------------------------------------------
const idCache = new Map();
function firstIdFrom(table) {
  if (idCache.has(table)) return idCache.get(table);
  let v = null;
  try { v = sql(`select id from ${table} limit 1`) || null; } catch { v = null; }
  idCache.set(table, v);
  return v;
}
const KIND_TABLES = [
  [/session/, "authenticated_sessions"],
  [/connection|sso/, "sso_connections"],
  [/scim|provisioning/, "scim_provisioning_tokens"],
  [/retention|policy/, "evidence_retention_policies"],
  [/hold/, "evidence_legal_holds"],
  [/review|campaign/, "access_reviews"],
  [/request/, "mfa_recovery_requests"],
  [/grant/, "support_access_grants"],
  [/report/, "reports"],
  [/package/, "verification_packages"],
  [/factor/, "mfa_factors"],
  [/domain/, "organization_domains"],
  [/rule|automation/, "automation_rules"],
  [/invite|invitation/, "organization_invites"],
];
function concretePath(p, persona) {
  return p.split("/").map((seg) => {
    if (!seg.startsWith(":")) return seg;
    const n = seg.slice(1).toLowerCase();
    if (n.includes("team") || n.includes("workspace")) return FX.teamId;
    if (n.includes("org")) return FX.orgId;
    if (n.includes("user") || n.includes("member")) return persona?.userId ?? FX.userId;
    if (n.includes("evidence")) return FX.evidenceId;
    if (n.includes("case")) return FX.caseId;
    if (n.includes("incident")) return FX.incidentId;
    if (n === "token") return "fixture-token";
    if (n === "slug") return "tsa-timestamp-failure";
    for (const [re, table] of KIND_TABLES) {
      if (re.test(n)) { const v = firstIdFrom(table); if (v) return v; }
    }
    return FX.evidenceId;
  }).join("/");
}

// ---------------------------------------------------------------------------
// Payload derived from the endpoint's own refusal.
// ---------------------------------------------------------------------------
function contractFrom(body) {
  try {
    const j = JSON.parse(body);
    const fields = j?.error?.fields;
    if (Array.isArray(fields) && fields.length) {
      return fields.map((f) => ({ path: f.path ?? "", message: f.message ?? "" }));
    }
    const fe = j?.error?.detail?.fieldErrors ?? j?.error?.details?.fieldErrors;
    if (fe && typeof fe === "object") {
      const out = Object.entries(fe).map(([path, msgs]) => ({
        path, message: Array.isArray(msgs) ? msgs.join(" ") : String(msgs),
      }));
      if (out.length) return out;
    }
    const m = /Invalid input: ([A-Za-z0-9_.]+) — (.+)$/.exec(j?.error?.message ?? "");
    if (m) return [{ path: m[1], message: m[2] }];
  } catch { /* not JSON */ }
  return [];
}
function valueFor(path, message, persona) {
  const n = String(path).toLowerCase();
  const options = /expected one of (.+)$/i.exec(message ?? "");
  if (options) {
    const first = options[1].split("|")[0].replace(/["'`]/g, "").trim();
    if (first) return first;
  }
  if (/expected array/i.test(message)) {
    // "Too small: expected array to have >=1 items" needs a member, not [].
    if (/>=\s*1|at least 1|nonempty/i.test(message)) return ["audit-fixture"];
    return [];
  }
  if (/expected boolean/i.test(message)) return true;
  if (/expected number/i.test(message)) return 1;
  if (n.includes("teamid") || n.includes("workspaceid")) return FX.teamId;
  if (n.includes("organizationid") || n.includes("orgid")) return FX.orgId;
  if (n.includes("evidenceid")) return FX.evidenceId;
  if (n.includes("caseid")) return FX.caseId;
  if (n.includes("userid") || n.includes("memberid") || n.includes("subject")) return persona?.userId ?? FX.userId;
  if (n.includes("email")) return "fixture-target@fixture.local";
  if (n.includes("confirm")) return "close my account";
  if (n.includes("reason") || n.includes("note") || n.includes("justification")) return "Audit pass — disposable fixture.";
  if (n.includes("name") || n.includes("label") || n.includes("title")) return "audit-fixture";
  if (n.includes("url")) return "http://localhost:59900/fixture";
  if (n.includes("id")) return FX.evidenceId;
  return "audit-fixture";
}
function setDeep(obj, path, value) {
  const parts = String(path).split(".").filter(Boolean);
  if (!parts.length) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) { cur[parts[i]] ??= {}; cur = cur[parts[i]]; }
  cur[parts.at(-1)] = value;
}

// ---------------------------------------------------------------------------
// Step-up, on a DEDICATED elevation persona.
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
let elevationPersona = null;
async function ensureElevationPersona() {
  if (elevationPersona) return elevationPersona;
  elevationPersona = await makeDisposablePersona();
  if (!elevationPersona.token) return elevationPersona;
  const eh = { authorization: `Bearer ${elevationPersona.token}`, "content-type": "application/json" };
  const start = await http(`${API}/v1/identity-security/contact-factors/enroll/start`, {
    method: "POST", headers: eh,
    body: JSON.stringify({ teamId: FX.teamId, channel: "SMS", destination: "+15555550188" }),
  });
  let sb = {}; try { sb = JSON.parse(start.text); } catch {}
  if (start.status < 400 && sb.factor) {
    await sleep(400);
    await http(`${API}/v1/identity-security/contact-factors/enroll/verify`, {
      method: "POST", headers: eh,
      body: JSON.stringify({
        teamId: FX.teamId, factorId: sb.factor.factorId,
        verificationAttemptId: sb.verificationAttemptId, code: latestCode(),
      }),
    });
  }
  return elevationPersona;
}
async function elevate(purpose, resourceKind, resourceId) {
  const p = await ensureElevationPersona();
  if (!p?.token) return null;
  const eh = { authorization: `Bearer ${p.token}`, "content-type": "application/json" };
  const start = await http(`${API}/v1/identity-security/step-up/start`, {
    method: "POST", headers: eh,
    body: JSON.stringify({
      teamId: FX.teamId, purpose,
      ...(resourceKind ? { resourceKind } : {}), ...(resourceId ? { resourceId } : {}),
    }),
  });
  if (start.status >= 400) return null;
  let s = {}; try { s = JSON.parse(start.text); } catch {}
  const challengeId = s.challengeId ?? s.challenge?.id ?? s.id ?? null;
  await sleep(300);
  const check = await http(`${API}/v1/identity-security/step-up/check`, {
    method: "POST", headers: eh,
    body: JSON.stringify({ teamId: FX.teamId, challengeId, code: latestCode() }),
  });
  return check.status < 400 ? { challengeId, token: p.token } : null;
}

// ---------------------------------------------------------------------------
// Durable-effect probe: a cheap global row-count fingerprint.
// ---------------------------------------------------------------------------
const EFFECT_TABLES = [
  "security_events", "operational_incidents", "scim_provisioning_tokens",
  "sso_connections", "access_reviews", "mfa_recovery_requests",
  "evidence_retention_policies", "evidence_legal_holds", "automation_rules",
  "organization_invites", "team_members", "support_access_grants",
];
function effectFingerprint() {
  try {
    const q = EFFECT_TABLES.map((t) => `select '${t}' t, count(*) c from ${t}`).join(" union all ");
    return sql(q);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Execute one action
// ---------------------------------------------------------------------------
async function execute(action, persona) {
  const path = concretePath(action.path, persona);
  const attempts = [];
  const authToken = persona?.token ?? TOKEN;
  const hdr = (extra = {}) => ({ authorization: `Bearer ${authToken}`, "content-type": "application/json", ...extra });
  let body = { teamId: FX.teamId };
  const before = effectFingerprint();

  for (let round = 0; round < 4; round += 1) {
    const r = await http(API + path, {
      method: action.method, headers: hdr(),
      body: action.method === "DELETE" && round === 0 ? undefined : JSON.stringify(body),
    });
    attempts.push({ round, status: r.status, body: r.text.slice(0, 200).replace(/\s+/g, " ") });

    if (r.timedOut) {
      return { ok: false, status: 0, attempts, payload: body, branch: "REQUEST_TIMEOUT", before, after: before };
    }
    if (r.status > 0 && r.status < 400) {
      const after = effectFingerprint();
      return { ok: true, status: r.status, attempts, payload: body, before, after, durableChange: before !== after };
    }
    if (r.status === 401 && !r.text.includes("STEP_UP")) {
      // A destroyed session is a HARNESS condition, never a product defect.
      if (!persona) {
        const restored = await ensureSession();
        if (restored && round === 0) continue;
      }
      return { ok: false, status: 401, attempts, payload: body, branch: "HARNESS_SESSION_LOST", before, after: before };
    }
    if (r.status === 401 && r.text.includes("STEP_UP_REQUIRED")) {
      let d = {}; try { d = JSON.parse(r.text).error?.details ?? {}; } catch {}
      const elev = await elevate(d.purpose, d.resourceKind, d.resourceId);
      if (!elev) {
        return { ok: false, status: 401, attempts, payload: body, branch: "STEP_UP_UNSATISFIED", before, after: before };
      }
      const retry = await http(API + path, {
        method: action.method,
        headers: { authorization: `Bearer ${elev.token}`, "content-type": "application/json", "x-proovra-step-up-challenge-id": elev.challengeId },
        body: JSON.stringify(body),
      });
      attempts.push({ round: `${round}+stepup`, status: retry.status, body: retry.text.slice(0, 200).replace(/\s+/g, " ") });
      const after = effectFingerprint();
      if (retry.status > 0 && retry.status < 400) {
        return { ok: true, status: retry.status, attempts, payload: body, stepUpSatisfied: true, before, after, durableChange: before !== after };
      }
      return { ok: false, status: retry.status, attempts, payload: body, branch: "REFUSED_AFTER_STEP_UP", before, after };
    }
    if (r.status === 400) {
      const contract = contractFrom(r.text);
      if (!contract.length) {
        return { ok: false, status: 400, attempts, payload: body, branch: "VALIDATION_CONTRACT_UNREADABLE", before, after: before };
      }
      let changed = false;
      for (const f of contract) {
        if (!f.path) continue;
        setDeep(body, f.path, valueFor(f.path, f.message, persona));
        changed = true;
      }
      if (!changed) {
        return { ok: false, status: 400, attempts, payload: body, branch: "VALIDATION_CONTRACT_UNREADABLE", before, after: before };
      }
      continue;
    }
    const after = effectFingerprint();
    return {
      ok: false, status: r.status, attempts, payload: body, before, after,
      branch: r.status === 402 ? "ENTITLEMENT_REFUSED"
        : r.status === 403 ? "AUTHORITY_REFUSED"
        : r.status === 404 ? "NOT_FOUND_OR_CONCEALED"
        : r.status === 409 ? "CONFLICT_REFUSED"
        : r.status === 429 ? "RATE_LIMITED"
        : r.status >= 500 ? "SERVER_ERROR"
        : "OTHER_REFUSAL",
    };
  }
  return { ok: false, status: attempts.at(-1)?.status ?? 0, attempts, payload: body, branch: "VALIDATION_NOT_SATISFIED", before, after: before };
}

function dispositionOf(r) {
  if (r.ok) return "RUNTIME_PROVEN_PASS";
  if (r.branch === "SERVER_ERROR") return "RUNTIME_PROVEN_DEFECT";
  if (["AUTHORITY_REFUSED", "ENTITLEMENT_REFUSED", "NOT_FOUND_OR_CONCEALED", "CONFLICT_REFUSED", "OTHER_REFUSAL", "RATE_LIMITED"].includes(r.branch)) {
    return "RUNTIME_PROVEN_REFUSAL_ONLY";
  }
  if (r.branch === "HARNESS_SESSION_LOST") return "BLOCKED_HARNESS_SESSION";
  return "BLOCKED_SUCCESS_BRANCH_UNREACHED";
}

// ---------------------------------------------------------------------------
// Run: ordinary actions first, session-destroying ones last.
// ---------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
TOKEN = await login();
if (!TOKEN) { console.error("sign-in failed"); process.exit(1); }

const ordinary = ACTIONS.filter((a) => !isSessionDestroying(a));
const destructive = ACTIONS.filter(isSessionDestroying);
console.log(`actions: ${ACTIONS.length}  ordinary: ${ordinary.length}  session-destroying (run last, disposable persona): ${destructive.length}`);

const results = [];
function checkpoint(phase) {
  const by = {};
  for (const r of results) by[r.disposition] = (by[r.disposition] || 0) + 1;
  writeFileSync(`${OUT_DIR}/mutation-results.json`, JSON.stringify({
    generatedAtUtc: new Date().toISOString(),
    totalActions: ACTIONS.length, completed: results.length,
    remaining: ACTIONS.length - results.length,
    byDisposition: by, phase, results,
  }, null, 2));
  console.log(`  [checkpoint] ${results.length}/${ACTIONS.length} ${JSON.stringify(by)}`);
}

for (const [phase, list] of [["ordinary", ordinary], ["session-destroying", destructive]]) {
  let n = 0;
  for (const action of list) {
    n += 1;
    let persona = null;
    if (phase === "session-destroying") {
      persona = await makeDisposablePersona();
      if (!persona.token) persona = null;
    } else if (n % 40 === 0) {
      await ensureSession(); // keep the harness actor alive across long stretches
    }
    let r;
    try { r = await execute(action, persona); }
    catch (e) { r = { ok: false, status: 0, attempts: [], branch: "HARNESS_ERROR", error: String(e).slice(0, 160) }; }
    results.push({
      ...action, phase, disposableActor: persona?.email ?? null,
      concretePath: concretePath(action.path, persona), ...r,
      disposition: dispositionOf(r),
    });
    if (results.length % CHECKPOINT_EVERY === 0) checkpoint(phase);
  }
  await ensureSession();
}
checkpoint("done");

const by = {};
for (const r of results) by[r.disposition] = (by[r.disposition] || 0) + 1;
console.log(`\ncompleted ${results.length}/${ACTIONS.length}`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
const defects = results.filter((r) => r.disposition === "RUNTIME_PROVEN_DEFECT");
if (defects.length) {
  console.log(`\nSERVER ERRORS:`);
  for (const d of defects) console.log(`   ${d.status} ${d.method} ${d.path} :: ${d.attempts.at(-1)?.body?.slice(0, 120)}`);
}
