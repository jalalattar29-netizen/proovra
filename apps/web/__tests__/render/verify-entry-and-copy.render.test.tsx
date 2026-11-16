/**
 * B5B-F-502 — every Verify input lands what a recipient pastes on the right page.
 * B5B-F-506 — copy feedback reflects the clipboard's outcome.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

import { resolveVerifyEntryTarget } from "../../lib/verify/verify-entry";
import { VerifyInstantly } from "../../components/marketing/VerifyInstantly";
import { copyWithFeedback, COPY_FAILED_MESSAGE } from "../../lib/clipboard/copy-with-feedback";

afterEach(() => {
  cleanup();
  nav.push.mockReset();
});

describe("B5B-F-502 — one parser for pasted links", () => {
  it("maps full links, package links and bare references", () => {
    expect(resolveVerifyEntryTarget("https://app.proovra.com/verify/pvr_AbC123")).toBe("/verify/pvr_AbC123");
    expect(resolveVerifyEntryTarget("https://www.proovra.com/verify/package/0f0e-11")).toBe("/verify/package/0f0e-11");
    expect(resolveVerifyEntryTarget("proovra://verify?id=pvs_tok")).toBe("/verify/pvs_tok");
    expect(resolveVerifyEntryTarget("/verify/pvr_x")).toBe("/verify/pvr_x");
    expect(resolveVerifyEntryTarget("  pvr_AbC123 ")).toBe("/verify/pvr_AbC123");
    expect(resolveVerifyEntryTarget("https://example.com/somewhere")).toBeNull();
    expect(resolveVerifyEntryTarget("two words")).toBeNull();
    expect(resolveVerifyEntryTarget("package")).toBeNull();
  });

  it("home 'Verify now' opens a pasted package link's package page", async () => {
    render(<VerifyInstantly />);
    const input = screen.getByLabelText(/verification link or reference/i);
    fireEvent.change(input, { target: { value: "https://www.proovra.com/verify/package/abc-123" } });
    await act(async () => {
      screen.getByRole("button", { name: /verify now/i }).click();
    });
    expect(nav.push).toHaveBeenCalledWith("/verify/package/abc-123");
  });

  it("home shows no inert Upload Package / Enter Hash modes", () => {
    render(<VerifyInstantly />);
    expect(screen.queryByRole("button", { name: /upload package/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /enter hash/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/record ID from an\s+evidence report/);
  });
});

describe("B5B-F-506 — a refused clipboard is not reported as copied", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
  });

  it("denied: says it could not copy", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) },
    });
    const toast = vi.fn();
    const ok = await copyWithFeedback("abc", toast, "SHA-256 copied");
    expect(ok).toBe(false);
    expect(toast).toHaveBeenCalledWith(COPY_FAILED_MESSAGE, "error");
    expect(toast).not.toHaveBeenCalledWith("SHA-256 copied", "success");
  });

  it("granted: success only after the write resolved", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const toast = vi.fn();
    expect(await copyWithFeedback("abc", toast, "SHA-256 copied")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
    expect(toast).toHaveBeenCalledWith("SHA-256 copied", "success");
  });
});

describe("B5B-F-506 — the Verify page's copy buttons go through the awaited helper", () => {
  it("no fire-and-forget clipboard write remains on the verify page", () => {
    for (const rel of ["app/verify/[token]/page.tsx", "app/verify/[token]/VerifyRecordSections.tsx"]) {
      const src = readFileSync(resolve(__dirname, "../..", rel), "utf8");
      expect(src, rel).not.toMatch(/navigator\.clipboard/);
      expect(src, rel).toMatch(/copyWithFeedback\(/);
    }
  });
});
