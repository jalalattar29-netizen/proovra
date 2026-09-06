/**
 * ONE TOKEN AUTHORITY, PROVEN FROM THE RENDERED PAGE.
 *
 * =============================================================================
 * WHY COMPUTED STYLES AND NOT A GREP
 * =============================================================================
 * Every previous claim about this console's colours has been a claim about
 * SOURCE — "no page declares a hex", "no file redeclares a token" — and source
 * is not what a person looks at. A token can be declared once and still render
 * two different values, because a custom property resolves against the element
 * that reads it: a scoped redeclaration on an ancestor, an import order that
 * puts one stylesheet after another, or a `var(--x, #fallback)` where `--x` is
 * missing all produce a page whose source says one thing and whose pixels say
 * another. The `--text-muted` alias that a previous pass deleted was exactly
 * that: declared, resolved, and wrong, and no source check found it.
 *
 * So this asks the browser. It opens real admin pages, reads
 * `getComputedStyle` off the real elements, and requires that each visual role
 * has ONE resolved value across every page that renders it:
 *
 *   card radius · card shadow · muted text · border · primary action ·
 *   selected tab · success · warning · danger · unavailable · disabled
 *
 * A role rendering two values is a second authority, wherever it is declared.
 *
 * =============================================================================
 * WHAT ELSE IT REFUSES
 * =============================================================================
 * The §B2 ground rules, measured rather than asserted: no photographic
 * background and no gradient behind the console, no glassmorphism in its
 * chrome, and no shadow deeper than the product's card elevation. The console
 * turns the product decor off with a body class, and a body class is precisely
 * the kind of thing that stops working without anybody noticing — the rule
 * that removes it lives in one file and the layer it removes lives in another.
 *
 * Usage:
 *   npx playwright test admin-token-authority \
 *     --config apps/web/e2e/admin-control-plane/playwright.config.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { CONSENT_VERSION } from "../../lib/consent";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const WEB = process.env.PROOVRA_WEB_ORIGIN ?? "http://localhost:3311";
const OUT = resolve(REPO, "artifacts/admin-token-authority");

const PASSWORD = "fixture-local-only-password";
const ADMIN = "platform-admin@fixture.local";

/**
 * The pages probed, and why these.
 *
 * One from each family that renders a different part of the vocabulary: the
 * overview (KPI tiles, the four semantic tones), a dense table page, a page
 * with tabs, a page with a filter bar, and a detail page. Adding pages makes
 * the claim stronger; these five are the floor.
 */
const PAGES = [
  "/admin",
  "/admin/users",
  "/admin/identity",
  "/admin/operations",
  "/admin/platform/queues",
  /* The one page with a tablist. §B10 owns its behaviour; this is here so the
     SELECTED-TAB colour is measured rather than assumed. */
  "/admin/identity/scim",
];

async function seedConsent(context: BrowserContext) {
  await context.addInitScript(
    ({ key, version }) => {
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({
            necessary: true,
            preferences: false,
            analytics: false,
            marketing: false,
            consentVersion: version,
            updatedAt: new Date().toISOString(),
          }),
        );
      } catch {
        /* storage disabled — the style rule below still removes the overlay */
      }
    },
    { key: "proovra-cookie-consent-state", version: CONSENT_VERSION },
  );
  await context.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "#cc-main{display:none!important;pointer-events:none!important}";
    const attach = () => document.head?.appendChild(style);
    if (document.head) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  });
}

async function signIn(page: Page) {
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle", timeout: 90_000 });
  const email = page.locator('input[type="email"]:visible').first();
  const pass = page.locator('input[type="password"]:visible').first();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await email.fill(ADMIN);
    await pass.fill(PASSWORD);
    const boxes = page.locator('input[type="checkbox"]:visible');
    for (let i = 0; i < (await boxes.count()); i += 1) {
      await boxes.nth(i).check().catch(() => {});
    }
    if ((await email.inputValue()) === ADMIN) break;
    if (attempt === 3) throw new Error("the login form kept clearing itself");
    await page.waitForTimeout(1_000);
  }
  await page.locator('button[type="submit"]:visible').first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 60_000,
  });
}

type Sample = { role: string; value: string; where: string; page: string };

/**
 * What each role IS, on the page, as a selector plus the property to read.
 *
 * Selectors are the canonical component's own class or data attribute, never a
 * page-local one, because the question is what the SHARED primitive renders.
 */
const PROBE = `
(() => {
  const out = [];
  const push = (role, el, prop) => {
    if (!el) return;
    const v = getComputedStyle(el).getPropertyValue(prop).trim();
    if (v === "") return;
    out.push({ role, value: v, where: el.className || el.tagName.toLowerCase() });
  };
  const all = (sel) => Array.from(document.querySelectorAll(sel));

  /* A CARD IS THE TWO PRIMITIVES THAT MEAN "CARD": the shared component and
     the console's own class. Asking both is the point — a role with one
     meaning rendering two values is the defect this looks for. */
  for (const el of all('[data-variant="summary"], [data-variant="status"], .adm-card, .app-panel').slice(0, 8)) {
    push("card-radius", el, "border-radius");
    push("card-shadow", el, "box-shadow");
    push("card-border", el, "border-top-color");
  }

  for (const el of all(".adm-help, .app-field-help, .app-table__muted").slice(0, 8)) {
    push("muted-text", el, "color");
  }

  /* THE PRIMARY ACTION IS THE ONE THE COMPONENT CALLS PRIMARY.
     A first version matched "any filled control whose background looks
     purple", which is a guess about the palette rather than a question about
     the primitive — and it matched nothing, because it was written against a
     hex range the accent does not sit in. */
  for (const el of all('[data-variant="primary"], .app-primary-action, button[data-primary="true"]')) {
    push("primary-action", el, "background-color");
  }

  /* Selected tab / selected filter — the two places §B2 allows the accent to
     mean "this one". Read the colour it paints, whichever attribute the
     surface uses to say it is selected. */
  for (const el of all(
    '[role="tab"][aria-selected="true"], .app-tab.is-active, [data-adm-tab][data-active="true"], [data-selected="true"], [aria-pressed="true"]',
  )) {
    push("selected-tab", el, "color");
  }

  /* A TONE IS READ OFF THE ELEMENT THAT PAINTS IT, not off an ancestor that
     merely carries the attribute. The first version read \`color\` from any
     [data-tone] node and reported three "danger" values, two of which were
     ordinary ink inherited by a wrapper that happened to be tagged. */
  const TONED = '.ui-badge, .app-status-badge, .app-status-text, .adm-inline, .apf-note, [class*="badge"]';
  const toned = (tone) =>
    all(TONED).filter((el) => {
      const own = el.getAttribute("data-tone") ?? el.getAttribute("data-state");
      return own !== null && tone.includes(own);
    });
  for (const el of toned(["verified", "healthy", "done", "success"])) push("success", el, "color");
  for (const el of toned(["pending", "warning"])) push("warning", el, "color");
  for (const el of toned(["risk", "critical", "danger"])) push("danger", el, "color");
  for (const el of toned(["unknown", "stale", "unavailable", "neutral", "not-measured"])) {
    push("unavailable", el, "color");
  }

  /* DISABLED IS WHAT THE CONTROL LOOKS LIKE, not what its opacity is. A first
     version read \`opacity\` and every control returned 1 — a role with one
     value because nothing was being measured, which is the same failure as
     having no probe at all. The console dims a disabled control by changing
     its ink and ground, so those are what this reads. */
  for (const el of all("button:disabled, [aria-disabled='true']")) {
    push("disabled-ink", el, "color");
    push("disabled-cursor", el, "cursor");
  }
  return out;
})()
`;

/** The console's ground, measured on the body and the shell. */
const GROUND = `
(() => {
  const body = getComputedStyle(document.body);
  const shell = document.querySelector(".app-shell-v2");
  const shellStyle = shell ? getComputedStyle(shell) : null;
  const header = document.querySelector(".app-shell-v2 header, .app-header, [data-app-header]");
  const sidebar = document.querySelector(".app-sidebar, [data-app-sidebar], nav[class*='sidebar']");
  const read = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      backgroundImage: s.backgroundImage,
      backdropFilter: s.backdropFilter || s.webkitBackdropFilter,
      backgroundColor: s.backgroundColor,
    };
  };
  return {
    bodyClass: document.body.className,
    body: { backgroundImage: body.backgroundImage, backgroundColor: body.backgroundColor },
    shell: shellStyle
      ? { backgroundImage: shellStyle.backgroundImage, backgroundColor: shellStyle.backgroundColor }
      : null,
    header: read(header),
    sidebar: read(sidebar),
  };
})()
`;

test("one value per visual role, and the console's ground is flat", async ({
  browser,
}) => {
  test.setTimeout(10 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await seedConsent(context);
  const page = await context.newPage();
  await signIn(page);

  const samples: Sample[] = [];
  const grounds: Array<Record<string, unknown>> = [];

  for (const route of PAGES) {
    await page.goto(`${WEB}${route}`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(400);
    const rows = (await page.evaluate(PROBE)) as Array<Omit<Sample, "page">>;
    for (const r of rows) samples.push({ ...r, page: route });
    grounds.push({ page: route, ...(await page.evaluate(GROUND)) as object });
  }

  const byRole = new Map<string, Map<string, Sample[]>>();
  for (const s of samples) {
    if (!byRole.has(s.role)) byRole.set(s.role, new Map());
    const m = byRole.get(s.role)!;
    if (!m.has(s.value)) m.set(s.value, []);
    m.get(s.value)!.push(s);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    pages: PAGES,
    roles: [...byRole.entries()].map(([role, values]) => ({
      role,
      distinctValues: values.size,
      values: [...values.entries()].map(([value, at]) => ({
        value,
        count: at.length,
        seenOn: [...new Set(at.map((a) => a.page))],
        firstWhere: at[0]?.where ?? null,
      })),
    })),
    ground: grounds,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, "token-authority.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  // ---- one value per role -------------------------------------------------
  const multi = report.roles.filter((r) => r.distinctValues > 1);
  expect(
    multi,
    `these visual roles render more than one value across the console — a second\n` +
      `authority, wherever it is declared:\n` +
      multi
        .map(
          (r) =>
            `  ${r.role}: ${r.values
              .map((v) => `${v.value} (${v.seenOn.join(", ")})`)
              .join("  ·  ")}`,
        )
        .join("\n"),
  ).toEqual([]);

  // Every role has to have been SEEN, or the probe is asserting nothing.
  const seen = new Set(report.roles.map((r) => r.role));
  for (const role of [
    "card-radius",
    "card-shadow",
    "card-border",
    "muted-text",
    "primary-action",
    "selected-tab",
    "success",
    "warning",
    "danger",
    "unavailable",
    "disabled-ink",
    "disabled-cursor",
  ]) {
    expect(seen.has(role), `no element matched the ${role} probe`).toBe(true);
  }

  // ---- the console's ground ----------------------------------------------
  for (const g of grounds as Array<{
    page: string;
    bodyClass: string;
    body: { backgroundImage: string };
    shell: { backgroundImage: string } | null;
    header: { backdropFilter: string; backgroundImage: string } | null;
    sidebar: { backgroundImage: string } | null;
  }>) {
    expect(g.bodyClass, `${g.page}: the console body class is missing`).toContain(
      "is-admin-console",
    );
    expect(g.body.backgroundImage, `${g.page}: body carries decor`).toBe("none");
    if (g.shell) {
      expect(
        g.shell.backgroundImage,
        `${g.page}: the app shell still paints its photographic background under the console`,
      ).toBe("none");
    }
    if (g.sidebar) {
      expect(
        g.sidebar.backgroundImage,
        `${g.page}: the sidebar still paints artwork under the console`,
      ).toBe("none");
    }
    if (g.header) {
      expect(
        g.header.backdropFilter ?? "none",
        `${g.page}: the console header is still glassmorphic`,
      ).toBe("none");
    }
  }
});

/**
 * THE PRIVACY PREFERENCES LAUNCHER — §B5.
 *
 * =============================================================================
 * WHERE IT ACTUALLY RENDERS, WHICH IS NOT THE CONSOLE
 * =============================================================================
 * The brief asks for this verified "on Admin desktop, mobile, RTL". It cannot
 * be: `globals.css` hides the launcher — and the consent banner with it —
 * under `body.is-internal-app`, which every authenticated route carries. The
 * CMP still initialises there, so consent storage and analytics gating are
 * unaffected; only the floating trigger is suppressed, on purpose, so a
 * fixed-position button does not sit over an operations console for hours.
 *
 * Measuring a `display: none` element would have produced a green tick for a
 * control nobody can press. So this checks both halves: the launcher is
 * DELIBERATELY absent inside /admin, and where it does render — the public
 * surfaces — it is a 44px target on the page's starting edge, focusable, and
 * with nothing on top of it.
 *
 * It was 38×38, under every published minimum for an interactive target, and
 * it is the control a person uses to change what is collected about them.
 */
test("the privacy launcher is suppressed in the console and a 44px target in public", async ({
  browser,
}) => {
  test.setTimeout(5 * 60_000);

  const results: Array<Record<string, unknown>> = [];

  // ---- 1. Absent in the console, and absent BY THE RULE, not by accident ---
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await seedConsent(context);
    const page = await context.newPage();
    await signIn(page);
    await page.goto(`${WEB}/admin`, { waitUntil: "networkidle", timeout: 90_000 });
    const state = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="privacy-preferences-launcher"]',
      );
      return {
        mounted: Boolean(el),
        display: el ? getComputedStyle(el).display : null,
        bodyClass: document.body.className,
      };
    });
    expect(
      state.bodyClass,
      "the internal-app body class is what suppresses it",
    ).toContain("is-internal-app");
    if (state.mounted) {
      expect(
        state.display,
        "the launcher renders inside the console — it must not",
      ).toBe("none");
    }
    results.push({ case: "admin", ...state });
    await context.close();
  }

  // ---- 2. Present and correct on the public surfaces ----------------------
  const cases = [
    { name: "public-desktop", viewport: { width: 1440, height: 900 }, rtl: false },
    { name: "public-mobile", viewport: { width: 390, height: 844 }, rtl: false },
    { name: "public-rtl", viewport: { width: 1440, height: 900 }, rtl: true },
  ];

  for (const c of cases) {
    const context = await browser.newContext({ viewport: c.viewport });
    if (c.rtl) {
      /* The direction is SERVER-rendered from a cookie, so it has to be set
         before the first request — a class toggled after hydration would test
         a different thing than a cold Arabic load. */
      await context.addCookies([
        { name: "proovra-locale", value: "ar", url: WEB },
        { name: "proovra-locale-mode", value: "manual", url: WEB },
      ]);
    }
    /* CONSENT IS SEEDED, AND THAT IS THE STATE THAT MATTERS.
       A first version left the banner up and failed at 390px because the
       banner's footer covers the launcher there. That is not a defect: while
       the banner is on screen the launcher is redundant — the choice is right
       in front of the person — and a small viewport giving the banner the
       bottom of the screen is correct. The launcher's whole purpose begins
       AFTER a decision has been recorded, when it is the only way back in, so
       that is the state its size, position and reachability are measured in. */
    await seedConsent(context);
    const page = await context.newPage();
    await page.goto(`${WEB}/login`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(600);

    const el = page.locator('[data-testid="privacy-preferences-launcher"]');
    await el.waitFor({ state: "visible", timeout: 30_000 });
    const box = await el.boundingBox();
    expect(box, `${c.name}: the launcher has no box`).not.toBeNull();

    // 44px on BOTH axes. Rounded because a fractional layout can land on
    // 43.99, which is the same target to a finger and a failure to a strict
    // comparison.
    expect(
      Math.round(box.width),
      `${c.name}: launcher width is ${box.width}px`,
    ).toBeGreaterThanOrEqual(44);
    expect(
      Math.round(box.height),
      `${c.name}: launcher height is ${box.height}px`,
    ).toBeGreaterThanOrEqual(44);

    const dir = await page.evaluate(
      () => document.documentElement.getAttribute("dir") ?? "ltr",
    );
    if (c.rtl) {
      expect(dir, "the Arabic cookie did not produce an RTL document").toBe("rtl");
    }

    /* Logical inset: the control anchors where the page BEGINS, so a
       right-to-left document puts it on the right. `left: 16` — what this
       used to be — pins it to the same corner in every language, which in
       Arabic is where the text ENDS. */
    const centre = box.x + box.width / 2;
    const half = c.viewport.width / 2;
    if (dir === "rtl") {
      expect(centre, "rtl: the launcher is still pinned to the left edge").toBeGreaterThan(half);
    } else {
      expect(centre, `${c.name}: the launcher left the start edge`).toBeLessThan(half);
    }

    /* NOTHING ELSE INTERACTIVE ON TOP OF IT. `elementFromPoint` at the centre
       has to land inside the launcher; anything else means a control is
       covering it, which is the failure mode a fixed corner button has. */
    const onTop = await page.evaluate(
      ({ x, y }) => {
        /* The dev server mounts `<nextjs-portal>` — the error overlay and
           build indicator — at the bottom-left of every page, and it does not
           exist in a production build. Excluding it is not weakening the
           check: it is the difference between measuring the product and
           measuring the dev server. Anything else on top is a real overlap. */
        const stack = document.elementsFromPoint(x, y);
        const hit =
          stack.find((n) => n.tagName.toLowerCase() !== "nextjs-portal") ?? null;
        const launcher = document.querySelector(
          '[data-testid="privacy-preferences-launcher"]',
        );
        return {
          isLauncher: Boolean(hit && launcher && launcher.contains(hit)),
          tag: hit ? hit.tagName.toLowerCase() : null,
          cls: hit ? String(hit.className).slice(0, 60) : null,
        };
      },
      { x: centre, y: box.y + box.height / 2 },
    );
    expect(
      onTop.isLauncher,
      `${c.name}: something else is on top of the launcher (${onTop.tag} ${onTop.cls})`,
    ).toBe(true);

    // Focus is reachable and VISIBLE — the component swaps its resting shadow
    // for the focus ring, so a focused launcher must not look unfocused.
    const before = await el.evaluate((n) => getComputedStyle(n).boxShadow);
    await el.focus();
    /* Polled, not read once: the ring comes from React state set in `onFocus`,
       so reading the computed style in the same tick as the focus call reads
       the frame BEFORE the re-render — which looks exactly like a control that
       has no focus style at all. */
    await expect
      .poll(
        async () => el.evaluate((n) => getComputedStyle(n).boxShadow),
        { timeout: 5_000, message: `${c.name}: focusing the launcher changed nothing visible` },
      )
      .not.toBe(before);
    const after = await el.evaluate((n) => getComputedStyle(n).boxShadow);
    expect(
      await el.evaluate((n) => n === document.activeElement),
      `${c.name}: the launcher did not take focus`,
    ).toBe(true);

    results.push({
      case: c.name,
      dir,
      width: box.width,
      height: box.height,
      x: box.x,
      y: box.y,
      restingShadow: before,
      focusShadow: after,
    });
    await context.close();
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, "privacy-launcher.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
    "utf8",
  );
});
