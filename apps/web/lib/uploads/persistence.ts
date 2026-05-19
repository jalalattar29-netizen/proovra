/**
 * Phase 30.9 — IndexedDB persistence for resumable uploads.
 *
 * Browser-only. Wraps IndexedDB with a typed, bounded schema so the
 * orchestrator can survive refresh / tab restart / device sleep.
 *
 * Schema:
 *   DB name:   "proovra-uploads"
 *   Version:   1
 *   Stores:
 *     "sessions" — key: sessionId (string)
 *                  value: PersistedUploadSession
 *
 * Hard rules:
 *   * NEVER persists raw file bytes — only the File reference + a
 *     fingerprint hash (name/size/lastModified). On reload the user
 *     re-picks the file and we re-bind by fingerprint. Browser
 *     security forbids re-opening File without user gesture.
 *   * NEVER persists storage keys / signed URLs / multipartUploadId.
 *     The persisted row holds session id + part progress + retry
 *     state only.
 *   * NEVER persists raw GPS or private notes.
 *   * Custody-safe: no `uploadedAt` is ever written here as the
 *     authoritative claim. Local progress timestamps are advisory.
 *
 * Test note: a non-browser environment (Node) gets a NO-OP impl so
 * the orchestrator can be exercised in unit tests without IndexedDB.
 */

import type {
  ClientUploadSessionState,
  UploadProgressSnapshot,
} from "./types";

// =============================================================================
// Schema
// =============================================================================

const DB_NAME = "proovra-uploads";
const DB_VERSION = 1;
const STORE_SESSIONS = "sessions";

/** What we persist per upload session. Intentionally narrow — no
 *  bytes, no URLs, no S3-internal identifiers. */
export type PersistedUploadSession = {
  sessionId: string;
  /** Server-side evidence id this session is bound to. */
  evidenceId: string;
  /** Server-side team id. */
  teamId: string;
  /** File fingerprint: name + size + lastModified. Used to verify
   *  the user re-picked the same file after refresh. */
  fileFingerprint: {
    name: string;
    sizeBytes: number;
    lastModifiedMs: number;
  };
  state: ClientUploadSessionState;
  /** Per-part state (no etag — that's storage metadata we don't
   *  need on the client after upload). retryCount is preserved so
   *  we don't reset back to 0 on refresh. */
  parts: ReadonlyArray<{
    partIndex: number;
    state:
      | "PENDING"
      | "QUEUED"
      | "PRESIGNING"
      | "IN_FLIGHT"
      | "UPLOADED_UNVERIFIED"
      | "VERIFIED"
      | "FAILED"
      | "PAUSED";
    retryCount: number;
    bytes: number;
  }>;
  /** Client-side observed timestamps. Advisory only — server clocks
   *  remain authoritative. */
  createdAtMsClient: number;
  updatedAtMsClient: number;
};

// =============================================================================
// Public API — async, bounded, no throwing
// =============================================================================

export type UploadPersistence = {
  put(session: PersistedUploadSession): Promise<void>;
  get(sessionId: string): Promise<PersistedUploadSession | null>;
  list(): Promise<ReadonlyArray<PersistedUploadSession>>;
  remove(sessionId: string): Promise<void>;
  /** Project a runtime snapshot down to the persisted shape. Pure
   *  — exposed so callers can persist outside the orchestrator. */
  project(
    snapshot: UploadProgressSnapshot,
    bindings: {
      evidenceId: string;
      teamId: string;
      fileFingerprint: PersistedUploadSession["fileFingerprint"];
      createdAtMsClient: number;
    },
  ): PersistedUploadSession;
};

/**
 * Returns a working persistence layer. In the browser, this opens
 * IndexedDB and returns a typed wrapper. In Node / SSR, returns a
 * NO-OP implementation so the orchestrator can be loaded without
 * crashing.
 */
export function createUploadPersistence(): UploadPersistence {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return createNoopPersistence();
  }
  return createIndexedDbPersistence();
}

// =============================================================================
// Browser implementation
// =============================================================================

function createIndexedDbPersistence(): UploadPersistence {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: "sessionId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> {
    const db = await openDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_SESSIONS, mode);
      const store = tx.objectStore(STORE_SESSIONS);
      let result: T | undefined;
      Promise.resolve(fn(store))
        .then((r) => {
          result = r;
        })
        .catch((err) => reject(err));
      tx.oncomplete = () => resolve(result as T);
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    async put(session) {
      await withStore("readwrite", (store) => {
        return new Promise<void>((resolve, reject) => {
          const req = store.put(session);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      });
    },
    async get(sessionId) {
      return withStore("readonly", (store) => {
        return new Promise<PersistedUploadSession | null>((resolve, reject) => {
          const req = store.get(sessionId);
          req.onsuccess = () => resolve((req.result as PersistedUploadSession) ?? null);
          req.onerror = () => reject(req.error);
        });
      });
    },
    async list() {
      return withStore("readonly", (store) => {
        return new Promise<ReadonlyArray<PersistedUploadSession>>(
          (resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () =>
              resolve((req.result as PersistedUploadSession[]) ?? []);
            req.onerror = () => reject(req.error);
          },
        );
      });
    },
    async remove(sessionId) {
      await withStore("readwrite", (store) => {
        return new Promise<void>((resolve, reject) => {
          const req = store.delete(sessionId);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      });
    },
    project: projectSnapshot,
  };
}

// =============================================================================
// No-op (SSR / tests)
// =============================================================================

function createNoopPersistence(): UploadPersistence {
  const memory = new Map<string, PersistedUploadSession>();
  return {
    async put(session) {
      memory.set(session.sessionId, session);
    },
    async get(id) {
      return memory.get(id) ?? null;
    },
    async list() {
      return Array.from(memory.values());
    },
    async remove(id) {
      memory.delete(id);
    },
    project: projectSnapshot,
  };
}

// =============================================================================
// Pure projector
// =============================================================================

function projectSnapshot(
  snapshot: UploadProgressSnapshot,
  bindings: {
    evidenceId: string;
    teamId: string;
    fileFingerprint: PersistedUploadSession["fileFingerprint"];
    createdAtMsClient: number;
  },
): PersistedUploadSession {
  return {
    sessionId: snapshot.sessionId,
    evidenceId: bindings.evidenceId,
    teamId: bindings.teamId,
    fileFingerprint: bindings.fileFingerprint,
    state: snapshot.state,
    // Intentionally drop `etag` — storage metadata, not needed for
    // resume. Server has the ETag; on resume we just continue from
    // wherever the server says.
    parts: snapshot.parts.map((p) => ({
      partIndex: p.partIndex,
      state: stripClientOnlyPartState(p.state),
      retryCount: p.retryCount,
      bytes: p.bytes,
    })),
    createdAtMsClient: bindings.createdAtMsClient,
    updatedAtMsClient: Date.now(),
  };
}

function stripClientOnlyPartState(
  s: UploadProgressSnapshot["parts"][number]["state"],
): PersistedUploadSession["parts"][number]["state"] {
  // The persisted vocabulary excludes mid-flight states because a
  // refresh always restarts those (you can't resume an in-flight
  // PUT). Collapse them to PENDING so resume re-uploads cleanly.
  if (s === "PRESIGNING" || s === "IN_FLIGHT" || s === "QUEUED") {
    return "PENDING";
  }
  return s;
}
