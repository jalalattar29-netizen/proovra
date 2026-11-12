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

describe("RT-008: a migrated select keeps its hooks and its reason", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  const options = [
    { value: "a", label: "Admin" },
    { value: "b", label: "Owner — above your role", disabled: true },
  ];

  it("passes data hooks and the description to the trigger", () => {
    render(
      <AppListbox
        ariaLabel="Role"
        value="a"
        onChange={() => undefined}
        options={options}
        triggerProps={{ "data-testid": "role", "aria-describedby": "why" }}
      />,
    );
    const trigger = screen.getByTestId("role");
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.getAttribute("aria-describedby")).toBe("why");
    expect(trigger.getAttribute("aria-label")).toBe("Role");
  });

  it("states why it is disabled, and only while disabled", () => {
    const { rerender } = render(
      <AppListbox
        ariaLabel="Role"
        value="a"
        onChange={() => undefined}
        options={options}
        disabled
        disabledReason="Only an Owner can change this."
      />,
    );
    expect(screen.getByRole("combobox").getAttribute("title")).toBe(
      "Only an Owner can change this.",
    );
    rerender(
      <AppListbox
        ariaLabel="Role"
        value="a"
        onChange={() => undefined}
        options={options}
        disabledReason="Only an Owner can change this."
      />,
    );
    expect(screen.getByRole("combobox").getAttribute("title")).toBeNull();
  });

  it("refuses a disabled option, as a native select does", async () => {
    const onChange = vi.fn();
    render(<AppListbox ariaLabel="Role" value="a" onChange={onChange} options={options} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /above your role/ }));
    expect(onChange).not.toHaveBeenCalled();
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

  // 2026-11-12 (owner decision): the launcher floats at the viewport's
  // bottom-right again, fixed while the page scrolls; the header holds no
  // assistant entry and no empty slot for one.
  it("floats fixed at the bottom-right, never in the header", () => {
    const dock = rulesFor(css, ".assistant-dock")[0];
    expect(dock).toContain("position: fixed");
    expect(dock).toContain("right: 1.5rem");
    expect(dock).toContain("bottom: 1.5rem");
    expect(read("components/app-shell-v2/AppAccountToolbar.tsx")).not.toContain("assistant");
    expect(read("components/app-shell-v2/app-shell-v2.css")).not.toContain("app-header-assistant-slot");
    const widget = read("components/ai/ProovraChatWidget.tsx");
    expect(widget).not.toContain("createPortal");
    expect(widget).not.toContain("app-header-assistant-slot");
  });

  it("leaves room at the foot of every page to scroll clear of the launcher", () => {
    const shell = read("components/app-shell-v2/app-shell-v2.css");
    const block = rulesFor(shell, ".app-shell-v2-content").find((b) => b.includes("padding:"));
    const foot = Number(/padding:\s*\S+\s+\S+\s+(\d+)px/.exec(block ?? "")?.[1]);
    // The launcher is fixed 1.5rem from the bottom and 3rem tall.
    expect(foot).toBeGreaterThanOrEqual(24 + 48 + 16);
  });
});

describe("narrow screens keep their data readable", () => {
  it("pins DataTable row actions only where there is room", () => {
    const table = read("components/ui/DataTable.tsx");
    expect(table).not.toMatch(/position: "sticky",\s+insetInlineEnd/);
    const primitives = read("components/app-primitives/app-primitives.css");
    const bare = primitives.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(bare).toMatch(
      /@media \(min-width: 721px\) \{\s*\[data-row-actions-head\],\s*\[data-row-actions\] \{\s*position: sticky;/,
    );
  });

  it("gives the phone assistant dock the width only while the panel is open", () => {
    const bare = read("components/ai/assistant.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const phone = bare.slice(bare.indexOf("@media (max-width: 640px)"));
    expect(rulesFor(phone, ".assistant-dock").join("")).not.toContain("left:");
    expect(rulesFor(phone, ".assistant-dock:has(.assistant-panel)").join("")).toContain("left:");
  });

  it("lets a public section be narrower than its widest table", () => {
    for (const file of ["app/pricing/page.tsx", "app/legal/[slug]/page.tsx"]) {
      const shrinkWrapped = [...read(file).matchAll(/<section className="([^"]*)"/g)]
        .map((match) => match[1])
        .filter((names) => /\bmx-auto\b/.test(names) && !/\bw-full\b/.test(names));
      expect(shrinkWrapped, file).toEqual([]);
    }
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
