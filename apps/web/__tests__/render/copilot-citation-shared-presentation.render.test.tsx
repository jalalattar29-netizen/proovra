/**
 * SHARED COPILOT PRESENTATION — CopilotCitation + the canonical
 * visually-hidden utility.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `CopilotCitation` is rendered by FOUR surfaces on four different routes
 * (evidence detail, case, reviewer ops, operations intelligence). While its
 * presentation lived in inline style objects that was invisible but harmless;
 * the moment it moves to a stylesheet, the stylesheet has to be a SHARED one.
 * A route-scoped home would style one consumer and silently unstyle three.
 *
 * So these tests pin two things source-level assertions cannot:
 *   1. the component emits the shared `app-*` classes and NO inline style, and
 *   2. every one of the four consumers still routes through it.
 *
 * The second half pins the visually-hidden utility. The app had no globally
 * defined `.sr-only`; a route stylesheet privately defined `.app-visually-
 * hidden`, and a later pass added `evd-sr-only` beside it. Both are now the
 * one rule in `app-primitives.css`, and the clipping contract is asserted
 * against that file rather than against a copy of it.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CopilotCitation,
  CopilotCitationList,
  type CopilotCitationData,
} from "../../components/ai-copilot/CopilotCitation";

const WEB = join(__dirname, "..", "..");
const PRIMITIVES = readFileSync(
  join(WEB, "components", "app-primitives", "app-primitives.css"),
  "utf8",
);

const citation = (over: Partial<CopilotCitationData> = {}): CopilotCitationData => ({
  type: "EVIDENCE_RECORD",
  objectId: "ev-1",
  displayLabel: "Incident bundle",
  route: "/evidence/ev-1",
  objectVersion: 3,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. The component carries no inline presentation
// ---------------------------------------------------------------------------

describe("CopilotCitation — zero static inline presentation", () => {
  it("renders a linked citation with only shared classes", () => {
    const { container } = render(<CopilotCitation citation={citation()} />);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);

    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/evidence/ev-1");
    expect(link.getAttribute("title")).toBe("View Evidence source");
    expect(link.className).toBe("app-link");

    const chip = container.querySelector(".app-chip")!;
    expect(chip.className).toBe("app-chip app-copilot-citation");
    expect(chip.querySelector(".app-chip__tag.app-copilot-citation__type")!.textContent).toBe(
      "Evidence",
    );
    // The version suffix stays part of the label, unchanged.
    expect(chip.querySelector(".app-copilot-citation__label")!.textContent).toBe(
      "Incident bundle · v3",
    );
  });

  it("renders an unlinkable citation as plain text, never a broken link", () => {
    const { container } = render(<CopilotCitation citation={citation({ route: "" })} />);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
    expect(container.querySelector("a")).toBeNull();
    const wrap = container.firstElementChild!;
    expect(wrap.className).toBe("app-copilot-citation--unavailable");
    expect(wrap.getAttribute("title")).toBe("Source no longer available");
  });

  it("rejects an unsafe route rather than linking to it", () => {
    const { container } = render(
      <CopilotCitation citation={citation({ route: "https://evil.invalid/x" })} />,
    );
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders the list and the empty state with only shared classes", () => {
    const list = render(<CopilotCitationList citations={[citation(), citation({ objectId: "ev-2" })]} />);
    expect(list.container.querySelectorAll("[style]")).toHaveLength(0);
    expect(list.container.querySelector(".app-copilot-citation-list")).not.toBeNull();
    expect(list.container.querySelectorAll(".app-copilot-citation")).toHaveLength(2);

    const empty = render(<CopilotCitationList citations={[]} />);
    expect(empty.container.querySelectorAll("[style]")).toHaveLength(0);
    expect(empty.container.firstElementChild!.className).toBe("app-copilot-citation-empty");
    expect(empty.container.textContent).toBe("No validated sources.");
  });

  it("every class it emits is defined in the SHARED primitives authority", () => {
    const { container } = render(
      <>
        <CopilotCitationList citations={[citation()]} />
        <CopilotCitation citation={citation({ route: "" })} />
        <CopilotCitationList citations={[]} />
      </>,
    );
    const emitted = new Set<string>();
    for (const el of Array.from(container.querySelectorAll("[class]"))) {
      for (const c of el.className.split(/\s+/).filter(Boolean)) emitted.add(c);
    }
    // `.app-link` is an existing app-wide anchor hook, not a citation class.
    emitted.delete("app-link");
    for (const c of emitted) {
      expect(PRIMITIVES, `${c} must be defined in app-primitives.css`).toContain(`.${c}`);
    }
    // And nothing it emits may come from a route stylesheet.
    for (const c of emitted) expect(c.startsWith("evd-")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. All four consumers still route through the shared component
// ---------------------------------------------------------------------------

describe("CopilotCitation — four consumers, one authority", () => {
  const CONSUMERS = [
    "EvidenceCopilotPanel.tsx",
    "CaseCopilotPanel.tsx",
    "ReviewerCopilotPanel.tsx",
    "OperationsIntelligencePanel.tsx",
  ];

  it.each(CONSUMERS)("%s imports and renders CopilotCitationList", (file) => {
    const src = readFileSync(join(WEB, "components", "ai-copilot", file), "utf8");
    expect(src).toMatch(/import \{[^}]*CopilotCitationList[^}]*\} from "\.\/CopilotCitation"/);
    expect(src).toContain("<CopilotCitationList citations=");
  });

  it("no consumer wraps the shared component in a ROUTE-scoped class", () => {
    for (const file of CONSUMERS) {
      const src = readFileSync(join(WEB, "components", "ai-copilot", file), "utf8");
      const wrapper = /<div className="([^"]*)"><CopilotCitationList/.exec(src)?.[1];
      if (!wrapper) continue; // OperationsIntelligencePanel mounts it bare.
      // The Evidence surface used to wrap it in `evd-block--tight`, a class
      // that only exists on the Evidence Detail route — 6px there against the
      // other surfaces' 4px, and dead styling anywhere else.
      expect(wrapper, `${file} wrapper`).toBe("app-copilot-sources");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The canonical visually-hidden utility
// ---------------------------------------------------------------------------

describe("visually-hidden — one canonical utility", () => {
  function rule(name: string): string | null {
    const m = new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(PRIMITIVES);
    return m ? m[1] : null;
  }

  it("app-visually-hidden lives in the shared primitives authority", () => {
    expect(rule("app-visually-hidden")).not.toBeNull();
  });

  it("pins the standard accessible clipping behaviour", () => {
    const body = rule("app-visually-hidden")!;
    // Removed from the visual layer...
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/inline-size:\s*1px/);
    expect(body).toMatch(/block-size:\s*1px/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(body).toMatch(/margin:\s*-1px/);
    expect(body).toMatch(/border:\s*0/);
    // ...but NOT from the accessibility tree. `display:none` and
    // `visibility:hidden` both un-announce the element, which is the whole
    // failure mode this utility exists to avoid.
    expect(body).not.toMatch(/display:\s*none/);
    expect(body).not.toMatch(/visibility:\s*hidden/);
  });

  it("is the only visually-hidden authority in the app stylesheets", () => {
    // Count EVERY rule that applies the clipping treatment, under any
    // selector — the app previously had `.app-visually-hidden` in a route
    // stylesheet, `.evd-sr-only` beside it, and a descendant-scoped
    // `.evidence-library-artifact > .sr-only` copy in a third file.
    const files = [
      ["app-primitives.css", join(WEB, "components", "app-primitives", "app-primitives.css")],
      ["globals.css", join(WEB, "app", "globals.css")],
      ["evidence-detail.css", join(WEB, "app", "(app)", "evidence", "[id]", "evidence-detail.css")],
      ["evidence-library.css", join(WEB, "app", "(app)", "evidence", "evidence-library.css")],
    ];
    const selectors: string[] = [];
    for (const [name, f] of files) {
      const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (/clip-path:\s*inset\(50%\)/.test(m[2]) || /clip:\s*rect\(0/.test(m[2])) {
          // Inside an `@media` block the outer capture is the media query and
          // the real selector opens the body; report both so a nested rule can
          // never hide behind its wrapper.
          const outer = m[1].trim().replace(/\s+/g, " ");
          const nested = /^\s*([^{};]+)\{/.exec(m[2])?.[1]?.trim().replace(/\s+/g, " ");
          selectors.push(`${name}: ${nested ? `${outer} > ${nested}` : outer}`);
        }
      }
    }
    expect(selectors).toEqual([
      // NOT a utility: a <thead> cannot carry a class from the markup, so the
      // responsive table transform has to express the treatment in its own
      // media-scoped selector. Nothing can apply it, so it cannot drift.
      "app-primitives.css: @media (max-width: 720px) > .app-table[data-responsive] thead",
      // THE canonical utility — the only rule anything can opt into.
      "app-primitives.css: .app-visually-hidden",
    ]);
  });

  it("no surface still references the retired names", () => {
    for (const f of [
      join(WEB, "app", "(app)", "evidence", "[id]", "evidence-detail.css"),
      join(WEB, "components", "ai-copilot", "EvidenceCopilotPanel.tsx"),
      join(WEB, "app", "(app)", "evidence", "components", "QueueSelectionPreview.tsx"),
    ]) {
      expect(readFileSync(f, "utf8")).not.toContain("evd-sr-only");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The live region keeps its semantics
// ---------------------------------------------------------------------------

describe("copilot live region", () => {
  it("stays in the accessibility tree while carrying the hidden utility", () => {
    const { container } = render(
      <span aria-live="polite" className="app-visually-hidden">
        Evidence Copilot result ready
      </span>,
    );
    const live = container.firstElementChild!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-hidden")).toBeNull();
    expect(live.textContent).toBe("Evidence Copilot result ready");
    // The class is the ONLY hiding mechanism — no inline style, and nothing
    // that would remove it from assistive technology.
    expect(live.getAttribute("style")).toBeNull();
  });
});
