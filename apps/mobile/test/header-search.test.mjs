/**
 * T-09a / RC-10 — global search must be reachable from EVERY primary surface.
 *
 * THE DEFECT THIS WOULD HAVE CAUGHT
 * ---------------------------------
 * The native app had no header. `/search` was reachable from exactly ONE place
 * in the entire application — a card on Home (`app/(tabs)/index.tsx:280`) — so
 * five of the seven primary destinations offered no search at all. That is the
 * "missing search" the user reported on a physical iPad.
 *
 * The web renders `AppAccountToolbar` from `AppShellV2` on every authenticated
 * page, and the search control lives there (`AppAccountToolbar.tsx:326-338`).
 *
 * These tests assert REACHABILITY (the header is in the shell, and the shell
 * wraps every primary surface), not merely that a search component exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWithProviders, renderInProviders, React } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const shell = readFileSync(resolve(MOBILE, "src/ui/shell.tsx"), "utf8");
const header = readFileSync(resolve(MOBILE, "src/ui/header.tsx"), "utf8");

test("the header exists and routes to the search surface", () => {
  assert.match(header, /router\.push\("\/search"\)/, "the header search does not reach /search");
  assert.match(
    header,
    /accessibilityRole="search"/,
    "the search control carries no search role, so assistive tech cannot find it",
  );
});

test("the shell renders the header in BOTH nav modes", () => {
  // Reachability is the whole point: a header only mounted on the phone bottom
  // layout would leave every tablet screen without search, which is the iPad
  // case the user actually reported.
  const railBranch = shell.slice(shell.indexOf('if (navMode === "rail")'), shell.indexOf("return (\n    <SafeAreaView style={styles.screen} edges={[\"top\", \"left\", \"right\"]}>\n      <OfflineBanner />\n      {/* T-09a"));
  assert.match(railBranch, /<ProovraHeader \/>/, "the TABLET rail layout renders no header");

  const phoneBranch = shell.slice(shell.lastIndexOf("<OfflineBanner />"));
  assert.match(phoneBranch, /<ProovraHeader \/>/, "the PHONE layout renders no header");
});

test("Home no longer carries a duplicate search card", () => {
  const home = readFileSync(resolve(MOBILE, "app/(tabs)/index.tsx"), "utf8");
  assert.doesNotMatch(
    home,
    /onPress=\{\(\) => router\.push\("\/search"\)\}/,
    "Home still has its own search card. The web's Home has none — the " +
      "affordance belongs to the shell header so it is available everywhere.",
  );
  assert.doesNotMatch(home, /styles\.searchBar/, "the orphaned searchBar style survived");
});

test("every primary destination is wrapped by the shell that owns the header", () => {
  // Every tab surface must render through
  // ProovraShell, otherwise the header is absent on that screen specifically.
  const tabs = readdirSync(resolve(MOBILE, "app/(tabs)")).filter(
    (f) => f.endsWith(".tsx") && f !== "_layout.tsx",
  );
  assert.ok(tabs.length >= 6, `expected the tab group to hold the primary surfaces, found ${tabs.length}`);
  for (const f of tabs) {
    const src = readFileSync(join(resolve(MOBILE, "app/(tabs)"), f), "utf8");
    assert.match(
      src,
      /<ProovraShell>/,
      `app/(tabs)/${f} does not render through ProovraShell, so it has no header and no search`,
    );
  }
});

test("T-09b: the workspace switcher is in the header, not buried in Settings", () => {
  // Before this, /spaces was reachable from ONE row inside the Settings tab
  // (app/(tabs)/settings.tsx:174) while the web offers the switcher in the
  // header on every page. A user on the wrong workspace had to leave the screen.
  assert.match(header, /router\.push\("\/spaces"\)/, "the header does not reach the switcher");
  assert.match(
    header,
    /Active workspace: \$\{workspaceName\}\. Open workspace switcher\./,
    "the accessible name does not mirror the web's (AppAccountToolbar.tsx:402)",
  );
  // The name must come from the server-projected envelope, never derived.
  assert.match(
    header,
    /context\?\.displayName/,
    "the workspace name is not read from the canonical platform context",
  );
});

test("T-09b: the switcher REUSES the existing surface rather than reimplementing it", () => {
  // src/product/spaces.ts owns projectSpaces / canSwitchTo / SWITCH_WORKSPACE_PATH
  // and app/(stack)/spaces.tsx renders them. The header must route there, not
  // grow a second switching path with its own POST.
  //
  // Comments are stripped first: the rationale above NAMES those symbols, and
  // matching the prose made this assert against its own documentation.
  const code = header
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.doesNotMatch(
    code,
    /SWITCH_WORKSPACE_PATH|switch-workspace/,
    "the header performs its own workspace switch. That is a second authority " +
      "for a server-pointer mutation; route to /spaces instead.",
  );

  // NARROWED from "the header makes no API calls at all", which was wrong: the
  // bell (T-09d) legitimately READS the canonical inbox summary. What must not
  // appear is a MUTATION — a header that writes is a second authority for state
  // the surfaces own.
  assert.doesNotMatch(
    code,
    /method:\s*"(POST|PUT|PATCH|DELETE)"/,
    "the header issues a mutating request. It may read for display; state " +
      "changes belong to the surface that owns them.",
  );
});

test("T-09d: the bell reads the CANONICAL aggregation and never invents zero", () => {
  // me-inbox.routes.ts:1376-1386 — /v1/me/inbox, /v1/me/inbox/summary and
  // mark-all-read share ONE aggregation precisely so the badge and the page
  // cannot disagree. The header must use that, not count a page itself.
  assert.match(header, /INBOX_SUMMARY_PATH/, "the bell does not read the canonical summary endpoint");
  assert.match(header, /router\.push\("\/notifications"\)/, "the bell does not reach the notification centre");

  const inbox = readFileSync(resolve(MOBILE, "src/product/inbox.ts"), "utf8");
  assert.match(
    inbox,
    /INBOX_SUMMARY_PATH = "\/v1\/me\/inbox\/summary"/,
    "the summary path is not the canonical cached bell endpoint",
  );
  // The honesty property: unknown must not render as zero.
  assert.match(
    inbox,
    /if \(unread === null \|\| unread <= 0\) return null;/,
    "inboxBadgeLabel no longer suppresses the badge for an unknown count — a " +
      "failed read would be shown to the user as 'all clear'.",
  );
});

test("RENDER: the header actually renders a reachable search control", async () => {
  // Asserted on the RENDERED tree, not on the source containing the string —
  // the distinction this harness exists to keep.
  const mod = await loadWithProviders("src/ui/header.tsx", ["ProovraHeader"]);
  const r = await renderInProviders(mod, React.createElement(mod.ProovraHeader, null));

  const searchNodes = r.byRole("search");
  assert.equal(
    searchNodes.length,
    1,
    `expected exactly one search control in the header, found ${searchNodes.length}`,
  );

  const texts = r.texts();
  assert.ok(
    texts.some((t) => t.includes("Search or jump to")),
    `the rendered header shows no search affordance text; saw ${JSON.stringify(texts)}`,
  );
});
