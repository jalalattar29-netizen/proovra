/**
 * SHARED VISUAL BEHAVIOURS THAT REGRESS QUIETLY.
 *
 * Each of these was seen in the audit's screenshots: a bottom sheet over the
 * Evidence Library on a phone, the browser's black ring on a keyboard-opened
 * listbox, a help bubble over the setup wizard's Next button, and a duplicate
 * logo in the mobile drawer. The stylesheet checks read the file that ships,
 * because `css: false` means jsdom never computes it; the behaviour checks
 * drive the real components.
 */

import fs from "node:fs";
import path from "node:path";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  COMPACT_INSPECTOR_QUERY,
  useInspectorHost,
} from "../../app/(app)/evidence/lib/useInspectorHost";
import { AppListbox } from "../../components/app-primitives/AppListbox";

const webRoot = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(webRoot, relative), "utf8");

/** Every declaration block whose selector list names `needle`. */
function rulesFor(css: string, needle: string): string[] {
  const out: string[] = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(",").some((s) => s.trim() === needle)) out.push(match[2]);
  }
  return out;
}

function stubViewport(compact: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: compact,
    media: COMPACT_INSPECTOR_QUERY,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => query,
  });
  return {
    change(next: boolean) {
      query.matches = next;
      act(() => listeners.forEach((fn) => fn()));
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("RT-010: the Evidence Library inspector on a compact screen", () => {
  it("does not open itself on load at 390px", () => {
    stubViewport(true);
    const { result } = renderHook(() => useInspectorHost());
    expect(result.current.compactInspector).toBe(true);
    expect(result.current.inspectorOpen).toBe(false);
  });

  it("opens when a row asks, and closes again", () => {
    stubViewport(true);
    const { result } = renderHook(() => useInspectorHost());
    act(() => result.current.openInspector());
    expect(result.current.inspectorOpen).toBe(true);
    act(() => result.current.dismissInspector());
    expect(result.current.inspectorOpen).toBe(false);
  });

  it("keeps the desktop column open by default (positive control)", () => {
    stubViewport(false);
    const { result } = renderHook(() => useInspectorHost());
    expect(result.current.compactInspector).toBe(false);
    expect(result.current.inspectorOpen).toBe(true);
  });

  it("follows the layout across the breakpoint", () => {
    const viewport = stubViewport(false);
    const { result } = renderHook(() => useInspectorHost());
    viewport.change(true);
    expect(result.current.inspectorOpen).toBe(false);
    viewport.change(false);
    expect(result.current.inspectorOpen).toBe(true);
  });
});

describe("RT-013: keyboard focus on an open listbox", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  function Harness() {
    const [value, setValue] = useState<string>("a");
    return (
      <AppListbox
        ariaLabel="Scope"
        value={value}
        onChange={setValue}
        options={[
          { value: "a", label: "All" },
          { value: "b", label: "Mine" },
        ]}
      />
    );
  }

  it("moves focus to the popup, which is what the ring has to cover", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    screen.getByRole("combobox").focus();
    await user.keyboard("{ArrowDown}");
    const popup = await screen.findByRole("listbox");
    expect(popup.tagName).toBe("UL");
    expect(document.activeElement).toBe(popup);
  });

  it("gives the popup the canonical ring, without removing the outline", () => {
    const css = read("app/globals.css");
    const blocks = rulesFor(css, '[role="listbox"]:focus-visible');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("outline: 2px solid #8b7cf6");
    const primitives = read("components/app-primitives/app-primitives.css");
    const popupRules = rulesFor(primitives, ".app-listbox__popup");
    expect(popupRules.join("")).not.toMatch(/outline:\s*(none|0)/);
  });
});

describe("V-018: the help nudge and the page's primary controls", () => {
  const css = read("components/ai/assistant.css");

  it("stays in the launcher's column and never takes a pointer", () => {
    const hint = rulesFor(css, ".assistant-hint")[0];
    expect(hint).toContain("pointer-events: none");
    expect(hint).toContain("inset-inline-end: 0");
    expect(hint).toContain("inline-size: 3rem");
    expect(hint).not.toMatch(/right:\s*3\.75rem/);
  });

  it("leaves room at the foot of every page to scroll clear of the launcher", () => {
    const shell = read("components/app-shell-v2/app-shell-v2.css");
    const block = rulesFor(shell, ".app-shell-v2-content").find((b) => b.includes("padding:"));
    const foot = Number(/padding:\s*\S+\s+\S+\s+(\d+)px/.exec(block ?? "")?.[1]);
    // The launcher is fixed 1.5rem from the bottom and 3rem tall.
    expect(foot).toBeGreaterThanOrEqual(24 + 48 + 16);
  });
});

describe("the mobile drawer shows one logo", () => {
  it("lowers the hexagon when it raises the wordmark", () => {
    const shell = read("components/app-shell-v2/app-shell-v2.css");
    const mark = rulesFor(shell, ".app-shell-v2-mobile-drawer .app-sidebar-v2-brand-mark");
    expect(mark.join("")).toContain("opacity: 0");
    const logo = rulesFor(shell, ".app-shell-v2-mobile-drawer .app-sidebar-v2-brand-logo");
    expect(logo.join("")).toContain("opacity: 1");
  });
});
