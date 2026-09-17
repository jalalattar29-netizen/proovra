/**
 * Background service worker — the capture orchestrator. It runs only in
 * response to the user's explicit "Preserve" action from the popup, drives the
 * canonical server session (open → reserve → upload+declare parts → manifest →
 * web-complete), and streams bounded progress back to the popup. It never
 * captures in the background on its own and logs no page content.
 */
import { CONFIG } from "./lib/config.js";
import { apiClient, ApiError } from "./lib/api-client.js";
import { captureFullPage, captureViewport, type CapturedArtifact } from "./lib/capture.js";
import { buildWebCaptureManifest } from "./lib/manifest-builder.js";
import { getStoredToken } from "./lib/auth.js";
import { sha256Hex } from "./lib/sha256.js";
import type { WebCaptureArtifactDescriptor } from "@proovra/shared";

type PreserveRequest = {
  kind: "PRESERVE";
  mode: "VIEWPORT" | "FULL_PAGE";
  teamId: string;
  tabId: number;
  windowId: number;
  evidenceType: "PHOTO" | "DOCUMENT";
};

const SOURCE_BY_ROLE: Record<CapturedArtifact["role"], string> = {
  viewport_screenshot: "WEB_VIEWPORT",
  page_tile: "WEB_FULL_PAGE",
  dom_snapshot: "WEB_DOM",
};

function progress(step: string, detail?: string) {
  chrome.runtime.sendMessage({ kind: "CAPTURE_PROGRESS", step, detail }).catch(() => undefined);
}

async function ensureContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function runPreserve(req: PreserveRequest): Promise<{ evidenceId: string }> {
  const token = (await getStoredToken())?.accessToken;
  if (!token) throw new Error("Please sign in to PROOVRA first.");

  progress("preparing");
  await ensureContentScript(req.tabId);

  const startedAtUtc = new Date().toISOString();
  progress("capturing", req.mode === "FULL_PAGE" ? "full page" : "visible area");
  const capture =
    req.mode === "FULL_PAGE"
      ? await captureFullPage(req.tabId, req.windowId)
      : await captureViewport(req.tabId, req.windowId);
  const endedAtUtc = new Date().toISOString();

  progress("opening_session");
  const opened = await apiClient.openWebSession(token, req.teamId);
  const sessionId = opened.session.captureSessionId;

  progress("reserving");
  const reserve = await apiClient.reserveEvidence(token, sessionId, {
    type: req.evidenceType,
    mimeType: capture.artifacts[0]?.mediaType ?? "image/png",
    originalFileName: `web-capture-${capture.pageInfo.title ?? "page"}`.slice(0, 120),
  });
  const evidenceId = reserve.evidence.evidenceId;

  // Upload + declare each artifact part in order; the manifest is the last part.
  const descriptors: WebCaptureArtifactDescriptor[] = [];
  for (let i = 0; i < capture.artifacts.length; i += 1) {
    const a = capture.artifacts[i];
    progress("uploading", `artifact ${i + 1}/${capture.artifacts.length + 1}`);
    const part = await apiClient.createPart(token, evidenceId, {
      partIndex: i,
      mimeType: a.mediaType,
      originalFileName: `${a.role}-${i}`,
    });
    await apiClient.putBytes(part.upload.putUrl, a.blob, a.mediaType);
    await apiClient.declarePart(token, sessionId, i, {
      sha256: a.sha256,
      clientReportedSource: SOURCE_BY_ROLE[a.role],
    });
    descriptors.push({
      role: a.role,
      partIndex: i,
      expectedSha256: a.sha256,
      sizeBytes: a.blob.size,
      mediaType: a.mediaType,
      completeness: "CAPTURED",
      ...(a.tileIndex !== undefined ? { tileIndex: a.tileIndex, scrollOffsetY: a.scrollOffsetY ?? null } : {}),
    });
  }

  const manifestPartIndex = capture.artifacts.length;
  const { manifestJson } = buildWebCaptureManifest({
    captureMode: req.mode,
    captureSessionId: sessionId,
    captureStartedAtUtc: startedAtUtc,
    captureEndedAtUtc: endedAtUtc,
    sourceUrl: capture.pageInfo.url,
    title: capture.pageInfo.title,
    browser: {
      name: detectBrowserName(),
      versionBucket: detectVersionBucket(),
      os: detectOs(),
      viewportW: capture.pageInfo.viewportW,
      viewportH: capture.pageInfo.viewportH,
      devicePixelRatio: capture.pageInfo.devicePixelRatio,
    },
    extensionVersion: CONFIG.extensionVersion,
    artifacts: descriptors,
    pageMutatedDuringCapture: capture.pageMutatedDuringCapture,
    limitations: capture.limitations,
    notes: [],
  });

  // Upload + declare the manifest as the CAPTURE_MANIFEST part.
  progress("uploading", "capture manifest");
  const manifestBytes = new Blob([manifestJson], { type: "application/json" });
  const manifestPart = await apiClient.createPart(token, evidenceId, {
    partIndex: manifestPartIndex,
    mimeType: "application/json",
    originalFileName: "capture-manifest.json",
  });
  await apiClient.putBytes(manifestPart.upload.putUrl, manifestBytes, "application/json");
  await apiClient.declarePart(token, sessionId, manifestPartIndex, {
    sha256: await sha256Hex(manifestJson),
    clientReportedSource: "WEB_MANIFEST",
  });

  progress("sealing");
  await apiClient.webComplete(token, sessionId, manifestJson);
  progress("done");
  return { evidenceId };
}

function detectBrowserName(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return "Chrome";
  return "Chromium";
}
function detectVersionBucket(): string {
  const m = /(?:Edg|Chrome)\/(\d+)/.exec(navigator.userAgent);
  return m ? m[1] : "unknown";
}
function detectOs(): string {
  const p = navigator.platform || "";
  if (/Win/.test(p)) return "Windows";
  if (/Mac/.test(p)) return "macOS";
  if (/Linux/.test(p)) return "Linux";
  return "unknown";
}

chrome.runtime.onMessage.addListener((message: PreserveRequest, _sender, sendResponse) => {
  if (message?.kind !== "PRESERVE") return;
  runPreserve(message)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((err: unknown) => {
      const denial = err instanceof ApiError ? err.denial : null;
      sendResponse({
        ok: false,
        denial,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  return true; // async response
});
