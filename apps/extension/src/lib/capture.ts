/**
 * Capture orchestration (chrome side). Runs in the background service worker
 * after the user's explicit action. Produces the direct-acquisition artifacts:
 * a viewport screenshot (VIEWPORT) or ordered page tiles (FULL_PAGE), plus a
 * sanitized DOM snapshot. Every artifact is a Blob with its own SHA-256; the
 * server recomputes the digests and is authoritative.
 *
 * UC-EXT-003 — every `captureVisibleTab` call goes through ONE paced scheduler
 * (>= 550 ms apart, under Chrome's 2-calls-per-second quota) and a quota
 * rejection is retried with bounded backoff instead of aborting the capture. A
 * tile that still fails ends the loop as CAPTURE_INTERRUPTED with the tiles
 * already taken, so the record is PARTIAL rather than discarded.
 *
 * UC-EXT-004 — the limitations are detected, not assumed: a missing DOM
 * snapshot, dynamic mutations observed while capturing, protected (EME) media
 * and cross-origin frames are all recorded.
 */
import { CAPTURE_LIMITS } from "./config.js";
import { planFullPageTiles } from "./capture-plan.js";
import { sha256Hex } from "./sha256.js";
import { createCaptureScheduler, withQuotaRetry, type CaptureScheduler } from "./capture-scheduler.js";
import { describeSanitization, type SanitizeCounts } from "./sanitizer.js";
import type { WebCaptureLimitationCode } from "@proovra/shared";

export type CapturedArtifact = {
  role: "viewport_screenshot" | "page_tile" | "dom_snapshot";
  blob: Blob;
  mediaType: string;
  sha256: string;
  tileIndex?: number;
  scrollOffsetY?: number;
};

export type CaptureResult = {
  artifacts: CapturedArtifact[];
  pageInfo: { url: string; title: string | null; viewportW: number; viewportH: number; devicePixelRatio: number };
  pageMutatedDuringCapture: boolean;
  limitations: WebCaptureLimitationCode[];
  /** True when the sanitized DOM snapshot could not be produced. */
  domSnapshotMissing: boolean;
  /** Technical notes for the manifest (sanitizer disclosure, tile truncation). */
  notes: string[];
};

/** Thrown when the user cancels; the orchestrator discards any opened session. */
export class CaptureCancelledError extends Error {
  constructor() {
    super("capture cancelled");
    this.name = "CaptureCancelledError";
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CaptureCancelledError();
}

// ONE scheduler for the whole service worker: two captures (in different
// windows) still share Chrome's per-extension quota.
const scheduler: CaptureScheduler = createCaptureScheduler({
  minIntervalMs: CAPTURE_LIMITS.minCaptureIntervalMs,
});

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function ask<T>(tabId: number, message: unknown): Promise<T> {
  return (await chrome.tabs.sendMessage(tabId, message)) as T;
}

async function captureVisible(windowId: number): Promise<Blob> {
  const dataUrl = await withQuotaRetry(
    () => scheduler.schedule(() => chrome.tabs.captureVisibleTab(windowId, { format: "png" })),
    { retries: CAPTURE_LIMITS.quotaRetries },
  );
  return dataUrlToBlob(dataUrl);
}

async function artifactFrom(
  blob: Blob,
  role: CapturedArtifact["role"],
  extra: Partial<CapturedArtifact> = {},
): Promise<CapturedArtifact> {
  const sha256 = await sha256Hex(await blob.arrayBuffer());
  return { role, blob, mediaType: blob.type || "application/octet-stream", sha256, ...extra };
}

type DomReply = {
  ok: boolean;
  html?: string;
  counts?: SanitizeCounts;
  crossOriginFrames?: number;
  shadowRoots?: number;
  protectedMedia?: number;
  mutationsObserved?: number;
};

function pushOnce(limitations: WebCaptureLimitationCode[], code: WebCaptureLimitationCode): void {
  if (!limitations.includes(code)) limitations.push(code);
}

async function domArtifact(
  tabId: number,
  limitations: WebCaptureLimitationCode[],
  notes: string[],
): Promise<CapturedArtifact | null> {
  let dom: DomReply;
  try {
    dom = await ask<DomReply>(tabId, { kind: "GET_SANITIZED_DOM" });
  } catch {
    return null;
  }
  // Facts about the LIVE page are recorded even when serialisation failed.
  if ((dom?.crossOriginFrames ?? 0) > 0) pushOnce(limitations, "CROSS_ORIGIN_IFRAME_NOT_CAPTURED");
  // cloneNode omits shadow trees, so an open shadow root means the DOM snapshot
  // is not complete.
  if ((dom?.shadowRoots ?? 0) > 0) pushOnce(limitations, "SHADOW_DOM_NOT_FULLY_REPRESENTED");
  // Encrypted (EME) media renders black or not at all in a screenshot.
  if ((dom?.protectedMedia ?? 0) > 0) pushOnce(limitations, "PROTECTED_MEDIA_NOT_CAPTURED");
  // The page changed its DOM while we were capturing it.
  if ((dom?.mutationsObserved ?? 0) > 0) pushOnce(limitations, "DYNAMIC_CONTENT_MAY_BE_INCOMPLETE");
  if (!dom?.ok || !dom.html) return null;
  if (dom.counts) notes.push(...describeSanitization(dom.counts));
  const blob = new Blob([dom.html], { type: "text/html" });
  return artifactFrom(blob, "dom_snapshot");
}

type PageInfo = {
  url: string;
  title: string | null;
  scrollHeight: number;
  viewportW: number;
  viewportH: number;
  devicePixelRatio: number;
  scrollY: number;
};

export async function captureViewport(tabId: number, windowId: number, signal?: AbortSignal): Promise<CaptureResult> {
  const limitations: WebCaptureLimitationCode[] = [];
  const notes: string[] = [];
  const info = await ask<PageInfo>(tabId, { kind: "GET_PAGE_INFO" });
  throwIfCancelled(signal);
  const shot = await artifactFrom(await captureVisible(windowId), "viewport_screenshot");
  throwIfCancelled(signal);
  const artifacts: CapturedArtifact[] = [shot];
  const dom = await domArtifact(tabId, limitations, notes);
  if (dom) artifacts.push(dom);
  return {
    artifacts,
    pageInfo: info,
    pageMutatedDuringCapture: false,
    limitations,
    domSnapshotMissing: dom === null,
    notes,
  };
}

export async function captureFullPage(tabId: number, windowId: number, signal?: AbortSignal): Promise<CaptureResult> {
  const limitations: WebCaptureLimitationCode[] = [];
  const notes: string[] = [];
  const info = await ask<PageInfo>(tabId, { kind: "GET_PAGE_INFO" });

  const plan = planFullPageTiles({
    pageHeightPx: info.scrollHeight,
    viewportHeightPx: info.viewportH,
    maxTiles: CAPTURE_LIMITS.maxTiles,
    maxPageHeightPx: CAPTURE_LIMITS.maxPageHeightPx,
  });
  if (plan.truncated) {
    pushOnce(limitations, "PAGE_EXCEEDED_CAPTURE_BOUNDS");
    notes.push(
      `Full-page capture bounded to ${plan.offsets.length} tile(s) (limit ${CAPTURE_LIMITS.maxTiles} tiles / ${CAPTURE_LIMITS.maxPageHeightPx}px); the page is ${info.scrollHeight}px tall, so its lower part is not in this record.`,
    );
  }

  const artifacts: CapturedArtifact[] = [];
  let mutated = false;
  const startedAt = Date.now();
  try {
    for (let i = 0; i < plan.offsets.length; i += 1) {
      throwIfCancelled(signal);
      if (Date.now() - startedAt > CAPTURE_LIMITS.captureTimeBudgetMs) {
        pushOnce(limitations, "CAPTURE_INTERRUPTED");
        notes.push(
          `Full-page capture stopped at the ${CAPTURE_LIMITS.captureTimeBudgetMs / 1000}s time budget after ${artifacts.length} of ${plan.offsets.length} planned tile(s).`,
        );
        break;
      }
      const scroll = await ask<{ ok: boolean; actualY: number; heightChanged: boolean }>(tabId, {
        kind: "SCROLL_TO",
        y: plan.offsets[i],
      });
      if (scroll.heightChanged) mutated = true;
      await new Promise((r) => setTimeout(r, CAPTURE_LIMITS.tileSettleMs));
      let blob: Blob;
      try {
        blob = await captureVisible(windowId);
      } catch (err) {
        // The quota retries are exhausted (or the tab became uncapturable). With
        // tiles already taken the capture ends PARTIAL; with none it failed.
        if (artifacts.length === 0) throw err;
        pushOnce(limitations, "CAPTURE_INTERRUPTED");
        notes.push(
          `Full-page capture stopped after ${artifacts.length} of ${plan.offsets.length} planned tile(s): the browser refused a further screenshot.`,
        );
        break;
      }
      artifacts.push(
        await artifactFrom(blob, "page_tile", { tileIndex: i, scrollOffsetY: scroll.actualY }),
      );
    }
  } finally {
    // Restore the user's original scroll position, whatever happened.
    await ask(tabId, { kind: "RESTORE_SCROLL", y: info.scrollY }).catch(() => undefined);
  }
  throwIfCancelled(signal);

  if (mutated) pushOnce(limitations, "PAGE_MUTATED_DURING_CAPTURE");
  const dom = await domArtifact(tabId, limitations, notes);
  if (dom) artifacts.push(dom);

  return {
    artifacts,
    pageInfo: info,
    pageMutatedDuringCapture: mutated,
    limitations,
    domSnapshotMissing: dom === null,
    notes,
  };
}
