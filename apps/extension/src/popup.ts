/**
 * Popup UI. Explicit user initiation only: nothing captures until a Capture
 * button is pressed. Renders sign-in state, workspace and case selection, and
 * the capture status the BACKGROUND owns (UC-EXT-005) — so closing and
 * reopening the popup shows the running capture or its result. Keyboard
 * accessible; no trust colour used to imply verification.
 */
import { clearToken, getStoredToken } from "./lib/auth.js";
import { CONFIG } from "./lib/config.js";
import {
  classifyCasesResponse,
  classifyContextResponse,
  type CaptureWorkspace,
  type CaseLoad,
  type WorkspaceLoad,
} from "./lib/popup-context.js";
import { CAPTURE_ALREADY_RUNNING, SESSION_ENDED, statusLine } from "./lib/status-copy.js";
import type { CaptureStatus } from "./lib/capture-registry.js";

/** Shown when sign-in does not complete, for any reason. */
const SIGN_IN_FAILED =
  "Sign-in did not complete. Nothing was saved. Try again — PROOVRA will ask you to sign in if you are not already.";

const WORKSPACES_FAILED =
  "Could not load your PROOVRA workspaces. Check your connection and try again.";

const NO_ELIGIBLE_WORKSPACE =
  "Your PROOVRA account has no workspace where you can record evidence. Ask a workspace admin for access.";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);

let workspaces: CaptureWorkspace[] = [];
let lastStatus: CaptureStatus | null = null;
let targetTabIdCache: number | null = null;

/** Read an API resource with the stored bearer; `status` null = no HTTP answer. */
async function apiGet(token: string, path: string): Promise<{ status: number | null; body: unknown }> {
  try {
    const res = await fetch(`${CONFIG.apiOrigin}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      credentials: "omit",
      signal: AbortSignal.timeout(20_000),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body };
  } catch {
    return { status: null, body: null };
  }
}

async function loadWorkspaces(token: string): Promise<WorkspaceLoad> {
  const r = await apiGet(token, "/v1/platform/context");
  return classifyContextResponse(r.status, r.body);
}

async function loadCases(token: string, teamId: string): Promise<CaseLoad> {
  const r = await apiGet(token, "/v1/cases");
  return classifyCasesResponse(r.status, r.body, teamId);
}

function setStatus(text: string, tone: "" | "ok" | "error" = "") {
  const el = $("status");
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

/**
 * The tab this popup captures. Normally the active tab of the popup's window.
 * An extension page may name one with `?targetTabId=` (the popup opened in its
 * own window); only this extension can open its pages, and captureVisibleTab
 * still captures only what that tab's window is showing.
 */
async function targetTab(): Promise<chrome.tabs.Tab | null> {
  const raw = params.get("targetTabId");
  if (raw !== null) {
    if (!/^\d{1,10}$/.test(raw)) return null;
    try {
      return await chrome.tabs.get(Number(raw));
    } catch {
      return null;
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function targetTabId(): Promise<number | null> {
  if (targetTabIdCache !== null) return targetTabIdCache;
  const t = await targetTab();
  targetTabIdCache = t?.id ?? null;
  return targetTabIdCache;
}

function captureButtons(enabled: boolean) {
  ($("capture-viewport") as HTMLButtonElement).disabled = !enabled;
  ($("capture-full") as HTMLButtonElement).disabled = !enabled;
}

function showSignedOut(note: string | null) {
  $("signed-out").hidden = false;
  $("signed-in").hidden = true;
  $("account").textContent = "";
  const n = $("signed-out-note");
  n.textContent = note ?? "";
  n.hidden = !note;
}

/** Reflect the background's capture status (running / result) in the UI. */
function applyStatus(s: CaptureStatus | null) {
  lastStatus = s;
  const running = s?.state === "RUNNING";
  captureButtons(!running && workspaces.length > 0);
  $("cancel").hidden = !running || Boolean(s?.cancelRequested);
  $("retry").hidden = !(s?.state === "FAILED" && s.reason !== "SIGNED_OUT" && workspaces.length > 0);
  const status = $("status");
  status.dataset.captureState = s?.state ?? "";
  status.dataset.evidenceId = s?.state === "SUCCEEDED" && s.evidenceId ? s.evidenceId : "";
  const line = statusLine(s);
  if (!line) {
    setStatus("");
    return;
  }
  if (line.signedOut) {
    // The capture ended because the sign-in ended. Once the user has signed in
    // again, that old result is no longer news.
    void getStoredToken().then((t) => {
      if (!t) showSignedOut(line.text);
      else setStatus("");
    });
    return;
  }
  setStatus(line.text, line.tone);
}

let casesGeneration = 0;

async function refreshCases(token: string) {
  // Loads can overlap (the initial render and a workspace change). Only the
  // LATEST one may write the list, and it replaces the options in one step —
  // two overlapping loads used to append the same cases twice.
  const generation = ++casesGeneration;
  const teamId = ($("workspace") as HTMLSelectElement).value;
  const select = $("case") as HTMLSelectElement;
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No case (file it later)";
  select.replaceChildren(none);
  const note = $("case-note");
  note.hidden = true;
  if (!teamId) return;
  const cases = await loadCases(token, teamId);
  if (generation !== casesGeneration) return;
  if (cases.kind === "signed_out") {
    await clearToken();
    showSignedOut(SESSION_ENDED);
    return;
  }
  if (cases.kind === "error") {
    // Not blocking: a capture can still be filed later from PROOVRA.
    note.textContent = "Cases could not be loaded. You can still capture and file the record later.";
    note.hidden = false;
    return;
  }
  const options = [none];
  for (const c of cases.cases) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    options.push(opt);
  }
  select.replaceChildren(...options);
}

async function render() {
  const stored = await getStoredToken();
  if (!stored) {
    showSignedOut(null);
    return;
  }
  $("signed-out").hidden = true;
  $("signed-in").hidden = false;
  $("account").textContent = stored.account ? `Signed in as ${stored.account}` : "Signed in";
  $("load-error").hidden = true;
  captureButtons(false);

  const select = $("workspace") as HTMLSelectElement;
  select.innerHTML = "";
  const loaded = await loadWorkspaces(stored.accessToken);
  if (loaded.kind === "signed_out") {
    // UC-EXT-002 — an expired/revoked token is a sign-in state, not "no workspace".
    await clearToken();
    showSignedOut(SESSION_ENDED);
    return;
  }
  if (loaded.kind === "error") {
    workspaces = [];
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Workspaces unavailable";
    select.appendChild(opt);
    $("load-error-text").textContent = WORKSPACES_FAILED;
    $("load-error").hidden = false;
    applyStatus(await currentStatus());
    return;
  }
  workspaces = loaded.workspaces;
  if (workspaces.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No workspace where you can record evidence";
    select.appendChild(opt);
    $("load-error-text").textContent = NO_ELIGIBLE_WORKSPACE;
    $("load-error").hidden = false;
  } else {
    for (const w of workspaces) {
      const opt = document.createElement("option");
      opt.value = w.id;
      opt.textContent = w.name;
      select.appendChild(opt);
    }
    if (loaded.activeId) select.value = loaded.activeId;
    await refreshCases(stored.accessToken);
  }
  applyStatus(await currentStatus());
}

async function currentStatus(): Promise<CaptureStatus | null> {
  const tabId = await targetTabId();
  if (tabId === null) return null;
  try {
    const r = (await chrome.runtime.sendMessage({ kind: "GET_CAPTURE_STATUS", tabId })) as { status: CaptureStatus | null };
    return r?.status ?? null;
  } catch {
    return null;
  }
}

async function preserve(mode: "VIEWPORT" | "FULL_PAGE") {
  const tab = await targetTab();
  if (!tab?.id || tab.windowId === undefined) {
    setStatus("No active page to capture.", "error");
    return;
  }
  const teamId = ($("workspace") as HTMLSelectElement).value;
  if (!teamId) {
    setStatus("Choose a workspace first.", "error");
    return;
  }
  const caseId = ($("case") as HTMLSelectElement).value || null;
  captureButtons(false);
  setStatus("Preparing capture…");
  try {
    const result = (await chrome.runtime.sendMessage({
      kind: "PRESERVE",
      mode,
      teamId,
      caseId,
      tabId: tab.id,
      windowId: tab.windowId,
      evidenceType: "PHOTO",
    })) as { accepted: boolean; reason?: string; status?: CaptureStatus };
    if (!result?.accepted && result?.reason === "ALREADY_RUNNING") {
      applyStatus(result.status ?? null);
      setStatus(CAPTURE_ALREADY_RUNNING);
      return;
    }
    applyStatus(result?.status ?? (await currentStatus()));
  } catch (err) {
    // The popup lost its channel (for example it was reopened); the background
    // still owns the capture, so show what it has recorded rather than guess.
    console.debug("capture message failed:", err);
    applyStatus(await currentStatus());
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("sign-in").addEventListener("click", async () => {
    setStatus("");
    $("signed-out-note").textContent = "Opening PROOVRA sign-in…";
    $("signed-out-note").hidden = false;
    try {
      const r = (await chrome.runtime.sendMessage({ kind: "SIGN_IN" })) as { ok: boolean };
      if (!r?.ok) throw new Error("sign-in refused");
      await render();
    } catch (err) {
      // The OAuth path fails for a cancelled window, a network drop and a
      // server refusal alike; the message is not something the reader can act on.
      console.debug("sign-in failed:", err);
      showSignedOut(SIGN_IN_FAILED);
    }
  });
  $("sign-out").addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ kind: "SIGN_OUT" });
    } catch {
      await clearToken();
    }
    await render();
  });
  $("workspace").addEventListener("change", async () => {
    const t = await getStoredToken();
    if (t) await refreshCases(t.accessToken);
  });
  $("reload").addEventListener("click", () => void render());
  $("capture-viewport").addEventListener("click", () => void preserve("VIEWPORT"));
  $("capture-full").addEventListener("click", () => void preserve("FULL_PAGE"));
  $("retry").addEventListener("click", () => void preserve(lastStatus?.mode ?? "VIEWPORT"));
  $("cancel").addEventListener("click", async () => {
    const tabId = await targetTabId();
    if (tabId === null) return;
    await chrome.runtime.sendMessage({ kind: "CANCEL_CAPTURE", tabId }).catch(() => undefined);
    applyStatus(await currentStatus());
  });
  chrome.runtime.onMessage.addListener((m: { kind?: string; status?: CaptureStatus }) => {
    if (m?.kind !== "CAPTURE_STATUS" || !m.status) return;
    void targetTabId().then((tabId) => {
      if (tabId !== null && m.status!.tabId === tabId) applyStatus(m.status!);
    });
  });
  void render();
});
