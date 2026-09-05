/**
 * COMPOSITION PROBE — what a migrated page actually renders.
 *
 * The legacy-system migration replaced 335 inline style attributes with
 * classes. An inline style always applied; a class only applies if the
 * stylesheet reached the page and the selector matched. Nothing in a
 * typecheck or a lint can tell those apart, and a page that silently lost
 * every border and every cell padding still compiles.
 *
 * So this measures, per route:
 *
 *   - the console stylesheet reached it        (a probe element resolves)
 *   - tables have real cell padding and rules  (not 0px, not transparent)
 *   - fields have a visible border             (not `none`)
 *   - the page did not lose its ground         (body background is set)
 *   - console errors
 *   - document scroll width vs viewport        (overflow)
 *
 * Usage: node scripts/admin-ledger/visual/composition.mjs <route> [<route>…]
 */
import { open, signIn, strip, WEB } from "./lib.mjs";

const routes = process.argv.slice(2);
if (routes.length === 0) {
  console.error("usage: composition.mjs <route> [<route>…]");
  process.exit(2);
}

/** The fixture rows the capture harness uses for the dynamic segments. */
const PARAMS = {
  "/admin/customers/:id": "0adf0000-0000-4000-8000-0000000000a1",
  "/admin/workspaces/:id": "0adf0000-0000-4000-8000-0000000000b1",
  "/admin/users/:id": "0adf0000-0000-4000-8000-000000000002",
  "/admin/demo-requests/:id": "0adf0000-0000-4000-8000-0000000000e1",
  "/admin/contact-sales/:id": "0adf0000-0000-4000-8000-0000000000e2",
  "/admin/platform/runbooks/:slug": "tsa-timestamp-failure",
};
const concrete = (r) => (PARAMS[r] ? r.replace(/:(\w+)$/, PARAMS[r]) : r);

const { browser, page } = await open({ width: 1440, height: 900 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await signIn(page);

let failures = 0;

for (const route of routes) {
  /* ONE RETRY ON A MISSING STYLESHEET.
     Over a 47-route sweep the dev server occasionally resets a chunk fetch
     (`net::ERR_CONNECTION_RESET`), and the CSS chunk failing to load makes
     the probe element resolve to no border — which reads exactly like "this
     page lost its stylesheet". It reported /admin/dashboard and
     /admin/executive as broken on two different runs, and both were clean on
     an immediate re-probe. A page that has genuinely lost its stylesheet
     loses it twice; a chunk reset does not. */
  let result = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    errors.length = 0;
    await page.goto(`${WEB}${concrete(route)}`, {
      waitUntil: "networkidle",
      timeout: 90_000,
    });
    await strip(page);
    await page.waitForTimeout(1200);
    result = await measure(page);
    if (result.probeBorder !== "0px") break;
  }

  const bad = [];
  await report(route, result, bad);
}

async function measure(page) {
  return page.evaluate(() => {
    /* The console's stylesheet is loaded by the admin LAYOUT, so `.adm-card`
       only exists under /admin. A Security Center page is on the product's
       shared `app-*` primitives instead, and probing it for `.adm-card` would
       report a missing stylesheet on a page that is styled correctly. Probe
       whichever system the route is supposed to be on. */
    const main = document.querySelector("main") ?? document.body;
    const admin = location.pathname.startsWith("/admin");
    const probe = document.createElement(admin ? "div" : "input");
    probe.className = admin ? "adm-card" : "app-input";
    document.body.appendChild(probe);
    const probeBorder = getComputedStyle(probe).borderTopWidth;
    probe.remove();

    /* A full-width cell is a state row — it holds an EmptyState or an
       AdmInline, both of which carry their own padding, so the CELL having
       none is correct rather than a defect. Only data cells are measured. */
    const cells = Array.from(document.querySelectorAll("td"))
      .filter((td) => !td.hasAttribute("colspan"))
      .slice(0, 60);
    const cellPads = cells.map((c) => getComputedStyle(c).paddingTop);
    const cellRules = cells.map((c) => getComputedStyle(c).borderBottomStyle);

    const fields = Array.from(
      document.querySelectorAll(
        "main input:not([type=checkbox]):not([type=radio]):not([type=hidden]), main select, main textarea",
      ),
    ).slice(0, 40);
    const fieldBorders = fields.map((f) => getComputedStyle(f).borderTopStyle);
    const fieldHeights = fields.map((f) => Math.round(f.getBoundingClientRect().height));

    /* ===================================================================
     * THE SHAPES THE COMPOSITION REVIEW KEPT FINDING BY EYE
     * ===================================================================
     * Each of these was found by opening a screenshot, and each turned out to
     * be a PATTERN rather than a one-off. Looking at 47 pages one at a time
     * finds the first instance of a shape; measuring finds all of them.
     * =================================================================== */

    /* TWO PRIMARY ACTIONS ON ONE SCREEN. /admin/identity/providers rendered
       "New connection" as a filled enterprise button in the page header AND
       again as a filled enterprise button in the empty state — so an operator
       had to decide which of two identical buttons was the real one. */
    const filled = Array.from(
      main.querySelectorAll(
        '[data-variant="primary"], [data-variant="enterprise"], .ui-button[data-variant="primary"]',
      ),
    ).filter((b) => b.getBoundingClientRect().height > 0);
    const filledLabels = filled.map((b) => (b.textContent ?? "").trim());
    const duplicatePrimary = filledLabels.filter(
      (l, i) => l && filledLabels.indexOf(l) !== i,
    ).length;

    /* TWO FILLED PRIMARIES SIDE BY SIDE — the same defect with DIFFERENT
       labels, which the duplicate-label check above cannot see.
       /admin/platform/recovery put "Run backup validation" and "Run restore
       validation (step-up)" in one row, both filled purple, so nothing said
       which an operator should reach for and the one needing a SECOND FACTOR
       looked exactly as routine as the one that does not.
       Measured per PARENT, because a page header's primary and a card's
       primary are legitimately different actions in different places; two in
       the same row are competing. */
    const primaryParents = new Map();
    for (const b of filled) {
      const key = b.parentElement;
      primaryParents.set(key, (primaryParents.get(key) ?? 0) + 1);
    }
    const competingPrimaries = [...primaryParents.values()].filter(
      (n) => n > 1,
    ).length;

    /* A COLOURED MEASURED ZERO — THE PHASE'S SIGNATURE DEFECT.
       /admin/platform/media-graph took each tile's tone from a STATIC table
       and applied it unconditionally, so on a healthy platform where all
       fourteen counters read 0 the page rendered ten amber/red warning cards
       and two green ones. A colour that cannot change cannot carry
       information, and an operator opening the page during an incident had no
       way to tell the amber that means something from the amber that is
       always there.
       Measured as a card-like element whose largest number is 0 and whose
       background is a tinted (non-white, non-page) ground. */
    const colouredZeros = Array.from(
      main.querySelectorAll("li, .adm-card, .adm-kpi, .apf-stat, [data-metric-tile]"),
    ).filter((el) => {
      const text = (el.textContent ?? "").trim();
      // The figure the card is about: its largest standalone number.
      const nums = text.match(/(?<![\w.])\d+(?![\w.%])/g);
      if (!nums || nums.length === 0) return false;
      if (Math.max(...nums.map(Number)) !== 0) return false;
      const bg = getComputedStyle(el).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(bg);
      if (!m) return false;
      const [r, g, b, a = "1"] = m[1].split(",").map((v) => parseFloat(v));
      if (Number(a) === 0) return false;
      // Tinted = the channels disagree by more than a neutral grey would.
      return Math.max(r, g, b) - Math.min(r, g, b) > 8;
    }).length;

    /* A RATIO OVER ZERO. `5 / 0` seats, `0 of 0` connections ready — two
       facts that disagree, rendered as though they were one measurement. An
       operator reads it as a fault rather than as "there is no denominator". */
    /* `textContent` CONCATENATES ACROSS ELEMENTS, so the trailing `\b` was
       the wrong boundary. On /admin/customers/:id the page reads
       "…(used / included)4 / 0Over-seat workspaces0…" once flattened, and
       `0O` is two word characters — no boundary — so the one page carrying
       this defect on a detail surface was reported clean. The requirement is
       only that the zero is not part of a LARGER number. */
    const zeroDenominator = (
      (main.textContent ?? "").match(/\d+\s*(?:\/|of)\s*0(?!\d)/g) ?? []
    ).length;

    /* A FULL TIMESTAMP AS A SUB-LINE IN A SCANNABLE LIST. Correct on an audit
       row; noise under every name in a directory, where it also wraps and
       makes each row three lines tall. Detected as a seconds-precision stamp
       inside a table cell that also holds a bold name. */
    const secondsInList = Array.from(main.querySelectorAll("tbody td")).filter(
      (td) =>
        /\d{1,2}:\d{2}:\d{2}/.test(td.textContent ?? "") &&
        /* ANY bold weight, not the two this happened to be written with.
           /admin/users used `fontWeight: 620` and was therefore reported as
           clean while printing `joined 05 Sept 2026, 11:19:54 Europe/Berlin`
           under every address. */
        (td.querySelector("strong, b") ||
          Array.from(td.querySelectorAll("*")).some(
            (el) => (parseInt(getComputedStyle(el).fontWeight, 10) || 400) >= 600,
          )),
    ).length;

    /* CENTRED PROSE IN A TALL BOX, WHERE A 56px ROW BELONGS.
       The console has ONE empty state: a left-aligned row that names WHICH
       state it is and why. /admin/platform/exports still had the older shape
       — a 74px card holding one centred muted line and no label — which is
       the ~25-instance form the phase replaced everywhere else, and it reads
       as "loading, forever" rather than as an answer. */
    const centredEmpties = Array.from(
      main.querySelectorAll(".adm-card, .apf-section, section, div"),
    ).filter((el) => {
      if (getComputedStyle(el).textAlign !== "center") return false;
      const text = (el.textContent ?? "").trim();
      if (text.length === 0 || text.length > 200) return false;
      if (el.querySelector("table, ul, ol, button, a, svg, img")) return false;
      return el.getBoundingClientRect().height > 56;
    }).length;

    /* A COLUMN WHERE EVERY ROW SAYS THE SAME THING.
       /admin/identity/runtime rendered `0adf0000-000…` in its User column on
       all twenty-five session rows: `shortId` took a UUID's FIRST eight
       characters, and these ids are allocated sequentially so the entropy is
       at the end. A truncation that truncates away the distinguishing part is
       worse than none — the column looks like data and carries none, and an
       operator picking a session to quarantine cannot tell which row they are
       acting on.
       Only flagged with 5+ rows, and only when the repeated value is
       non-trivial: a column of "—" or of one repeated status is a legitimate
       answer about the data, not a rendering fault. */
    const deadColumns = (() => {
      const bodyRows = Array.from(main.querySelectorAll("tbody tr")).filter(
        (tr) => !tr.querySelector("td[colspan]"),
      );
      if (bodyRows.length < 5) return 0;
      const width = bodyRows[0].querySelectorAll("td").length;
      let dead = 0;
      for (let c = 0; c < width; c += 1) {
        const values = bodyRows.map(
          (tr) => (tr.querySelectorAll("td")[c]?.textContent ?? "").trim(),
        );
        const first = values[0];
        // A truncated identifier is the case this exists for: it ends in an
        // ellipsis and repeats. A short repeated word is data, not a defect.
        if (!first || first.length < 8) continue;
        if (!/[…]/.test(first)) continue;
        if (!values.every((v) => v === first)) continue;

        /* IS THE TRUNCATION HIDING A DIFFERENCE, OR ARE THE VALUES THE SAME?
           After the `shortId` fix, /admin/identity/runtime still showed one
           string on all 25 rows — because all 25 ARE one user's sessions.
           That is honest data, and failing on it would push the page toward
           inventing a distinction that does not exist.
           The full value lives in each cell's `title`, so the two cases are
           separable: identical DISPLAY over differing FULL values is the
           defect; identical display over identical full values is the truth. */
        const fulls = bodyRows.map((tr) => {
          const td = tr.querySelectorAll("td")[c];
          return (
            td?.getAttribute("title") ??
            td?.querySelector("[title]")?.getAttribute("title") ??
            ""
          );
        });
        const distinctFulls = new Set(fulls.filter(Boolean)).size;
        if (distinctFulls > 1) dead += 1;
        // No titles at all is also a finding: nothing on the page carries the
        // value the truncation removed, so it cannot be recovered or copied.
        else if (distinctFulls === 0) dead += 1;
      }
      return dead;
    })();

    /* A ROW RENDERED FOUR LINES TALL. Two stacked badges saying the same
       thing twice, or a phrase wrapping mid-word in a narrow column.
       MEASURED PER ROW, NOT PER CELL: a `<td>`'s height IS its row's height,
       so the first version of this counted every cell in a tall row and
       reported "18 tall cells" for a two-row table with nine columns. The
       threshold is absolute — 100px is four lines of 13px text with padding,
       which no data row needs. */
    const tallRows = Array.from(main.querySelectorAll("tbody tr")).filter(
      (tr) =>
        !tr.querySelector("td[colspan]") &&
        tr.getBoundingClientRect().height > 100,
    ).length;
    const rows = main.querySelectorAll("tbody tr").length;

    /* TONE INFLATION: A WARNING COLOUR ON MOST OF THE ROWS.
       /admin/adoption rendered an amber "Never used" badge on 15 of its 17
       capabilities, so a page reporting ordinary adoption read as fifteen
       cautions. A tone that applies to most of a table has stopped
       distinguishing anything, which is the same defect as the Control
       Center's coloured zeros. Measured as the share of DATA ROWS carrying a
       pending or risk badge; a page where that exceeds 60% is either an
       emergency or is inflating. */
    const dataRows = Array.from(main.querySelectorAll("tbody tr")).filter(
      (tr) => !tr.querySelector("td[colspan]"),
    );
    const alarmedRows = dataRows.filter((tr) =>
      tr.querySelector(
        '[data-tone="pending"], [data-tone="risk"], [data-ui-badge][data-tone="pending"]',
      ),
    ).length;
    const alarmShare = dataRows.length > 0 ? alarmedRows / dataRows.length : 0;

    /* A DISABLED CONTROL THAT DOES NOT SAY WHY.
       §11's BLOCKED state is "the control is disabled, WITH the reason". A
       grey button an operator cannot press and cannot explain is a dead end:
       /admin/support-access had TWO of them, both acting over a customer's
       data, both refusing silently until the right field happened to be long
       enough. A pager's Previous on page one is exempt — its own position
       text is the reason, and it is the one disabled control in the console
       whose cause is already on screen. */
    /* A RAW ISO TIMESTAMP RENDERED TO A HUMAN.
       /admin/platform/readiness printed `Generated 2026-09-05T15:28:59.807Z`
       on the page an operator reads to decide whether the platform is ready
       to launch. Every other timestamp in the console goes through the shared
       formatter; a machine string with milliseconds and a Z is what the API
       returned, not what a person reads. Deliberately excludes anything
       inside a `<code>`, `<pre>` or `.adm-mono` — a raw value shown AS a raw
       value (an audit payload, a manifest field) is correct. */
    const rawIso = (() => {
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      let n = 0;
      let node;
      while ((node = walker.nextNode())) {
        if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(node.nodeValue ?? "")) continue;
        const el = node.parentElement;
        if (!el) continue;
        if (el.closest("code, pre, .adm-mono, [data-mono], input, textarea")) continue;
        n += 1;
      }
      return n;
    })();

    const PAGER = /^(next|previous|prev|older|newer)$/i;
    const disabledControls = Array.from(
      main.querySelectorAll("button[disabled], [aria-disabled='true']"),
    ).filter((b) => b.getBoundingClientRect().height > 0);
    const silentDisabled = disabledControls.filter((b) => {
      const label = (b.textContent ?? "").trim();
      if (PAGER.test(label)) return false;
      if (b.getAttribute("title")) return false;
      if (b.getAttribute("aria-describedby")) return false;
      // A sentence beside it, or in the card that holds it, counts.
      const near = b.parentElement?.textContent ?? "";
      return near.replace(label, "").trim().length < 12;
    }).length;

    /**
     * A LINE THAT BREAKS INSIDE A WORD.
     *
     * `/admin/platform/analytics` traces every number to the table it came
     * from, and under the last Automation tile that trace rendered as
     *
     *     source: AutomationWebhookDestinati
     *     on
     *
     * — a twenty-eight-character model name with no break opportunity in it,
     * in a hundred-and-twenty-pixel tile, on a surface whose whole claim is
     * that a number can be checked against its source. A reader cannot check
     * a name they cannot read, and an operator's next step is to grep for it.
     *
     * MEASURED, NOT GUESSED AT FROM THE SOURCE. Whether a word breaks depends
     * on the rendered width, the font and the wrap rule, so the only place the
     * answer exists is the laid-out page. Each text node's characters are
     * rected and grouped into line boxes; a break is mid-word when a line ends
     * on a letter or digit and the next line starts on a LOWER-CASE letter,
     * which no legitimate wrap does.
     *
     * Bounded deliberately: only nodes short enough to be a label, a value or
     * a trace. A paragraph of prose wraps constantly and legitimately, and
     * walking every character of every paragraph on a 3,000px page costs
     * seconds for an answer nobody needs.
     */
    const splitWords = (() => {
      const hits = [];
      const range = document.createRange();
      const walker = document.createTreeWalker(
        document.querySelector("main") ?? document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node = walker.nextNode();
      while (node) {
        const text = node.data ?? "";
        // A label, a value or a trace — not a sentence.
        if (text.trim().length >= 8 && text.trim().length <= 64) {
          const byTop = new Map();
          for (let i = 0; i < text.length; i += 1) {
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const r = range.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            const top = Math.round(r.top);
            byTop.set(top, (byTop.get(top) ?? "") + text[i]);
          }
          const lines = [...byTop.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, s]) => s);
          for (let i = 0; i < lines.length - 1; i += 1) {
            const endsWord = /[A-Za-z0-9]$/.test(lines[i]);
            const startsLower = /^[a-z]/.test(lines[i + 1]);
            if (endsWord && startsLower) {
              hits.push(`${lines[i].slice(-14)}|${lines[i + 1].slice(0, 14)}`);
              break;
            }
          }
        }
        node = walker.nextNode();
      }
      return hits;
    })();

    /**
     * HOW MANY SOLID-RED CONTROLS, AND HOW MANY IN ONE ROW.
     *
     * `/admin/identity/sessions` rendered TWO of them per row — "Revoke" and
     * "Revoke all" — so a full page carried fifty, and the more dangerous of
     * the pair was indistinguishable from the safer one. "Revoke all" is also
     * member-scoped, so a member with ten live sessions rendered ten identical
     * copies of the same button.
     *
     * Fifty red buttons remove red's meaning from the page: when everything is
     * an alarm, the one genuine alarm is invisible. For scale, the other three
     * admin routes with a filled destructive control render one, one and four.
     *
     * MEASURED BY COMPUTED FILL, not by variant name — a page can reach the
     * same appearance with an inline style, and what matters is what the
     * reader sees. Two per row is the finding; a page total is advisory,
     * because a long list of genuinely destructive rows is a real shape.
     */
    const destructive = (() => {
      const solidRed = (el) => {
        const m = /rgba?\(([0-9.]+), ([0-9.]+), ([0-9.]+)(?:, ([0-9.]+))?\)/.exec(
          getComputedStyle(el).backgroundColor,
        );
        if (!m) return false;
        const alpha = m[4] === undefined ? 1 : Number(m[4]);
        // Opaque, red-dominant, and not a pale tint.
        return (
          alpha > 0.8 &&
          Number(m[1]) > 150 &&
          Number(m[2]) < 110 &&
          Number(m[3]) < 110
        );
      };
      const controls = Array.from(
        main.querySelectorAll("button, a.ui-button"),
      ).filter((b) => b.getBoundingClientRect().height > 0 && solidRed(b));
      const perRow = Array.from(main.querySelectorAll("tbody tr")).map(
        (tr) =>
          Array.from(tr.querySelectorAll("button, a.ui-button")).filter(solidRed)
            .length,
      );
      return {
        total: controls.length,
        maxPerRow: perRow.length ? Math.max(...perRow) : 0,
        labels: [...new Set(controls.map((b) => (b.textContent ?? "").trim()))].slice(
          0,
          4,
        ),
      };
    })();

    /**
     * A CONTROL THAT RENDERS OUTSIDE WHAT THE READER CAN SEE.
     *
     * `/admin/identity/sessions` carried four controls in its actions cell,
     * which made the table 1214→1268px inside a 1216px wrapper. "Revoke all"
     * rendered at x=1403 against a visible container edge at x=1362, on all
     * twenty-five rows, at the default 1440px desktop width.
     *
     * BE PRECISE ABOUT WHAT THAT IS. The wrapper is `overflow-x: auto`, so the
     * button was REACHABLE — by scrolling a nine-column table sideways to find
     * a row action. It was not clipped by a `hidden` container, and the first
     * version of this check looked only for `hidden`/`clip` and therefore
     * reported nothing even when handed the pre-fix DOM. An instrument that
     * cannot reproduce the defect it was written for is worse than none: it
     * certifies the page.
     *
     * So the rule is the one that matches the fault: a CONTROL whose box falls
     * outside its scroll container's visible box, whether or not that
     * container scrolls. Wide DATA scrolling inside its own surface is this
     * console's documented pattern and stays fine — off-screen columns are
     * still columns. An off-screen button is a capability the page appears not
     * to have, with nothing on screen saying otherwise.
     */
    const clippedControls = (() => {
      const hits = [];
      for (const el of main.querySelectorAll("button, a.ui-button")) {
        const r = el.getBoundingClientRect();
        if (r.height === 0 || r.width === 0) continue;
        let node = el.parentElement;
        while (node && node !== document.body) {
          const cs = getComputedStyle(node);
          if (/hidden|clip|auto|scroll/.test(cs.overflowX)) {
            const b = node.getBoundingClientRect();
            if (r.right > b.right + 1 || r.left < b.left - 1) {
              hits.push((el.textContent ?? "").trim().slice(0, 20));
            }
            break;
          }
          node = node.parentElement;
        }
      }
      return [...new Set(hits)];
    })();

    return {
      splitWords,
      destructive,
      clippedControls,
      probeBorder,
      duplicatePrimary,
      competingPrimaries,
      filledPrimaries: filled.length,
      zeroDenominator,
      colouredZeros,
      secondsInList,
      tallRows,
      deadColumns,
      centredEmpties,
      alarmedRows,
      silentDisabled,
      rawIso,
      disabledControls: disabledControls.length,
      dataRows: dataRows.length,
      alarmShare: Math.round(alarmShare * 100),
      rows,
      cells: cells.length,
      flatCells: cellPads.filter((p) => p === "0px").length,
      ruleless: cellRules.filter((s) => s === "none").length,
      fields: fields.length,
      borderless: fieldBorders.filter((s) => s === "none").length,
      shortFields: fieldHeights.filter((h) => h > 0 && h < 44).length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      overflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
      legacyInline: document.querySelectorAll(
        'main [style*="borderCollapse"], main [style*="border-collapse"]',
      ).length,
    };
  });
}

/** Turn a measurement into findings and a printed line. */
async function report(route, result, bad) {
  if (result.probeBorder === "0px") bad.push("STYLESHEET NOT APPLIED (twice)");
  if (result.splitWords?.length) {
    bad.push(
      `${result.splitWords.length} word(s) broken mid-word: ` +
        result.splitWords.slice(0, 3).join(", "),
    );
  }
  if ((result.destructive?.maxPerRow ?? 0) > 1) {
    bad.push(
      `${result.destructive.maxPerRow} solid-red controls in one row ` +
        `(${result.destructive.total} on the page): ` +
        result.destructive.labels.join(" / "),
    );
  }
  if (result.clippedControls?.length) {
    bad.push(
      `${result.clippedControls.length} control(s) outside the visible box of ` +
        `their container: ${result.clippedControls.slice(0, 3).join(", ")}`,
    );
  }
  if (result.cells > 0 && result.flatCells > 0)
    bad.push(`${result.flatCells}/${result.cells} cells with no padding`);
  if (result.cells > 0 && result.ruleless === result.cells)
    bad.push("no row rules at all");
  if (result.borderless > 0)
    bad.push(`${result.borderless}/${result.fields} fields with no border`);
  if (result.shortFields > 0)
    bad.push(`${result.shortFields} fields under 44px`);
  if (result.overflow > 0) bad.push(`overflow ${result.overflow}px`);

  /* A SCRIPT ERROR IS A DEFECT. A 402 IS THE PAGE DOING ITS JOB.
     `/admin/identity/access-reviews` logs "Failed to load resource: the
     server responded with a status of 402" because the fixture workspace's
     plan does not carry the surface — and the page then renders the refusal
     that 402 means. Counting the browser's network log as a page defect
     reported the ONE route that exercises PLAN_GATED as the only unclean
     route in the console. A refusal the page handles is separated from an
     error it did not. */
  const REFUSAL_STATUS = /Failed to load resource.*\b(400|402|403|404|409)\b/;
  const refusals = errors.filter((e) => REFUSAL_STATUS.test(e));
  const scriptErrors = errors.filter((e) => !REFUSAL_STATUS.test(e));
  if (scriptErrors.length) bad.push(`${scriptErrors.length} console errors`);
  const note = refusals.length
    ? `  (${refusals.length} handled refusal response${refusals.length > 1 ? "s" : ""})`
    : "";
  if (result.competingPrimaries > 0) {
    bad.push(
      `${result.competingPrimaries} row(s) with two filled primary actions`,
    );
  }
  if (result.duplicatePrimary > 0) {
    bad.push(`${result.duplicatePrimary} duplicate primary action(s)`);
  }
  if (result.colouredZeros > 0) {
    bad.push(`${result.colouredZeros} measured zero(s) on a tinted ground`);
  }
  if (result.zeroDenominator > 0) {
    bad.push(`${result.zeroDenominator} ratio(s) over a zero denominator`);
  }
  if (result.secondsInList > 0) {
    bad.push(`${result.secondsInList} list cells carrying a seconds-precision stamp`);
  }
  /* TONE INFLATION IS AN ADVISORY, NOT A FAILURE, BECAUSE THIS CANNOT TELL A
     FAILURE LIST FROM AN INFLATED ONE.
     Four routes exceed 60%, and three of them are RIGHT to:

       /admin/platform/queues        15/15 — the table IS the failed-job list
       /admin/evidence-ops/records    5/5  — the cohort IS failed records
       /admin/identity/timeline       8/12 — fixture severities, genuinely HIGH
       /admin/security                8/12 — fixture posture findings

     The one that was wrong was /admin/adoption, where 15 of 17 ordinary
     capabilities carried amber for "never used" — a fact about adoption, not
     a caution — and that is fixed. A check that failed the build here would
     force a table of failures to stop looking like one, so it reports and
     leaves the judgement where it belongs. */
  const advisory =
    result.dataRows >= 5 && result.alarmShare > 60
      ? `  [advisory] ${result.alarmedRows}/${result.dataRows} rows carry a warning tone (${result.alarmShare}%)`
      : "";
  if (result.rawIso > 0) {
    bad.push(`${result.rawIso} raw ISO timestamp(s) rendered as prose`);
  }
  if (result.silentDisabled > 0) {
    bad.push(
      `${result.silentDisabled}/${result.disabledControls} disabled controls give no reason`,
    );
  }
  if (result.centredEmpties > 0) {
    bad.push(`${result.centredEmpties} centred prose block(s) taller than a state row`);
  }
  if (result.deadColumns > 0) {
    bad.push(
      `${result.deadColumns} truncated column(s) identical on every row`,
    );
  }
  if (result.tallRows > 0) {
    bad.push(`${result.tallRows}/${result.rows} data rows over four lines tall`);
  }

  if (bad.length) failures += 1;
  console.log(
    `${bad.length ? "FAIL" : "ok  "}  ${route.padEnd(44)} ` +
      `h=${String(result.height).padStart(5)} ` +
      `td=${String(result.cells).padStart(3)} ` +
      `field=${String(result.fields).padStart(2)}` +
      note +
      advisory +
      (bad.length ? "\n        " + bad.join("; ") : ""),
  );
  if (scriptErrors.length) {
    for (const e of scriptErrors.slice(0, 3)) console.log("        ! " + e.slice(0, 160));
  }
}

await browser.close();
console.log(`\n${routes.length - failures}/${routes.length} routes clean`);
process.exit(failures ? 1 : 0);
