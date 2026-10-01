/**
 * AUDIT-ONLY runtime journey driver. Not product code.
 *
 * Drives the REAL product API (booted by scripts/uc1-acceptance-windows.mjs on a
 * disposable stack: API + worker + PG + Redis + MinIO, all loopback) with the
 * actors printed by seed-journeys.ts, and records every request/response plus
 * durable DB observations to runtime/journeys-raw.json.
 *
 * Usage: node journeys.mjs <seed.json> <out.json>
 * Env:   UCA_API (default http://localhost:4000), UCA_PG_CONTAINER (uc1-acc-pg),
 *        UCA_MINIO_CONTAINER (uc1-acc-minio)
 */
import * as nodeCrypto from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
globalThis.__crypto = nodeCrypto;
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const API = process.env.UCA_API ?? "http://localhost:4000";
for (const u of [API]) {
  const h = new URL(u).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(h)) throw new Error(`REFUSED non-loopback ${u}`);
}
const PG = process.env.UCA_PG_CONTAINER ?? "uc1-acc-pg";
const MINIO = process.env.UCA_MINIO_CONTAINER ?? "uc1-acc-minio";
const [seedPath, outPath] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(seedPath, "utf8").trim().split("\n").pop());

const log = [];
const journeys = [];
const REQ_TIMEOUT = 30_000;

function trim(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 1500 ? s.slice(0, 1500) + "…" : s;
}

async function call(actor, method, path, body, { raw = false, headers = {} } = {}) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const h = { ...headers };
  if (actor) h.authorization = `Bearer ${actor.bearer}`;
  if (body !== undefined && !raw) h["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(REQ_TIMEOUT),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {
    /* binary / empty */
  }
  const safePath = path.replace(/pvs_[A-Za-z0-9_-]+/g, "pvs_<redacted>").replace(/X-Amz-[^&]+/g, "X-Amz-<redacted>");
  log.push({ actor: actor?.tag ?? "anonymous", method, path: safePath.startsWith("http") ? new URL(safePath).pathname : safePath, status: res.status, body: json ? trim(json) : `<${buf.length} bytes>` });
  return { status: res.status, json, buf, headers: res.headers };
}

function sql(q) {
  const r = spawnSync("docker", ["exec", PG, "psql", "-U", "proovra", "-d", "uc1_acceptance_test", "-At", "-F", "|", "-c", q], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (r.status !== 0) return { error: r.stderr.trim() };
  return { rows: r.stdout.trim().split("\n").filter(Boolean) };
}

function mc(args) {
  const r = spawnSync("docker", ["exec", MINIO, "sh", "-c", `mc alias set l http://127.0.0.1:9000 uc1miniolocal uc1miniolocalsecret >/dev/null 2>&1; ${args}`], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: r.status, out: (r.stdout + r.stderr).trim().slice(0, 2000) };
}

const ONLY = (process.env.UCA_ONLY ?? "").split(",").filter(Boolean);
async function journey(id, title, fn) {
  if (ONLY.length && !ONLY.some((p) => id.startsWith(p))) return;
  const start = log.length;
  const j = { id, title, verdict: "FAIL", checks: [], observations: {} };
  const check = (name, ok, detail) => j.checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : trim(detail) });
  try {
    await fn(check, j.observations);
    j.verdict = j.checks.length > 0 && j.checks.every((c) => c.ok) ? "PASS" : "FAIL";
  } catch (err) {
    j.checks.push({ name: "journey threw", ok: false, detail: String(err?.stack ?? err).slice(0, 800) });
    j.verdict = "FAIL";
  }
  j.requests = log.slice(start);
  journeys.push(j);
  process.stdout.write(`${id} ${j.verdict} (${j.checks.filter((c) => c.ok).length}/${j.checks.length})\n`);
}

const sha256b64 = (b) => createHash("sha256").update(b).digest("base64");
const md5b64 = (b) => createHash("md5").update(b).digest("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Canonical web-upload sequence used by the Capture page's simple (non-resumable) path. */
async function webUpload(actor, teamId, bytes, { mime = "image/png", name = "uca.png", type = "PHOTO", caseId } = {}) {
  const created = await call(actor, "POST", "/v1/evidence", {
    type,
    teamId,
    mimeType: mime,
    originalFileName: name,
    captureFileName: name,
    deviceTimeIso: new Date().toISOString(),
    checksumSha256Base64: sha256b64(bytes),
    contentMd5Base64: md5b64(bytes),
    ...(caseId ? { caseId } : {}),
  });
  if (created.status >= 300) return { created };
  const id = created.json.id;
  const part = await call(actor, "POST", `/v1/evidence/${id}/parts`, {
    partIndex: 0,
    mimeType: mime,
    originalFileName: name,
    checksumSha256Base64: sha256b64(bytes),
    contentMd5Base64: md5b64(bytes),
  });
  if (part.status >= 300) return { created, id, part };
  const put = await call(null, "PUT", part.json.upload.putUrl, bytes, {
    raw: true,
    headers: { "content-type": mime, "x-amz-checksum-sha256": sha256b64(bytes), "Content-MD5": md5b64(bytes) },
  });
  const complete = await call(actor, "POST", `/v1/evidence/${id}/complete`, {});
  return { created, id, part, put, complete };
}

async function pollOutputs(actor, id, timeoutMs = 240_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const s = await call(actor, "GET", `/v1/evidence/${id}/artifacts/status`);
    last = s.json;
    const rep = s.json?.report?.available === true;
    const pkg = s.json?.verificationPackage?.available === true;
    const failed = /FAIL/i.test(String(s.json?.outputs?.report?.state ?? "")) || /FAIL/i.test(String(s.json?.outputs?.verificationPackage?.state ?? ""));
    if ((rep && pkg) || failed) break;
    await sleep(5000);
  }
  // keep the log small: drop all but the last poll
  const polls = log.filter((l) => l.path === `/v1/evidence/${id}/artifacts/status`);
  for (const p of polls.slice(0, -1)) log.splice(log.indexOf(p), 1);
  return last;
}

function base32Decode(str){const a="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let bits="";for(const ch of str.replace(/=+$/,"").toUpperCase()){const v=a.indexOf(ch);if(v<0)continue;bits+=v.toString(2).padStart(5,"0");}const out=[];for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(out);}
function totp(secretB32,offset=0){const { createHmac } = globalThis.__crypto;const key=base32Decode(secretB32);const ctr=Math.floor(Date.now()/1000/30)+offset;const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(ctr));const h=createHmac("sha1",key).update(b).digest();const o=h[h.length-1]&15;const code=((h.readUInt32BE(o)&0x7fffffff)%1000000).toString().padStart(6,"0");return code;}
const totpSecrets = new Map();
const lastWindow = new Map();
/** Real product path: enrol TOTP (once per actor), then start + check a step-up challenge. */
async function stepUp(actor, teamId, purpose, resourceKind, resourceId) {
  if (!totpSecrets.has(actor.tag)) {
    const st = await call(actor, "POST", "/v1/identity/mfa/enroll/start", { label: "uca" });
    if (st.status >= 300) return { error: "enroll_start", status: st.status, body: st.json };
    const secret = st.json.secretBase32;
    const vf = await call(actor, "POST", "/v1/identity/mfa/enroll/verify", { factorId: st.json.factorId, code: totp(secret) });
    if (vf.status >= 300) return { error: "enroll_verify", status: vf.status, body: vf.json };
    totpSecrets.set(actor.tag, secret);
    await sleep(31000); // next TOTP window so the challenge code is not a replay of the enrolment code
  }
  const win = Math.floor(Date.now() / 30000);
  if (lastWindow.get(actor.tag) === win) await sleep(30000 - (Date.now() % 30000) + 1500);
  lastWindow.set(actor.tag, Math.floor(Date.now() / 30000));
  const start = await call(actor, "POST", "/v1/identity-security/step-up/start", { teamId, purpose, resourceKind, resourceId });
  if (start.status >= 300) return { error: "start", status: start.status, body: start.json };
  const challengeId = start.json?.challenge?.id;
  const chk = await call(actor, "POST", "/v1/identity-security/step-up/check", { teamId, challengeId, code: totp(totpSecrets.get(actor.tag)) });
  if (chk.status >= 300) return { error: "check", status: chk.status, body: chk.json };
  return { challengeId };
}
async function mintShare(actor, evidenceId, teamId, audience) {
  let r = await call(actor, "POST", `/v1/evidence/${evidenceId}/verify-links`, { audience, expiresInDays: 7 });
  if (r.status === 401 && r.json?.error?.code === "STEP_UP_REQUIRED") {
    const su = await stepUp(actor, teamId, "PUBLIC_VERIFY_PUBLISH", "evidence", evidenceId);
    if (su.error) return { status: 0, stepUpError: su };
    r = await call(actor, "POST", `/v1/evidence/${evidenceId}/verify-links`, { audience, expiresInDays: 7 }, { headers: { "x-proovra-step-up-challenge-id": su.challengeId } });
  }
  return r;
}

const actors = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, { ...v, tag: k }]));
const { ownerA, viewerA, memberA, ownerB, free } = actors;
const png = (n) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(512 + n)]);

let mainId = null;
let mainBytes = null;
let mainCaseId = null;

await journey("J01-web-upload-to-public-verify", "Web/PWA upload → finalize → report → package → share link → Public Verify", async (check, obs) => {
  mainBytes = png(1);
  const u = await webUpload(ownerA, ownerA.teamId, mainBytes);
  check("evidence created", u.created.status === 201 || u.created.status === 200, u.created.status);
  check("part presigned", u.part?.status < 300, u.part?.status);
  check("bytes PUT to object storage", u.put?.status < 300, u.put?.status);
  check("complete accepted", u.complete?.status < 300, u.complete?.json);
  mainId = u.id;
  obs.evidenceId = mainId;
  const row = sql(`select status, acquisition_mode, acquisition_mode_source, file_sha256 is not null, team_id from evidence where id='${mainId}'`);
  obs.evidenceRow = row;
  const status = await pollOutputs(ownerA, mainId);
  obs.artifactsStatus = status;
  check("report available", status?.report?.available === true, status?.outputs?.report);
  check("verification package available", status?.verificationPackage?.available === true, status?.outputs?.verificationPackage);
  const rep = await call(ownerA, "GET", `/v1/evidence/${mainId}/report/latest`);
  check("report/latest readable", rep.status === 200, rep.status);
  obs.reportSnapshots = rep.json?.snapshots ?? null;
  check("report snapshot carries acquisition mode PROOVRA_WEB_UPLOAD", rep.json?.snapshots?.acquisitionMode === "PROOVRA_WEB_UPLOAD", rep.json?.snapshots?.acquisitionMode);
  const pkg = await call(ownerA, "GET", `/v1/evidence/${mainId}/verification-package`);
  check("verification-package readable", pkg.status === 200, pkg.status);
  obs.package = pkg.json;
  const byId = await call(null, "GET", `/public/verify/${mainId}`);
  check("record id is not a public link (anti-enumeration 404)", byId.status === 404, byId.status);
  const link = await mintShare(ownerA, mainId, ownerA.teamId, "uca audit");
  obs.mintStepUp = link.stepUpError ?? "ok";
  check("share link minted through the product route", link.status === 201, link.status);
  obs.linkId = link.json?.link?.id;
  const tokenRow = sql(`select count(*) from verification_share_tokens where evidence_id='${mainId}'`);
  obs.shareLinkRows = tokenRow;
  if (link.json?.token) {
    const tokenHash = createHash("sha256").update(link.json.token).digest("hex");
    const plain = sql(`select count(*) from verification_share_tokens t where row_to_json(t)::text like '%${link.json.token}%'`);
    check("share token is not stored in plaintext", plain.rows?.[0] === "0", plain);
    obs.plaintextTokenStored = plain;
    const pub = await call(null, "GET", `/public/verify/${link.json.token}`);
    check("public verify reachable by share token", pub.status === 200, pub.status);
    obs.publicVerify = pub.json;
    obs.tokenHashPrefix = tokenHash.slice(0, 8);
    const pubStr = JSON.stringify(pub.json ?? {});
    check("public verify does not leak the owner email", !pubStr.includes(ownerA.email), null);
    check("public verify does not leak the workspace id", !pubStr.includes(ownerA.teamId), null);
    // revoke
    const rv = await call(ownerA, "POST", `/v1/evidence/${mainId}/verify-links/${obs.linkId}/revoke`, {});
    check("revoke accepted", rv.status === 200, rv.json);
    const after = await call(null, "GET", `/public/verify/${link.json.token}`);
    check("revoked token no longer verifies", after.status === 404 || after.status === 410, after.status);
    // replace (rotate) on a fresh link
    const l2 = await mintShare(ownerA, mainId, ownerA.teamId, "uca rotate");
    const rot = await call(ownerA, "POST", `/v1/evidence/${mainId}/verify-links/${l2.json?.link?.id}/rotate`, {});
    check("rotate accepted", rot.status === 200 || rot.status === 201, rot.status);
    const oldAfter = await call(null, "GET", `/public/verify/${l2.json?.token}`);
    check("rotated-away token no longer verifies", oldAfter.status === 404 || oldAfter.status === 410, oldAfter.status);
    const newTok = rot.json?.token;
    if (newTok) {
      const nw = await call(null, "GET", `/public/verify/${newTok}`);
      check("replacement token verifies", nw.status === 200, nw.status);
    } else check("rotate returned a replacement token", false, rot.json);
    const guess = await call(null, "GET", `/public/verify/pvs_${randomBytes(32).toString("base64url")}`);
    check("guessed share token → 404", guess.status === 404, guess.status);
  }
  const custody = sql(`select count(*), count(distinct event_type) from custody_events where evidence_id='${mainId}'`);
  obs.custodyEvents = custody;
  const audits = sql(`select row_to_json(t)::text from admin_audit_logs t where row_to_json(t)::text like '%${mainId}%'`);
  check("tenant audit trail records share-link actions", (audits.rows ?? []).some((r) => r.includes("verification.link_created")), (audits.rows ?? []).length);
  obs.auditActions = audits;
});

await journey("J02-package-independent-recompute", "Download verification package and recompute its checksum index outside the application", async (check, obs) => {
  if (!mainId) throw new Error("no evidence from J01");
  const pkg = await call(ownerA, "GET", `/v1/evidence/${mainId}/verification-package`);
  const url = pkg.json?.downloadUrl ?? pkg.json?.url ?? pkg.json?.package?.downloadUrl ?? null;
  obs.packageKeys = Object.keys(pkg.json ?? {});
  check("package response carries a download URL", Boolean(url), obs.packageKeys);
  if (!url) return;
  const dl = await call(null, "GET", url);
  check("package bytes downloadable", dl.status === 200 && dl.buf.length > 0, dl.status);
  writeFileSync(outPath.replace(/\.json$/, "-package.zip"), dl.buf);
  obs.packageSha256 = createHash("sha256").update(dl.buf).digest("hex");
  obs.packageBytes = dl.buf.length;
  const recorded = sql(`select version, zip_sha256, status from verification_packages where evidence_id='${mainId}' order by version desc limit 1`);
  obs.recordedPackageRow = recorded;
});

await journey("J03-case-attach-and-tenancy", "Create case, attach evidence, read back; cross-tenant + viewer negatives", async (check, obs) => {
  if (!mainId) throw new Error("no evidence from J01");
  const c = await call(ownerA, "POST", "/v1/cases", { name: "UCA case A", teamId: ownerA.teamId });
  check("case created", c.status === 201 || c.status === 200, c.json);
  mainCaseId = c.json?.id;
  const link = await call(ownerA, "POST", `/v1/cases/${mainCaseId}/evidence`, { evidenceId: mainId });
  check("evidence attached to case", link.status < 300 && link.json?.evidence?.caseId === mainCaseId, link.json);
  const list = await call(ownerA, "GET", `/v1/evidence?caseId=${mainCaseId}&scope=all`);
  check("case lists the evidence", (list.json?.items ?? []).some((x) => x.id === mainId), list.status);
  const again = await call(ownerA, "POST", `/v1/cases/${mainCaseId}/evidence`, { evidenceId: mainId });
  check("re-attach is idempotent (no error, no duplicate)", again.status < 300, again.status);
  // cross-tenant
  const bRead = await call(ownerB, "GET", `/v1/evidence/${mainId}`);
  check("tenant B cannot read tenant A evidence (404)", bRead.status === 404, bRead.status);
  const bOrig = await call(ownerB, "GET", `/v1/evidence/${mainId}/original`);
  check("tenant B cannot fetch tenant A original", bOrig.status === 404 || bOrig.status === 403, bOrig.status);
  const cb = await call(ownerB, "POST", "/v1/cases", { name: "UCA case B", teamId: ownerB.teamId });
  const bLink = await call(ownerB, "POST", `/v1/cases/${cb.json?.id}/evidence`, { evidenceId: mainId });
  check("tenant B cannot attach tenant A evidence to its case", bLink.status === 404 || bLink.status === 403, bLink.status);
  const aLinkB = await call(ownerA, "POST", `/v1/cases/${cb.json?.id}/evidence`, { evidenceId: mainId });
  check("tenant A cannot attach into tenant B case", aLinkB.status === 404 || aLinkB.status === 403, aLinkB.status);
  const bShare = await call(ownerB, "POST", `/v1/evidence/${mainId}/verify-links`, { audience: "x", expiresInDays: 1 });
  check("tenant B cannot mint a share link for tenant A evidence", bShare.status === 404 || bShare.status === 403, bShare.status);
  const unknown = await call(ownerA, "POST", `/v1/cases/00000000-0000-4000-8000-000000000000/evidence`, { evidenceId: mainId });
  check("unknown case id refused", unknown.status === 404 || unknown.status === 403 || unknown.status === 400, unknown.status);
  const malformed = await call(ownerA, "GET", `/v1/evidence/not-a-uuid`);
  check("malformed evidence id refused (4xx, not 5xx)", malformed.status >= 400 && malformed.status < 500, malformed.status);
  const anon = await call(null, "GET", `/v1/evidence/${mainId}`);
  check("anonymous caller refused", anon.status === 401, anon.status);
  // viewer role
  const vRead = await call(viewerA, "GET", `/v1/evidence/${mainId}`);
  obs.viewerRead = vRead.status;
  const vOrig = await call(viewerA, "GET", `/v1/evidence/${mainId}/original`);
  obs.viewerOriginal = vOrig.status;
  const vShare = await call(viewerA, "POST", `/v1/evidence/${mainId}/verify-links`, { audience: "viewer", expiresInDays: 1 });
  check("viewer cannot mint a public share link", vShare.status === 403 || vShare.status === 404, vShare.status);
  const vTrash = await call(viewerA, "DELETE", `/v1/evidence/${mainId}`);
  check("viewer cannot trash evidence", vTrash.status === 403 || vTrash.status === 404, vTrash.status);
  const vUp = await webUpload(viewerA, ownerA.teamId, png(2));
  check("viewer cannot create evidence in the workspace", vUp.created.status === 403 || vUp.created.status === 404, vUp.created.status);
  const detail = await call(ownerA, "GET", `/v1/evidence/${mainId}`);
  obs.detailCaseId = detail.json?.evidence?.caseId ?? detail.json?.evidence?.case?.id ?? null;
  check("evidence detail shows the case relationship", obs.detailCaseId === mainCaseId, obs.detailCaseId);
  const unlink = await call(ownerA, "DELETE", `/v1/cases/${mainCaseId}/evidence/${mainId}`);
  obs.unlinkStatus = unlink.status;
  const stillThere = await call(ownerA, "GET", `/v1/evidence/${mainId}`);
  check("unlink does not delete the evidence", stillThere.status === 200, stillThere.status);
  const teamAfterUnlink = sql(`select team_id from evidence where id='${mainId}'`);
  obs.teamAfterUnlink = teamAfterUnlink;
  check("unlink keeps the workspace binding (team_id not NULL)", (teamAfterUnlink.rows?.[0] ?? "").split("|")[0] === ownerA.teamId, teamAfterUnlink);
});

await journey("J04-trash-restore", "Trash → restore keeps the record and its outputs", async (check, obs) => {
  const u = await webUpload(ownerA, ownerA.teamId, png(3));
  check("evidence created+completed", u.complete?.status < 300, u.complete?.status);
  const t = await call(ownerA, "DELETE", `/v1/evidence/${u.id}`);
  check("trash accepted", t.status === 200, t.json);
  const row = sql(`select deleted_at is not null from evidence where id='${u.id}'`);
  obs.trashedRow = row;
  check("trash is soft (row kept, deleted_at set)", row.rows?.[0] === "t", row);
  const list = await call(ownerA, "GET", `/v1/evidence?scope=all`);
  check("trashed record hidden from the library", !(list.json?.items ?? []).some((x) => x.id === u.id), null);
  const r = await call(ownerA, "POST", `/v1/evidence/${u.id}/restore`, { restore: true });
  check("restore accepted", r.status === 200, r.json);
  const row2 = sql(`select deleted_at is null, status from evidence where id='${u.id}'`);
  obs.restoredRow = row2;
  check("restored row live again", (row2.rows?.[0] ?? "").startsWith("t|"), row2);
  const t2 = await call(ownerA, "DELETE", `/v1/evidence/${u.id}`);
  obs.retrashStatus = t2.status;
  const dest = await call(ownerA, "POST", `/v1/governance/lifecycle/evidence/${u.id}/transition`, { to: "DESTROYED", reason: "uca" });
  obs.destroyAttemptStatus = dest.status;
  obs.destroyAttempt = dest.json;
});

await journey("J05-free-allowance", "FREE personal workspace: three records, fourth refused, trash keeps the slot", async (check, obs) => {
  obs.personalTeam = free.personalTeam;
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const u = await webUpload(free, free.teamId, png(10 + i));
    obs[`create${i + 1}`] = u.created.status;
    obs[`complete${i + 1}`] = u.complete?.status ?? null;
    if (u.id) ids.push(u.id);
  }
  check("three FREE records created", ids.length === 3, ids.length);
  const fourth = await webUpload(free, free.teamId, png(20));
  obs.fourth = { status: fourth.created.status, body: fourth.created.json };
  check("fourth FREE record refused with a 4xx", fourth.created.status >= 400 && fourth.created.status < 500, fourth.created.status);
  if (ids[0]) {
    await call(free, "DELETE", `/v1/evidence/${ids[0]}`);
    const fifth = await webUpload(free, free.teamId, png(21));
    obs.afterTrash = fifth.created.status;
    check("trash does not release the FREE slot", fifth.created.status >= 400 && fifth.created.status < 500, fifth.created.status);
  }
  const ledger = sql(`select count(*) from evidence where team_id='${free.teamId}'`);
  obs.rowsInPersonalTeam = ledger;
});

await journey("J06-integrity-tamper", "Tamper stored original bytes; the product must not keep saying verified", async (check, obs) => {
  const bytes = png(30);
  const u = await webUpload(ownerA, ownerA.teamId, bytes);
  check("evidence completed", u.complete?.status < 300, u.complete?.status);
  const st = await pollOutputs(ownerA, u.id);
  check("outputs produced before tamper", st?.report?.available === true, st?.outputs);
  const keyRow = sql(`select storage_bucket, storage_key from evidence_parts where evidence_id='${u.id}' order by part_index limit 1`);
  obs.partStorage = keyRow;
  const [bucket, key] = (keyRow.rows?.[0] ?? "|").split("|");
  const tam = mc(`printf 'tampered' | mc pipe l/${bucket}/${key} && mc stat l/${bucket}/${key} | head -5`);
  obs.tamper = tam;
  check("stored object overwritten (disposable MinIO, no object lock)", tam.status === 0, tam.out);
  const link = await mintShare(ownerA, u.id, ownerA.teamId, "tamper");
  check("share link minted for tampered record", Boolean(link.json?.token), link.stepUpError ?? link.status);
  const pub = await call(null, "GET", `/public/verify/${link.json?.token}`);
  obs.publicVerifyAfterTamper = pub.json;
  const regen = await call(ownerA, "POST", `/v1/evidence/${u.id}/reports/regenerate`, {});
  obs.regenerate = { status: regen.status, body: regen.json };
  await sleep(20000);
  const st2 = await call(ownerA, "GET", `/v1/evidence/${u.id}/artifacts/status`);
  obs.statusAfterRegen = st2.json;
  const ev = sql(`select status, file_sha256 from evidence where id='${u.id}'`);
  obs.evidenceAfter = ev;
  const pub2 = await call(null, "GET", `/public/verify/${link.json?.token}`);
  obs.publicVerifyAfterRegen = pub2.json;
  const s = JSON.stringify(pub2.json ?? {});
  check("public verify reachable after tamper", pub2.status === 200, pub2.status);
  check("public verify after regeneration does not present a clean VERIFIED headline", !/"(verdict|headline|status)":"(VERIFIED|verified|INTACT)"/.test(s), s.slice(0, 400));
  // Remediation rerun (UC-TRUST-008): the headline is not enough — the STORED BYTES row
  // must not claim the substituted object is currently verified either.
  const sb = pub2.json?.basicVerification?.storedBytes ?? null;
  obs.storedBytesAfterTamper = sb;
  check("stored bytes are not presented as currently verified after substitution", sb && sb.state !== "verified_current" && sb.checkStatus !== "VERIFIED", sb);
});


await journey("J07-upload-session-member-injection", "Same-workspace MEMBER drives the OWNER's resumable upload session (UC-SEC-001)", async (check, obs) => {
  const teamId = ownerA.teamId;
  const injected = Buffer.concat([Buffer.from("MEMBER-INJECTED-"), randomBytes(64)]);
  const ev = await call(ownerA, "POST", "/v1/evidence", { type: "DOCUMENT", teamId, mimeType: "application/pdf", originalFileName: "owner.pdf" });
  const evidenceId = ev.json?.id;
  const sess = await call(ownerA, "POST", "/v1/uploads/sessions", { teamId, evidenceId, expectedPartCount: 1, idempotencyKey: `uca:${evidenceId}:0`, targetPartIndex: 0, originalFileName: "owner.pdf", expectedMimeType: "application/pdf" });
  const sessionId = sess.json?.session?.id;
  const init = await call(ownerA, "POST", `/v1/uploads/sessions/${sessionId}/multipart/initiate`, { teamId, contentType: "application/pdf" });
  obs.initiate = init.status;
  check("owner opened a resumable session + multipart", sess.status === 201 && init.status < 300, { sess: sess.status, init: init.status, body: init.json });
  const presign = await call(memberA, "POST", `/v1/uploads/sessions/${sessionId}/parts/0/presign`, { teamId });
  obs.memberPresign = presign.status;
  const url = presign.json?.uploadUrl;
  let injectedSigned = false;
  if (url) {
    const put = await fetch(url, { method: "PUT", body: injected, signal: AbortSignal.timeout(20000) });
    obs.memberPut = put.status;
    const etag = put.headers.get("etag") ?? undefined;
    const mk = await call(memberA, "POST", `/v1/uploads/sessions/${sessionId}/parts/0/uploaded`, { teamId, partEtag: etag, partSizeBytes: injected.length, clientSha256: createHash("sha256").update(injected).digest("hex") });
    obs.memberMarkUploaded = { status: mk.status, body: mk.json };
    const mc = await call(memberA, "POST", `/v1/uploads/sessions/${sessionId}/multipart/complete`, { teamId, verifyHash: true });
    obs.memberMultipartComplete = { status: mc.status, body: mc.json };
    const sc = await call(memberA, "POST", `/v1/uploads/sessions/${sessionId}/complete`, { teamId });
    obs.memberSessionComplete = sc.status;
    const fin = await call(ownerA, "POST", `/v1/evidence/${evidenceId}/complete`, {});
    obs.ownerFinalize = { status: fin.status, body: fin.json };
    const row = sql(`select status, owner_user_id, file_sha256 from evidence where id='${evidenceId}'`);
    obs.evidenceAfter = row;
    obs.injectedSha256 = createHash("sha256").update(injected).digest("hex");
    injectedSigned = (row.rows?.[0] ?? "").includes(obs.injectedSha256) && /^SIGNED|/.test(row.rows?.[0] ?? "");
  }
  check("a member who is not the session owner cannot presign into it", presign.status === 404 || presign.status === 403, presign.status);
  check("the owner's record is not signed over the member's bytes", !injectedSigned, obs.evidenceAfter);
});

// ---------------------------------------------------------------- phase 2 (second stack: intake flags on)
await journey("J08-intake-link-to-public-verify", "Intake link: anonymous contributor submits → evidence in the org workspace → report → package → Public Verify", async (check, obs) => {
  const link = await call(ownerA, "POST", "/v1/workflow/intake-links", {
    teamId: ownerA.teamId,
    workflowTemplateSlug: "general-evidence-record",
    intakeMode: "EXTERNAL_REUSABLE",
    recipientLabel: "uca",
    expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(),
  });
  check("intake link minted", link.status === 201, link.status === 201 ? null : link.json);
  const raw = link.json?.rawToken;
  if (!raw) return;
  const t = encodeURIComponent(raw);
  const boot = await call(null, "GET", `/v1/external-intake/${t}`);
  check("public intake boot", boot.status === 200, boot.status);
  const sid = boot.json?.session?.id;
  const consent = await call(null, "POST", `/v1/external-intake/${t}/sessions/${sid}/consent`, {
    consent: {
      acceptedAtUtc: new Date().toISOString(),
      policyVersion: boot.json?.link?.consentPolicyVersion || "v1",
      disclosureTextHash: createHash("sha256").update(boot.json?.link?.consentDisclosureText ?? "").digest("hex"),
      termsAcknowledged: true,
      identityDisclosed: true,
      ipHash: null,
      userAgent: null,
    },
  });
  check("consent recorded", consent.status === 200, consent.json);
  const bytes = png(40);
  const part = await call(null, "POST", `/v1/external-intake/${t}/sessions/${sid}/parts`, {
    partIndex: 0,
    mimeType: "image/png",
    originalFileName: "intake.png",
    checksumSha256Base64: sha256b64(bytes),
    webkitRelativePath: null,
  });
  check("intake part reserved", part.status === 201, part.json);
  const put = await call(null, "PUT", part.json?.upload?.putUrl, bytes, {
    raw: true,
    headers: { "content-type": "image/png", "x-amz-checksum-sha256": sha256b64(bytes) },
  });
  check("intake bytes stored", put.status < 300, put.status);
  const submit = await call(null, "POST", `/v1/external-intake/${t}/sessions/${sid}/submit`, {});
  check("intake submitted", submit.status < 300, submit.json);
  const evRow = sql(`select e.id, e.status, e.acquisition_mode, e.team_id from evidence e where e.id = (select evidence_id from workflow_intake_sessions where id='${sid}')`);
  obs.evidenceRow = evRow;
  const id = (evRow.rows?.[0] ?? "").split("|")[0];
  check(
    "evidence bound to the org workspace with mode SECURE_INTAKE_LINK",
    (evRow.rows?.[0] ?? "").includes(`SECURE_INTAKE_LINK|${ownerA.teamId}`),
    evRow,
  );
  if (!id) return;
  const st = await pollOutputs(ownerA, id);
  obs.outputs = st?.outputs;
  check("intake record: report available", st?.report?.available === true, st?.outputs?.report?.state);
  check("intake record: package available", st?.verificationPackage?.available === true, st?.outputs?.verificationPackage?.state);
  const share = await mintShare(ownerA, id, ownerA.teamId, "intake");
  const pub = await call(null, "GET", `/public/verify/${share.json?.token}`);
  check("intake record verifies publicly", pub.status === 200, pub.status);
  obs.publicAcquisition = pub.json?.acquisition?.acquisition ?? null;
  obs.publicOriginal = pub.json?.basicVerification?.original ?? null;
});

let contId = null;
await journey("J09-continuous-direct-capture-to-public-verify", "Android continuous direct capture (API-driven, real MinIO + worker) → seal → report → package → Public Verify", async (check, obs) => {
  const open = await call(ownerA, "POST", "/v1/capture/direct-sessions", {
    mode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
    teamId: ownerA.teamId,
    deviceId: null,
  });
  check("direct session opened", open.status === 201, open.json);
  const sessionId = open.json?.session?.captureSessionId;
  const res = await call(ownerA, "POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, { type: "VIDEO", mimeType: "video/mp4" });
  check("record reserved", res.status === 201, res.json);
  contId = res.json?.evidence?.evidenceId;
  const segs = [];
  const mp4 = readFileSync(process.env.UCA_SAMPLE_MP4);
  for (let i = 0; i < 2; i += 1) {
    const p = await call(ownerA, "POST", `/v1/evidence/${contId}/parts`, { partIndex: i, mimeType: "video/mp4", originalFileName: `seg-${i}.mp4` });
    const put = await call(null, "PUT", p.json?.upload?.putUrl, mp4, { raw: true, headers: { "content-type": "video/mp4" } });
    const d = createHash("sha256").update(mp4).digest("hex");
    const decl = await call(ownerA, "POST", `/v1/capture/direct-sessions/${sessionId}/parts/${i}/declaration`, {
      sha256: d,
      clientReportedSource: "SCREEN_SEGMENT",
      signed: null,
    });
    check(`segment ${i} stored + declared`, p.status === 201 && put.status < 300 && decl.status === 201, { p: p.status, put: put.status, decl: decl.status, body: decl.json });
    segs.push({
      role: "screen_segment",
      partIndex: i,
      sequence: i,
      expectedSha256: d,
      sizeBytes: mp4.length,
      mediaType: "video/mp4",
      startedAtOffsetMs: i * 1000,
      durationMs: 1000,
      widthPx: 1080,
      heightPx: 2400,
      orientation: "portrait",
    });
  }
  const manifest = {
    // Remediation rerun: the server now speaks continuity manifest V2 (UC-STR-002), which
    // adds the REQUIRED recordedSegmentCount (how many segments the recorder produced).
    // The audit run sent V1; the client app was moved to V2 in the same change.
    schemaVersion: "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V2",
    captureSessionId: sessionId,
    captureStartedAtUtc: new Date(Date.now() - 2500).toISOString(),
    captureEndedAtUtc: new Date(Date.now() - 500).toISOString(),
    device: { platform: "android", osVersion: "14", model: "Pixel 8", appVersion: "1.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" },
    osConsentGranted: true,
    totalDurationMs: 2000,
    recordedSegmentCount: segs.length,
    segments: segs,
    sessionCompleteness: "COMPLETE_SESSION",
    terminationReason: "USER_STOPPED",
    limitations: [],
    notes: [],
  };
  const mj = JSON.stringify(manifest);
  const mb = Buffer.from(mj, "utf8");
  const mp = await call(ownerA, "POST", `/v1/evidence/${contId}/parts`, { partIndex: 2, mimeType: "application/json", originalFileName: "manifest.json" });
  const mput = await call(null, "PUT", mp.json?.upload?.putUrl, mb, { raw: true, headers: { "content-type": "application/json" } });
  const mdecl = await call(ownerA, "POST", `/v1/capture/direct-sessions/${sessionId}/parts/2/declaration`, {
    sha256: createHash("sha256").update(mb).digest("hex"),
    clientReportedSource: "CONTINUOUS_MANIFEST",
    signed: null,
  });
  check("manifest stored + declared", mp.status === 201 && mput.status < 300 && mdecl.status === 201, { mp: mp.status, mput: mput.status, mdecl: mdecl.status });
  const seal = await call(ownerA, "POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, { manifestJson: mj });
  check("continuous capture sealed", seal.status === 200, seal.json);
  const st = await pollOutputs(ownerA, contId);
  obs.outputs = st?.outputs;
  check("continuous record: report available", st?.report?.available === true, st?.outputs?.report?.state);
  check("continuous record: package available", st?.verificationPackage?.available === true, st?.outputs?.verificationPackage?.state);
  const rep = await call(ownerA, "GET", `/v1/evidence/${contId}/report/latest`);
  obs.reportSnapshots = rep.json?.snapshots ?? null;
  check(
    "report sealed with the direct-capture acquisition mode",
    rep.json?.snapshots?.acquisitionMode === "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
    rep.json?.snapshots?.acquisitionMode,
  );
  const share = await mintShare(ownerA, contId, ownerA.teamId, "continuous");
  const pub = await call(null, "GET", `/public/verify/${share.json?.token}`);
  check("continuous record verifies publicly", pub.status === 200, pub.status);
  obs.publicAcquisition = pub.json?.acquisition ?? null;
  obs.auditActions = sql(`select action from admin_audit_logs t where row_to_json(t)::text like '%${contId}%' group by action order by 1`).rows;
  obs.custody = sql(`select event_type, count(*) from custody_events where evidence_id='${contId}' group by 1 order by 1`).rows;
  obs.reviewWorkflowRows = sql(`select count(*) from evidence_review_workflow_events where evidence_id='${contId}'`).rows;
});

await journey("J10-uc4-derived-review", "UC-4: Generate Derived Review on the continuous capture and observe the worker run", async (check, obs) => {
  if (!contId) throw new Error("no continuous record from J09");
  const gen = await call(ownerA, "POST", `/v1/evidence/${contId}/derived-review/generate`, { teamId: ownerA.teamId });
  obs.generate = { status: gen.status, body: gen.json };
  check("derived review generation accepted", gen.status === 202 || gen.status === 200, gen.status);
  let dr = null;
  for (let i = 0; i < 24; i += 1) {
    await sleep(5000);
    dr = await call(ownerA, "GET", `/v1/evidence/${contId}/derived-review?teamId=${ownerA.teamId}`);
    if (/COMPLETED|FAILED|DISMISSED|PARTIAL/.test(JSON.stringify(dr.json ?? {}))) break;
  }
  obs.derivedReview = dr?.json ?? null;
  const runs = sql(`select kind, status, attempt_count from media_intelligence_runs where evidence_id='${contId}'`);
  obs.runs = runs;
  obs.derivedAssets = sql(`select asset_kind, count(*) from evidence_part_derived_assets where evidence_id='${contId}' group by 1`);
  check("a reconstruct_screen run reached a terminal state", /COMPLETED|FAILED|DISMISSED/.test(JSON.stringify(runs.rows ?? [])), runs);
  const again = await call(ownerA, "POST", `/v1/evidence/${contId}/derived-review/generate`, { teamId: ownerA.teamId });
  obs.regenerate = { status: again.status, body: again.json };
  await sleep(10000);
  obs.runsAfterRegenerate = sql(`select kind, status, attempt_count from media_intelligence_runs where evidence_id='${contId}'`);
});

await journey("J11-destroy-and-free-slot", "FREE record: trash → governed destruction transitions → does the slot release?", async (check, obs) => {
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const u = await webUpload(free, free.teamId, png(60 + i));
    if (u.id && u.complete?.status < 300) ids.push(u.id);
  }
  check("three FREE records completed", ids.length === 3, ids.length);
  const victim = ids[0];
  const trash = await call(free, "DELETE", `/v1/evidence/${victim}`);
  obs.trash = trash.status;
  const transitions = [];
  for (const toState of ["PENDING_DESTRUCTION", "DESTROYED"]) {
    const r = await call(free, "POST", `/v1/governance/lifecycle/evidence/${victim}/transition`, {
      teamId: free.teamId,
      toState,
      summary: "UCA audit destruction probe",
    });
    transitions.push({ toState, status: r.status, body: r.json });
  }
  obs.transitions = transitions;
  const row = sql(`select status, deleted_at is not null, destroyed_at_utc is not null from evidence where id='${victim}'`);
  obs.victimRow = row;
  const fourth = await webUpload(free, free.teamId, png(70));
  obs.fourthAfterDestroyAttempt = { status: fourth.created.status, body: fourth.created.json };
  check("destruction attempt answered with a governed, non-5xx response", transitions.every((t) => t.status < 500), transitions.map((t) => t.status));
});

// ---------------------------------------------------------------- remediation rerun additions
// R13 and R14b were BLOCKED in the audit only because they had not been driven end to end;
// neither needs anything external, so the remediation rerun drives them on the same stack.

await journey("J12-failure-and-recovery", "Induced capture failures (finalize before bytes, bytes that do not match the declared digest) are refused with no false completion; the SAME record then recovers to Public Verify", async (check, obs) => {
  const bytes = png(80);
  const wrong = png(81);
  const created = await call(ownerA, "POST", "/v1/evidence", {
    type: "PHOTO", teamId: ownerA.teamId, mimeType: "image/png", originalFileName: "recover.png", captureFileName: "recover.png",
    deviceTimeIso: new Date().toISOString(), checksumSha256Base64: sha256b64(bytes), contentMd5Base64: md5b64(bytes),
  });
  check("record created", created.status < 300, created.status);
  const id = created.json?.id;
  const part = await call(ownerA, "POST", `/v1/evidence/${id}/parts`, {
    partIndex: 0, mimeType: "image/png", originalFileName: "recover.png", checksumSha256Base64: sha256b64(bytes), contentMd5Base64: md5b64(bytes),
  });
  check("part declared", part.status < 300, part.status);
  const statusOf = () => sql(`select status from evidence where id='${id}'`).rows?.[0] ?? "";

  const early = await call(ownerA, "POST", `/v1/evidence/${id}/complete`, {});
  obs.finalizeWithoutBytes = { status: early.status, body: early.json };
  check("failure 1: finalize before the bytes exist is refused (4xx, not 5xx)", early.status >= 400 && early.status < 500, early.status);
  obs.statusAfterFailure1 = statusOf();
  check("failure 1 leaves no false completion", !/SIGNED|REPORTED/.test(obs.statusAfterFailure1), obs.statusAfterFailure1);

  const badPut = await call(null, "PUT", part.json?.upload?.putUrl, wrong, {
    raw: true,
    headers: { "content-type": "image/png", "x-amz-checksum-sha256": sha256b64(bytes), "Content-MD5": md5b64(bytes) },
  });
  obs.wrongBytesPut = badPut.status;
  check("failure 2: storage refuses bytes that do not match the declared digest", badPut.status >= 400, badPut.status);
  const again = await call(ownerA, "POST", `/v1/evidence/${id}/complete`, {});
  obs.finalizeAfterWrongBytes = { status: again.status, body: again.json };
  check("failure 2: finalize is still refused", again.status >= 400 && again.status < 500, again.status);
  obs.statusAfterFailure2 = statusOf();
  check("failure 2 leaves no false completion", !/SIGNED|REPORTED/.test(obs.statusAfterFailure2), obs.statusAfterFailure2);

  const put = await call(null, "PUT", part.json?.upload?.putUrl, bytes, {
    raw: true,
    headers: { "content-type": "image/png", "x-amz-checksum-sha256": sha256b64(bytes), "Content-MD5": md5b64(bytes) },
  });
  check("recovery: the correct bytes are accepted", put.status < 300, put.status);
  const done = await call(ownerA, "POST", `/v1/evidence/${id}/complete`, {});
  obs.finalizeAfterRecovery = { status: done.status, body: done.json };
  check("recovery: the same record finalizes", done.status < 300, done.status);
  const st = await pollOutputs(ownerA, id);
  check("recovery: report and package produced by the worker", st?.report?.available === true && st?.verificationPackage?.available === true, st?.outputs);
  const fp = sql(`select file_sha256 from evidence where id='${id}'`).rows?.[0] ?? "";
  check("the sealed digest is the correct bytes' digest, never the refused ones", fp === createHash("sha256").update(bytes).digest("hex"), fp);
  const link = await mintShare(ownerA, id, ownerA.teamId, "recovery");
  const pub = await call(null, "GET", `/public/verify/${link.json?.token}`);
  check("recovery: Public Verify answers for the recovered record", pub.status === 200, pub.status);
  const rows = sql(`select count(*) from evidence where original_file_name='recover.png' and team_id='${ownerA.teamId}'`).rows?.[0];
  obs.recordsNamedRecover = rows;
});

await journey("J13-governed-permanent-destruction", "Enterprise record: retention passes → destruction review → step-up approve → execute → bytes gone from storage, one certificate, the share link stops verifying", async (check, obs) => {
  const u = await webUpload(ownerA, ownerA.teamId, png(90));
  check("record completed", u.complete?.status < 300, u.complete?.status);
  await pollOutputs(ownerA, u.id);
  const link = await mintShare(ownerA, u.id, ownerA.teamId, "destruction");
  const before = await call(null, "GET", `/public/verify/${link.json?.token}`);
  check("share link verifies before destruction", before.status === 200, before.status);
  const objects = (sql(`select storage_bucket, storage_key from evidence_parts where evidence_id='${u.id}'`).rows ?? []).map((r) => r.split("|"));
  obs.objects = objects.length;
  check("stored original present before destruction", objects.length > 0 && objects.every(([b, k]) => mc(`mc stat l/${b}/${k}`).status === 0), objects.length);
  // Governed destruction starts from an ACTIVE record (the lifecycle table has no
  // transition out of TRASHED): the review moves it to PENDING_DESTRUCTION and the
  // executed review to DESTROYED. Time passes for THIS record only, in the disposable
  // database: its application retention lies in the past. The bucket has no Object Lock.
  obs.aged = sql(`update evidence set retention_until_utc = now() - interval '1 day' where id='${u.id}' returning id`);
  const rv = await call(ownerA, "POST", "/v1/governance/destruction-reviews", { teamId: ownerA.teamId, evidenceId: u.id, reason: "manual_review" });
  obs.createReview = { status: rv.status, body: rv.json };
  check("destruction review created", rv.status === 201, rv.status);
  const rid = rv.json?.review?.id;
  const steps = [];
  for (const nextStatus of ["UNDER_REVIEW", "APPROVED", "EXECUTED"]) {
    const body = { teamId: ownerA.teamId, nextStatus, decisionNote: "UCA remediation journey" };
    let r = await call(ownerA, "POST", `/v1/governance/destruction-reviews/${rid}/transition`, body);
    if (r.status === 401 && r.json?.error?.code === "STEP_UP_REQUIRED") {
      const su = await stepUp(ownerA, ownerA.teamId, nextStatus === "APPROVED" ? "EVIDENCE_DESTRUCTION_APPROVE" : "EVIDENCE_DESTRUCTION_EXECUTE", "destruction_review", rid);
      r = su.error ? { status: 0, json: su } : await call(ownerA, "POST", `/v1/governance/destruction-reviews/${rid}/transition`, body, { headers: { "x-proovra-step-up-challenge-id": su.challengeId } });
    }
    steps.push({ nextStatus, status: r.status, body: r.json });
  }
  obs.transitions = steps;
  // The approval (step-up) is the human decision; execution is then done either by the
  // operator's own EXECUTE (step-up) or by the worker's destruction orchestrator, which
  // sweeps APPROVED reviews — whichever comes first. Both are the designed path; the
  // other one then meets an already-EXECUTED review.
  const [review, approve, execute] = steps;
  check("review and step-up approval accepted", review?.status === 200 && approve?.status === 200, steps.map((s) => `${s.nextStatus}:${s.status}`));
  const reviewRow = sql(`select status from destruction_reviews where id='${rid}'`).rows?.[0] ?? "";
  const executedBy =
    execute?.status === 200 ? "operator EXECUTE (step-up)"
      : execute?.status === 400 && execute?.body?.error?.details?.from === "EXECUTED" ? "destruction orchestrator (APPROVED sweep)"
        : null;
  obs.executedBy = executedBy;
  check("the approved review was executed exactly once (operator or orchestrator)", reviewRow === "EXECUTED" && executedBy !== null, { reviewRow, executedBy, execute: execute?.status });
  let row = "";
  for (let i = 0; i < 36; i += 1) {
    row = sql(`select lifecycle_state, destroyed_at_utc is not null from evidence where id='${u.id}'`).rows?.[0] ?? "";
    if (row.startsWith("DESTROYED|t")) break;
    await sleep(5000);
  }
  obs.row = row;
  check("record tombstoned DESTROYED with a destruction time", row.startsWith("DESTROYED|t"), row);
  const gone = objects.map(([b, k]) => mc(`mc stat l/${b}/${k}`));
  obs.storageAfter = gone.map((g) => g.out.slice(0, 200));
  check("the stored original is gone from storage (verified by reading the bucket)", objects.length > 0 && gone.every((g) => g.status !== 0), gone.map((g) => g.status));
  const cert = await call(ownerA, "GET", `/v1/governance/destruction-reviews/${rid}/certificate?teamId=${ownerA.teamId}`);
  check("a destruction certificate exists", cert.status === 200, cert.status);
  const after = await call(null, "GET", `/public/verify/${link.json?.token}`);
  obs.publicVerifyAfter = { status: after.status, body: after.json };
  check("the share link no longer verifies the destroyed record", after.status >= 400 || /destroy/i.test(JSON.stringify(after.json ?? {})), after.status);
});

writeFileSync(outPath, JSON.stringify({ api: API, generatedAt: new Date().toISOString(), journeys }, null, 2));
process.stdout.write(`wrote ${outPath}\n`);
