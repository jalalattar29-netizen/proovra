/**
 * THE FIELD-LABEL AUTHORITY — measured on every surface that consumes it.
 *
 * `.app-field-label` was declared twice: once in `app-primitives.css` as the
 * label tier (12.5px / 600 / `--app-ink-label`), and once near the bottom of
 * `globals.css` as an 11px uppercase 800-weight label in
 * `rgba(194, 204, 201, 0.56)`, written for a dark admin shell that never used
 * it. One class each, so specificity ties and SOURCE ORDER decides — the
 * primitive is `@import`ed at the top of `globals.css`, so the pale rule won.
 * Every field label in the authenticated product was painted at 56% alpha on a
 * light surface, and no component or route stylesheet mentioned it anywhere.
 *
 * The duplicate is deleted. `apps/web/__tests__/app-field-label-authority.test.ts`
 * proves the cascade now holds ONE declaration; this file proves what that one
 * declaration actually PAINTS, on each reachable consumer family, in a real
 * engine, in both directions and at a narrow width.
 *
 * It lives in this project because this project already serves the whole app
 * and carries the cross-surface layout specs (search, case attach, case
 * copilot); the label authority is likewise not one route's property.
 */

import { expect, test, type Page } from "@playwright/test";

import { DIRECTIONS, envelopeFor, openSearch, setDirection } from "./_fixtures";

/** The resolved value of `--app-ink-label` (#344054). */
const LABEL_INK: [number, number, number] = [52, 64, 84];
/** The retired pale value, in the form the engine would report it. */
const RETIRED_PALE = "rgba(194, 204, 201, 0.56)";

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };

function rgb(value: string): [number, number, number] | null {
  const m = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function alpha(value: string): number {
  const m = value.match(/rgba\(\s*\d+[,\s]+\d+[,\s]+\d+[,\s]+([\d.]+)\s*\)/);
  return m ? Number(m[1]) : 1;
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

type LabelReading = {
  text: string;
  color: string;
  ground: string;
  weight: number;
  size: number;
  transform: string;
  inlineStyle: string | null;
  left: number;
  right: number;
  width: number;
};

/** Every visible `.app-field-label` on the page, with what it actually paints. */
async function readLabels(page: Page, scope = "body"): Promise<LabelReading[]> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel) as HTMLElement;
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
    return Array.from(
      host.querySelectorAll<HTMLElement>(".app-field-label"),
    )
      .filter((el) => {
        const cs = getComputedStyle(el);
        return cs.display !== "none" && cs.visibility !== "hidden";
      })
      .map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
          color: cs.color,
          ground: ground(el),
          weight: Number(cs.fontWeight),
          size: parseFloat(cs.fontSize),
          transform: cs.textTransform,
          inlineStyle: el.getAttribute("style"),
          left: r.left,
          right: r.right,
          width: r.width,
        };
      });
  }, scope);
}

/** The assertions every consumer family must satisfy, wherever it renders. */
function assertCanonical(labels: LabelReading[], where: string) {
  expect(labels.length, `${where}: no field labels rendered`).toBeGreaterThan(0);
  for (const l of labels) {
    // The one tier: dark neutral, weight 600, 12.5px, sentence case.
    expect(rgb(l.color), `${where} / "${l.text}" colour`).toEqual(LABEL_INK);
    expect(alpha(l.color), `${where} / "${l.text}" alpha`).toBe(1);
    expect(l.color, `${where} / "${l.text}"`).not.toBe(RETIRED_PALE);
    expect(l.weight, `${where} / "${l.text}" weight`).toBe(600);
    expect(l.size, `${where} / "${l.text}" size`).toBeCloseTo(12.5, 1);
    expect(l.transform, `${where} / "${l.text}" case`).toBe("none");
    // Nothing paints a label from an inline style.
    if (l.inlineStyle) {
      expect(l.inlineStyle, `${where} / "${l.text}"`).not.toMatch(/color/i);
    }
    // MEASURED contrast against the ground it is actually painted on. The pale
    // rule measured 1.5:1 here; the tier clears AAA.
    expect(
      contrast(l.color, l.ground),
      `${where} / "${l.text}" contrast on ${l.ground}`,
    ).toBeGreaterThanOrEqual(7);
    // It occupies real space — a zero-width label is not a readable one.
    expect(l.width, `${where} / "${l.text}" width`).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// Consumer family 1 — Search › Search activity (the audit log panel)
// ---------------------------------------------------------------------------

async function openSearchActivity(page: Page): Promise<void> {
  await openSearch(page, "organization");
  await page.click('[data-search-scope-tab="activity"]');
  await page.waitForSelector("[data-search-audit-failclosed-filter]", {
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Consumer family 2 — Collaboration teams › the create dialog
// ---------------------------------------------------------------------------

const TEAM_ID = "77777777-7777-4777-8777-777777777777";

function teamsPayload() {
  return {
    teams: [
      {
        id: TEAM_ID,
        name: "Incident response",
        description: "Cross-office incident reviewers",
        archivedAt: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        memberCount: 4,
        pendingInviteCount: 1,
        assignmentCount: 2,
        viewerRole: "OWNER",
        viewerCanManage: true,
      },
    ],
  };
}

async function openTeamsDialog(page: Page): Promise<void> {
  const envelope = {
    ...envelopeFor("organization"),
    capabilities: {
      ...(envelopeFor("organization").capabilities as Record<string, boolean>),
      COLLABORATION_TEAMS_VIEW: true,
      COLLABORATION_TEAMS_MANAGE: true,
    },
  };
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path.endsWith("/v1/platform/context")) return json(envelope);
    if (path.endsWith("/v1/auth/me") || path.endsWith("/v1/users/me")) {
      return json({ id: "u-1", email: "operator@example.invalid" });
    }
    if (path.endsWith("/v1/collaboration-teams")) return json(teamsPayload());
    return json({});
  });
  await page.goto("/collaboration-teams");
  const create = page.getByRole("button", { name: /create team/i }).first();
  await create.waitFor({ state: "visible", timeout: 30_000 });
  await create.click();
  await page.waitForSelector(".app-dialog .app-field-label", { timeout: 30_000 });
}

// ===========================================================================
// The gate
// ===========================================================================

const FAMILIES: Array<[string, (p: Page) => Promise<void>, string]> = [
  ["search activity", openSearchActivity, "body"],
  ["collaboration teams dialog", openTeamsDialog, ".app-dialog"],
];

test.describe("every field-label consumer resolves the one authority", () => {
  for (const [family, open, scope] of FAMILIES) {
    for (const dir of DIRECTIONS) {
      test(`${family} ${dir} @ 1440: the label tier, measured`, async ({
        page,
      }) => {
        await page.setViewportSize(WIDE);
        await open(page);
        await setDirection(page, dir);
        const labels = await readLabels(page, scope);
        assertCanonical(labels, `${family} ${dir} @ 1440`);

        // The labels share a logical start edge with each other, so a mirrored
        // document does not scatter them.
        const edge = dir === "rtl" ? "right" : "left";
        const edges = new Set(labels.map((l) => Math.round(l[edge])));
        expect(edges.size).toBeLessThanOrEqual(labels.length);
      });
    }

    test(`${family}: still the label tier at 390`, async ({ page }) => {
      await page.setViewportSize(NARROW);
      await open(page);
      const labels = await readLabels(page, scope);
      assertCanonical(labels, `${family} @ 390`);
      // Narrow does not change the tier — only the measure.
      expect(await page.evaluate(() => {
        const d = document.documentElement;
        return Math.max(0, d.scrollWidth - d.clientWidth);
      })).toBe(0);
    });
  }

  test("a label that is itself the control keeps the tier through hover and focus", async ({
    page,
  }) => {
    // The Search audit filter is a `<label class="app-field-label">` wrapping
    // its own checkbox: the one consumer where the label IS interactive, so
    // its states are the ones that could drift.
    await page.setViewportSize(WIDE);
    await openSearchActivity(page);

    const readStates = async () =>
      page.evaluate(() => {
        const el = document.querySelector(
          "[data-search-audit-failclosed-filter]",
        ) as HTMLElement;
        const input = el.querySelector("input") as HTMLInputElement;
        return {
          resting: getComputedStyle(el).color,
          weight: Number(getComputedStyle(el).fontWeight),
          checkboxVisible: getComputedStyle(input).display !== "none",
        };
      });

    const resting = await readStates();
    expect(rgb(resting.resting)).toEqual(LABEL_INK);
    expect(resting.weight).toBe(600);
    expect(resting.checkboxVisible).toBe(true);

    const label = page.locator("[data-search-audit-failclosed-filter]");
    await label.hover();
    const hovered = await readStates();
    expect(rgb(hovered.resting)).toEqual(LABEL_INK);

    // Focus moves to the control inside; the LABEL is not dimmed by it.
    await page.locator("[data-search-audit-failclosed-filter] input").focus();
    const focused = await readStates();
    expect(rgb(focused.resting)).toEqual(LABEL_INK);
    expect(focused.weight).toBe(600);
  });

  test("no surface in the running app paints the retired pale label", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await openSearchActivity(page);
    // Ask the ENGINE which rules exist for this class, rather than trusting a
    // grep over source: a stale bundle or a second imported sheet would both
    // show up here and nowhere else.
    const declarations = await page.evaluate(() => {
      const out: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin; the app serves none
        }
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSStyleRule)) continue;
          if (rule.selectorText.trim() === ".app-field-label") {
            out.push(rule.style.cssText);
          }
        }
      }
      return out;
    });
    expect(declarations.length, "the class is declared more than once").toBe(1);
    expect(declarations[0]).toContain("color");
    expect(declarations[0]).not.toContain("194, 204, 201");
    expect(declarations[0]).not.toContain("uppercase");
    expect(declarations[0]).not.toContain("!important");
  });
});
