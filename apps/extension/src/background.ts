/**
 * Background service worker — the capture orchestrator and the OWNER of capture
 * state (UC-EXT-005). It runs a capture only in response to the user's explicit
 * action from the popup, drives the canonical server session (open → reserve →
 * upload+declare parts → manifest → web-complete, or discard on failure), and
 * persists bounded progress in chrome.storage.session so a reopened popup shows
 * what is happening. It never captures in the background on its own and logs
 * no page content.
 */
import { CONFIG } from "./lib/config.js";
import { apiClient } from "./lib/api-client.js";
import { captureFullPage, captureViewport } from "./lib/capture.js";
import { clearToken, getStoredToken, signIn, signOut } from "./lib/auth.js";
import { sha256Hex } from "./lib/sha256.js";
import { runPreserveFlow, type PreserveRequest } from "./lib/preserve-flow.js";
import { createCaptureRegistry, type CaptureStatus } from "./lib/capture-registry.js";

const STATUS_KEY = "proovra.capture.status";

const registry = createCaptureRegistry({
  store: {
    async read() {
      const out = await chrome.storage.session.get(STATUS_KEY);
      return (out?.[STATUS_KEY] as Record<string, CaptureStatus>) ?? {};
    },
    async write(all) {
      await chrome.storage.session.set({ [STATUS_KEY]: all });
    },
  },
  newId: () => crypto.randomUUID(),
  onChange: (status) => {
    chrome.runtime.sendMessage({ kind: "CAPTURE_STATUS", status }).catch(() => undefined);
  },
  run: (req, signal, attemptId) =>
    runPreserveFlow(
      {
        api: apiClient,
        getToken: async () => (await getStoredToken())?.accessToken ?? null,
        clearToken,
        prepare: async (tabId) => {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        },
        capture: (r, s) =>
          r.mode === "FULL_PAGE" ? captureFullPage(r.tabId, r.windowId, s) : captureViewport(r.tabId, r.windowId, s),
        sha256Hex,
        progress: (step, detail) => {
          void registry.progress(req.tabId, attemptId, step, detail);
        },
        browser: { name: detectBrowserName(), versionBucket: detectVersionBucket(), os: detectOs() },
        extensionVersion: CONFIG.extensionVersion,
      },
      req,
      signal,
    ).then((outcome) => {
      // Debug detail for whoever is debugging — never user copy, never content.
      if (outcome.status === "FAILED") console.debug("capture failed:", outcome.reason, outcome.detail);
      return outcome;
    }),
});

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

type Msg =
  | ({ kind: "PRESERVE" } & PreserveRequest)
  | { kind: "GET_CAPTURE_STATUS"; tabId: number }
  | { kind: "CANCEL_CAPTURE"; tabId: number }
  | { kind: "SIGN_IN" }
  | { kind: "SIGN_OUT" };

/** Control messages are honoured only from this extension's own pages. */
function fromOwnPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

function isTabId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

chrome.runtime.onMessage.addListener((message: Msg, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const kinds = ["PRESERVE", "GET_CAPTURE_STATUS", "CANCEL_CAPTURE", "SIGN_IN", "SIGN_OUT"];
  if (!kinds.includes((message as { kind?: string }).kind ?? "")) return;
  if (!fromOwnPage(sender)) return;

  if (message.kind === "PRESERVE") {
    if (!isTabId(message.tabId) || !isTabId(message.windowId) || typeof message.teamId !== "string") {
      sendResponse({ accepted: false, reason: "INVALID_REQUEST" });
      return;
    }
    const req: PreserveRequest = {
      mode: message.mode === "FULL_PAGE" ? "FULL_PAGE" : "VIEWPORT",
      teamId: message.teamId,
      caseId: typeof message.caseId === "string" && message.caseId ? message.caseId : null,
      tabId: message.tabId,
      windowId: message.windowId,
      evidenceType: message.evidenceType === "DOCUMENT" ? "DOCUMENT" : "PHOTO",
    };
    void registry.start(req).then(async (started) => {
      if (!started.accepted) {
        sendResponse({ accepted: false, reason: started.reason, status: started.status });
        return;
      }
      // The response arrives only if the popup is still open; the persisted
      // status is the durable answer either way.
      const final = await started.done;
      sendResponse({ accepted: true, attemptId: started.attemptId, status: final });
    });
    return true;
  }
  if (message.kind === "GET_CAPTURE_STATUS") {
    if (!isTabId(message.tabId)) {
      sendResponse({ status: null });
      return;
    }
    void registry.status(message.tabId).then((status) => sendResponse({ status }));
    return true;
  }
  if (message.kind === "CANCEL_CAPTURE") {
    if (!isTabId(message.tabId)) {
      sendResponse({ cancelled: false });
      return;
    }
    void registry.cancel(message.tabId).then((cancelled) => sendResponse({ cancelled }));
    return true;
  }
  if (message.kind === "SIGN_IN") {
    signIn()
      .then((r) => sendResponse({ ok: true, account: r.account }))
      .catch((err: unknown) => {
        console.debug("sign-in failed:", err);
        sendResponse({ ok: false });
      });
    return true;
  }
  if (message.kind === "SIGN_OUT") {
    signOut((token) => apiClient.revokeExtensionToken(token))
      .then((r) => sendResponse({ ok: true, revoked: r.revoked }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return;
});
