/**
 * The typeahead menu must render ABOVE the workspace panels, and must not be
 * clipped by any ancestor.
 *
 * A source-text assertion cannot prove this: the defect was never in the
 * menu's own CSS. It was in its ANCESTRY — an `.app-panel` carrying
 * `backdrop-filter` and a workspace carrying `container-type: inline-size`,
 * each of which creates a stacking context, so the menu's `z-index: 30` was
 * only ever ordered inside the search panel while the workspace painted over
 * it. The proof has to be about where the element ends up in the tree.
 *
 * The fixture below reproduces that exact ancestry and asserts the menu
 * escapes it.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import * as React from "react";

import { AppAnchoredOverlay } from "../../components/app-primitives/AppAnchoredOverlay";

/** The ancestry that trapped the menu, rebuilt. */
function TrappingAncestry({
  open,
  onOutside,
}: {
  open: boolean;
  onOutside?: () => void;
}) {
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  return (
    <main className="search-page">
      {/* backdrop-filter → stacking context; overflow hidden → clipping. */}
      <div
        className="app-panel search-form-panel"
        data-fixture="form-panel"
        style={{ backdropFilter: "blur(8px)", overflow: "hidden" }}
      >
        <div className="search-form__field" ref={anchorRef} data-fixture="anchor">
          <input aria-label="Search query" />
        </div>
        <AppAnchoredOverlay
          anchorRef={anchorRef}
          open={open}
          onPointerDownOutside={onOutside}
          data-search-typeahead-overlay
        >
          <div className="search-typeahead" role="listbox" data-search-typeahead>
            <button type="button" data-search-typeahead-recent-row="alpha">
              alpha
            </button>
          </div>
        </AppAnchoredOverlay>
      </div>

      {/* container-type → contain: layout → a second stacking context, and it
          paints AFTER the panel above because it comes later in the DOM. */}
      <div
        className="search-workspace"
        data-fixture="workspace"
        style={{ containerType: "inline-size" }}
      >
        <div className="app-panel" data-fixture="results-panel">
          result card
        </div>
      </div>
    </main>
  );
}

const overlay = () =>
  document.querySelector<HTMLElement>("[data-search-typeahead-overlay]");

describe("Search typeahead — the menu escapes its ancestry", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("does not render inside the panel that would clip and trap it", () => {
    render(<TrappingAncestry open />);
    const el = overlay();
    expect(el).not.toBeNull();

    const formPanel = document.querySelector('[data-fixture="form-panel"]')!;
    const workspace = document.querySelector('[data-fixture="workspace"]')!;
    expect(formPanel.contains(el!)).toBe(false);
    expect(workspace.contains(el!)).toBe(false);
    // Exactly one ancestor: <body>. Nothing between it and the page can clip
    // it with `overflow`, or trap its layer with a stacking context.
    expect(el!.parentElement).toBe(document.body);
  });

  it("carries the canonical overlay layer, not a per-site number", () => {
    render(<TrappingAncestry open />);
    const el = overlay()!;
    expect(el.classList.contains("app-anchored-overlay")).toBe(true);
    // The layer comes from the stylesheet class; the element's own style
    // attribute carries measured geometry only — never a z-index.
    expect(el.style.zIndex).toBe("");
    expect(el.getAttribute("style")).not.toMatch(/z-index/i);
  });

  it("is anchored to the field's measured rect and moves no layout", () => {
    const anchorRect = {
      left: 120,
      top: 40,
      bottom: 90,
      right: 620,
      width: 500,
      height: 50,
      x: 120,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect;
    const proto = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return this.hasAttribute("data-fixture") &&
        this.getAttribute("data-fixture") === "anchor"
        ? anchorRect
        : proto.call(this);
    };
    try {
      render(<TrappingAncestry open />);
      const el = overlay()!;
      // `position: fixed` is the CLASS's job — the inline style carries
      // measured geometry only, which is why it may not carry a layer either.
      expect(el.classList.contains("app-anchored-overlay")).toBe(true);
      expect(el.style.left).toBe("120px");
      expect(el.style.width).toBe("500px");
      // Opens downward from the anchor's bottom edge, plus the 6px offset.
      expect(el.style.top).toBe("96px");
      // The anchor keeps its own box — the menu is out of flow entirely.
      const anchor = document.querySelector('[data-fixture="anchor"]')!;
      expect(anchor.querySelector("[data-search-typeahead]")).toBeNull();
    } finally {
      Element.prototype.getBoundingClientRect = proto;
    }
  });

  it("closes on an outside pointer, and not on one inside the menu", () => {
    let closed = 0;
    render(<TrappingAncestry open onOutside={() => (closed += 1)} />);

    // Inside the portaled menu — an "inside" click is NOT a DOM descendant of
    // the anchor, which is the case a naive contains() check gets wrong.
    const row = document.querySelector<HTMLElement>(
      "[data-search-typeahead-recent-row]",
    )!;
    act(() => {
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(closed).toBe(0);

    // Inside the anchor.
    const anchor = document.querySelector<HTMLElement>('[data-fixture="anchor"]')!;
    act(() => {
      anchor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(closed).toBe(0);

    // A result card below the field.
    const results = document.querySelector<HTMLElement>(
      '[data-fixture="results-panel"]',
    )!;
    act(() => {
      results.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(closed).toBe(1);
  });

  it("unmounts completely when closed, leaving nothing behind in the body", () => {
    const { rerender } = render(<TrappingAncestry open />);
    expect(overlay()).not.toBeNull();
    act(() => {
      rerender(<TrappingAncestry open={false} />);
    });
    expect(overlay()).toBeNull();
    expect(document.querySelector("[data-search-typeahead]")).toBeNull();
  });
});
