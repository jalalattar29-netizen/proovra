/**
 * A DEVICE COLUMN MUST NOT BE A USER-AGENT STRING.
 *
 * `/admin/identity/sessions` printed the stored 120-character user-agent in a
 * 207px column. It wrapped to five or six lines, every cell in the row
 * stretched to match, and the table reached 15,409px over 75 rows — pushing
 * four further sections of the page past 16,000px.
 *
 * These pin the two properties that matter: a recognisable client becomes
 * something an operator can read at a glance, and an unrecognisable one
 * returns null rather than a guess.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { describeClient as d } from "../lib/ui/describeClient";

test("the common desktop browsers, with their platform", () => {
  assert.equal(
    d("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
    "Chrome on Windows",
  );
  assert.equal(
    d("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"),
    "Safari on macOS",
  );
  assert.equal(
    d("Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0"),
    "Firefox on Linux",
  );
});

test("browsers that impersonate Chrome are not reported as Chrome", () => {
  // Edge, Opera and Samsung Internet all carry "Chrome/" in their UA. Order
  // in the table is the whole mechanism, so it is pinned here.
  assert.equal(
    d("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"),
    "Edge on Windows",
  );
  assert.equal(
    d("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0"),
    "Opera on Windows",
  );
  assert.equal(
    d("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36"),
    "Samsung Internet on Android",
  );
});

test("and every WebKit browser claims Safari, so Safari is matched last", () => {
  assert.equal(
    d("Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1"),
    "Chrome on iPhone",
  );
});

test("non-browser clients are named, because a session from one is a signal", () => {
  assert.equal(d("curl/8.4.0"), "curl");
  assert.equal(d("PostmanRuntime/7.36.0"), "Postman");
  assert.equal(d("python-requests/2.31.0"), "Python");
});

test("an unrecognisable client returns null rather than a guess", () => {
  // The caller renders "Unrecognised client", which is true. Inventing
  // "Other browser" would not be, and a device column nobody can trust is
  // worse than one that admits what it does not know.
  assert.equal(d("Some-Internal-Agent/2"), null);
  assert.equal(d(""), null);
  assert.equal(d("   "), null);
  assert.equal(d(null), null);
  assert.equal(d(undefined), null);
});

test("a platform with no recognisable browser still says something useful", () => {
  assert.equal(d("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Windows");
});

/*
 * PHASE 4 — the rule holds across every Admin surface, not just sessions.
 *
 * The sessions table was fixed when `describeClient` was written, but two
 * other Admin surfaces still printed a raw user-agent verbatim: the demo
 * request list panel and the demo request detail page, both rendering
 * `details.userAgent` straight into the page. Same failure, different screen —
 * and on those screens the string is a lead's browser, captured at form
 * submission.
 *
 * This walks the Admin tree rather than naming the two files, so a third
 * surface that starts rendering one fails here.
 */
test("no Admin page renders a raw user-agent field", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");

  const root = join(import.meta.dirname, "..", "app", "(app)", "admin");
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".tsx")) continue;
      const src = readFileSync(full, "utf8");
      // A JSX expression that puts a userAgent value on the page. Type
      // declarations (`userAgent: string | null;`) are not renders.
      const rendered =
        /\{[^}]*\.userAgent[^}]*\}/.test(src) &&
        !/describeClient\s*\([^)]*\.userAgent/.test(src);
      if (rendered) offenders.push(full);
    }
  };
  walk(root);

  assert.deepEqual(
    offenders,
    [],
    `these Admin pages render a raw user-agent:\n${offenders.join("\n")}`,
  );
});
