#!/usr/bin/env node
/**
 * THE CAPACITY PROFILER. Against the isolated acceptance stack only.
 *
 *   node e2e/acceptance/capacity/profile.mjs --label=before [--samples=20] [--only=regex]
 *   node e2e/acceptance/capacity/profile.mjs --label=before --explain
 *   node e2e/acceptance/capacity/profile.mjs --label=before --concurrency=1,5,10,20
 *
 * Plain mode: for each route, one request with pg_stat_statements reset around it
 * (statement count, rows, slowest statements), then sequential samples for p50/p95.
 * --explain: auto_explain on, one request per route, plans cut from the container
 * log per route. Plans are taken in a separate pass because auto_explain's timing
 * would otherwise be part of the latency numbers.
 * --concurrency: a mixed read workload at each level with the database's connection
 * states sampled throughout. Measures this machine's stack and nothing else.
 *
 * --upload: the upload path end to end for one part, with real bytes to the fixture's
 * MinIO: create the record, open a session, initiate, presign, PUT, mark uploaded.
 *
 * It refuses before sending anything unless the base URL is loopback, the stack
 * proves isolation on /health, and the database is the acceptance fixture.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const OUT = resolve(ROOT, ".p7tmp", "capacity");
const { evaluateProdGuard, percentile } = await import(
  pathToFileURL(resolve(ROOT, "scripts/load/runner.mjs")).href
);

const BASE = "http://localhost:8391";
const CONTAINER = "acc-postgres";
const DB = "proovra_acceptance_fixture";

const arg = (name, fallback = null) => {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};

const label = arg("label", "run");
const samples = Number(arg("samples", 20));
const only = arg("only") ? new RegExp(arg("only")) : null;

const guard = evaluateProdGuard({ baseUrl: BASE, nodeEnv: process.env.NODE_ENV, allowProd: false });
if (guard.blocked) throw new Error(`refused: ${guard.reasons.join("; ")}`);

function sql(query) {
  return execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "pv", "-d", DB, "-At", "-F", "\t"], {
    input: query,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

const health = await (await fetch(`${BASE}/health`)).json();
const iso = health.isolation;
if (iso?.isolated !== true || iso.envFilesLoaded !== 0 || (iso.liveCredentialNames ?? []).length > 0) {
  throw new Error("refused: the stack does not prove isolation");
}
console.log(`isolated:${iso.isolated} envFilesLoaded:${iso.envFilesLoaded} liveCredentialNames:${iso.liveCredentialNames.length}`);

const manifest = JSON.parse(readFileSync(resolve(OUT, "seed-manifest.json"), "utf8"));
const tokens = {};
async function login(key) {
  if (tokens[key]) return tokens[key];
  const p = manifest.personas[key];
  const res = await fetch(`${BASE}/v1/auth/email/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: manifest.password }),
  });
  const body = await res.json();
  if (!res.ok || !body.token) throw new Error(`login ${key}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  tokens[key] = body.token;
  return body.token;
}

const a = manifest.personas.anchorOwner;
const m = manifest.personas.anchorMember;
const l = manifest.personas.largeOwner;

/** [name, persona, path, group] — the paths the web client calls. */
const ROUTES = [
  ["command_center_anchor", "anchorOwner", `/v1/dashboard/command-center?teamId=${a.teamId}`],
  ["command_center_member", "anchorMember", `/v1/dashboard/command-center?teamId=${a.teamId}`],
  ["command_center_large", "largeOwner", `/v1/dashboard/command-center?teamId=${l.teamId}`],
  ["trust_summary", "anchorOwner", `/v1/dashboard/trust-summary?teamId=${a.teamId}`],
  ["evidence_list_workspace", "anchorOwner", `/v1/evidence?scope=active&limit=50&teamId=${a.teamId}`],
  ["evidence_list_all_workspaces", "anchorOwner", `/v1/evidence?scope=active&limit=50`],
  ["evidence_list_filtered", "anchorOwner", `/v1/evidence?scope=active&limit=50&status=SIGNED&type=VIDEO&teamId=${a.teamId}`],
  ["evidence_list_member", "anchorMember", `/v1/evidence?scope=active&limit=50&teamId=${a.teamId}`],
  ["evidence_library_summary", "anchorOwner", `/v1/evidence/library-summary?scope=active&teamId=${a.teamId}`],
  ["evidence_search_common", "anchorOwner", `/v1/evidence?scope=active&limit=50&search=crane&teamId=${a.teamId}`],
  ["evidence_search_rare", "anchorOwner", `/v1/evidence?scope=active&limit=50&search=zzqnomatch&teamId=${a.teamId}`],
  ["unified_search", "anchorOwner", `/v1/search?q=crane&teamId=${a.teamId}`],
  ["cases_list", "anchorOwner", `/v1/cases`],
  ["cases_matter_queue", "anchorOwner", `/v1/cases/matter-queue?teamId=${a.teamId}`],
  ["team_members", "anchorOwner", `/v1/teams/${a.teamId}/members`],
  ["org_members", "anchorOwner", `/v1/orgs/${a.orgId}/members`],
  ["org_audit_events", "anchorOwner", `/v1/orgs/${a.orgId}/audit-events`],
  ["org_audit_filtered", "anchorOwner", `/v1/orgs/${a.orgId}/audit-events?eventType=policy.updated`],
  ["org_admin_detail", "anchorOwner", `/v1/orgs/${a.orgId}`],
  ["org_admin_workspaces", "anchorOwner", `/v1/orgs/${a.orgId}/workspaces`],
  ["org_billing_rollup", "anchorOwner", `/v1/orgs/${a.orgId}/billing/rollup`],
  ["inbox", "anchorOwner", `/v1/me/inbox`],
  ["inbox_summary", "anchorOwner", `/v1/me/inbox/summary`],
  ["notification_deliveries", "anchorOwner", `/v1/notifications/deliveries?teamId=${a.teamId}`],
  ["reviewer_queue", "anchorOwner", `/v1/reviewer-ops/queue?teamId=${a.teamId}&limit=25`],
];

const selected = ROUTES.filter(([name]) => !only || only.test(name));

async function call(persona, path) {
  const token = await login(persona);
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - started, bytes: text.length, text };
}

const topStatementsSql = `
  SELECT calls, rows, round(total_exec_time::numeric, 1), round(max_exec_time::numeric, 1),
         shared_blks_hit + shared_blks_read, left(regexp_replace(query, '\\s+', ' ', 'g'), 240)
    FROM pg_stat_statements
   WHERE query NOT ILIKE '%pg_stat_statements%' AND dbid = (SELECT oid FROM pg_database WHERE datname = '${DB}')
   ORDER BY total_exec_time DESC LIMIT 6;
  SELECT 'TOTAL', sum(calls), sum(rows), round(sum(total_exec_time)::numeric, 1), sum(shared_blks_hit + shared_blks_read)
    FROM pg_stat_statements
   WHERE query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE 'BEGIN%' AND query NOT ILIKE 'COMMIT%'
     AND dbid = (SELECT oid FROM pg_database WHERE datname = '${DB}');`;

async function plainPass() {
  const results = [];
  for (const [name, persona, path] of selected) {
    await login(persona);
    await call(persona, path); // warm the route once; the fixture's first read is not the measurement.
    sql("SELECT pg_stat_statements_reset();");
    const one = await call(persona, path);
    await new Promise((r) => setTimeout(r, 300)); // fire-and-forget audit writes land in this window.
    const out = sql(topStatementsSql).split("\n");
    const totalLine = out.find((line) => line.startsWith("TOTAL"))?.split("\t") ?? [];
    const top = out
      .filter((line) => !line.startsWith("TOTAL"))
      .map((line) => {
        const [calls, rows, totalMs, maxMs, blocks, query] = line.split("\t");
        return { calls: Number(calls), rows: Number(rows), totalMs: Number(totalMs), maxMs: Number(maxMs), blocks: Number(blocks), query };
      });

    const times = [];
    const budget = Date.now() + 120_000;
    let errors = 0;
    for (let i = 0; i < samples && Date.now() < budget; i += 1) {
      const r = await call(persona, path);
      if (r.status >= 400) errors += 1;
      times.push(r.ms);
    }
    const row = {
      name,
      status: one.status,
      bytes: one.bytes,
      n: times.length,
      errors,
      p50: Math.round(percentile(times, 50)),
      p95: Math.round(percentile(times, 95)),
      statements: Number(totalLine[1] ?? 0),
      dbRows: Number(totalLine[2] ?? 0),
      dbMs: Number(totalLine[3] ?? 0),
      dbBlocks: Number(totalLine[4] ?? 0),
      top,
      body: one.status >= 400 ? one.text.slice(0, 200) : undefined,
    };
    results.push(row);
    console.log(
      `${name.padEnd(30)} ${row.status} p50=${String(row.p50).padStart(6)} p95=${String(row.p95).padStart(6)} n=${row.n} stmts=${row.statements} rows=${row.dbRows} dbMs=${row.dbMs} blocks=${row.dbBlocks} bytes=${row.bytes}${row.errors ? ` errors=${row.errors}` : ""}${row.body ? ` ${row.body}` : ""}`,
    );
  }
  writeFileSync(resolve(OUT, `${label}.json`), JSON.stringify(results, null, 2));
}

async function explainPass() {
  sql(`ALTER SYSTEM SET auto_explain.log_min_duration = '${arg("min-ms", "25")}ms';
       ALTER SYSTEM SET auto_explain.log_analyze = on;
       ALTER SYSTEM SET auto_explain.log_buffers = on;
       ALTER SYSTEM SET auto_explain.log_nested_statements = on;
       SELECT pg_reload_conf();`);
  const plans = {};
  try {
    for (const [name, persona, path] of selected) {
      await login(persona);
      const since = new Date(Date.now() - 500).toISOString();
      await call(persona, path);
      await new Promise((r) => setTimeout(r, 500));
      // The server logs to stderr.
      const logs = spawnSync("docker", ["logs", "--since", since, CONTAINER], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      const log = logs.stdout + logs.stderr;
      plans[name] = log;
      console.log(`${name}: ${log.length} bytes of plans`);
    }
  } finally {
    sql(`ALTER SYSTEM RESET auto_explain.log_min_duration; SELECT pg_reload_conf();`);
  }
  mkdirSync(resolve(OUT, `plans-${label}`), { recursive: true });
  for (const [name, text] of Object.entries(plans)) {
    writeFileSync(resolve(OUT, `plans-${label}`, `${name}.log`), text);
  }
}

async function concurrencyPass() {
  const levels = String(arg("concurrency")).split(",").map(Number);
  const durationMs = Number(arg("duration-ms", 20_000));
  const mix = (arg("mix") ?? "command_center_anchor,evidence_list_workspace,evidence_library_summary,cases_list,org_members,org_audit_events,inbox_summary")
    .split(",")
    .map((n) => ROUTES.find((r) => r[0] === n))
    .filter(Boolean);
  for (const [, persona] of mix) await login(persona);
  const out = [];
  for (const level of levels) {
    const times = [];
    const perRoute = {};
    const statuses = {};
    let stop = false;
    const conn = [];
    const sampler = (async () => {
      while (!stop) {
        const line = sql(`SELECT count(*), count(*) FILTER (WHERE state = 'active'), count(*) FILTER (WHERE state = 'idle'),
                                 count(*) FILTER (WHERE wait_event_type = 'Lock'), count(*) FILTER (WHERE state = 'idle in transaction')
                            FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid();`).split("\t").map(Number);
        conn.push(line);
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    const started = Date.now();
    const clients = Array.from({ length: level }, async (_, c) => {
      let i = c;
      while (Date.now() - started < durationMs) {
        const [name, persona, path] = mix[i % mix.length];
        i += 1;
        const r = await call(persona, path);
        times.push(r.ms);
        (perRoute[name] ??= []).push(r.ms);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      }
    });
    await Promise.all(clients);
    stop = true;
    await sampler;
    const row = {
      clients: level,
      requests: times.length,
      rps: Number((times.length / ((Date.now() - started) / 1000)).toFixed(1)),
      p50: Math.round(percentile(times, 50)),
      p95: Math.round(percentile(times, 95)),
      statuses,
      maxConnections: Math.max(...conn.map((c) => c[0])),
      maxActive: Math.max(...conn.map((c) => c[1])),
      maxLockWaiters: Math.max(...conn.map((c) => c[3])),
      perRoute: Object.fromEntries(
        Object.entries(perRoute).map(([k, v]) => [k, { n: v.length, p50: Math.round(percentile(v, 50)), p95: Math.round(percentile(v, 95)) }]),
      ),
    };
    out.push(row);
    console.log(JSON.stringify({ ...row, perRoute: undefined }));
  }
  writeFileSync(resolve(OUT, `${label}-concurrency.json`), JSON.stringify(out, null, 2));
}

async function uploadPass() {
  const persona = "anchorOwner";
  const token = await login(persona);
  const teamId = a.teamId;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) => {
    const started = performance.now();
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.status >= 400) throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`);
    return { ms: performance.now() - started, body: text ? JSON.parse(text) : null };
  };
  const steps = {};
  const note = (step, ms) => (steps[step] ??= []).push(ms);
  const payload = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
  for (let i = 0; i < samples; i += 1) {
    const created = await post("/v1/evidence", { type: "DOCUMENT", teamId, mimeType: "application/pdf", originalFileName: `capacity-${i}.pdf` });
    note("evidence_create", created.ms);
    const evidenceId = created.body.id ?? created.body.evidence?.id;
    const session = await post("/v1/uploads/sessions", { teamId, evidenceId, expectedPartCount: 1, targetPartIndex: 0, originalFileName: `capacity-${i}.pdf`, expectedMimeType: "application/pdf" });
    note("session_create", session.ms);
    const sessionId = session.body.session.id;
    const init = await post(`/v1/uploads/sessions/${sessionId}/multipart/initiate`, { teamId, contentType: "application/pdf" });
    note("multipart_initiate", init.ms);
    const presign = await post(`/v1/uploads/sessions/${sessionId}/parts/0/presign`, { teamId, sizeBytes: payload.length });
    note("part_presign", presign.ms);
    const put = await fetch(presign.body.uploadUrl, { method: "PUT", body: payload, headers: { "content-length": String(payload.length) } });
    if (!put.ok) throw new Error(`storage PUT ${put.status}`);
    const uploaded = await post(`/v1/uploads/sessions/${sessionId}/parts/0/uploaded`, { teamId, partEtag: (put.headers.get("etag") ?? "").replaceAll('"', ""), partSizeBytes: payload.length });
    note("part_uploaded", uploaded.ms);
    await post(`/v1/uploads/sessions/${sessionId}/abort`, { teamId }).catch(() => null);
  }
  const summary = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { n: v.length, p50: Math.round(percentile(v, 50)), p95: Math.round(percentile(v, 95)) }]));
  console.log(JSON.stringify(summary, null, 1));
  writeFileSync(resolve(OUT, `${label}-upload.json`), JSON.stringify(summary, null, 2));
}

mkdirSync(OUT, { recursive: true });
if (arg("upload")) await uploadPass();
else if (arg("explain")) await explainPass();
else if (arg("concurrency")) await concurrencyPass();
else await plainPass();
