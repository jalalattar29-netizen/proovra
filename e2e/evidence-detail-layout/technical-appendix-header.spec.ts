/**
 * SECTION-HEADER HIERARCHY — Evidence Detail › Technical Appendix.
 *
 * "Technical Evidence Context" and the sentence that explains it were painted
 * as two COLUMNS of one flex row: the heading on the left, its description
 * beside it, the row split awkwardly in half. They are a title and its
 * description — two ROWS.
 *
 * A class name cannot answer that. `display: flex` on the parent, an absent
 * wrapper, or a `gap` that resolves to nothing all leave the markup looking
 * correct while the engine paints a row. Every assertion below reads a real
 * box out of the real production bundle.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  DIRECTIONS,
  VIEWPORTS,
  openTechnicalAppendix,
  setDirection,
  type EvidenceContext,
} from "./_fixtures";

const CONTEXTS: EvidenceContext[] = ["personal", "organization", "enterprise"];

const TITLE = "Technical Evidence Context";
const DESCRIPTION_HEAD = "The same acquisition, device, media and integrity";

type HeaderBox = {
  title: { top: number; bottom: number; left: number; right: number; text: string };
  description: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    text: string;
  };
  copy: { left: number; right: number; width: number };
  intro: { left: number; right: number; width: number };
  titleLines: number;
  descriptionLines: number;
  gap: number;
  columnGap: string;
  flexDirection: string;
  titleColor: string;
  descriptionColor: string;
  titleWeight: number;
  descriptionWeight: number;
  titleSize: number;
  descriptionSize: number;
  descriptionLineHeight: number;
  descriptionMargin: string;
  ground: string;
  documentOverflow: number;
};

/** Read the section header's real boxes. */
async function readHeader(page: Page): Promise<HeaderBox> {
  return page.evaluate(() => {
    const root = document.querySelector(
      '[data-testid="evidence-technical-appendix"]',
    ) as HTMLElement;
    const intro = root.querySelector(".ta-intro") as HTMLElement;
    const copy = intro.querySelector(".ta-intro-copy") as HTMLElement;
    const title = intro.querySelector(".ta-intro-title") as HTMLElement;
    const description = intro.querySelector(".ta-intro-sub") as HTMLElement;

    const box = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    };
    const lines = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      return Math.max(
        1,
        Math.round(
          el.getBoundingClientRect().height / parseFloat(cs.lineHeight),
        ),
      );
    };

    /** Walk up to whatever actually paints a ground. */
    const ground = (el: HTMLElement): string => {
      let node: HTMLElement | null = el;
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        const m = bg.match(
          /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/,
        );
        if (m && (m[4] === undefined || Number(m[4]) > 0.6)) return bg;
        node = node.parentElement;
      }
      return "rgb(255, 255, 255)";
    };

    const copyRect = copy.getBoundingClientRect();
    const introRect = intro.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const descRect = description.getBoundingClientRect();
    const descCs = getComputedStyle(description);
    const titleCs = getComputedStyle(title);
    const doc = document.documentElement;

    return {
      title: box(title),
      description: box(description),
      copy: { left: copyRect.left, right: copyRect.right, width: copyRect.width },
      intro: {
        left: introRect.left,
        right: introRect.right,
        width: introRect.width,
      },
      titleLines: lines(title),
      descriptionLines: lines(description),
      gap: descRect.top - titleRect.bottom,
      columnGap: getComputedStyle(copy).rowGap,
      flexDirection: getComputedStyle(copy).flexDirection,
      titleColor: titleCs.color,
      descriptionColor: descCs.color,
      titleWeight: Number(titleCs.fontWeight),
      descriptionWeight: Number(descCs.fontWeight),
      titleSize: parseFloat(titleCs.fontSize),
      descriptionSize: parseFloat(descCs.fontSize),
      descriptionLineHeight: parseFloat(descCs.lineHeight),
      descriptionMargin: descCs.margin,
      ground: ground(description),
      documentOverflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
    };
  });
}

/** Parse `rgb(...)` into a triple. */
function rgb(value: string): [number, number, number] | null {
  const m = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: string, b: string): number {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return 0;
  const l1 = luminance(x);
  const l2 = luminance(y);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ===========================================================================
// The hierarchy itself
// ===========================================================================

test.describe("the section header is two rows, not two columns", () => {
  for (const context of CONTEXTS) {
    for (const vp of VIEWPORTS) {
      for (const dir of DIRECTIONS) {
        test(`${context} ${dir} @ ${vp.name}: heading above its description`, async ({
          page,
        }) => {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await openTechnicalAppendix(page, context);
          await setDirection(page, dir);
          const h = await readHeader(page);

          // 1. The two elements are the copy this section promises.
          expect(h.title.text).toBe(TITLE);
          expect(h.description.text.startsWith(DESCRIPTION_HEAD)).toBe(true);

          // 2. SEPARATE ROWS. The description starts below the heading ends —
          //    the defect was a description whose box began beside it.
          expect(
            h.description.top,
            `${dir} @ ${vp.name}: description is not below the heading`,
          ).toBeGreaterThanOrEqual(h.title.bottom - 0.5);
          // Their painted boxes cannot overlap vertically.
          const overlaps =
            h.title.top < h.description.bottom - 0.5 &&
            h.description.top < h.title.bottom - 0.5;
          expect(overlaps).toBe(false);

          // 3. The same LOGICAL start edge, in both directions.
          const startEdge = dir === "rtl" ? "right" : "left";
          expect(
            Math.abs(h.title[startEdge] - h.description[startEdge]),
            `${dir} @ ${vp.name}: the two rows do not share a start edge`,
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(h.title[startEdge] - h.copy[startEdge]),
          ).toBeLessThanOrEqual(1);

          // 4. A compact, real vertical gap owned by ONE declaration.
          expect(h.flexDirection).toBe("column");
          expect(h.columnGap).toBe("4px");
          expect(h.descriptionMargin).toBe("0px");
          expect(h.gap).toBeGreaterThan(0);
          expect(h.gap).toBeLessThanOrEqual(8);

          // 5. Typography hierarchy survives: the heading is larger and
          //    heavier, the description carries the canonical secondary ink
          //    and a readable line height.
          expect(h.titleSize).toBeGreaterThan(h.descriptionSize + 3);
          expect(h.titleWeight).toBeGreaterThan(h.descriptionWeight);
          expect(rgb(h.descriptionColor)).toEqual([102, 112, 133]);
          expect(h.descriptionLineHeight / h.descriptionSize).toBeGreaterThanOrEqual(
            1.4,
          );
          expect(
            contrast(h.descriptionColor, h.ground),
            `${dir} @ ${vp.name}: description contrast`,
          ).toBeGreaterThanOrEqual(4.5);

          // 6. Nothing clips and nothing scrolls the page sideways.
          expect(h.documentOverflow).toBe(0);
          expect(h.title.right - h.title.left).toBeGreaterThan(0);
          expect(h.copy.width).toBeGreaterThan(0);
          expect(h.title.left).toBeGreaterThanOrEqual(h.intro.left - 1);
          expect(h.title.right).toBeLessThanOrEqual(h.intro.right + 1);
          expect(h.description.left).toBeGreaterThanOrEqual(h.intro.left - 1);
          expect(h.description.right).toBeLessThanOrEqual(h.intro.right + 1);
        });
      }
    }
  }

  test("the heading occupies one line at every supported width", async ({
    page,
  }) => {
    for (const vp of VIEWPORTS) {
      for (const dir of DIRECTIONS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await openTechnicalAppendix(page, "organization");
        await setDirection(page, dir);
        const h = await readHeader(page);
        // Not forced — measured. "Context" is never pushed onto its own line,
        // and the heading is never artificially narrowed to make it happen.
        expect(h.titleLines, `${dir} @ ${vp.name}: heading wrapped`).toBe(1);
        // The description is free to wrap; that is what a description does.
        expect(h.descriptionLines).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("the copy column takes the row, so the two never share a track", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTechnicalAppendix(page, "organization");
    const measured = await page.evaluate(() => {
      const intro = document.querySelector(
        '[data-testid="evidence-technical-appendix"] .ta-intro',
      ) as HTMLElement;
      return {
        // The horizontal axis carries the copy column and nothing else here.
        childClasses: Array.from(intro.children).map((c) => c.className),
        introDirection: getComputedStyle(intro).flexDirection,
        copyWidth: (
          intro.querySelector(".ta-intro-copy") as HTMLElement
        ).getBoundingClientRect().width,
        introWidth: intro.getBoundingClientRect().width,
      };
    });
    expect(measured.introDirection).toBe("row");
    expect(measured.childClasses).toEqual(["ta-intro-copy"]);
    // The column really takes the row it is given.
    expect(measured.copyWidth).toBeCloseTo(measured.introWidth, 0);
  });

  test("the appendix data and behaviour are untouched by the header change", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTechnicalAppendix(page, "organization");
    const measured = await page.evaluate(() => {
      const root = document.querySelector(
        '[data-testid="evidence-technical-appendix"]',
      ) as HTMLElement;
      return {
        cards: root.querySelectorAll(".ta-card").length,
        sections: Array.from(
          root.querySelectorAll<HTMLElement>("[data-testid^='ta-section-']"),
        ).map((el) => el.getAttribute("data-testid")),
        rows: root.querySelectorAll(".ta-row, .ta-meta-row").length,
        headings: Array.from(root.querySelectorAll("h2")).map((h) =>
          (h.textContent ?? "").trim(),
        ),
      };
    });
    // Ten context cards, one section heading — the section still says
    // everything it said before, in the same structure.
    expect(measured.cards).toBeGreaterThanOrEqual(8);
    expect(measured.sections).toContain("ta-section-acquisition");
    expect(measured.sections).toContain("ta-section-capture-device");
    expect(measured.headings).toEqual([TITLE]);
    expect(measured.rows).toBeGreaterThan(10);
  });
});

// ===========================================================================
// The guard bites
// ===========================================================================

test("removing the copy column reproduces the split — so this gate is load-bearing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTechnicalAppendix(page, "organization");

  const fixed = await readHeader(page);
  expect(fixed.description.top).toBeGreaterThanOrEqual(fixed.title.bottom - 0.5);

  // Put the title and the sentence back on the horizontal axis, exactly as the
  // defective markup did, and measure what the engine then paints. If this
  // still measured as two rows the assertions above would be proving nothing.
  const split = await page.evaluate(() => {
    const intro = document.querySelector(
      '[data-testid="evidence-technical-appendix"] .ta-intro',
    ) as HTMLElement;
    const copy = intro.querySelector(".ta-intro-copy") as HTMLElement;
    while (copy.firstChild) intro.appendChild(copy.firstChild);
    copy.remove();
    const title = intro.querySelector(".ta-intro-title") as HTMLElement;
    const sub = intro.querySelector(".ta-intro-sub") as HTMLElement;
    const t = title.getBoundingClientRect();
    const s = sub.getBoundingClientRect();
    return { titleBottom: t.bottom, subTop: s.top, titleRight: t.right, subLeft: s.left };
  });

  // Side by side: the sentence begins after the heading ends horizontally, and
  // starts ABOVE where the heading ends vertically. That is the reported split.
  expect(split.subTop).toBeLessThan(split.titleBottom - 0.5);
  expect(split.subLeft).toBeGreaterThanOrEqual(split.titleRight - 0.5);
});
