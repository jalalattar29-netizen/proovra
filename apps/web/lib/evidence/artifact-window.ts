/**
 * F-P1-04 — OPENING A MINTED REPORT / PACKAGE URL IN A NEW TAB.
 *
 * The download handlers awaited the API (`report/latest`, `verification-package`)
 * and THEN called `window.open(url, "_blank", "noopener,noreferrer")`. After an
 * await the click's user activation can be gone, so Safari / iOS and strict
 * popup blockers drop the tab silently — and with "noopener" `window.open`
 * returns null even when it works, so nothing could tell. The button did
 * nothing while the custody chain says a download link was issued.
 *
 * Now the tab is opened SYNCHRONOUSLY in the click, blank, before any await;
 * the URL is assigned to it once minted. The opener is cut by hand (so the
 * handle is still returned and a blocked tab is observable). A blocked tab is
 * said in words instead of being a silent no-op.
 *
 * Custody note (not changed here): `GET /report/latest` and
 * `/verification-package` append DOWNLOAD_AUTHORIZED ("… download link
 * issued", accessMode `authenticated_download_url_issued`) when they MINT the
 * URL. That event states issuance, not a completed download, so it stays true
 * when the browser blocks the tab.
 */

export type PendingArtifactWindowResult = "opened" | "blocked" | "closed";

export type PendingArtifactWindow = {
  /** Send the pending tab to `url`. */
  assign(url: string): PendingArtifactWindowResult;
  /** Close the pending tab (nothing to show: a refusal, no URL). */
  close(): void;
};

/** Said when the browser refused to open the new tab. */
export const ARTIFACT_WINDOW_BLOCKED_MESSAGE =
  "Your browser blocked the new tab, so the file did not open. Allow pop-ups for PROOVRA, then select Download again.";

/**
 * Open a blank tab NOW — call this synchronously inside the click handler,
 * before the first await — and point it at the URL later.
 */
export function openPendingArtifactWindow(win: Window = window): PendingArtifactWindow {
  let tab: Window | null = null;
  try {
    tab = win.open("", "_blank") ?? null;
  } catch {
    tab = null;
  }
  if (tab) {
    try {
      // The handle is kept (unlike "noopener"), but the new page gets no
      // reference back to this one.
      tab.opener = null;
    } catch {
      // Cross-origin hardening varies; the tab is still usable.
    }
  }
  return {
    assign(url) {
      if (!tab) return "blocked";
      if (tab.closed) return "closed";
      try {
        tab.location.replace(url);
        return "opened";
      } catch {
        return "blocked";
      }
    },
    close() {
      try {
        if (tab && !tab.closed) tab.close();
      } catch {
        // Nothing to close.
      }
    },
  };
}

/**
 * Open `url` in a new tab right now (no pending tab was opened in the click —
 * e.g. the fallback after a blob download failed). Returns false when the
 * browser blocked it, so the caller can say so.
 */
export function openArtifactUrlNow(url: string, win: Window = window): boolean {
  return openPendingArtifactWindow(win).assign(url) !== "blocked";
}
