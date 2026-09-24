/**
 * Popup UI. Explicit user initiation only: nothing captures until a Capture
 * button is pressed. Renders sign-in state, workspace selection and factual
 * progress. Keyboard accessible; no trust colour used to imply verification.
 */
import { getStoredToken, isSignedIn, signIn, signOut } from "./lib/auth.js";
import { CONFIG } from "./lib/config.js";
import { denialToMessage } from "./lib/denial-copy.js";

/** Shown when sign-in does not complete, for any reason. */
const SIGN_IN_FAILED =
  "Sign-in did not complete. Nothing was saved. Try again, and check that pop-ups are allowed for PROOVRA.";

/** The one sentence shown when no written refusal copy applies. */
const CAPTURE_FAILED =
  "The capture could not be completed. Nothing was saved. Please try again, or open PROOVRA if this keeps happening.";

type Workspace = { id: string; name: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function loadWorkspaces(token: string): Promise<Workspace[]> {
  // Reuse the canonical workspace projection. A failure yields no options and
  // disables capture rather than guessing a workspace.
  try {
    const res = await fetch(`${CONFIG.apiOrigin}/v1/platform/context`, {
      headers: { authorization: `Bearer ${token}` },
      credentials: "omit",
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { workspaces?: Workspace[]; teams?: Workspace[] };
    return body.workspaces ?? body.teams ?? [];
  } catch {
    return [];
  }
}

function setStatus(text: string, tone: "" | "ok" | "error" = "") {
  const el = $("status");
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function busy(disabled: boolean) {
  ($("capture-viewport") as HTMLButtonElement).disabled = disabled;
  ($("capture-full") as HTMLButtonElement).disabled = disabled;
}

async function preserve(mode: "VIEWPORT" | "FULL_PAGE") {
  const tab = await activeTab();
  if (!tab?.id || tab.windowId === undefined) {
    setStatus("No active page to capture.", "error");
    return;
  }
  const teamId = ($("workspace") as HTMLSelectElement).value;
  if (!teamId) {
    setStatus("Choose a workspace first.", "error");
    return;
  }
  busy(true);
  setStatus("Preparing capture…");
  const onProgress = (m: { kind?: string; step?: string; detail?: string }) => {
    if (m?.kind === "CAPTURE_PROGRESS") {
      setStatus(`${humanStep(m.step ?? "")}${m.detail ? ` — ${m.detail}` : ""}…`);
    }
  };
  chrome.runtime.onMessage.addListener(onProgress);
  try {
    const result = (await chrome.runtime.sendMessage({
      kind: "PRESERVE",
      mode,
      teamId,
      tabId: tab.id,
      windowId: tab.windowId,
      evidenceType: "PHOTO",
    })) as { ok: boolean; evidenceId?: string; error?: string; denial?: string | null };
    if (result.ok) {
      setStatus("Preserved. The record is in your PROOVRA workspace.", "ok");
    } else {
      // Capture is plan-blind: a server refusal is surfaced as the evidence
      // -creation / quota / entitlement reason it actually is, never as a
      // capture-specific plan restriction. Unknown codes (auth, not-found,
      // faults) fall back to the generic error line.
      // NEVER `result.error`. That field carries the SERVER'S message — or, for
      // a non-API throw, a raw JavaScript error string — straight from
      // background.ts, and this line put it on screen. A backend sentence in a
      // user surface is the one thing the platform error discipline forbids,
      // and it is how internal wording, ids and URLs reach people.
      //
      // Known refusals keep their written copy; everything else gets one
      // truthful generic line, and the detail goes to the console for whoever
      // is debugging.
      const denialMessage = denialToMessage(result.denial);
      if (!denialMessage && result.error) console.debug("capture failed:", result.error);
      setStatus(denialMessage ?? CAPTURE_FAILED, "error");
    }
  } catch (err) {
    // Same rule on the throw path: an exception message is not user copy.
    console.debug("capture threw:", err);
    setStatus(CAPTURE_FAILED, "error");
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
    busy(false);
  }
}

function humanStep(step: string): string {
  const map: Record<string, string> = {
    preparing: "Preparing",
    capturing: "Capturing",
    opening_session: "Opening a capture session",
    reserving: "Creating the record",
    uploading: "Uploading",
    sealing: "Sealing",
    done: "Finishing",
  };
  return map[step] ?? "Working";
}

async function render() {
  const signedIn = await isSignedIn();
  $("signed-out").hidden = signedIn;
  $("signed-in").hidden = !signedIn;
  if (!signedIn) return;
  const token = (await getStoredToken())?.accessToken;
  if (!token) return;
  const account = (await getStoredToken())?.account ?? null;
  $("account").textContent = account ? `Signed in as ${account}` : "Signed in";
  const select = $("workspace") as HTMLSelectElement;
  select.innerHTML = "";
  const workspaces = await loadWorkspaces(token);
  if (workspaces.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No workspace available";
    select.appendChild(opt);
    busy(true);
  } else {
    for (const w of workspaces) {
      const opt = document.createElement("option");
      opt.value = w.id;
      opt.textContent = w.name;
      select.appendChild(opt);
    }
    busy(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("sign-in").addEventListener("click", async () => {
    setStatus("Opening PROOVRA sign-in…");
    try {
      await signIn();
      await render();
      setStatus("");
    } catch (err) {
      // The OAuth path throws for a cancelled window, a closed tab, a network
      // drop and a server refusal alike, and `err.message` is whatever threw —
      // an internal string the reader cannot act on.
      console.debug("sign-in failed:", err);
      setStatus(SIGN_IN_FAILED, "error");
    }
  });
  $("sign-out").addEventListener("click", async () => {
    await signOut();
    await render();
  });
  $("capture-viewport").addEventListener("click", () => void preserve("VIEWPORT"));
  $("capture-full").addEventListener("click", () => void preserve("FULL_PAGE"));
  void render();
});
