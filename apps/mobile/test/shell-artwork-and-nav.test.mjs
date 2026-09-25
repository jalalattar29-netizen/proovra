/**
 * T-05 / RC-05 and T-06 / RC-06 — the tablet rail must render the canonical
 * branded artwork, and must colour its labels with the palette that actually
 * WINS on the web.
 *
 * THE DEFECTS THESE TESTS WOULD HAVE CAUGHT
 * -----------------------------------------
 * RC-05: `apps/mobile/assets/` held five files, all launcher/splash icons. No
 * background artwork existed in the bundle and no `ImageBackground` appeared
 * anywhere in the app, so the web's branded sidebar had nothing to render.
 *
 * RC-06: the rail coloured its idle labels with `ink.muted` (#94A3B8) where the
 * web uses `--nav-ink` (#1A1F2B), and rendered no active capsule at all.
 *
 * A CORRECTION THE AUDIT ITSELF NEEDED
 * ------------------------------------
 * RC-06 originally claimed the web sidebar was DARK artwork with LIGHT ink, and
 * that `theme.color.nav.*` carried matching values. Both halves were wrong: the
 * audit resolved `--nav-*` through `tokens.css` (`:root`) only and never saw
 * that `app-shell-v2.css:48-58` overrides every one of them at component scope.
 * The web's own comment there reads "the rail background is a very light
 * artwork ... every nav foreground colour is enterprise-dark ... Never white."
 *
 * So `theme.color.nav.inkStrong` (#F8FAFC) is near-WHITE and would be illegible
 * on the light artwork. These tests pin the WINNING values and explicitly
 * forbid the `:root` ones, so the original mistake cannot be re-made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const WEB = resolve(MOBILE, "../web");
const shell = readFileSync(resolve(MOBILE, "src/ui/shell.tsx"), "utf8");

test("the canonical sidebar artwork is in the native bundle", () => {
  const asset = resolve(MOBILE, "assets/brand/sidebar-bg.png");
  assert.ok(
    existsSync(asset),
    "assets/brand/sidebar-bg.png is missing. The rail cannot render the " +
      "branded surface the web declares at app-shell-v2.css:175.",
  );
  // A zero-byte file would satisfy existsSync and render nothing.
  assert.ok(statSync(asset).size > 100_000, "the sidebar artwork is implausibly small");
});

test("the artwork the native bundle ships is the SAME file the web renders", () => {
  const nativeAsset = readFileSync(resolve(MOBILE, "assets/brand/sidebar-bg.png"));
  const webAsset = readFileSync(resolve(WEB, "public/assets/cards/sidebar.png"));
  assert.deepEqual(
    nativeAsset,
    webAsset,
    "the native sidebar artwork has diverged from the web reference. The PWA is " +
      "the canonical design source; a different image is a parity defect.",
  );
});

test("the rail actually renders the artwork", () => {
  assert.match(shell, /sidebar-bg\.png/, "shell.tsx does not import the sidebar artwork");

  // Scope to the rail component. Matching "ImageBackground" anywhere in the
  // file passes on the IMPORT line alone — which it did on the first draft of
  // this test, making it unable to fail on the very defect it exists for.
  const start = shell.indexOf("export function ProovraTabletRail");
  const end = shell.indexOf("export function ProovraShell");
  assert.ok(start > 0 && end > start, "could not locate ProovraTabletRail");
  const rail = shell.slice(start, end);

  assert.match(rail, /<ImageBackground/, "the rail does not render an ImageBackground");
  assert.match(rail, /source=\{SIDEBAR_BG\}/, "the rail renders no artwork source");
  assert.match(
    rail,
    /resizeMode="cover"/,
    'the web uses background-size: cover; RN needs resizeMode="cover" to match',
  );
});

test("the rail uses the palette that actually WINS on the web", () => {
  assert.match(shell, /inkStrong: "#141A22"/, "rail active label is not the winning --nav-ink-strong");
  assert.match(shell, /ink: "#1A1F2B"/, "rail idle label is not the winning --nav-ink");
  assert.match(shell, /activeBg: "rgba\(255, 255, 255, 0\.45\)"/, "the active white capsule is missing");
});

test("the rail does NOT fall back to the :root nav tokens or the body ink ramp", () => {
  // Bound the slice to the RAIL branch only. The bottom-bar branch legitimately
  // uses ink.muted, so including it would make this assertion unfalsifiable.
  const start = shell.indexOf('if (orientation === "rail")');
  const end = shell.indexOf("// The phone bottom bar is NOT the branded rail");
  assert.ok(start > 0 && end > start, "could not locate the rail branch of navPalette");
  const railBranch = shell.slice(start, end);

  assert.doesNotMatch(
    railBranch,
    /theme\.color\.nav\./,
    "the rail uses theme.color.nav.* (the tokens.css :root values). Those are " +
      "near-white and unreadable on the light sidebar artwork — the component " +
      "stylesheet overrides them for exactly that reason.",
  );
  assert.doesNotMatch(
    railBranch,
    /theme\.color\.ink\.muted/,
    "the rail still uses ink.muted (#94A3B8) for idle labels where the web uses " +
      "--nav-ink (#1A1F2B). That is the low-contrast regression.",
  );
});

test("the sidebar override values still match the web stylesheet", () => {
  // Makes the copied palette falsifiable: if the web restyles its sidebar this
  // fails, instead of letting native drift silently.
  const css = readFileSync(resolve(WEB, "components/app-shell-v2/app-shell-v2.css"), "utf8");
  const pairs = [
    ["--nav-ink", "#1A1F2B"],
    ["--nav-ink-strong", "#141A22"],
    ["--nav-icon-idle", "#495469"],
    ["--nav-active-bg", "rgba(255, 255, 255, 0.45)"],
  ];
  for (const [prop, expected] of pairs) {
    const m = css.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
    assert.ok(m, `${prop} is no longer declared in app-shell-v2.css`);
    assert.equal(
      m[1].trim(),
      expected,
      `${prop} changed on the web; the native rail must follow it`,
    );
  }
});

test("the phone bottom bar keeps the body ink ramp", () => {
  // The bottom bar sits on surface.card, not on the artwork, so the sidebar
  // palette would be wrong there. Asserts the split is deliberate.
  const start = shell.indexOf("// The phone bottom bar is NOT the branded rail");
  assert.ok(start > 0, "the bottom-bar branch lost its rationale comment");
  const bottomBranch = shell.slice(start, start + 400);
  assert.match(
    bottomBranch,
    /theme\.color\.ink\.primary/,
    "the bottom bar no longer uses the body ink ramp",
  );
});
