/**
 * The Chrome launch boundary of `renderPdfFromHtml` (2026-10-19).
 *
 * A cold Chrome on a loaded CI runner can take longer than Puppeteer's 30 s to
 * print its DevTools endpoint. The renderer therefore takes one optional launch
 * timeout. Production keeps the 30 s default; the heavy layout test passes 90 s.
 * This file pins that the headroom covers the launch only: a launch that
 * genuinely fails still fails, and a render failure is neither retried nor
 * swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());
vi.mock("puppeteer", () => ({ default: { launch } }));

import { BROWSER_LAUNCH_TIMEOUT_MS, renderPdfFromHtml } from "../src/report-v2/render-pdf.js";

function fakeBrowser(setContent: () => Promise<void>) {
  const close = vi.fn(async () => undefined);
  const page = {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    setViewport: vi.fn(async () => undefined),
    emulateMediaType: vi.fn(async () => undefined),
    setContent: vi.fn<(html: string, options?: { timeout?: number }) => Promise<void>>(setContent),
  };
  return { browser: { newPage: vi.fn(async () => page), close }, page, close };
}

describe("renderPdfFromHtml's launch boundary", () => {
  const before = process.env.PUPPETEER_EXECUTABLE_PATH;
  beforeEach(() => {
    launch.mockReset();
    // Any existing file passes the executable lookup; the launch is mocked.
    process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = before;
  });

  it("production keeps Puppeteer's 30 s launch timeout", async () => {
    launch.mockRejectedValue(new Error("stop after launch options"));
    await expect(renderPdfFromHtml("<p>x</p>")).rejects.toThrow("stop after launch options");
    expect(BROWSER_LAUNCH_TIMEOUT_MS).toBe(30_000);
    expect(launch.mock.calls[0][0].timeout).toBe(30_000);
  });

  it("a slow launch gets the configured headroom and the render goes on", async () => {
    const renderGate = new Error("render reached");
    const { browser } = fakeBrowser(async () => {
      throw renderGate;
    });
    // The browser starts slowly, inside the configured headroom.
    launch.mockImplementation(async (opts: { timeout: number }) => {
      await new Promise((r) => setTimeout(r, 50));
      if (opts.timeout < 90_000) throw new Error("TimeoutError: launch headroom not applied");
      return browser;
    });
    await expect(renderPdfFromHtml("<p>x</p>", { launchTimeoutMs: 90_000 })).rejects.toBe(renderGate);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0].timeout).toBe(90_000);
  });

  it("a genuine launch failure still fails, once, with its own error", async () => {
    const failure = new Error("TimeoutError: Timed out after 90000 ms while waiting for the WS endpoint URL");
    launch.mockRejectedValue(failure);
    await expect(renderPdfFromHtml("<p>x</p>", { launchTimeoutMs: 90_000 })).rejects.toBe(failure);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("a render failure is not retried or swallowed, and the browser is closed", async () => {
    const renderFailure = new Error("setContent failed");
    const { browser, page, close } = fakeBrowser(async () => {
      throw renderFailure;
    });
    launch.mockResolvedValue(browser);
    await expect(renderPdfFromHtml("<p>x</p>", { launchTimeoutMs: 90_000 })).rejects.toBe(renderFailure);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(page.setContent).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    // The render keeps its own timeouts: the launch headroom changes none.
    expect(page.setDefaultTimeout).toHaveBeenCalledWith(120_000);
    expect(page.setContent.mock.calls[0][1]).toMatchObject({ timeout: 30_000 });
  });
});
