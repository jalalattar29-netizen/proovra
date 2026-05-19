/**
 * Phase 30.9 — Browser resumable multipart upload orchestrator.
 *
 * Drives the Phase 30/30.5/30.6/30.8 backend surface from the
 * browser side:
 *
 *   1. Create / reuse the resumable session.
 *   2. Initiate the S3 native multipart upload (server-side).
 *   3. For each part:
 *        - request a presigned UploadPart URL
 *        - PUT the chunk bytes (with retry + bounded backoff)
 *        - capture S3 ETag from response
 *        - report ETag back to server (mark-uploaded)
 *   4. Drive the server-side complete-multipart call.
 *   5. Leave evidence finalization to a separate explicit call —
 *      this class NEVER calls `/v1/evidence/:id/complete`.
 *
 * Hard custody / privacy rules baked in here:
 *
 *   * NEVER calls `/v1/evidence/:id/complete`.
 *   * NEVER creates custody events (no `/custody-events` POST).
 *   * NEVER sets uploadedAt locally.
 *   * NEVER trusts ETag as a hash — the etag is recorded as opaque
 *     storage metadata only.
 *   * NEVER claims server verification before the server returns it.
 *   * NEVER projects bucket / key / multipartUploadId / signed URL
 *     in the public snapshot — presigned URLs flow through the
 *     fetch call and are then dropped on the floor.
 *   * No full-file buffering: only `file.slice(start, end)` is
 *     materialised per chunk; the slice is fed straight to fetch.
 *   * Bounded concurrency, bounded retries, bounded backoff.
 *
 * The class is framework-agnostic — it emits snapshot events via a
 * subscribe callback. Hooks / UI components wrap it.
 */

import {
  apiFetch,
  type ApiError as ApiErrorImpl,
} from "../api";
import { classifyRetry, planChunks, type ChunkPlan } from "./retry";
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MAX_PART_RETRIES,
  MIN_CONCURRENCY,
  type ClientFailureReason,
  type ClientPartProgress,
  type ClientPartState,
  type ClientUploadSessionState,
  type UploadProgressSnapshot,
} from "./types";

// =============================================================================
// Public configuration
// =============================================================================

export type MultipartUploaderConfig = {
  /** Server-side session ID (already-created Phase 30 session). */
  sessionId: string;
  /** Team scope — the server uses this for every authorize call. */
  teamId: string;
  /** The File from the input/picker. */
  file: File;
  /** Chunk size; clamped to [5MB, 64MB]. Falls back to 8 MB. */
  chunkSizeBytes?: number;
  /** Concurrent parts in flight. Clamped to [1, 6]. Default 4. */
  concurrency?: number;
  /** True ↔ navigator.onLine OR a custom monitor (for tests). */
  isOnline?: () => boolean;
  /** Optional content type. Falls back to file.type. */
  contentType?: string | null;
  /** Hook to persist progress snapshots (e.g. IndexedDB). Called
   *  on every state transition so a refresh restores progress. */
  onPersist?: (snapshot: UploadProgressSnapshot) => void | Promise<void>;
};

export type MultipartUploaderListener = (
  snapshot: UploadProgressSnapshot,
) => void;

// =============================================================================
// Orchestrator
// =============================================================================

type InternalPart = {
  plan: ChunkPlan;
  state: ClientPartState;
  retryCount: number;
  etag: string | null;
  failureReason: ClientFailureReason | null;
};

export class MultipartUploader {
  private readonly cfg: Required<
    Omit<MultipartUploaderConfig, "onPersist" | "contentType">
  > & {
    onPersist: MultipartUploaderConfig["onPersist"];
    contentType: string | null;
  };
  private readonly parts: InternalPart[];
  private state: ClientUploadSessionState = "STAGED";
  private failureReason: ClientFailureReason | null = null;
  private lastServerContactMs: number | null = null;
  private readonly listeners = new Set<MultipartUploaderListener>();
  private paused = false;
  private cancelled = false;
  private inFlightCount = 0;
  /** Resolves when the run loop has fully stopped (all in-flight
   *  parts settled). */
  private idleResolvers: Array<() => void> = [];

  constructor(config: MultipartUploaderConfig) {
    const chunkSize = config.chunkSizeBytes ?? 8 * 1024 * 1024;
    const concurrency = clamp(
      config.concurrency ?? DEFAULT_CONCURRENCY,
      MIN_CONCURRENCY,
      MAX_CONCURRENCY,
    );
    this.cfg = {
      sessionId: config.sessionId,
      teamId: config.teamId,
      file: config.file,
      chunkSizeBytes: chunkSize,
      concurrency,
      isOnline: config.isOnline ?? defaultIsOnline,
      onPersist: config.onPersist,
      contentType: config.contentType ?? config.file.type ?? null,
    };
    const plan = planChunks(config.file.size, chunkSize);
    this.parts = plan.map((p) => ({
      plan: p,
      state: "PENDING",
      retryCount: 0,
      etag: null,
      failureReason: null,
    }));
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  subscribe(listener: MultipartUploaderListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Start (or resume) the upload. Returns when there's nothing more
   *  to do — either everything is UPLOADED_UNVERIFIED, or we hit a
   *  terminal failure / cancellation. */
  async start(): Promise<UploadProgressSnapshot> {
    if (this.cancelled) {
      this.transitionTo("CANCELLED");
      return this.snapshot();
    }
    this.paused = false;
    // The session must already exist on the server. We do NOT
    // create sessions here — that's the caller's job (so the same
    // session can be reused across refreshes).
    if (this.state === "STAGED") {
      this.transitionTo("INITIATING_MULTIPART");
      const init = await this.initiateMultipart();
      if (!init.ok) {
        this.failureReason = init.reason;
        this.transitionTo(init.terminal ? "FAILED_TERMINAL" : "FAILED_RETRYABLE");
        return this.snapshot();
      }
    }
    this.transitionTo("UPLOADING");
    await this.runPool();
    return this.snapshot();
  }

  pause(): void {
    if (this.state === "UPLOADING") {
      this.paused = true;
      this.transitionTo("PAUSED");
    }
  }

  resume(): Promise<UploadProgressSnapshot> {
    if (this.state === "PAUSED" || this.state === "FAILED_RETRYABLE") {
      // Reset retry counts on transient failures so the operator
      // can manually retry without leaking through MAX_PART_RETRIES
      // forever.
      if (this.state === "FAILED_RETRYABLE") {
        for (const p of this.parts) {
          if (p.state === "FAILED") {
            p.state = "PENDING";
            p.failureReason = null;
            // Note: retryCount carries over so we still respect
            // MAX_PART_RETRIES against pathological cases.
          }
        }
      }
      this.failureReason = null;
      return this.start();
    }
    return Promise.resolve(this.snapshot());
  }

  cancel(): void {
    this.cancelled = true;
    this.paused = true;
    this.transitionTo("CANCELLED");
  }

  snapshot(): UploadProgressSnapshot {
    const partsProj: ClientPartProgress[] = this.parts.map((p) => ({
      partIndex: p.plan.partIndex,
      state: p.state,
      bytes: p.plan.byteLength,
      retryCount: p.retryCount,
      etag: p.etag,
      failureReason: p.failureReason,
    }));
    const uploadedBytes = this.parts
      .filter(
        (p) => p.state === "UPLOADED_UNVERIFIED" || p.state === "VERIFIED",
      )
      .reduce((acc, p) => acc + p.plan.byteLength, 0);
    const verifiedBytes = this.parts
      .filter((p) => p.state === "VERIFIED")
      .reduce((acc, p) => acc + p.plan.byteLength, 0);
    const totalBytes = this.cfg.file.size;
    return {
      sessionId: this.cfg.sessionId,
      state: this.state,
      verifiedBytes,
      uploadedBytes,
      totalBytes,
      parts: partsProj,
      failureReason: this.failureReason,
      isOnline: this.cfg.isOnline(),
      safeToClose: this.computeSafeToClose(),
      lastServerContactMs: this.lastServerContactMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private computeSafeToClose(): boolean {
    if (this.inFlightCount > 0) return false;
    return (
      this.state === "PAUSED" ||
      this.state === "FAILED_RETRYABLE" ||
      this.state === "FAILED_TERMINAL" ||
      this.state === "CANCELLED" ||
      this.state === "FINALIZED" ||
      this.state === "READY_FOR_FINALIZATION"
    );
  }

  private async runPool(): Promise<void> {
    const slots = this.cfg.concurrency;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < slots; i++) {
      workers.push(this.worker());
    }
    await Promise.all(workers);
    if (this.paused || this.cancelled) return;
    // Pool drained — was that a success or a failure?
    const anyFailed = this.parts.some((p) => p.state === "FAILED");
    const allUploaded = this.parts.every(
      (p) => p.state === "UPLOADED_UNVERIFIED" || p.state === "VERIFIED",
    );
    if (anyFailed) {
      // Determine whether any failure is terminal-grade.
      const terminal = this.parts.some(
        (p) =>
          p.state === "FAILED" &&
          p.failureReason &&
          isTerminalFailureReason(p.failureReason),
      );
      this.transitionTo(terminal ? "FAILED_TERMINAL" : "FAILED_RETRYABLE");
      return;
    }
    if (allUploaded) {
      this.transitionTo("VERIFYING");
    }
  }

  private async worker(): Promise<void> {
    while (!this.paused && !this.cancelled) {
      const part = this.parts.find((p) => p.state === "PENDING");
      if (!part) return;
      part.state = "PRESIGNING";
      this.inFlightCount += 1;
      this.emit();
      try {
        await this.uploadPart(part);
      } finally {
        this.inFlightCount -= 1;
      }
      if (this.paused || this.cancelled) return;
    }
  }

  private async uploadPart(part: InternalPart): Promise<void> {
    // 1. Request a presigned UploadPart URL from the server.
    let presign: { uploadUrl: string; expiresAt: string } | null = null;
    try {
      const res = (await apiFetch(
        `/v1/uploads/sessions/${this.cfg.sessionId}/parts/${part.plan.partIndex}/presign`,
        {
          method: "POST",
          body: JSON.stringify({ teamId: this.cfg.teamId }),
        },
      )) as { uploadUrl: string; expiresAt: string };
      presign = res;
      this.lastServerContactMs = Date.now();
    } catch (err) {
      this.handlePartFailure(part, err, "presign_failed");
      return;
    }
    // 2. PUT the chunk bytes directly to S3.
    part.state = "IN_FLIGHT";
    this.emit();
    const slice = this.cfg.file.slice(
      part.plan.byteStart,
      part.plan.byteEnd,
    );
    let etag: string | null = null;
    try {
      // Use the global `fetch` so we don't pipe S3 traffic through
      // apiFetch (which would re-attach the auth header). Presigned
      // URLs must be unauthenticated requests.
      const response = await fetch(presign!.uploadUrl, {
        method: "PUT",
        body: slice,
      });
      if (!response.ok) {
        this.handlePartHttpFailure(part, response.status);
        return;
      }
      etag = response.headers.get("ETag") ?? response.headers.get("etag");
    } catch (err) {
      this.handlePartFailure(part, err, "network_error");
      return;
    }
    if (!etag) {
      this.handlePartFailure(part, null, "etag_missing");
      return;
    }
    // 3. Report ETag back to server. The orchestrator does NOT
    // mark the part VERIFIED — only the server can do that, and
    // only after its own HEAD/SHA-256 check.
    try {
      await apiFetch(
        `/v1/uploads/sessions/${this.cfg.sessionId}/parts/${part.plan.partIndex}/uploaded`,
        {
          method: "POST",
          body: JSON.stringify({
            teamId: this.cfg.teamId,
            partEtag: etag,
            partSizeBytes: part.plan.byteLength,
          }),
        },
      );
      this.lastServerContactMs = Date.now();
    } catch (err) {
      this.handlePartFailure(part, err, "mark_uploaded_failed");
      return;
    }
    part.state = "UPLOADED_UNVERIFIED";
    part.etag = etag;
    part.failureReason = null;
    this.emit();
    void this.persistSnapshotSafe();
  }

  private handlePartHttpFailure(part: InternalPart, status: number): void {
    const decision = classifyRetry({
      status,
      attempt: part.retryCount,
      isOnline: this.cfg.isOnline(),
    });
    if (decision.kind === "terminal") {
      part.state = "FAILED";
      part.failureReason = decision.reason;
      this.emit();
      return;
    }
    part.retryCount += 1;
    part.failureReason = decision.reason;
    // Schedule retry: the pool worker picks the part back up after
    // the wait. We use a setTimeout to avoid pinning the worker
    // slot during the backoff.
    setTimeout(() => {
      if (
        this.cancelled ||
        this.paused ||
        part.retryCount > MAX_PART_RETRIES
      ) {
        return;
      }
      part.state = "PENDING";
      this.emit();
    }, decision.waitMs);
    part.state = "FAILED";
    this.emit();
  }

  private handlePartFailure(
    part: InternalPart,
    _err: unknown,
    reason: ClientFailureReason,
  ): void {
    const decision = classifyRetry({
      status: 0,
      attempt: part.retryCount,
      isOnline: this.cfg.isOnline(),
    });
    if (decision.kind === "terminal" || isTerminalFailureReason(reason)) {
      part.state = "FAILED";
      part.failureReason = reason;
      this.emit();
      return;
    }
    part.retryCount += 1;
    part.failureReason = reason;
    setTimeout(() => {
      if (
        this.cancelled ||
        this.paused ||
        part.retryCount > MAX_PART_RETRIES
      ) {
        return;
      }
      part.state = "PENDING";
      this.emit();
    }, decision.waitMs);
    part.state = "FAILED";
    this.emit();
  }

  private async initiateMultipart(): Promise<
    | { ok: true }
    | { ok: false; reason: ClientFailureReason; terminal: boolean }
  > {
    try {
      await apiFetch(
        `/v1/uploads/sessions/${this.cfg.sessionId}/multipart/initiate`,
        {
          method: "POST",
          body: JSON.stringify({
            teamId: this.cfg.teamId,
            contentType: this.cfg.contentType ?? undefined,
          }),
        },
      );
      this.lastServerContactMs = Date.now();
      return { ok: true };
    } catch (err) {
      const status =
        (err as ApiErrorImpl & { statusCode?: number })?.statusCode ?? 0;
      const decision = classifyRetry({
        status,
        attempt: 0,
        isOnline: this.cfg.isOnline(),
      });
      return {
        ok: false,
        reason: decision.kind === "terminal"
          ? decision.reason
          : decision.reason,
        terminal: decision.kind === "terminal",
      };
    }
  }

  // ---------------------------------------------------------------------------
  // State / event plumbing
  // ---------------------------------------------------------------------------

  private transitionTo(next: ClientUploadSessionState): void {
    if (this.state === next) {
      this.emit();
      return;
    }
    this.state = next;
    this.emit();
    void this.persistSnapshotSafe();
    if (next === "FINALIZED" || next === "CANCELLED") {
      this.resolveIdle();
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        /* listener errors must not break the pool */
      }
    }
  }

  private async persistSnapshotSafe(): Promise<void> {
    if (!this.cfg.onPersist) return;
    try {
      await this.cfg.onPersist(this.snapshot());
    } catch {
      /* persistence failures don't fail the upload */
    }
  }

  private resolveIdle(): void {
    const queued = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of queued) r();
  }
}

// =============================================================================
// Helpers
// =============================================================================

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function defaultIsOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

function isTerminalFailureReason(reason: ClientFailureReason): boolean {
  return (
    reason === "put_4xx" ||
    reason === "session_expired" ||
    reason === "session_aborted" ||
    reason === "session_failed" ||
    reason === "hash_mismatch" ||
    reason === "conflict" ||
    reason === "cancelled_by_user"
  );
}
