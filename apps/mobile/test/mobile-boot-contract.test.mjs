/**
 * PERMANENT GUARD D (audit §19) — mobile boot / root-composition contract.
 *
 * F4 was: the Expo Router root `app/_layout.tsx` was a `Tabs` navigator that
 * mounted NONE of the React providers, so the first routed screen's `useAuth()`
 * threw "AuthContext missing" and the whole app fell into the ErrorBoundary.
 *
 * A functional boot (rendering the tree with the native runtime) requires a
 * device/emulator and is part of physical acceptance. This is the durable
 * source contract that catches the exact regression class without a device:
 * the ONE root must mount every provider `useAuth`/`useToast`/`useLocale`
 * depend on and render a real navigator. It also guards the reported Android
 * symptom: the web-only Direct Web Capture surface must never appear in the
 * native app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "../app");
const SRC_DIR = resolve(HERE, "../src");
const rootLayout = readFileSync(join(APP_DIR, "_layout.tsx"), "utf8");
const indexGate = readFileSync(join(APP_DIR, "index.tsx"), "utf8");

test("the root layout mounts every global provider (F4)", () => {
  for (const provider of ["AuthProvider", "ToastProvider", "LocaleProvider"]) {
    assert.match(rootLayout, new RegExp(`<${provider}[\\s>]`), `root must mount <${provider}>`);
    assert.match(rootLayout, new RegExp(`import\\s*\\{[^}]*\\b${provider}\\b`), `root must import ${provider}`);
  }
});

test("the root layout wraps everything in the ErrorBoundary and renders a navigator", () => {
  assert.match(rootLayout, /<ErrorBoundary>/, "root must mount the ErrorBoundary");
  assert.match(rootLayout, /<(Stack|Slot|Tabs)\b/, "root must render an Expo Router navigator");
});

test("the root is NOT a providerless Tabs-only root (the F4 regression shape)", () => {
  // The broken root rendered a Tabs listing only lifecycle screens with no
  // provider mounted. If a Tabs root ever returns, it must still mount providers.
  const mountsAuth = /<AuthProvider[\s>]/.test(rootLayout);
  assert.ok(mountsAuth, "root must mount AuthProvider regardless of navigator kind");
});

test("the first routed screen depends on AuthProvider (documents the guarded contract)", () => {
  assert.match(indexGate, /useAuth\(\)/, "app/index.tsx should consume useAuth (needs the provider)");
});

test("native screen-capture entries live in CAPTURE, platform-gated — not on Home", () => {
  // This test used to REQUIRE the opposite ("Home should route to UC-2
  // /screen-capture"), which is how the landing page became a native-capability
  // launcher. Screen capture is an acquisition SOURCE; it belongs beside the
  // photo/video/audio/document chooser, where a user decides how to record.
  const home = readFileSync(join(APP_DIR, "(tabs)", "index.tsx"), "utf8");
  assert.ok(!home.includes("/screen-capture"), "UC-2 must not be reachable from Home");
  assert.ok(!home.includes("/continuous-capture"), "UC-3/UC-5 must not be reachable from Home");

  const capture = readFileSync(join(APP_DIR, "(stack)", "capture.tsx"), "utf8");
  assert.match(capture, /Platform\.OS\s*===\s*"android"/, "Capture must gate the Android engines");
  assert.ok(capture.includes("/screen-capture"), "Capture routes to UC-2 /screen-capture");
  assert.ok(capture.includes("/continuous-capture"), "Capture routes to UC-3/UC-5");
  const gateIdx = capture.search(/Platform\.OS\s*===\s*"android"/);
  const scIdx = capture.indexOf('"/screen-capture"');
  assert.ok(gateIdx >= 0 && gateIdx < scIdx, "the Android-only entries sit under the Android gate");
});
test("Home has no hardcoded placeholder evidence row / dead link", () => {
  const home = readFileSync(join(APP_DIR, "(tabs)", "index.tsx"), "utf8");
  // The former defect: an empty list rendered a fake row linking to /evidence/1.
  assert.doesNotMatch(home, /router\.push\(["']\/evidence\/1["']\)/, "no dead /evidence/1 link");
  assert.doesNotMatch(home, /3 minutes ago/, "no hardcoded placeholder subtitle");
  // The empty branch must render a real empty state, not a fabricated record.
  // Since the PWA-parity Home it lives in HomeRecentEvidenceCard
  // (src/ui/home-overview.tsx), in the web's own words
  // (apps/web/components/home-experience/HomeDashboardSections.tsx).
  assert.match(home, /<HomeRecentEvidenceCard[\s\S]{0,40}rows=\{recentRows\}/, "Home renders the recent-evidence card");
  const overview = readFileSync(join(APP_DIR, "..", "src", "ui", "home-overview.tsx"), "utf8");
  const card = overview.slice(overview.indexOf("export function HomeRecentEvidenceCard"));
  assert.match(
    card.slice(0, 1200),
    /rows\.length === 0 \?[\s\S]{0,200}Your newest records appear here after the first capture\./,
    "Home must show a truthful empty state",
  );
  assert.doesNotMatch(overview, /\/evidence\/1["']/, "no dead /evidence/1 link in the card either");
});

test("the web-only Direct Web Capture surface never appears in the native app", () => {
  const offenders = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        scan(full);
        continue;
      }
      if (!/\.(t|j)sx?$/.test(entry.name)) continue;
      const src = readFileSync(full, "utf8");
      if (src.includes("Install the PROOVRA extension") || src.includes("Direct Web Capture")) {
        offenders.push(full);
      }
    }
  };
  scan(APP_DIR);
  if (statSync(SRC_DIR).isDirectory()) scan(SRC_DIR);
  assert.deepEqual(
    offenders,
    [],
    `native app must not render the web Direct Web Capture / extension surface: ${offenders.join(", ")}`,
  );
});
