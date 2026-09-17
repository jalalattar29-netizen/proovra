/**
 * Capture orchestration (chrome side). Runs in the background service worker
 * after the user's explicit action. Produces the direct-acquisition artifacts:
 * a viewport screenshot (VIEWPORT) or ordered page tiles (FULL_PAGE), plus a
 * sanitized DOM snapshot. Every artifact is a Blob with its own SHA-256; the
 * server recomputes the digests and is authoritative.
 */
import { CAPTURE_LIMITS } from "./config.js";
import { planFullPageTiles } from "./capture-plan.js";
import { sha256Hex } from "./sha256.js";
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
};

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
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
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

async function domArtifact(tabId: number, limitations: WebCaptureLimitationCode[]): Promise<CapturedArtifact | null> {
  const dom = await ask<{ ok: boolean; html?: string; crossOriginFrames?: number; shadowRoots?: number }>(tabId, {
    kind: "GET_SANITIZED_DOM",
  });
  if (!dom.ok || !dom.html) return null;
  if ((dom.crossOriginFrames ?? 0) > 0 && !limitations.includes("CROSS_ORIGIN_IFRAME_NOT_CAPTURED")) {
    limitations.push("CROSS_ORIGIN_IFRAME_NOT_CAPTURED");
  }
  // UC-1 §4.2 — cloneNode omits shadow trees, so an open shadow root means the
  // DOM snapshot is not complete. Disclose it truthfully in the manifest.
  if ((dom.shadowRoots ?? 0) > 0 && !limitations.includes("SHADOW_DOM_NOT_FULLY_REPRESENTED")) {
    limitations.push("SHADOW_DOM_NOT_FULLY_REPRESENTED");
  }
  const blob = new Blob([dom.html], { type: "text/html" });
  return artifactFrom(blob, "dom_snapshot");
}

export async function captureViewport(tabId: number, windowId: number): Promise<CaptureResult> {
  const limitations: WebCaptureLimitationCode[] = [];
  const info = await ask<{ url: string; title: string | null; viewportW: number; viewportH: number; devicePixelRatio: number }>(
    tabId,
    { kind: "GET_PAGE_INFO" },
  );
  const shot = await artifactFrom(await captureVisible(windowId), "viewport_screenshot");
  const artifacts: CapturedArtifact[] = [shot];
  const dom = await domArtifact(tabId, limitations);
  if (dom) artifacts.push(dom);
  return {
    artifacts,
    pageInfo: info,
    pageMutatedDuringCapture: false,
    limitations,
  };
}

export async function captureFullPage(tabId: number, windowId: number): Promise<CaptureResult> {
  const limitations: WebCaptureLimitationCode[] = [];
  const info = await ask<{
    url: string;
    title: string | null;
    scrollHeight: number;
    viewportW: number;
    viewportH: number;
    devicePixelRatio: number;
    scrollY: number;
  }>(tabId, { kind: "GET_PAGE_INFO" });

  const plan = planFullPageTiles({
    pageHeightPx: info.scrollHeight,
    viewportHeightPx: info.viewportH,
    maxTiles: CAPTURE_LIMITS.maxTiles,
    maxPageHeightPx: CAPTURE_LIMITS.maxPageHeightPx,
  });
  if (plan.truncated) limitations.push("PAGE_EXCEEDED_CAPTURE_BOUNDS");

  const artifacts: CapturedArtifact[] = [];
  let mutated = false;
  const startedAt = Date.now();
  for (let i = 0; i < plan.offsets.length; i += 1) {
    if (Date.now() - startedAt > CAPTURE_LIMITS.captureTimeBudgetMs) {
      if (!limitations.includes("CAPTURE_INTERRUPTED")) limitations.push("CAPTURE_INTERRUPTED");
      break;
    }
    const scroll = await ask<{ ok: boolean; actualY: number; heightChanged: boolean }>(tabId, {
      kind: "SCROLL_TO",
      y: plan.offsets[i],
    });
    if (scroll.heightChanged) mutated = true;
    await new Promise((r) => setTimeout(r, CAPTURE_LIMITS.tileSettleMs));
    const tile = await artifactFrom(await captureVisible(windowId), "page_tile", {
      tileIndex: i,
      scrollOffsetY: scroll.actualY,
    });
    artifacts.push(tile);
  }
  // Restore the user's original scroll position.
  await ask(tabId, { kind: "RESTORE_SCROLL", y: info.scrollY });

  if (mutated && !limitations.includes("PAGE_MUTATED_DURING_CAPTURE")) {
    limitations.push("PAGE_MUTATED_DURING_CAPTURE");
  }
  const dom = await domArtifact(tabId, limitations);
  if (dom) artifacts.push(dom);

  return { artifacts, pageInfo: info, pageMutatedDuringCapture: mutated, limitations };
}
