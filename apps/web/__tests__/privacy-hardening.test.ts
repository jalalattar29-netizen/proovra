/**
 * Privacy/security hardening regression suite.
 *
 * Locks the contract for:
 *   - No persistent `proovra-token` reads/writes in production source.
 *   - The orphaned `components/CookieBanner.tsx` stays deleted.
 *   - Cookie consent banner copy says "Reject all" (not "Reject optional")
 *     and the modal carries Cookie Policy / Privacy Policy / Trust Center
 *     footer links.
 *   - The shared privacy redactor scrubs verification tokens, evidence
 *     UUIDs, share/intake/portal tokens, OAuth callbacks, JWTs, emails,
 *     and long opaque tokens.
 *   - `PrivacyPreferencesLauncher` exposes the right ARIA label.
 *   - AI Chat widget no longer leaks raw `window.location.pathname` /
 *     `document.title` and is gated for sensitive routes.
 *   - Sentry init carries the redaction options.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = resolve(__dirname, "..");

const WEB_SOURCE_ROOTS = [
  resolve(APP_ROOT, "app"),
  resolve(APP_ROOT, "components"),
  resolve(APP_ROOT, "lib"),
];

const TOKEN_EXEMPTIONS_FRAGMENT_LIST: ReadonlyArray<string> = [
  "removeItem(\"proovra-token\")",
  "removeItem('proovra-token')",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    const ext = extname(entry.name);
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      out.push(full);
    }
  }
  return out;
}

test("no production source persists proovra-token in localStorage/sessionStorage", () => {
  const offenders: string[] = [];
  for (const root of WEB_SOURCE_ROOTS) {
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (
          /localStorage\.\s*setItem\(\s*['"`]proovra-token['"`]/.test(line) ||
          /sessionStorage\.\s*setItem\(\s*['"`]proovra-token['"`]/.test(line)
        ) {
          offenders.push(`${file}:${idx + 1} ${line.trim()}`);
        }
        if (
          /localStorage\.\s*getItem\(\s*['"`]proovra-token['"`]/.test(line) ||
          /sessionStorage\.\s*getItem\(\s*['"`]proovra-token['"`]/.test(line)
        ) {
          offenders.push(`${file}:${idx + 1} ${line.trim()}`);
        }
        // removeItem is allowed (migration cleanup of legacy values).
        if (/proovra-token/.test(line)) {
          const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
          if (isComment) return;
          const isAllowedRemoval = TOKEN_EXEMPTIONS_FRAGMENT_LIST.some((f) =>
            line.includes(f),
          );
          if (isAllowedRemoval) return;
          if (
            /localStorage\.\s*(get|set)Item/.test(line) ||
            /sessionStorage\.\s*(get|set)Item/.test(line)
          ) {
            // already captured above
            return;
          }
        }
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Production source must not read/write 'proovra-token' in browser storage. Offending lines:\n${offenders.join("\n")}`,
  );
});

test("the duplicate components/CookieBanner.tsx remains deleted", () => {
  const orphan = resolve(APP_ROOT, "components", "CookieBanner.tsx");
  assert.equal(
    existsSync(orphan),
    false,
    `components/CookieBanner.tsx must not exist — vanilla-cookieconsent is the only consent system.`,
  );
});

test("cookie consent copy says 'Reject all' and never 'Reject optional'", () => {
  const file = resolve(APP_ROOT, "lib", "cookieConsent.ts");
  const text = readFileSync(file, "utf8");
  assert.ok(
    text.includes('acceptNecessaryBtn: "Reject all"'),
    "consent modal must use 'Reject all'",
  );
  assert.ok(
    !text.includes("Reject optional"),
    "the legacy 'Reject optional' label must be gone",
  );
});

test("preferences modal carries Cookie Policy / Privacy Policy / Trust Center links", () => {
  const file = resolve(APP_ROOT, "lib", "cookieConsent.ts");
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("/legal/cookies"), "must link to /legal/cookies");
  assert.ok(text.includes("/legal/privacy"), "must link to /legal/privacy");
  assert.ok(text.includes("/trust"), "must link to /trust");
});

test("preferences-modal categories include Strictly Necessary + Analytics + Marketing", () => {
  const file = resolve(APP_ROOT, "lib", "cookieConsent.ts");
  const text = readFileSync(file, "utf8");
  for (const required of [
    "Strictly Necessary",
    "Functional Preferences",
    "Analytics",
    "Marketing",
    'linkedCategory: "necessary"',
    'linkedCategory: "preferences"',
    'linkedCategory: "analytics"',
    'linkedCategory: "marketing"',
  ]) {
    assert.ok(
      text.includes(required),
      `cookieConsent.ts must include ${JSON.stringify(required)}`,
    );
  }
});

test("PrivacyPreferencesLauncher exposes the right ARIA label and uses openCookiePreferences", () => {
  const file = resolve(
    APP_ROOT,
    "components",
    "privacy",
    "PrivacyPreferencesLauncher.tsx",
  );
  assert.ok(existsSync(file), "launcher component must exist");
  const text = readFileSync(file, "utf8");
  assert.ok(
    text.includes('aria-label="Open privacy preferences"'),
    "launcher must have aria-label='Open privacy preferences'",
  );
  assert.ok(
    text.includes('title="Privacy preferences"'),
    "launcher must have title='Privacy preferences'",
  );
  assert.ok(
    text.includes("openCookiePreferences"),
    "launcher must dispatch via openCookiePreferences",
  );
  assert.ok(
    !text.includes("localStorage"),
    "launcher must not touch localStorage",
  );
  assert.ok(
    !text.includes("sessionStorage"),
    "launcher must not touch sessionStorage",
  );
  // No emoji, no green.
  assert.ok(!text.includes("🍪"), "no cookie emoji");
});

test("launcher is mounted exactly once in the root layout", () => {
  const layout = resolve(APP_ROOT, "app", "layout.tsx");
  const text = readFileSync(layout, "utf8");
  const imports = (
    text.match(/^\s*import\s+PrivacyPreferencesLauncher\b/gm) ?? []
  ).length;
  const jsxMounts = (text.match(/<PrivacyPreferencesLauncher\b/g) ?? []).length;
  assert.equal(imports, 1, `layout.tsx must import the launcher exactly once`);
  assert.equal(
    jsxMounts,
    1,
    `layout.tsx must render <PrivacyPreferencesLauncher /> exactly once`,
  );
});

test("Sentry init enables redaction options", () => {
  const file = resolve(APP_ROOT, "lib", "sentry.ts");
  const text = readFileSync(file, "utf8");
  for (const required of [
    "sendDefaultPii: false",
    "tracePropagationTargets: []",
    "tracesSampleRate: 0",
    "beforeSend",
    "beforeBreadcrumb",
    "ignoreErrors",
  ]) {
    assert.ok(
      text.includes(required),
      `sentry.ts must contain ${JSON.stringify(required)}`,
    );
  }
});

test("ProovraChatWidget no longer leaks raw pathname or document.title", () => {
  const file = resolve(
    APP_ROOT,
    "components",
    "ai",
    "ProovraChatWidget.tsx",
  );
  const text = readFileSync(file, "utf8");
  assert.ok(
    !/path:\s*typeof window !== "undefined" \? window\.location\.pathname/.test(
      text,
    ),
    "AI chat must not send raw window.location.pathname",
  );
  assert.ok(
    !/title:\s*typeof document !== "undefined" \? document\.title/.test(text),
    "AI chat must not send raw document.title",
  );
  assert.ok(
    text.includes("getSafePageContext"),
    "AI chat must call getSafePageContext for the page context",
  );
  assert.ok(
    text.includes("isSensitiveRoute"),
    "AI chat must guard sensitive routes via isSensitiveRoute",
  );
});

test("AI chat is hidden on sensitive routes from the (app) layout", () => {
  const file = resolve(APP_ROOT, "app", "(app)", "layout.tsx");
  const text = readFileSync(file, "utf8");
  for (const prefix of [
    '/admin',
    '/verify',
    '/v/',
    '/share',
    '/intake',
    '/portal',
    '/auth',
  ]) {
    assert.ok(
      text.includes(`"${prefix}"`),
      `(app)/layout.tsx hideAiWidget must guard ${prefix}`,
    );
  }
});

test("redactor: sensitive paths, UUIDs, JWTs, and emails are scrubbed", async () => {
  const mod = await import("../lib/privacy/redact");
  const {
    redactSensitivePath,
    redactSensitiveUrl,
    redactSensitiveText,
    isSensitiveRoute,
    classifyRouteClass,
  } = mod;

  assert.equal(
    redactSensitivePath("/verify/413dc332-d92f-40ef-8bd8-f02678e5ef97"),
    "/verify/[redacted]",
  );
  assert.equal(redactSensitivePath("/share/abc12345abc12345abc12345abc"), "/share/[redacted]");
  assert.equal(redactSensitivePath("/intake/sometoken"), "/intake/[redacted]");
  assert.equal(redactSensitivePath("/portal/foo"), "/portal/[redacted]");
  assert.equal(redactSensitivePath("/auth/callback?code=xx&state=yy"), "/auth/callback/[redacted]");
  assert.equal(
    redactSensitivePath("/evidence/413dc332-d92f-40ef-8bd8-f02678e5ef97"),
    "/evidence/[redacted]",
  );

  // Generic UUID outside the special route families is still scrubbed.
  assert.equal(
    redactSensitivePath("/random/413dc332-d92f-40ef-8bd8-f02678e5ef97/edit"),
    "/random/[uuid]/edit",
  );

  // URL sanitizer strips OAuth code/state to placeholders.
  const u = redactSensitiveUrl(
    "https://app.proovra.com/auth/callback?code=secret123&state=xyz",
  );
  assert.ok(u && u.includes("[redacted]"), `expected redacted query: ${u}`);
  assert.ok(u && !u.includes("secret123"), `must not leak code: ${u}`);
  assert.ok(u && !u.includes("xyz"), `must not leak state: ${u}`);

  // Text/object redaction.
  const out = redactSensitiveText({
    Authorization: "Bearer eyJabc.def.ghi",
    cookie: "proovra_session=xxxx",
    note: "ping user@example.com about 413dc332-d92f-40ef-8bd8-f02678e5ef97",
  }) as Record<string, unknown>;
  assert.equal(out["Authorization"], "[redacted]");
  assert.equal(out["cookie"], "[redacted]");
  assert.ok(
    typeof out["note"] === "string" &&
      !(out["note"] as string).includes("user@example.com") &&
      !(out["note"] as string).includes("413dc332"),
    `note must redact email + UUID, got: ${out["note"]}`,
  );

  // Route classification + sensitive detection.
  assert.equal(isSensitiveRoute("/verify/foo"), true);
  assert.equal(isSensitiveRoute("/pricing"), false);
  assert.equal(classifyRouteClass("/home"), "app");
  assert.equal(classifyRouteClass("/verify/x"), "public-sensitive");
  assert.equal(classifyRouteClass("/pricing"), "public");
});

test("clearNonEssentialStorage removes preference/analytics keys but never the consent record", async () => {
  // Lightweight in-memory storage mock.
  const make = () => {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      key(i: number) {
        return Array.from(data.keys())[i] ?? null;
      },
      getItem(k: string) {
        return data.has(k) ? (data.get(k) as string) : null;
      },
      setItem(k: string, v: string) {
        data.set(k, v);
      },
      removeItem(k: string) {
        data.delete(k);
      },
      clear() {
        data.clear();
      },
    };
  };

  const local = make();
  const session = make();

  // Pre-seed
  local.setItem("proovra-cookie-consent-state", "{}"); // must NOT be removed
  local.setItem("proovra_legal_acceptance", "{}"); // must NOT be removed
  local.setItem("proovra-locale", "en"); // preferences
  local.setItem("proovra-chat-hint-seen", "1"); // preferences
  local.setItem("contextual-help-dismissed:foo:bar", "1"); // preferences
  local.setItem("visitor_id", "v123"); // analytics
  session.setItem("session_id", "s123"); // analytics

  type Win = {
    localStorage: typeof local;
    sessionStorage: typeof session;
  };
  const win = { localStorage: local, sessionStorage: session };
  const realWindow = (globalThis as { window?: Win }).window;
  (globalThis as { window?: Win }).window = win;

  try {
    const { clearNonEssentialStorage } = await import("../lib/consent");
    clearNonEssentialStorage({ preferences: true, analytics: true });

    assert.equal(local.getItem("proovra-cookie-consent-state"), "{}");
    assert.equal(local.getItem("proovra_legal_acceptance"), "{}");
    assert.equal(local.getItem("proovra-locale"), null);
    assert.equal(local.getItem("proovra-chat-hint-seen"), null);
    assert.equal(local.getItem("contextual-help-dismissed:foo:bar"), null);
    assert.equal(local.getItem("visitor_id"), null);
    assert.equal(session.getItem("session_id"), null);
  } finally {
    if (realWindow === undefined) {
      delete (globalThis as { window?: Win }).window;
    } else {
      (globalThis as { window?: Win }).window = realWindow;
    }
  }
});

void statSync;
