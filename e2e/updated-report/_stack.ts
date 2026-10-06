/**
 * THE UPDATED-REPORT JOURNEY STACK — helpers over the disposable Linux stack in
 * `stack/docker-compose.yml` (project `pv-rga`). Everything here acts through a
 * product path wherever one exists; the two places a fixture stands in for an
 * EXTERNAL party are named where they happen:
 *
 *   * the second workspace member is added as a membership row (team creation
 *     and invitations are not self-service for a TEAM-plan personal workspace);
 *   * the OpenTimestamps proof is constructed locally with the official
 *     `opentimestamps` library inside the worker image, standing in for the
 *     public calendars (no network). It is then ANCHORED by the worker's real
 *     upgrade processor and the real `ots` CLI — the supported path.
 *
 * The RFC 3161 token is REAL: the stack runs its own openssl TSA, the API stamps
 * against it at completion WITHOUT a trust anchor (so the token is kept and
 * recorded FAILED — not validated), and the product's own
 * `repair-tsa-failed-with-token` validates it once the anchor is configured.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { resolve } from "node:path";

import { expect, type APIRequestContext } from "@playwright/test";

const REPO = resolve(__dirname, "..", "..");
const API_DIR = resolve(REPO, "services", "api");
const COMPOSE = ["compose", "-p", "pv-rga", "-f", resolve(__dirname, "stack", "docker-compose.yml")];

export const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** One SQL statement against the stack's own disposable database. */
export function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): T[] {
  const script = `
    const { Client } = require("pg");
    (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query(${JSON.stringify(query)}, ${JSON.stringify(params)});
      process.stdout.write(JSON.stringify(r.rows));
      await c.end();
    })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
  `;
  const run = spawnSync(process.execPath, ["-e", script], { cwd: API_DIR, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`sql failed: ${run.stderr}`);
  return JSON.parse(run.stdout || "[]") as T[];
}

/** Run a command inside a stack service, failing loudly with its output. */
export function stackExec(service: string, args: string[], env: Record<string, string> = {}): string {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const run = spawnSync("docker", [...COMPOSE, "exec", "-T", ...envArgs, service, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(`docker exec ${service} ${args.join(" ")} failed (${run.status}): ${run.stderr || run.stdout}`);
  }
  return run.stdout;
}

/** docker compose stop/start/pause for failure drills. */
export function stackCtl(verb: "stop" | "start" | "pause" | "unpause" | "restart" | "kill", service: string): void {
  const run = spawnSync("docker", [...COMPOSE, verb, service], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`docker compose ${verb} ${service}: ${run.stderr}`);
}

export async function personalTeamId(api: APIRequestContext): Promise<string> {
  const res = await api.get("/v1/teams");
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as { teams?: Array<{ id: string; isPersonal?: boolean }> };
  const t = body.teams?.find((x) => x.isPersonal) ?? body.teams?.[0];
  expect(t?.id).toBeTruthy();
  return t!.id;
}

/** FIXTURE: add a second ACTIVE member with a role that may generate reports. */
export function addWorkspaceMember(teamId: string, userId: string, role: "ADMIN" | "MEMBER" | "VIEWER" = "ADMIN") {
  sql(
    `INSERT INTO team_members (team_id, user_id, role, status, access_granted_at_utc)
     VALUES ($1, $2, $3::"TeamRole", 'ACTIVE', now())
     ON CONFLICT DO NOTHING`,
    [teamId, userId, role],
  );
}

/** Create, upload (presigned, to the stack's MinIO) and complete one record. */
export async function createFinalizedEvidence(api: APIRequestContext, teamId: string, label: string): Promise<{ id: string; bytes: string }> {
  const bytes = `updated-report journey ${label} ${Date.now()}\n`;
  const sha = createHash("sha256").update(bytes).digest("base64");
  const md5 = createHash("md5").update(bytes).digest("base64");
  const created = await api.post("/v1/evidence", {
    data: { teamId, type: "DOCUMENT", mimeType: "text/plain", originalFileName: `${label}.txt`, checksumSha256Base64: sha, contentMd5Base64: md5 },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const id = ((await created.json()) as { id: string }).id;
  const partRes = await api.post(`/v1/evidence/${id}/parts`, {
    data: { partIndex: 0, mimeType: "text/plain", originalFileName: `${label}.txt`, checksumSha256Base64: sha, contentMd5Base64: md5 },
  });
  expect(partRes.ok(), await partRes.text()).toBe(true);
  const part = (await partRes.json()) as { upload: { putUrl: string } };
  const put = await signedRequest("PUT", part.upload.putUrl, Buffer.from(bytes), {
    "Content-Type": "text/plain",
    "x-amz-checksum-sha256": sha,
    "Content-MD5": md5,
  });
  expect(put.status, `PUT ${put.status} ${put.body.toString("utf8").slice(0, 300)}`).toBe(200);
  const done = await api.post(`/v1/evidence/${id}/complete`, { data: {} });
  expect(done.ok(), await done.text()).toBe(true);
  return { id, bytes };
}

/**
 * A presigned request from Node. The URL is signed for `minio.localhost:57900`;
 * Node's resolver may not map *.localhost, so connect to loopback and send the
 * SIGNED Host header unchanged.
 */
export function signedRequest(
  method: "GET" | "PUT",
  url: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Buffer }> {
  const u = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        method,
        host: u.hostname.endsWith(".localhost") ? "127.0.0.1" : u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        headers: { ...headers, Host: u.host, ...(body ? { "Content-Length": String(body.length) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export type StatusBody = {
  outputs: {
    report: { state: string; action: string; version: number | null };
    verificationPackage: { state: string; action: string; version: number | null };
    newVersion: { action: string; reason: string | null; currentVersion: number | null; nextVersion: number | null };
    offer: { revision: string; targetVersion: number | null } | null;
    freshness: { hasNewerFacts: boolean; changes: Array<{ code: string }> };
    trust: { tsa: { status: string | null; validated: boolean }; ots: { status: string | null; anchorCheck: string | null } };
    activeRequest: { requestId: string; state: string; progress: { currentStep: string; outcome: string } } | null;
    pollIntervalMs: number | null;
  };
  versions: {
    versions: Array<{
      reportVersion: number;
      latest: boolean;
      sha256: string | null;
      package: { version: number; sha256: string | null; embeddedReportSha256: string | null } | null;
    }>;
  };
};

export async function status(api: APIRequestContext, id: string): Promise<StatusBody> {
  const r = await api.get(`/v1/evidence/${id}/artifacts/status`);
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as StatusBody;
}

/** Wait until the pair at `version` exists (report AND its package), via the side-effect-free status. */
export async function waitForPair(api: APIRequestContext, id: string, version: number, timeoutMs = 240_000) {
  await expect
    .poll(
      async () => {
        const s = await status(api, id);
        const v = s.versions.versions.find((x) => x.reportVersion === version);
        return v?.package?.version === version ? "PAIR" : `${s.outputs.report.state}/${s.outputs.verificationPackage.state}/${s.outputs.activeRequest?.state ?? "-"}:${s.outputs.activeRequest?.progress.currentStep ?? "-"}`;
      },
      { timeout: timeoutMs, intervals: [2000] },
    )
    .toBe("PAIR");
}

/** Download one exact version's bytes through the product's versioned routes. */
export async function downloadVersion(api: APIRequestContext, id: string, kind: "report" | "package", version: number): Promise<Buffer> {
  const path = kind === "report" ? `/v1/evidence/${id}/reports/${version}` : `/v1/evidence/${id}/verification-packages/${version}`;
  const res = await api.get(path);
  expect(res.status(), await res.text()).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const file = await signedRequest("GET", url);
  expect(file.status).toBe(200);
  return file.body;
}

/**
 * TSA — validate the KEPT token through the product's own repair script, with
 * the stack TSA's root configured as the trust anchor (ET-TSA-09).
 */
export function validateKeptTsaToken(evidenceId: string): string {
  return stackExec("api", ["node", "dist/scripts/repair-tsa-failed-with-token.js", "--evidence-id", evidenceId, "--apply"], {
    TSA_TRUST_BUNDLE_PATH: "/tsa/ca.pem",
  });
}

/**
 * OTS — a proof committing to the record's digest with a Bitcoin block-header
 * attestation, built offline with the official library, then anchored by the
 * worker's real upgrade processor (`ots upgrade` / `ots info`; no Bitcoin node,
 * so the recorded check is PROOF_STRUCTURE — never claimed as chain-verified).
 */
export function anchorOtsThroughUpgrade(evidenceId: string): void {
  // The anchor commits to the CANONICAL FINGERPRINT HASH (what completion
  // stamps), not the file digest — a proof over any other digest is reported
  // by the product as an anchoring integrity concern, correctly.
  const [row] = sql<{ fingerprint_hash: string | null }>(
    "SELECT fingerprint_hash FROM evidence WHERE id = $1",
    [evidenceId],
  );
  const digest = (row?.fingerprint_hash ?? "").toLowerCase();
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  // stack/ots-proof.py: the digest inside a serialized Bitcoin transaction,
  // its txid, and a block-header attestation — the shape of a real upgrade.
  const proof = stackExec("worker", ["/opt/ots-venv/bin/python", "/srv/ots-proof.py", digest]).trim();
  expect(proof.length).toBeGreaterThan(20);
  // The stamp a calendar would have returned: a pending record WITH its proof.
  sql(
    `UPDATE evidence SET ots_status = 'PENDING', ots_hash = $2, ots_proof_base64 = $3,
       ots_calendar = 'rga-local-offline-proof', ots_anchored_at_utc = NULL, ots_anchor_check = NULL,
       ots_failure_reason = NULL WHERE id = $1`,
    [evidenceId, digest, proof],
  );
  // The product's ONE producer for this work, from inside the API image.
  stackExec("api", [
    "node",
    "--input-type=module",
    "-e",
    `const m = await import("/app/services/api/dist/services/integrity/ots-anchoring-authority.service.js");
     const r = await m.requestEvidenceOtsAnchoring({ evidenceId: ${JSON.stringify(evidenceId)}, trigger: "operations.remediation" });
     console.log(JSON.stringify(r)); process.exit(r.requested || r.reason === "collapsed" ? 0 : 3);`,
  ]);
}

/** The bytes of one ZIP entry (stored or deflated), using the repo's reader. */
export { readZipEntries } from "../../services/api/test/point5/_zip-entries";

/**
 * Kill the worker (SIGKILL, no drain) the moment the request row satisfies a
 * predicate — a persistent connection polled every 20 ms, so the kill lands
 * inside sub-second windows (e.g. after the report is committed, before the
 * package is published). Returns the row seen at the kill.
 */
export async function killWorkerWhen(
  requestId: string,
  pred: (r: { state: string; stage: string | null; progress_stage: string | null }) => boolean,
  timeoutMs = 300_000,
): Promise<{ state: string; stage: string | null; progress_stage: string | null }> {
  const { createRequire } = await import("node:module");
  const req = createRequire(resolve(API_DIR, "package.json"));
  const { Client } = req("pg") as { Client: new (o: { connectionString?: string }) => { connect(): Promise<void>; query(q: string, p: unknown[]): Promise<{ rows: Array<{ state: string; stage: string | null; progress_stage: string | null }> }>; end(): Promise<void> } };
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const until = Date.now() + timeoutMs;
  try {
    for (;;) {
      const { rows } = await c.query("SELECT state, stage, progress_stage FROM report_generation_requests WHERE id = $1", [requestId]);
      const r = rows[0];
      if (r && pred(r)) {
        spawnSync("docker", ["kill", "pv-rga-worker-1"], { encoding: "utf8" });
        return r;
      }
      if (Date.now() > until) throw new Error(`killWorkerWhen: never matched; last ${JSON.stringify(r)}`);
      await new Promise((res) => setTimeout(res, 20));
    }
  } finally {
    await c.end();
  }
}
