/**
 * Closure phase 2 — the Maestro device journeys (apps/mobile/maestro) stay
 * runnable against THIS app: the right app id, every on-screen text or test id
 * a flow waits for or taps exists in the app's source, every link a flow opens
 * lands on a route file or a DeepLinkGate family, every sub-flow exists, and
 * the runner runs every flow.
 *
 * This does not run a device. It catches the drift that would make a device
 * run fail for a reason unrelated to the behaviour under test (renamed copy, a
 * moved route, a flow nobody runs). Without it a flow can rot silently until
 * the day somebody finally has a phone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModule } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const FLOWS_DIR = resolve(MOBILE, "maestro");
const appJson = JSON.parse(readFileSync(resolve(MOBILE, "app.json"), "utf8"));
const L = await loadModule("src/deep-link/link-ownership.ts", ["test/support/expo-stub.mjs"]);

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const flowFiles = walk(FLOWS_DIR, [".yaml"]);
const mainFlows = flowFiles.filter((f) => dirname(f) === FLOWS_DIR);
const source = walk(resolve(MOBILE, "src"), [".ts", ".tsx"])
  .concat(walk(resolve(MOBILE, "app"), [".ts", ".tsx"]))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n")
  // JSX string attributes decode entities ("Stop &amp; Review" renders "Stop & Review").
  .replace(/&amp;/g, "&");

/** Texts owned by the OPERATING SYSTEM, not the app (consent dialog, alert default button). */
const SYSTEM_TEXT = new Set(["Start now", "Start", "OK"]);

/** Every quoted or bare string a flow matches on screen, with its kind. */
function screenRefs(yaml) {
  const refs = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+#.*$/, "");
    let m;
    if ((m = line.match(/^\s*-?\s*(tapOn|assertVisible|assertNotVisible):\s*"(.+)"\s*$/))) refs.push({ kind: "text", value: m[2] });
    else if ((m = line.match(/^\s*visible:\s*"(.+)"\s*$/))) refs.push({ kind: "text", value: m[1] });
    else if ((m = line.match(/^\s*text:\s*"(.+)"\s*$/))) refs.push({ kind: "text", value: m[1] });
    else if ((m = line.match(/^\s*id:\s*"(.+)"\s*$/))) refs.push({ kind: "id", value: m[1] });
  }
  return refs.filter((r) => !r.value.includes("${"));
}

test("there are ten journeys, one per required behaviour", () => {
  assert.deepEqual(
    mainFlows.map((f) => f.split(/[\\/]/).pop().replace(/\.yaml$/, "")).sort(),
    [
      "01-process-death-capture-recovery",
      "02-disk-write-failure-ledger-refusal",
      "03-offline-sign-out",
      "04-shared-phone-account-switch",
      "05-owner-only-recovery-discard",
      "06-workspace-switch-during-capture",
      "07-recovery-code-display",
      "08-invite-deep-link-resume",
      "09-legal-acceptance-deep-link-resume",
      "10-org-ownership-offer-handoff",
    ],
  );
});

test("every flow targets this app's id on both platforms", () => {
  assert.equal(appJson.expo.android.package, appJson.expo.ios.bundleIdentifier);
  for (const f of flowFiles) {
    const m = readFileSync(f, "utf8").match(/^appId:\s*(\S+)/m);
    assert.ok(m, `${f} has no appId`);
    assert.equal(m[1], appJson.expo.android.package, f);
  }
});

test("every on-screen text and test id a flow uses exists in the app's source", () => {
  const missing = [];
  for (const f of flowFiles) {
    for (const r of screenRefs(readFileSync(f, "utf8"))) {
      if (r.kind === "text" && SYSTEM_TEXT.has(r.value)) continue;
      const needle = r.kind === "id" ? new RegExp(`testID=\\{?["\`]${r.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["\`]`) : null;
      const found = needle ? needle.test(source) : source.includes(r.value);
      if (!found) missing.push(`${f.split(/[\\/]/).pop()}: ${r.kind} "${r.value}"`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the drift check can fail: a renamed label is caught", () => {
  const refs = screenRefs('- tapOn: "Start Continuous Capture (renamed)"\n- assertVisible:\n    id: "no-such-test-id"\n');
  assert.equal(refs.length, 2);
  assert.equal(source.includes(refs[0].value), false);
  assert.equal(/testID=\{?["`]no-such-test-id["`]/.test(source), false);
});

test("every link a flow opens lands on a route file or a DeepLinkGate family", () => {
  const routeExists = (path) => {
    const p = path.split("?")[0].replace(/^\/+/, "");
    const candidates = [
      `app/(stack)/${p}.tsx`,
      `app/(tabs)/${p}.tsx`,
      `app/${p}.tsx`,
      `app/(stack)/${p}/index.tsx`,
    ];
    return candidates.some((c) => existsSync(resolve(MOBILE, c)));
  };
  const bad = [];
  for (const f of flowFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(/openLink:\s*(proovra:\/\/\S+)/g)) {
      const url = m[1].replace(/\$\{[A-Z_0-9]+\}/g, "0a0a0a0a-0000-4000-8000-000000000001");
      const path = url.replace(/^proovra:\/\//, "/");
      if (!L.deepLinkGateOwns(url) && !routeExists(path)) bad.push(`${f.split(/[\\/]/).pop()}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("every sub-flow a flow runs exists, and the runner runs every journey", () => {
  for (const f of flowFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(/(?:runFlow:|file:)\s*(subflows\/\S+\.yaml)/g)) {
      assert.ok(existsSync(resolve(FLOWS_DIR, m[1])), `${f}: ${m[1]}`);
    }
  }
  const runner = readFileSync(resolve(FLOWS_DIR, "run-device-journeys.sh"), "utf8");
  for (const f of mainFlows) {
    const name = f.split(/[\\/]/).pop().replace(/\.yaml$/, "");
    assert.ok(runner.includes(`  ${name}\n`), `run-device-journeys.sh never runs ${name}`);
  }
  // The disk-failure journey is only meaningful with its adb pre-step around it.
  assert.match(runner, /files\/proovra-continuous\/ledger\.json\.tmp/);
});

test("the disk-failure pre-step blocks the file the Android ledger store actually writes", () => {
  const kt = readFileSync(
    resolve(MOBILE, "modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ContinuousLedger.kt"),
    "utf8",
  );
  const svc = readFileSync(
    resolve(MOBILE, "modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ContinuousScreenCaptureService.kt"),
    "utf8",
  );
  assert.match(kt, /File\(dir, "ledger\.json\.tmp"\)/);
  assert.match(svc, /SPOOL_DIR = "proovra-continuous"/);
  assert.match(svc, /File\(context\.filesDir, SPOOL_DIR\)/);
});
