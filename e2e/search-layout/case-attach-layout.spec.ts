/**
 * STRUCTURAL VERIFICATION — Case Details → Add evidence.
 *
 * The dialog's geometry is the half of its redesign that source text cannot
 * describe: whether the LIST scrolls rather than the page, whether the footer
 * stays put while the records move, whether a 120-character filename widens
 * the row or wraps inside it, whether the checkbox survives at 390px, and
 * whether the whole thing mirrors correctly in RTL.
 *
 * Runs against the production build under Chromium, with the API intercepted —
 * the properties measured here belong to the layout engine, not the database.
 */

import { expect, test, type Page } from "@playwright/test";

import { DIRECTIONS, VIEWPORTS, envelopeFor, setDirection } from "./_fixtures";

/**
 * The envelope the Add-evidence dialog actually renders under.
 *
 * NON-enterprise on purpose. `/cases/[id]` branches on
 * `useEnterpriseSurfaceAccess()`: an Enterprise workspace renders
 * `MatterWorkspace`, which has no attach picker at all — the ONE dialog in the
 * product lives in `SimpleCaseDetail`. Pointing this spec at the Enterprise
 * branch measured a page that never mounts the dialog.
 *
 * The Search envelope also grants `SEARCH_VIEW` and nothing else, so the case
 * route refuses it at the navigation gate — correctly. These are the
 * capabilities the CASE surface requires, and only those.
 */
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

const CASE_ID = "c1000000-0000-4000-8000-000000000001";

const LONG_NAME =
  "Q4-incident-bundle-with-an-extremely-long-operator-supplied-filename-that-nobody-would-shorten-2026-08-20-final-v7-REVIEWED.jpg";

function candidate(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `e0000000-0000-4000-8000-00000000000${i}`,
    title: i === 0 ? LONG_NAME : `incident-bundle-${i}.jpg`,
    displayFileName: i === 0 ? LONG_NAME : `incident-bundle-${i}.jpg`,
    originalFileName: `incident-bundle-${i}.jpg`,
    mimeType: "image/jpeg",
    itemCount: 1,
    type: "PHOTO",
    status: "CREATED",
    verificationStatus:
      i === 1 ? "FAILED" : i === 2 ? "REVIEW_REQUIRED" : "RECORDED_INTEGRITY_VERIFIED",
    createdAt: "2026-08-01T00:00:00.000Z",
    reportReady: i !== 1,
    packageReady: i !== 2,
    ...over,
  };
}

/** The `matter-workspace` envelope, shaped to the real contract. */
function matterWorkspace() {
  const iso = "2026-07-11T00:00:00.000Z";
  const section = (extra: Record<string, unknown>) => ({ status: "ok", ...extra });
  return {
    generatedAt: iso,
    case: {
      id: CASE_ID,
      name: "Bilal",
      referenceNumber: null,
      description: null,
      status: "CLOSED",
      priority: "P2",
      scope: "TEAM",
      ownerUserId: "u-1",
      teamId: "44444444-4444-4444-8444-444444444444",
      closedAtUtc: iso,
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
          linkedEvidenceCount: 0,
          recentlyLinkedCount: 0,
          activeCaseHoldsCount: 0,
          affectedEvidenceHoldsCount: 0,
          pendingReviewCount: 0,
          openEscalationsCount: 0,
          activeAssignmentCount: 0,
        },
      }),
      evidence: section({ items: [] }),
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

/** Open the case page and its Add evidence dialog. */
async function openDialog(page: Page, rowCount = 12): Promise<void> {
  const envelope = caseEnvelope();
  const items = Array.from({ length: rowCount }, (_, i) => candidate(i % 3));

  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path.endsWith("/v1/platform/context")) return json(envelope);
    if (path.endsWith("/available-evidence")) {
      // Unique ids so every row is its own record.
      return json({
        items: items.map((c, i) => ({
          ...c,
          id: `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        })),
      });
    }
    if (path.endsWith("/matter-workspace")) return json(matterWorkspace());
    if (path.endsWith("/v1/auth/me") || path.endsWith("/v1/users/me")) {
      return json({ id: "u-1", email: "operator@example.invalid" });
    }
    return json({});
  });

  await page.goto(`/cases/${CASE_ID}`);
  // The stable contract hook, not the label: the button carries an icon and a
  // configurable label, and matching on text would break on either.
  const trigger = page.locator("[data-simple-case-action='add-evidence']");
  await trigger.waitFor({ state: "visible", timeout: 30_000 });
  await trigger.click();
  await page.waitForSelector("[data-matter-modal='attach-evidence']", {
    timeout: 30_000,
  });
  await page.waitForSelector("[data-simple-case-attach-row]", { timeout: 30_000 });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

for (const viewport of VIEWPORTS) {
  for (const dir of DIRECTIONS) {
    test.describe(`Add evidence ${viewport.name}px ${dir}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await openDialog(page);
        await setDirection(page, dir);
      });

      test("the dialog is usable and the page does not scroll sideways", async ({
        page,
      }) => {
        const box = await page
          .locator("[data-matter-modal='attach-evidence']")
          .boundingBox();
        expect(box, "the dialog has no box").not.toBeNull();
        // It fits the viewport it was opened in.
        expect(box!.width).toBeLessThanOrEqual(viewport.width);
        expect(box!.x).toBeGreaterThanOrEqual(-1);
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      });

      test("nothing escapes the dialog", async ({ page }) => {
        const escaped = await page.evaluate(() => {
          const dialog = document.querySelector(
            "[data-matter-modal='attach-evidence']",
          ) as HTMLElement | null;
          if (!dialog) return ["<no dialog>"];
          const rd = dialog.getBoundingClientRect();
          const out: string[] = [];
          for (const el of Array.from(dialog.querySelectorAll<HTMLElement>("*"))) {
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (r.left < rd.left - 1 || r.right > rd.right + 1) {
              out.push(
                `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}`,
              );
            }
          }
          return out;
        });
        expect(escaped).toEqual([]);
      });

      test("the LIST scrolls, not the page, and the footer stays put", async ({
        page,
      }) => {
        const before = await page.evaluate(() => {
          const list = document.querySelector(
            "[data-simple-case-attach-list]",
          ) as HTMLElement;
          const footer = document.querySelector(
            "[data-matter-modal-footer]",
          ) as HTMLElement;
          return {
            scrollable: list.scrollHeight > list.clientHeight,
            footerTop: footer.getBoundingClientRect().top,
            pageScroll: window.scrollY,
          };
        });
        expect(before.scrollable, "the list is not the scroll region").toBe(true);

        const after = await page.evaluate(() => {
          const list = document.querySelector(
            "[data-simple-case-attach-list]",
          ) as HTMLElement;
          list.scrollTop = list.scrollHeight;
          const footer = document.querySelector(
            "[data-matter-modal-footer]",
          ) as HTMLElement;
          return {
            listScrolled: list.scrollTop > 0,
            footerTop: footer.getBoundingClientRect().top,
            pageScroll: window.scrollY,
          };
        });
        expect(after.listScrolled).toBe(true);
        // The footer did NOT move with the records, and the page never scrolled.
        expect(Math.round(after.footerTop)).toBe(Math.round(before.footerTop));
        expect(after.pageScroll).toBe(before.pageScroll);
      });

      test("the footer does not overlap the list", async ({ page }) => {
        const overlap = await page.evaluate(() => {
          const list = document.querySelector(
            "[data-simple-case-attach-list]",
          ) as HTMLElement;
          const footer = document.querySelector(
            "[data-matter-modal-footer]",
          ) as HTMLElement;
          const rl = list.getBoundingClientRect();
          const rf = footer.getBoundingClientRect();
          return Math.min(rl.bottom, rf.bottom) - Math.max(rl.top, rf.top);
        });
        expect(overlap).toBeLessThanOrEqual(1);
      });

      test("a long filename wraps inside its row and keeps the row intact", async ({
        page,
      }) => {
        const measured = await page.evaluate(() => {
          const row = document.querySelector(
            "[data-simple-case-attach-row]",
          ) as HTMLElement;
          const title = row.querySelector(
            "[data-simple-case-attach-row-title]",
          ) as HTMLElement;
          const list = document.querySelector(
            "[data-simple-case-attach-list]",
          ) as HTMLElement;
          return {
            titleRight: title.getBoundingClientRect().right,
            rowRight: row.getBoundingClientRect().right,
            listRight: list.getBoundingClientRect().right,
            hasFullValue: (title.getAttribute("title") ?? "").length > 40,
            lines: Math.round(
              title.getBoundingClientRect().height /
                parseFloat(getComputedStyle(title).lineHeight),
            ),
          };
        });
        // Bounded inside its own region.
        expect(measured.titleRight).toBeLessThanOrEqual(measured.rowRight + 1);
        expect(measured.rowRight).toBeLessThanOrEqual(measured.listRight + 1);
        // Clamped to two lines, and the full value is still retrievable.
        expect(measured.lines).toBeLessThanOrEqual(2);
        expect(measured.hasFullValue).toBe(true);
      });

      test("the checkbox is visible and reaches a usable target", async ({
        page,
      }) => {
        const measured = await page.evaluate(() => {
          const box = document.querySelector(
            "[data-simple-case-attach-row-checkbox]",
          ) as HTMLElement;
          const label = box.closest("label") as HTMLElement;
          const rb = box.getBoundingClientRect();
          const rl = label.getBoundingClientRect();
          return {
            visible: rb.width > 0 && rb.height > 0,
            targetHeight: rl.height,
            appearance: getComputedStyle(box).appearance,
          };
        });
        expect(measured.visible).toBe(true);
        // The LABEL is the target — the canonical checkbox is 18px by design.
        expect(measured.targetHeight).toBeGreaterThanOrEqual(44);
        // …and it is the canonical control, not a raw native box.
        expect(measured.appearance).toBe("none");
      });

      test("selection changes no dimension", async ({ page }) => {
        const row = page.locator("[data-simple-case-attach-row]").first();
        const before = await row.boundingBox();
        await row.locator("label").click();
        await expect(row).toHaveAttribute("data-selected", "true");
        const after = await row.boundingBox();
        expect(Math.round(after!.height)).toBe(Math.round(before!.height));
        expect(Math.round(after!.width)).toBe(Math.round(before!.width));
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      });

      test("the record id stays left-to-right", async ({ page }) => {
        const dirs = await page.evaluate(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>(".attach-evidence__row-id"),
          ).map((el) => getComputedStyle(el).direction),
        );
        expect(dirs.length).toBeGreaterThan(0);
        for (const d of dirs) expect(d).toBe("ltr");
      });

      test("the checkbox leads the row on the logical inline axis", async ({
        page,
      }) => {
        const leading = await page.evaluate((direction) => {
          const box = document.querySelector(
            "[data-simple-case-attach-row-checkbox]",
          ) as HTMLElement;
          const body = document.querySelector(
            ".attach-evidence__row-body",
          ) as HTMLElement;
          const rb = box.getBoundingClientRect();
          const rt = body.getBoundingClientRect();
          // LTR: the control is to the left of the text. RTL: to its right.
          return direction === "rtl" ? rb.left > rt.left : rb.left < rt.left;
        }, dir);
        expect(leading, `the checkbox is on the wrong side in ${dir}`).toBe(true);
      });
    });
  }
}
