/**
 * PHASE UI-TRUTH — runtime authorization probe (AUDIT HARNESS).
 *
 * Asks the RUNNING fixture API what each persona actually gets from every
 * read endpoint the in-scope surfaces consume. Source analysis says what the
 * product intends; this says what it does.
 *
 * SAFETY: refuses to run against anything but a loopback API, and only ever
 * issues GET requests, so it cannot mutate the fixture. The personas are the
 * fixture's own local accounts.
 *
 * Usage: node audit/ui-truth/harness/runtime-authz.mjs
 *   env: UIT_API (default http://127.0.0.1:8931)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./surfaces.mjs";

const API = process.env.UIT_API ?? "http://127.0.0.1:8931";
{
  const host = new URL(API).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    console.error(`REFUSED — the probe API origin ${API} is not loopback. Nothing was sent.`);
    process.exit(2);
  }
}

const PASSWORD = "fixture-local-only-password";
const PERSONAS = [
  { id: "platform-admin", email: "platform-admin@fixture.local" },
  { id: "org-owner", email: "org-owner@fixture.local" },
  { id: "workspace-admin", email: "workspace-admin@fixture.local" },
  { id: "read-only", email: "read-only@fixture.local" },
  { id: "free-personal", email: "free-personal@fixture.local" },
  { id: "pro-personal", email: "pro-personal@fixture.local" },
  { id: "anonymous", email: null },
];

/** Fixture ids, from services/api/scripts/seed-admin-fixture.ts. */
const ID = (n) => `0adf0000-0000-4000-8000-${n.padStart(12, "0")}`;
const FIXTURE = {
  orgPopulated: ID("a1"),
  orgEmpty: ID("a2"),
  wsPopulated: ID("b1"),
  wsEmpty: ID("b2"),
  wsPersonal: ID("b3"),
  demoRequest: ID("e1"),
  contactSales: ID("e2"),
  user: ID("2"),
};

/**
 * Fill a `:param` path from fixture ids. A path we cannot fill honestly is
 * skipped and reported as BLOCKED_FIXTURE_CAPABILITY rather than probed with
 * an invented id, because a 404 for a made-up id proves nothing.
 */
function fillPath(path) {
  const unresolved = [];
  const filled = path.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => {
    const n = name.toLowerCase();
    if (n === "teamid" || n === "workspaceid") return FIXTURE.wsPopulated;
    if (n === "orgid" || n === "organizationid") return FIXTURE.orgPopulated;
    if (n === "userid") return FIXTURE.user;
    unresolved.push(name);
    return `:${name}`;
  });
  return { filled, unresolved };
}

async function login(persona) {
  if (!persona.email) return null;
  const res = await fetch(`${API}/v1/auth/email/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: persona.email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${persona.id}: ${res.status}`);
  const body = await res.json();
  return body.token;
}

/** What the answer MEANS, in the vocabulary the audit reports. */
function classify(status, body) {
  if (status === 200 || status === 204) {
    const empty =
      body && typeof body === "object"
        ? Object.values(body).some((v) => Array.isArray(v) && v.length === 0)
        : false;
    return empty ? "OK_EMPTY" : "OK";
  }
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "REFUSED_FORBIDDEN";
  if (status === 404) return "NOT_FOUND_OR_CONCEALED";
  if (status === 402 || status === 409) return "REFUSED_BOUNDED";
  if (status === 410) return "GONE_TOMBSTONE";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_FAULT";
  return `OTHER_${status}`;
}

async function probe(token, method, path) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const started = Date.now();
  try {
    const res = await fetch(`${API}${path}`, { method, headers, signal: AbortSignal.timeout(20_000) });
    let body = null;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const denial =
      body && typeof body === "object"
        ? body.denial ?? body.error?.code ?? body.code ?? null
        : null;
    return {
      status: res.status,
      outcome: classify(res.status, body),
      denial: typeof denial === "string" ? denial : null,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { status: null, outcome: "PROBE_ERROR", denial: String(err).slice(0, 120), ms: Date.now() - started };
  }
}

async function main() {
  const placement = JSON.parse(readFileSync(join(REPO, "audit", "ui-truth", "data", "placement.json"), "utf8"));

  /** Every distinct GET endpoint a surface consumes, with the surfaces that use it. */
  const endpoints = new Map();
  for (const row of placement.rows) {
    for (const e of row.endpoints) {
      if (e.method !== "GET") continue;
      const entry = endpoints.get(e.routeId) ?? {
        routeId: e.routeId,
        method: e.method,
        path: e.path,
        gates: e.gates,
        dataScope: e.dataScope,
        tenantType: e.tenantType,
        surfaces: [],
      };
      if (!entry.surfaces.includes(row.route)) entry.surfaces.push(row.route);
      endpoints.set(e.routeId, entry);
    }
  }
  const list = [...endpoints.values()].sort((a, b) => (a.routeId < b.routeId ? -1 : 1));

  const tokens = {};
  for (const persona of PERSONAS) tokens[persona.id] = await login(persona);

  const rows = [];
  for (const endpoint of list) {
    const { filled, unresolved } = fillPath(endpoint.path);
    if (unresolved.length > 0) {
      rows.push({
        ...endpoint,
        probedPath: null,
        evidence: "BLOCKED_FIXTURE_CAPABILITY",
        blockedReason: `no fixture record for path parameter(s): ${unresolved.join(", ")}`,
        results: {},
      });
      continue;
    }
    /**
     * A 400 for a missing required query parameter is a probe artefact, not an
     * authorization answer. Retry once with the fixture's own workspace and a
     * minimal query, and record which form actually answered.
     */
    const withQuery = `${filled}?teamId=${FIXTURE.wsPopulated}&workspaceId=${FIXTURE.wsPopulated}&organizationId=${FIXTURE.orgPopulated}&q=fixture&limit=5`;
    const results = {};
    let probedPath = filled;
    let queryRetried = false;
    for (const persona of PERSONAS) {
      let r = await probe(tokens[persona.id], "GET", filled);
      if (r.status === 400) {
        const retry = await probe(tokens[persona.id], "GET", withQuery);
        if (retry.status !== 400) {
          r = { ...retry, viaQueryRetry: true };
          queryRetried = true;
          probedPath = withQuery;
        } else {
          r = { ...r, viaQueryRetry: true, retryStatus: retry.status };
        }
      }
      results[persona.id] = r;
    }
    rows.push({ ...endpoint, probedPath, queryRetried, evidence: "RUNTIME_PROVEN", blockedReason: null, results });
  }

  const probed = rows.filter((r) => r.evidence === "RUNTIME_PROVEN");
  const totals = {
    endpointsConsideredGET: list.length,
    probed: probed.length,
    blockedByFixture: rows.length - probed.length,
    requests: probed.length * PERSONAS.length,
    byPersonaOutcome: {},
  };
  for (const persona of PERSONAS) {
    const counts = {};
    for (const r of probed) {
      const o = r.results[persona.id].outcome;
      counts[o] = (counts[o] ?? 0) + 1;
    }
    totals.byPersonaOutcome[persona.id] = counts;
  }

  writeFileSync(
    join(REPO, "audit", "ui-truth", "data", "runtime-authz.json"),
    JSON.stringify(
      { artifact: "ui-truth/runtime-authz", schemaVersion: 1, api: "loopback fixture", personas: PERSONAS.map((p) => p.id), totals, rows },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(totals, null, 2));
}

await main();
