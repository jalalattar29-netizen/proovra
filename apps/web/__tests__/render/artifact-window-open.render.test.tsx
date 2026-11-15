import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

/**
 * F-P1-04 — a report / package opened from Evidence Detail opens its tab IN
 * the click (before the API await) and points it at the minted URL; a tab the
 * browser blocked is SAID, and a refusal closes the blank tab.
 *
 * RED on the pre-remediation tree: `window.open(url, "_blank", "noopener…")`
 * ran only after `await apiFetch(...)` (no tab at click time), its result was
 * never read, and a blocked tab was a silent no-op.
 *
 * Browser popup policy itself (Safari / iOS user-activation after an await) is
 * EXTERNALLY-UNVERIFIED in jsdom; what is proved is the ordering and the
 * observable outcome.
 */
const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const tryDownloadFile = vi.fn();
vi.mock("../../app/(app)/evidence/[id]/_tabs/_lib", () => ({
  tryDownloadFile: (...a: unknown[]) => tryDownloadFile(...a),
}));

import { useEvidenceArtifactActions } from "../../app/(app)/evidence/[id]/_hooks/useEvidenceArtifactActions";
import {
  ARTIFACT_WINDOW_BLOCKED_MESSAGE,
  openPendingArtifactWindow,
} from "../../lib/evidence/artifact-window";

type FakeTab = { closed: boolean; opener: unknown; location: { replace: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> };
function fakeTab(): FakeTab {
  const tab: FakeTab = {
    closed: false,
    opener: { the: "app" },
    location: { replace: vi.fn() },
    close: vi.fn(() => {
      tab.closed = true;
    }),
  };
  return tab;
}

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
  const { result } = renderHook(() =>
    useEvidenceArtifactActions({ evidenceId: "ev-1", addToast, reloadWorkspace: () => {} }),
  );
  return { result, addToast };
}

describe("F-P1-04 — report opened in the click", () => {
  it("opens a blank tab BEFORE the API answers, cuts the opener, then sends it to the minted URL", async () => {
    const tab = fakeTab();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
    let answer!: (v: unknown) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const { result, addToast } = hook();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.downloadReport();
    });
    // Synchronously in the click: the tab exists while the request is in flight.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.slice(0, 2)).toEqual(["", "_blank"]);
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).not.toHaveBeenCalled();
    await act(async () => {
      answer({ url: "https://files.test/report.pdf" });
      await pending;
    });
    expect(tab.location.replace).toHaveBeenCalledWith("https://files.test/report.pdf");
    expect(addToast).not.toHaveBeenCalled();
  });

  it("a blocked tab is said, not a silent no-op", async () => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ url: "https://files.test/report.pdf" });
    const { result, addToast } = hook();
    await act(async () => {
      await result.current.downloadReport();
    });
    expect(addToast).toHaveBeenCalledWith(ARTIFACT_WINDOW_BLOCKED_MESSAGE, "error");
  });

  it("a refusal closes the blank tab and says the refusal", async () => {
    const tab = fakeTab();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
    apiFetch.mockRejectedValueOnce(Object.assign(new Error("x"), { statusCode: 404 }));
    const { result, addToast } = hook();
    await act(async () => {
      await result.current.downloadReport();
    });
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]?.[0]).toMatch(/no report/i);
  });

  it("a report version is opened the same way", async () => {
    const tab = fakeTab();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
    apiFetch.mockResolvedValueOnce({ url: "https://files.test/report-v2.pdf" });
    const { result } = hook();
    await act(async () => {
      await result.current.downloadReportVersion(2);
    });
    expect(openSpy.mock.calls[0]?.slice(0, 2)).toEqual(["", "_blank"]);
    expect(tab.location.replace).toHaveBeenCalledWith("https://files.test/report-v2.pdf");
  });
});

describe("F-P1-04 — package fallback tab", () => {
  it("when the in-page download fails and the fallback tab is blocked, it is said", async () => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ url: "https://files.test/pkg.zip" });
    tryDownloadFile.mockResolvedValueOnce(false);
    const { result, addToast } = hook();
    await act(async () => {
      await result.current.downloadVerificationPackage();
    });
    expect(addToast).toHaveBeenCalledWith(ARTIFACT_WINDOW_BLOCKED_MESSAGE, "error");
  });

  it("an in-page download that works opens no tab at all", async () => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ url: "https://files.test/pkg.zip" });
    tryDownloadFile.mockResolvedValueOnce(true);
    const { result, addToast } = hook();
    await act(async () => {
      await result.current.downloadVerificationPackage();
    });
    expect(openSpy).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});

describe("artifact-window (unit)", () => {
  it("a tab the person closed before the URL arrived is left alone (no notice)", () => {
    const tab = fakeTab();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);
    const pending = openPendingArtifactWindow();
    tab.closed = true;
    expect(pending.assign("https://files.test/x.pdf")).toBe("closed");
    expect(tab.location.replace).not.toHaveBeenCalled();
  });
});
