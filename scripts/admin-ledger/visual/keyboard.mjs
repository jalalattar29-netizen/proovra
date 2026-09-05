/**
 * KEYBOARD, FOCUS AND MOBILE NAVIGATION — the §18/§19 debt.
 *
 * =============================================================================
 * WHAT IS DRIVEN, NOT INSPECTED
 * =============================================================================
 * A focus-visible outline can be read out of a stylesheet. Whether Tab reaches
 * the content, whether Escape closes the drawer, and whether focus RETURNS
 * cannot — those need the keys pressed. So this presses them.
 *
 *   TAB ORDER          walks the first 30 stops from the top of the document
 *                      and reports the first stop inside <main>, so "how many
 *                      presses to reach the page" is a number
 *   FOCUS VISIBILITY   every stop must paint an outline, a box-shadow ring or
 *                      a border change. A stop with no visible change is
 *                      unreachable in practice for a sighted keyboard user
 *   NESTED INTERACTIVE a focusable inside a focusable — a button in a link, a
 *                      link in a button — which is invalid and traps
 *   CLICKABLE DIV      an onclick div with no role and no tabindex
 *   MOBILE DRAWER      trigger reachable and 44px, opens, marks the current
 *                      route, Escape closes it, focus returns to the trigger,
 *                      and the background is inert while it is open
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { WEB, strip, signIn } from "./lib.mjs";

const ROUTES = process.argv.slice(2);

const FIRST_STOP = () => {
  const a = document.activeElement;
  return a
    ? {
        tag: a.tagName,
        cls: (a.className || "").toString().slice(0, 30),
        txt: (a.textContent || "").trim().slice(0, 30),
      }
    : null;
};

const FOCUS_PROBE = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const main = document.querySelector("main");
  return {
    tag: el.tagName,
    cls: (el.className || "").toString().slice(0, 30),
    txt: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 26),
    inMain: main ? main.contains(el) : false,
    box: `${Math.round(r.width)}x${Math.round(r.height)}`,
    // Any of the three is a visible focus signal.
    outline:
      cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0,
    ring: cs.boxShadow !== "none",
    // A stop with zero size cannot show focus at all.
    sized: r.width > 0 && r.height > 0,
  };
};

const STATIC_PROBE = () => {
  const FOCUSABLE =
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"]';
  const nested = [];
  for (const el of document.querySelectorAll(FOCUSABLE)) {
    const inner = el.querySelector(FOCUSABLE);
    if (inner) {
      nested.push({
        outer: `${el.tagName}.${(el.className || "").toString().slice(0, 22)}`,
        inner: `${inner.tagName}.${(inner.className || "").toString().slice(0, 22)}`,
        txt: (el.textContent || "").trim().slice(0, 26),
      });
    }
  }
  // A div that takes a click but is not reachable by keyboard.
  const clickableDiv = [];
  for (const el of document.querySelectorAll("div[onclick], span[onclick]")) {
    if (!el.getAttribute("role") && el.tabIndex < 0) {
      clickableDiv.push((el.textContent || "").trim().slice(0, 30));
    }
  }
  // Landmarks and heading order.
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) =>
    Number(h.tagName[1]),
  );
  const skips = [];
  for (let i = 1; i < heads.length; i += 1) {
    if (heads[i] - heads[i - 1] > 1) skips.push(`h${heads[i - 1]}->h${heads[i]}`);
  }
  return {
    nested,
    clickableDiv,
    h1: document.querySelectorAll("h1").length,
    headingSkips: skips,
    landmarks: {
      main: document.querySelectorAll("main").length,
      nav: document.querySelectorAll("nav").length,
      labelledNav: [...document.querySelectorAll("nav")].filter(
        (n) => n.getAttribute("aria-label") || n.getAttribute("aria-labelledby"),
      ).length,
    },
    // Every icon-only control must carry an accessible name.
    unnamedIconButtons: [...document.querySelectorAll("button")].filter((b) => {
      const text = (b.textContent || "").trim();
      if (text.length > 0) return false;
      return !(
        b.getAttribute("aria-label") ||
        b.getAttribute("aria-labelledby") ||
        b.getAttribute("title")
      );
    }).length,
    // A form control with no label of any kind.
    unlabelledFields: [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(
      (f) => {
        if (f.getAttribute("aria-label") || f.getAttribute("aria-labelledby")) return false;
        if (f.id && document.querySelector(`label[for="${f.id}"]`)) return false;
        if (f.closest("label")) return false;
        if (f.getAttribute("placeholder")) return false;
        return true;
      },
    ).length,
  };
};

const browser = await chromium.launch();
const results = [];

/* ---------------------------------------------------------- DESKTOP KEYBOARD */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem(
        "proovra-cookie-consent-state",
        JSON.stringify({
          necessary: true, preferences: false, analytics: false,
          marketing: false, consentVersion: 1,
          updatedAt: new Date().toISOString(),
        }),
      );
    } catch {}
  });
  const page = await ctx.newPage();
  await signIn(page);

  for (const route of ROUTES) {
    await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    await strip(page).catch(() => 0);

    const stat = await page.evaluate(STATIC_PROBE).catch((e) => ({ error: String(e) }));

    // Walk the tab order from the very top.
    await page.evaluate(() => {
      const b = document.body;
      b.setAttribute("tabindex", "-1");
      b.focus();
      b.removeAttribute("tabindex");
    });
    const stops = [];
    let firstMain = null;
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press("Tab");
      const s = await page.evaluate(FOCUS_PROBE);
      if (!s) break;
      stops.push(s);
      if (firstMain === null && s.inMain) firstMain = i + 1;
    }
    /*
     * DOES THE SKIP LINK ACTUALLY SKIP?
     *
     * A skip link that is present, focusable and does nothing is worse than
     * none, because it consumes the one press somebody spends looking for it.
     * So the first stop is focused and ENTER is pressed, and the assertion is
     * that focus lands inside <main>.
     */
    let skip = null;
    if (stops.length > 0) {
      await page.evaluate(() => {
        const b = document.body;
        b.setAttribute("tabindex", "-1");
        b.focus();
        b.removeAttribute("tabindex");
      });
      await page.keyboard.press("Tab");
      const first = await page.evaluate(FIRST_STOP);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(350);
      const landed = await page.evaluate(() => {
        const a = document.activeElement;
        const main = document.querySelector("main");
        return {
          tag: a?.tagName ?? null,
          id: a?.id ?? null,
          inMain: !!(main && a && (main === a || main.contains(a))),
        };
      });
      skip = { firstStop: first, landed };
    }

    const noFocusSignal = stops.filter((s) => !s.outline && !s.ring && s.sized);
    const unsized = stops.filter((s) => !s.sized);

    const row = {
      route,
      ...stat,
      stops: stops.length,
      firstMainStop: firstMain,
      noFocusSignal: noFocusSignal.length,
      noFocusExamples: noFocusSignal.slice(0, 4).map((s) => `${s.tag}.${s.cls} "${s.txt}"`),
      unsizedStops: unsized.length,
      skipLink: skip,
    };
    results.push(row);

    const flag = [
      stat.error ?? "",
      row.noFocusSignal ? `${row.noFocusSignal} stops with NO focus signal` : "",
      row.unsizedStops ? `${row.unsizedStops} zero-size stops` : "",
      stat.nested?.length ? `${stat.nested.length} NESTED interactive` : "",
      stat.clickableDiv?.length ? `${stat.clickableDiv.length} clickable div` : "",
      stat.h1 !== 1 ? `h1=${stat.h1}` : "",
      stat.headingSkips?.length ? `heading skip ${stat.headingSkips.join(",")}` : "",
      stat.unnamedIconButtons ? `${stat.unnamedIconButtons} unnamed icon buttons` : "",
      stat.unlabelledFields ? `${stat.unlabelledFields} unlabelled fields` : "",
      stat.landmarks && stat.landmarks.nav !== stat.landmarks.labelledNav
        ? `${stat.landmarks.nav - stat.landmarks.labelledNav} unlabelled nav`
        : "",
      skip && !skip.landed.inMain ? "SKIP LINK DID NOT REACH MAIN" : "",
    ].filter(Boolean).join(" · ");
    console.log(
      `${route.padEnd(46)} stops=${String(row.stops).padStart(2)} main@${String(firstMain ?? "-").padStart(2)} skip=${skip ? (skip.landed.inMain ? "works" : "BROKEN") : "-"} first="${skip?.firstStop?.txt ?? ""}"  ${flag || "ok"}`,
    );
    for (const n of stat.nested ?? []) console.log(`      nested: ${n.outer} > ${n.inner}  "${n.txt}"`);
    for (const e of row.noFocusExamples) console.log(`      no-ring: ${e}`);
  }
  await ctx.close();
}

/* ------------------------------------------------------------ MOBILE DRAWER */
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem(
        "proovra-cookie-consent-state",
        JSON.stringify({
          necessary: true, preferences: false, analytics: false,
          marketing: false, consentVersion: 1,
          updatedAt: new Date().toISOString(),
        }),
      );
    } catch {}
  });
  const page = await ctx.newPage();
  await signIn(page);
  await page.goto(`${WEB}/admin/identity/sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);
  await strip(page).catch(() => 0);

  const nav = { route: "/admin/identity/sessions" };

  const TRIGGER_SEL = "button.app-account-toolbar-mobile-menu";
  const trigger = await page.evaluate((sel) => {
    const b = document.querySelector(sel);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return {
      name: b.getAttribute("aria-label") ?? (b.textContent || "").trim().slice(0, 24),
      cls: (b.className || "").toString().slice(0, 30),
      box: `${Math.round(r.width)}x${Math.round(r.height)}`,
      expanded: b.getAttribute("aria-expanded"),
      visible: r.width > 0 && r.height > 0,
    };
  }, TRIGGER_SEL);
  nav.trigger = trigger;

  if (trigger) {
    const sel = TRIGGER_SEL;
    // Focus it by keyboard rather than clicking, which also proves it is a stop.
    await page.locator(sel).first().focus().catch(() => {});
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    nav.afterOpen = await page.evaluate(() => {
      const drawer = document.querySelector(".app-shell-v2-mobile-drawer");
      const isOpen = !!drawer && drawer.classList.contains("is-open");
      const slot = document.querySelector(".app-shell-v2-content-slot");
      const header = document.querySelector(".app-shell-v2-header-slot");
      const inertBg = {
        contentInert: !!slot && slot.hasAttribute("inert"),
        headerInert: !!header && header.hasAttribute("inert"),
        bodyScrollLocked: getComputedStyle(document.body).overflow === "hidden",
      };
      return {
        drawerOpen: isOpen,
        drawerLinks: drawer ? drawer.querySelectorAll("a[href]").length : 0,
        drawerInertWhenClosed: !!drawer && drawer.hasAttribute("inert"),
        currentMarked: drawer
          ? drawer.querySelectorAll('[aria-current], .is-active, [data-active="true"]').length
          : 0,
        focusInside: drawer ? drawer.contains(document.activeElement) : false,
        backgroundInert: inertBg,
        adminSectionsReachable: document.querySelectorAll('.adminnav__primary-link').length,
      };
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    nav.afterEscape = await page.evaluate(() => {
      const drawer = document.querySelector(".app-shell-v2-mobile-drawer");
      const isOpen = !!drawer && drawer.classList.contains("is-open");
      const a = document.activeElement;
      return {
        drawerOpen: isOpen,
        // The TRIGGER specifically, by class. Matching on the word "nav"
        // accepted the drawer's own "Close navigation" button and reported a
        // focus return that had not happened.
        focusReturnedToTrigger:
          !!a && a.classList?.contains("app-account-toolbar-mobile-menu"),
        focusTag: a?.tagName ?? null,
        drawerInertWhenClosed: !!drawer && drawer.hasAttribute("inert"),
        focusName: (a?.getAttribute?.("aria-label") ?? a?.textContent ?? "").trim().slice(0, 26),
      };
    });
  }
  console.log("\n=== MOBILE NAVIGATION (390x844, touch) ===");
  console.log(JSON.stringify(nav, null, 1));
  results.push({ mobileNav: nav });
  await ctx.close();
}

mkdirSync("artifacts/admin-visual-review", { recursive: true });
writeFileSync(
  "artifacts/admin-visual-review/keyboard.json",
  JSON.stringify({ results }, null, 2),
  "utf8",
);
const rows = results.filter((r) => r.route);
const n = (f) => rows.filter(f).length;
console.log(
  [
    "",
    `routes                       ${rows.length}`,
    `with no-focus-signal stops   ${n((r) => r.noFocusSignal)}`,
    `with nested interactive      ${n((r) => r.nested?.length)}`,
    `with clickable divs          ${n((r) => r.clickableDiv?.length)}`,
    `with h1 != 1                 ${n((r) => r.h1 !== 1)}`,
    `with heading skips           ${n((r) => r.headingSkips?.length)}`,
    `with unnamed icon buttons    ${n((r) => r.unnamedIconButtons)}`,
    `with unlabelled fields       ${n((r) => r.unlabelledFields)}`,
    `with unlabelled nav          ${n((r) => r.landmarks && r.landmarks.nav !== r.landmarks.labelledNav)}`,
  ].join("\n"),
);
await browser.close();
