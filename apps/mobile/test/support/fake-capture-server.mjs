/**
 * An in-memory direct-capture SERVER for client orchestration tests
 * (AUD-004 / AUD-005), installed as globalThis.fetch + the storage PUT hook.
 *
 * It enforces the real server's semantics where the client depends on them
 * (services/api/src/services/capture-trust/direct-capture-ingest.service.ts,
 * services/api/src/routes/evidence.routes.ts):
 *
 *   - a part declaration with the SAME index and digest returns the existing
 *     declaration and writes NO custody event (`created: false`); a different
 *     digest at a declared index is 409 PART_ALREADY_DECLARED;
 *   - a part presign for an existing index returns that part;
 *   - a session reserves ONE evidence (a second reserve is 409);
 *   - an expired / reaped / discarded session answers 409 SESSION_EXPIRED /
 *     SESSION_NOT_ACTIVE to every write.
 *
 * Failures are injected per path: `failNext(regex, kind, times)` where kind is
 * "network" (fetch rejects, no response), "hang" (never answers), or an HTTP
 * status with a code.
 */

export function installFakeCaptureServer() {
  const state = {
    sessions: new Map(),
    seq: 0,
    /** Every custody-relevant event the server wrote, in order. */
    custody: [],
    /** Bytes at storage: `${evidenceId}/${partIndex}` -> contents. */
    storage: new Map(),
    requests: [],
    faults: [],
  };

  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refuse = (status, code) => json(status, { error: { code, message: code } });

  function takeFault(path, method) {
    const i = state.faults.findIndex((f) => f.times > 0 && f.re.test(`${method} ${path}`));
    if (i < 0) return null;
    state.faults[i].times -= 1;
    return state.faults[i];
  }

  function writable(s) {
    if (!s) return refuse(404, "SESSION_NOT_FOUND");
    if (s.status === "EXPIRED") return refuse(409, "SESSION_EXPIRED");
    if (s.status !== "ACTIVE") return refuse(409, "SESSION_NOT_ACTIVE");
    return null;
  }

  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ method, path, body });
    const fault = takeFault(path, method);
    if (fault?.kind === "network") throw new TypeError("Network request failed");
    if (fault?.kind === "hang") return new Promise(() => {});
    if (fault && typeof fault.kind === "object") return refuse(fault.kind.status, fault.kind.code);

    if (method === "POST" && path === "/v1/capture/direct-sessions") {
      state.seq += 1;
      const id = `cs-${state.seq}`;
      state.sessions.set(id, { id, status: "ACTIVE", evidenceId: null, declarations: new Map(), mode: body?.mode });
      state.custody.push({ type: "SESSION_OPENED", sessionId: id });
      return json(200, { session: { captureSessionId: id, expiresAtUtc: "2099-01-01T00:00:00.000Z" } });
    }
    let m = path.match(/^\/v1\/capture\/direct-sessions\/([^/]+)\/evidence$/);
    if (m && method === "POST") {
      const s = state.sessions.get(m[1]);
      const bad = writable(s);
      if (bad) return bad;
      if (s.evidenceId) return refuse(409, "SESSION_ALREADY_RESERVED");
      s.evidenceId = `ev-${m[1]}`;
      state.custody.push({ type: "EVIDENCE_RESERVED", sessionId: s.id });
      return json(200, { evidence: { evidenceId: s.evidenceId } });
    }
    m = path.match(/^\/v1\/capture\/direct-sessions\/([^/]+)\/parts\/(\d+)\/declaration$/);
    if (m && method === "POST") {
      const s = state.sessions.get(m[1]);
      const bad = writable(s);
      if (bad) return bad;
      const idx = Number(m[2]);
      const existing = s.declarations.get(idx);
      if (existing && existing !== body.sha256) return refuse(409, "PART_ALREADY_DECLARED");
      if (!existing) {
        s.declarations.set(idx, body.sha256);
        state.custody.push({ type: "CAPTURE_ARTIFACT_RECEIVED", sessionId: s.id, partIndex: idx, sha256: body.sha256 });
      }
      return json(200, {
        declaration: { partIndex: idx, sha256: body.sha256 },
        created: !existing,
        session: { expiresAtUtc: "2099-01-01T00:00:00.000Z" },
      });
    }
    m = path.match(/^\/v1\/evidence\/([^/]+)\/parts$/);
    if (m && method === "POST") {
      const s = [...state.sessions.values()].find((x) => x.evidenceId === m[1]);
      const bad = writable(s);
      if (bad) return bad;
      return json(200, { upload: { putUrl: `https://storage.test/${m[1]}/${body.partIndex}` } });
    }
    m = path.match(/^\/v1\/capture\/direct-sessions\/([^/]+)\/discard$/);
    if (m && method === "POST") {
      const s = state.sessions.get(m[1]);
      if (s && s.status === "ACTIVE") {
        s.status = "DISCARDED";
        state.custody.push({ type: "SESSION_DISCARDED", sessionId: s.id });
      }
      return json(200, { result: { discarded: true, releasedEvidenceId: s?.evidenceId ?? null } });
    }
    if (method === "POST" && path === "/v1/capture/sessions") {
      return json(200, { session: { id: `draft-${state.seq}`, status: "DRAFT" } });
    }
    return refuse(404, "NOT_FOUND");
  };

  // The storage PUT (expo-file-system uploadAsync in the expo stub).
  globalThis.__UPLOAD_ASYNC__ = async (putUrl, fileUri) => {
    state.requests.push({ method: "PUT", path: putUrl });
    const fault = takeFault(putUrl, "PUT");
    if (fault?.kind === "network") throw new TypeError("Network request failed");
    if (fault?.kind === "hang") return new Promise(() => {});
    if (fault && typeof fault.kind === "object") return { status: fault.kind.status };
    const fs = globalThis.__FS__;
    const key = putUrl.replace("https://storage.test/", "");
    state.storage.set(key, fs instanceof Map ? fs.get(fileUri) : "");
    return { status: 200 };
  };

  return {
    state,
    failNext(re, kind, times = 1) {
      state.faults.push({ re, kind, times });
    },
    /** The server-side reaper: the session expires and its reservation is released. */
    reap(sessionId) {
      const s = state.sessions.get(sessionId);
      if (s) s.status = "EXPIRED";
    },
    declarations(sessionId) {
      return state.custody.filter((e) => e.type === "CAPTURE_ARTIFACT_RECEIVED" && e.sessionId === sessionId);
    },
    opens() {
      return state.custody.filter((e) => e.type === "SESSION_OPENED");
    },
    reservations() {
      return state.custody.filter((e) => e.type === "EVIDENCE_RESERVED");
    },
  };
}
