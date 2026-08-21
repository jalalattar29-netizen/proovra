/**
 * STRUCTURAL VERIFICATION — Case Details → Evidence Operations Copilot.
 *
 * The panel's geometry is the half of its redesign source text cannot describe:
 * whether the evidence selector keeps a bounded height instead of deciding the
 * rail's, whether the Run action stays reachable, whether a long filename wraps
 * inside its row, whether the pre-run facts reflow, and whether the whole thing
 * mirrors correctly in RTL.
 *
 * The unbounded list was the specific defect: with a dozen linked records the
 * rail grew past the viewport and the primary action left the screen.
 */

import { expect, test, type Page } from "@playwright/test";

import { evaluateCopilotEvidenceEligibility } from "../../packages/shared/src/ai-copilot-selection";
import { buildEvidenceAnalysisRevision } from "../../packages/shared-runtime/src/evidence-analysis-revision";

import { DIRECTIONS, VIEWPORTS, envelopeFor, setDirection } from "./_fixtures";

const CASE_ID = "c1000000-0000-4000-8000-000000000001";
/** The tenant the matter-workspace fixture below projects. */
const TEAM_ID = "44444444-4444-4444-8444-444444444444";

/** The case surface's capabilities. The Search envelope grants only SEARCH_VIEW. */
function caseEnvelope(): Record<string, unknown> {
  const base = envelopeFor("organization");
  return {
    ...base,
    capabilities: {
      ...(base.capabilities as Record<string, boolean>),
      CASES_VIEW: true,
      CASES_MANAGE: true,
      EVIDENCE_VIEW: true,
    },
  };
}

const LONG_NAME =
  "Q4-incident-bundle-with-an-extremely-long-operator-supplied-filename-that-nobody-would-shorten-2026-08-20-final-v7-REVIEWED.jpg";

/**
 * Enough linked evidence that an unbounded list would run off the page.
 *
 * ANALYSIS REVISION IS PART OF THE CONTRACT, not an optional extra. The
 * matter-workspace projection computes one per record with
 * `evidenceAnalysisRevisionFor`, and `evaluateCopilotEvidenceEligibility`
 * refuses any record whose revision it cannot read — the panel declares
 * `analysisRevisionKnown: true`, so an absent revision is a refusal, not a
 * default. A fixture without one therefore produced twelve INELIGIBLE records,
 * an empty eligible set, and a permanently disabled "Select all": the geometry
 * assertions below never reached the state they exist to measure.
 *
 * The value is built here by the SAME function the server builds it with, over
 * the same facts, so the fixture cannot drift into a shape the product would
 * never send.
 */
function analysisRevisionFor(i: number, id: string): string {
  return buildEvidenceAnalysisRevision(
    {
      id,
      teamId: TEAM_ID,
      title: i === 0 ? LONG_NAME : `incident-bundle-${i}.jpg`,
      type: i % 3 === 0 ? "PHOTO" : i % 3 === 1 ? "VIDEO" : "DOCUMENT",
      mimeType: "image/jpeg",
      status: i % 4 === 3 ? "UPLOADING" : "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      captureMethod: "WEB_UPLOAD",
      tsaStatus: "RECORDED",
      otsStatus: "ANCHORED",
      createdAtUtc: "2026-08-01T00:00:00.000Z",
      partCount: 1,
      custodyEventCount: 2,
      caseLinkCount: 1,
      latestReportVersion: 2,
      verificationPackageVersion: i % 2 === 0 ? 2 : 0,
      lifecycleState: "ACTIVE",
      deletedAt: null,
      archivedAt: null,
    },
    { scope: "case", scopeId: CASE_ID, linkedToScope: true },
  );
}

function evidenceItems(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const id = `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    return {
      id,
      title: i === 0 ? LONG_NAME : `incident-bundle-${i}.jpg`,
      displayFileName: i === 0 ? LONG_NAME : `incident-bundle-${i}.jpg`,
      originalFileName: `incident-bundle-${i}.jpg`,
      mimeType: "image/jpeg",
      itemCount: 1,
      type: i % 3 === 0 ? "PHOTO" : i % 3 === 1 ? "VIDEO" : "DOCUMENT",
      // A mixture, so eligible and ineligible rows are both measured.
      status: i % 4 === 3 ? "UPLOADING" : "REPORTED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      lifecycleState: "ACTIVE",
      createdAt: "2026-08-01T00:00:00.000Z",
      reportReady: true,
      packageReady: i % 2 === 0,
      verificationPackageVersion: i % 2 === 0 ? 2 : 0,
      analysisRevision: analysisRevisionFor(i, id),
      caseLinked: true,
      stale: false,
      linkId: `l${i}`,
      linkRole: "SUPPORTING",
      linkSource: "USER",
    };
  });
}

/** How many of `evidenceItems(n)` the canonical authority calls eligible. */
function eligibleCount(n: number): number {
  return evidenceItems(n).filter(
    (e) =>
      evaluateCopilotEvidenceEligibility({
        status: e.status,
        lifecycleState: e.lifecycleState,
        caseLinked: e.caseLinked,
        stale: e.stale,
        analysisRevision: e.analysisRevision as never,
        analysisRevisionKnown: true,
      }).eligible,
  ).length;
}

function matterWorkspace(n: number) {
  const iso = "2026-07-11T00:00:00.000Z";
  const section = (extra: Record<string, unknown>) => ({ status: "ok", ...extra });
  return {
    generatedAt: iso,
    case: {
      id: CASE_ID,
      name: "Bilal",
      referenceNumber: null,
      description: null,
      status: "OPEN",
      priority: "P2",
      scope: "TEAM",
      ownerUserId: "u-1",
      teamId: TEAM_ID,
      closedAtUtc: null,
      closureReason: null,
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: iso,
    },
    viewer: {
      userId: "u-1",
      role: "OWNER",
      canManage: true,
      canMutate: true,
      canAssign: true,
      canChangeStatus: true,
      canLinkEvidence: true,
      canUnlinkEvidence: true,
      canUnlinkLegacyEvidence: true,
      canComment: true,
      canResolveComment: true,
      disabledReasons: {},
      activeAssignmentRoles: [],
    },
    risk: { status: "ok", data: null, sampledAtUtc: iso },
    sections: {
      commandSummary: section({
        data: {
          linkedEvidenceCount: n,
          recentlyLinkedCount: 0,
          activeCaseHoldsCount: 0,
          affectedEvidenceHoldsCount: 0,
          pendingReviewCount: 0,
          openEscalationsCount: 0,
          activeAssignmentCount: 0,
        },
      }),
      evidence: section({ items: evidenceItems(n) }),
      relationships: section({
        links: [],
        relationships: [],
        counts: {
          primary: 0,
          supporting: 0,
          related: 0,
          duplicate: 0,
          derived: 0,
          context: 0,
        },
      }),
      workflows: section({ items: [] }),
      incidentsAndCausality: section({ incidents: [], chains: [] }),
      governance: section({ holds: [], retention: [], items: [] }),
      assignments: section({ items: [] }),
      comments: section({ items: [] }),
      activity: section({ items: [] }),
      timeline: section({ items: [] }),
    },
  };
}

async function openCase(page: Page, n = 14): Promise<void> {
  const envelope = caseEnvelope();
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path.endsWith("/v1/platform/context")) return json(envelope);
    if (path.endsWith("/matter-workspace")) return json(matterWorkspace(n));
    if (path.endsWith("/v1/auth/me") || path.endsWith("/v1/users/me")) {
      return json({ id: "u-1", email: "operator@example.invalid" });
    }
    return json({});
  });
  await page.goto(`/cases/${CASE_ID}`);
  // The Copilot lives in the EVIDENCE tab, beside the evidence list — not on
  // Overview, which is where the route opens.
  const tab = page.locator('[data-simple-case-tab="evidence"]');
  await tab.waitFor({ state: "visible", timeout: 30_000 });
  await tab.click();
  await page.waitForSelector("[data-case-copilot]", { timeout: 30_000 });
  await page.waitForSelector("[data-case-copilot-row]", { timeout: 30_000 });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

for (const viewport of VIEWPORTS) {
  for (const dir of DIRECTIONS) {
    test.describe(`Copilot ${viewport.name}px ${dir}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await openCase(page);
        await setDirection(page, dir);
      });

      test("the page does not scroll sideways and nothing escapes the panel", async ({
        page,
      }) => {
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
        const escaped = await page.evaluate(() => {
          const panel = document.querySelector("[data-case-copilot]") as HTMLElement;
          const rp = panel.getBoundingClientRect();
          const out: string[] = [];
          for (const el of Array.from(panel.querySelectorAll<HTMLElement>("*"))) {
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (r.left < rp.left - 1 || r.right > rp.right + 1) {
              out.push(
                `${el.tagName.toLowerCase()}.${String(el.getAttribute("class")).slice(0, 40)}`,
              );
            }
          }
          return out;
        });
        expect(escaped).toEqual([]);
      });

      test("the evidence selector is BOUNDED and scrolls internally", async ({
        page,
      }) => {
        // THE DEFECT: an unbounded list made the rail's height a function of how
        // much evidence a case happened to have.
        const measured = await page.evaluate(() => {
          const list = document.querySelector(
            "[data-case-copilot-list]",
          ) as HTMLElement;
          const panel = document.querySelector("[data-case-copilot]") as HTMLElement;
          return {
            clientHeight: list.clientHeight,
            scrollHeight: list.scrollHeight,
            panelHeight: panel.getBoundingClientRect().height,
            viewport: window.innerHeight,
          };
        });
        // Fourteen records exceed the ceiling, so the list is the scroller.
        expect(measured.scrollHeight).toBeGreaterThan(measured.clientHeight);
        // …and the whole panel still fits a sane multiple of the viewport.
        expect(measured.panelHeight).toBeLessThan(measured.viewport * 2.2);
      });

      test("the Run action stays reachable below the selector", async ({ page }) => {
        const geometry = await page.evaluate(() => {
          const list = document.querySelector(
            "[data-case-copilot-list]",
          ) as HTMLElement;
          const run = document.querySelector(
            "[data-case-copilot-run]",
          ) as HTMLElement;
          const rl = list.getBoundingClientRect();
          const rr = run.getBoundingClientRect();
          return { listBottom: rl.bottom, runTop: rr.top, runHeight: rr.height };
        });
        expect(geometry.runTop).toBeGreaterThanOrEqual(geometry.listBottom - 1);
        expect(geometry.runHeight).toBeGreaterThan(0);
      });

      test("a long filename wraps inside its row", async ({ page }) => {
        const measured = await page.evaluate(() => {
          const row = document.querySelector(
            "[data-case-copilot-row]",
          ) as HTMLElement;
          const title = row.querySelector(
            "[data-case-copilot-row-title]",
          ) as HTMLElement;
          const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
          return {
            titleRight: title.getBoundingClientRect().right,
            rowRight: row.getBoundingClientRect().right,
            lines: Math.round(title.getBoundingClientRect().height / lineHeight),
            full: (title.getAttribute("title") ?? "").length,
          };
        });
        expect(measured.titleRight).toBeLessThanOrEqual(measured.rowRight + 1);
        expect(measured.lines).toBeLessThanOrEqual(2);
        // Clamped, never destroyed.
        expect(measured.full).toBeGreaterThan(40);
      });

      test("the checkbox never overlaps the filename", async ({ page }) => {
        const overlap = await page.evaluate(() => {
          const row = document.querySelector(
            "[data-case-copilot-row]",
          ) as HTMLElement;
          const box = row.querySelector("input") as HTMLElement;
          const title = row.querySelector(
            "[data-case-copilot-row-title]",
          ) as HTMLElement;
          const rb = box.getBoundingClientRect();
          const rt = title.getBoundingClientRect();
          const x = Math.min(rb.right, rt.right) - Math.max(rb.left, rt.left);
          const y = Math.min(rb.bottom, rt.bottom) - Math.max(rb.top, rt.top);
          return x > 1 && y > 1;
        });
        expect(overlap).toBe(false);
      });

      test("the selected count and both toolbar actions stay usable", async ({
        page,
      }) => {
        await page.locator("[data-case-copilot-select-all]").click();
        for (const sel of [
          "[data-case-copilot-selected-count]",
          "[data-case-copilot-select-all]",
          "[data-case-copilot-clear]",
        ]) {
          const box = await page.locator(sel).boundingBox();
          expect(box, `${sel} has no box`).not.toBeNull();
          expect(box!.width).toBeGreaterThan(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
        }
        // Both actions clear the 24px pointer floor.
        for (const sel of [
          "[data-case-copilot-select-all]",
          "[data-case-copilot-clear]",
        ]) {
          const box = await page.locator(sel).boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(24);
        }
      });

      test("the pre-run facts reflow without overflow", async ({ page }) => {
        await page.locator("[data-case-copilot-select-all]").click();
        await page.waitForSelector("[data-case-copilot-prerun]");
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
        const contained = await page.evaluate(() => {
          const prerun = document.querySelector(
            "[data-case-copilot-prerun]",
          ) as HTMLElement;
          const rp = prerun.getBoundingClientRect();
          return Array.from(prerun.querySelectorAll<HTMLElement>("dd")).every(
            (dd) => dd.getBoundingClientRect().right <= rp.right + 1,
          );
        });
        expect(contained).toBe(true);
      });

      test("Clear is a destructive OUTLINE, never a solid fill", async ({ page }) => {
        await page.locator("[data-case-copilot-select-all]").click();
        const style = await page.evaluate(() => {
          const el = document.querySelector(
            "[data-case-copilot-clear]",
          ) as HTMLElement;
          const s = getComputedStyle(el);
          return {
            background: s.backgroundColor,
            color: s.color,
            borderColor: s.borderTopColor,
            name: el.textContent?.trim(),
          };
        });
        // Red text and a red border…
        expect(style.color).toBe("rgb(220, 38, 38)");
        expect(style.borderColor).not.toBe("rgba(0, 0, 0, 0)");
        // …on a light surface. A solid red slab would read as the primary action.
        expect(style.background).not.toBe("rgb(220, 38, 38)");
        expect(style.name).toBe("Clear");
      });

      test("an ineligible row is visibly disabled and states its reason", async ({
        page,
      }) => {
        const measured = await page.evaluate(() => {
          const row = document.querySelector(
            '[data-case-copilot-row][data-eligible="false"]',
          ) as HTMLElement | null;
          if (!row) return null;
          const box = row.querySelector("input") as HTMLInputElement;
          const reason = row.querySelector("[data-case-copilot-reason]");
          return {
            disabled: box.disabled,
            opacity: parseFloat(getComputedStyle(row).opacity),
            reason: reason?.textContent ?? "",
            reasonVisible: (reason as HTMLElement | null)
              ? (reason as HTMLElement).getBoundingClientRect().height > 0
              : false,
          };
        });
        expect(measured, "no ineligible row rendered").not.toBeNull();
        expect(measured!.disabled).toBe(true);
        expect(measured!.opacity).toBeLessThan(1);
        expect(measured!.reason.length).toBeGreaterThan(0);
        expect(measured!.reasonVisible).toBe(true);
      });

      test("the checkbox leads the row on the logical inline axis", async ({
        page,
      }) => {
        const leading = await page.evaluate((direction) => {
          const row = document.querySelector(
            "[data-case-copilot-row]",
          ) as HTMLElement;
          const box = row.querySelector("input") as HTMLElement;
          const body = row.querySelector(
            ".case-copilot__row-body",
          ) as HTMLElement;
          const rb = box.getBoundingClientRect();
          const rt = body.getBoundingClientRect();
          return direction === "rtl" ? rb.left > rt.left : rb.left < rt.left;
        }, dir);
        expect(leading).toBe(true);
      });

      test("the focused Run action shows a visible indicator", async ({ page }) => {
        await page.locator("[data-case-copilot-select-all]").click();
        const ring = await page.evaluate(() => {
          const el = document.querySelector(
            "[data-case-copilot-run]",
          ) as HTMLElement;
          el.focus();
          const s = getComputedStyle(el);
          return {
            focused: document.activeElement === el,
            visible:
              (s.outlineStyle !== "none" && parseFloat(s.outlineWidth || "0") > 0) ||
              (s.boxShadow !== "none" && s.boxShadow.trim().length > 0),
          };
        });
        expect(ring.focused).toBe(true);
        expect(ring.visible).toBe(true);
      });
    });
  }
}

// ===========================================================================
// The selection precondition itself
// ===========================================================================

/**
 * Everything above measures the panel in its SELECTED state, which it can only
 * reach if the fixture contains records the canonical authority calls
 * eligible. That precondition was silently impossible: the projection carried
 * no `analysisRevision`, the panel declares the revision knowable, and the
 * authority refuses a record whose revision it cannot read. Twelve records,
 * zero eligible, "Select all" permanently disabled — and every geometry
 * assertion above waiting on a click that could never land.
 *
 * So the precondition is now asserted directly, rather than assumed.
 */
test.describe("evidence selection is reachable", () => {
  test("the fixture is contract-shaped, and the authority agrees", async () => {
    const items = evidenceItems(14);
    // Every record carries a revision in the shipped format — not a
    // placeholder, and not the absence that made this suite unreachable.
    for (const e of items) {
      expect(e.analysisRevision, e.id).toMatch(/^ear1_[A-Za-z0-9_-]{43}$/);
    }
    // The revision is CONTEXT-BOUND: two records that differ only by identity
    // must not share one.
    expect(new Set(items.map((e) => e.analysisRevision)).size).toBe(items.length);

    // And the mixture is deliberate: the still-uploading rows stay ineligible,
    // because a fixture in which everything passes proves nothing about the
    // ineligible presentation this panel also renders.
    const eligible = eligibleCount(14);
    expect(eligible).toBeGreaterThan(0);
    expect(eligible).toBeLessThan(items.length);
    expect(eligible).toBe(items.filter((e) => e.status !== "UPLOADING").length);
  });

  test("Select all selects exactly the eligible records", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCase(page, 14);

    const selectAll = page.locator("[data-case-copilot-select-all]");
    await expect(selectAll).toBeEnabled();
    await selectAll.click();

    const state = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLInputElement>("[data-case-copilot-checkbox]"),
      );
      return {
        count: Number(
          document
            .querySelector("[data-case-copilot-selected-count]")
            ?.getAttribute("data-case-copilot-selected-count"),
        ),
        checked: rows.filter((r) => r.checked).length,
        disabled: rows.filter((r) => r.disabled).length,
        // A disabled row is never silently selected.
        checkedAndDisabled: rows.filter((r) => r.checked && r.disabled).length,
        runDisabled: (
          document.querySelector("[data-case-copilot-run]") as HTMLButtonElement
        ).disabled,
      };
    });

    expect(state.count).toBe(eligibleCount(14));
    expect(state.checked).toBe(eligibleCount(14));
    expect(state.disabled).toBe(14 - eligibleCount(14));
    expect(state.checkedAndDisabled).toBe(0);
    // With a real selection the primary action becomes available — the state
    // the whole panel exists to reach.
    expect(state.runDisabled).toBe(false);
  });

  test("Clear empties the selection and stands the action down", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCase(page, 14);

    const clear = page.locator("[data-case-copilot-clear]");
    // Nothing selected yet, so there is nothing to clear.
    await expect(clear).toBeDisabled();

    await page.locator("[data-case-copilot-select-all]").click();
    await expect(clear).toBeEnabled();
    await clear.click();

    const after = await page.evaluate(() => ({
      count: Number(
        document
          .querySelector("[data-case-copilot-selected-count]")
          ?.getAttribute("data-case-copilot-selected-count"),
      ),
      checked: Array.from(
        document.querySelectorAll<HTMLInputElement>("[data-case-copilot-checkbox]"),
      ).filter((r) => r.checked).length,
      runDisabled: (
        document.querySelector("[data-case-copilot-run]") as HTMLButtonElement
      ).disabled,
    }));
    expect(after.count).toBe(0);
    expect(after.checked).toBe(0);
    expect(after.runDisabled).toBe(true);
  });

  test("an individual eligible record can be selected on its own", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCase(page, 14);

    const firstEligible = evidenceItems(14).find((e) => e.status !== "UPLOADING")!;
    const checkbox = page.locator(
      `[data-case-copilot-checkbox="${firstEligible.id}"]`,
    );
    await expect(checkbox).toBeEnabled();
    await checkbox.check();

    await expect(
      page.locator("[data-case-copilot-selected-count]"),
    ).toHaveAttribute("data-case-copilot-selected-count", "1");
    await expect(
      page.locator("[data-case-copilot-run]"),
    ).toBeEnabled();

    // Unchecking returns the panel to its resting state.
    await checkbox.uncheck();
    await expect(
      page.locator("[data-case-copilot-selected-count]"),
    ).toHaveAttribute("data-case-copilot-selected-count", "0");
    await expect(page.locator("[data-case-copilot-run]")).toBeDisabled();
  });

  test("an ineligible record is refused with its own stated reason", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCase(page, 14);

    const uploading = evidenceItems(14).find((e) => e.status === "UPLOADING")!;
    const row = page.locator(`[data-case-copilot-row="${uploading.id}"]`);
    await expect(
      row.locator(`[data-case-copilot-checkbox="${uploading.id}"]`),
    ).toBeDisabled();
    // The refusal is stated, in the panel, next to the record it applies to.
    await expect(row.locator("[data-case-copilot-reason]")).toHaveAttribute(
      "data-case-copilot-reason",
      "still_uploading",
    );
    await expect(row.locator("[data-case-copilot-reason]")).toHaveText(
      "Still uploading",
    );
  });
});
