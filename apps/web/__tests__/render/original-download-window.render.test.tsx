import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

/**
 * F-P1-04 (follow-up, originals) — "Open original" opens its tab IN the click
 * and points it at the minted URL; a blocked tab is said; a blocked fallback
 * after a failed in-page download is never reported as "Original downloaded".
 *
 * RED on the pre-remediation tree: `window.open(url, "_blank", "noopener…")`
 * after `await apiFetch(...)`, result unread, and "Original downloaded" /
 * "Original files downloaded" toasted whatever the browser did.
 *
 * Custody is unchanged: the server records the link it mints; nothing here
 * calls the API differently.
 */
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  isApiResponseError: (e: unknown) => Boolean(e && typeof e === "object" && "code" in (e as object)),
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const tryDownloadFile = vi.fn();
vi.mock("../../app/(app)/evidence/[id]/_tabs/_lib", () => ({
  tryDownloadFile: (...a: unknown[]) => tryDownloadFile(...a),
}));

import { useOriginalDownload } from "../../app/(app)/evidence/[id]/_hooks/useOriginalDownload";
import { ARTIFACT_WINDOW_BLOCKED_MESSAGE } from "../../lib/evidence/artifact-window";

type FakeTab = { closed: boolean; opener: unknown; location: { replace: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> };
const fakeTab = (): FakeTab => ({ closed: false, opener: {}, location: { replace: vi.fn() }, close: vi.fn() });

let openSpy: MockInstance<typeof window.open>;
beforeEach(() => {
  apiFetch.mockReset();
  tryDownloadFile.mockReset();
});
afterEach(() => {
  openSpy?.mockRestore();
  cleanup();
});

function hook() {
  const addToast = vi.fn();
  const { result } = renderHook(() => useOriginalDownload({ evidenceId: "ev-1", addToast }));
  return { result, addToast };
}

describe("F-P1-04 — originals", () => {
  it("Open original opens a blank tab before the API answers, then sends it to the URL", async () => {
    const tab = fakeTab();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
    let answer!: (v: unknown) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const { result, addToast } = hook();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.openOriginal();
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.slice(0, 2)).toEqual(["", "_blank"]);
    expect(tab.opener).toBeNull();
    await act(async () => {
      answer({ url: "https://files.test/original.jpg" });
      await pending;
    });
    expect(tab.location.replace).toHaveBeenCalledWith("https://files.test/original.jpg");
    expect(addToast).not.toHaveBeenCalled();
  });

  it("Open original: a blocked tab is said", async () => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ url: "https://files.test/original.jpg" });
    const { result, addToast } = hook();
    await act(async () => {
      await result.current.openOriginal();
    });
    expect(addToast).toHaveBeenCalledWith(ARTIFACT_WINDOW_BLOCKED_MESSAGE, "error");
  });

  it("Download original: a failed in-page download with a blocked fallback is said, never 'downloaded'", async () => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ url: "https://files.test/original.jpg", originalFileName: "photo.jpg" });
    tryDownloadFile.mockResolvedValueOnce(false);
    const { result, addToast } = hook();
    await act(async () => {
      await result.current.downloadOriginal();
    });
    expect(addToast).toHaveBeenCalledWith(ARTIFACT_WINDOW_BLOCKED_MESSAGE, "error");
    expect(addToast).not.toHaveBeenCalledWith("Original downloaded", "success");
  });

  it("Download original: an in-page download that works opens no tab and says downloaded", async () => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ url: "https://files.test/original.jpg", originalFileName: "photo.jpg" });
    tryDownloadFile.mockResolvedValueOnce(true);
    const { result, addToast } = hook();
    await act(async () => {
      await result.current.downloadOriginal();
    });
    expect(openSpy).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith("Original downloaded", "success");
  });

  it("multi-file originals: blocked fallback tabs are counted and said", async () => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    apiFetch
      .mockRejectedValueOnce(Object.assign(new Error("multipart"), { code: "ORIGINAL_IS_MULTIPART", statusCode: 409 }))
      .mockResolvedValueOnce({
        parts: [
          { partIndex: 0, url: "https://files.test/p0", originalFileName: "a.mp4" },
          { partIndex: 1, url: "https://files.test/p1", originalFileName: "b.mp4" },
        ],
      });
    tryDownloadFile.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result, addToast } = hook();
    await act(async () => {
      await result.current.downloadOriginal();
    });
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]?.[0]).toContain(ARTIFACT_WINDOW_BLOCKED_MESSAGE);
    expect(addToast.mock.calls[0]?.[0]).toContain("1 of 2");
    expect(addToast.mock.calls[0]?.[1]).toBe("error");
  });
});
