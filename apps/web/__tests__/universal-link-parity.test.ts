/**
 * ONE DEEP-LINK CLAIM, DECLARED THE SAME WAY ON BOTH PLATFORMS.
 *
 * A universal link is declared in three places that nothing forces to agree:
 * `apple-app-site-association` (iOS), `android.intentFilters` in the Expo
 * config (Android), and `apps/mobile/docs/universal-links.md`, which is what
 * a person reads when they ask which links open the app.
 *
 * They had drifted. Android claimed the prefix `/auth`, which is every path
 * under it — `/auth/login` included — while iOS claimed exactly the two the
 * document names. An Android device would have opened the app on a sign-in
 * link it has no route for, and nothing in the repository said so, because
 * nothing compared the two files.
 *
 * This is a DECLARATION guard, not a routing one: it asserts that the two
 * platforms claim the same paths and the same hosts. Whether a claimed path
 * then resolves to a screen is the mobile app's own concern.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

/** `/legal/*` and `/legal` are the same claim written two ways. */
const normalise = (path: string): string =>
  path.replace(/\/\*$/, "").replace(/\/$/, "");

function iosClaims(): { paths: Set<string>; hosts: Set<string> } {
  const aasa = JSON.parse(
    readFileSync(
      resolve(REPO_ROOT, "apps/web/public/.well-known/apple-app-site-association"),
      "utf8",
    ),
  ) as { applinks: { details: { components: { "/": string }[] }[] } };
  const paths = new Set(
    aasa.applinks.details.flatMap((d) => d.components.map((c) => normalise(c["/"]))),
  );

  const expo = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "apps/mobile/app.json"), "utf8"),
  ) as { expo: { ios: { associatedDomains: string[] } } };
  // "applinks:www.proovra.com" — the host is what follows the scheme.
  const hosts = new Set(
    expo.expo.ios.associatedDomains.map((d) => d.replace(/^applinks:/, "")),
  );
  return { paths, hosts };
}

function androidClaims(): { paths: Set<string>; hosts: Set<string> } {
  const expo = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "apps/mobile/app.json"), "utf8"),
  ) as {
    expo: {
      android: {
        intentFilters?: {
          data?: { host?: string; pathPrefix?: string }[];
        }[];
      };
    };
  };
  const paths = new Set<string>();
  const hosts = new Set<string>();
  for (const filter of expo.expo.android.intentFilters ?? []) {
    for (const datum of filter.data ?? []) {
      if (datum.pathPrefix) paths.add(normalise(datum.pathPrefix));
      if (datum.host) hosts.add(datum.host);
    }
  }
  return { paths, hosts };
}

test("iOS and Android claim the same deep-link paths", () => {
  const ios = iosClaims();
  const android = androidClaims();

  const iosOnly = [...ios.paths].filter((p) => !android.paths.has(p)).sort();
  const androidOnly = [...android.paths].filter((p) => !ios.paths.has(p)).sort();

  assert.deepEqual(
    { iosOnly, androidOnly },
    { iosOnly: [], androidOnly: [] },
    "a link that opens the app on one platform and the browser on the other " +
      "is a difference nobody chose. Declare it in BOTH files, or neither.",
  );
  assert.ok(ios.paths.size > 0, "the AASA file claims nothing at all");
});

test("iOS and Android claim the same hosts", () => {
  const ios = iosClaims();
  const android = androidClaims();
  assert.deepEqual(
    [...ios.hosts].sort(),
    [...android.hosts].sort(),
    "the apex and www host must both be claimed on both platforms, or a link " +
      "works only when it happens to carry the right one.",
  );
});

/**
 * A PLACEHOLDER IN A SERVED FILE FAILS SILENTLY.
 *
 * Both association files sit on real paths on a real host, so a placeholder
 * RESOLVES and then fails verification — the link opens the browser and
 * nothing anywhere says why. The Android fingerprint was extracted from the
 * signed APK itself on 2026-09-24 (APK Signing Block v2, corroborated with
 * `openssl x509 -fingerprint -sha256`).
 *
 * The Apple Team ID is still outstanding, and this test says so out loud
 * rather than leaving its absence to be discovered on a device.
 */
test("the Android fingerprint is a real one, not a placeholder", () => {
  const links = JSON.parse(
    readFileSync(
      resolve(REPO_ROOT, "apps/web/public/.well-known/assetlinks.json"),
      "utf8",
    ),
  ) as { target: { sha256_cert_fingerprints: string[] } }[];

  const prints = links.flatMap((l) => l.target.sha256_cert_fingerprints);
  assert.ok(prints.length > 0, "assetlinks.json claims no signing key at all");
  for (const print of prints) {
    assert.match(
      print,
      /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/,
      `${print} is not an uppercase colon-separated SHA-256 fingerprint. ` +
        "Android App Links verification rejects anything else, and it does so " +
        "silently — the link simply opens the browser.",
    );
  }
});

/**
 * THE ONE THAT IS STILL MISSING, STATED AS A FACT RATHER THAN A HOPE.
 *
 * This test PASSES while the Apple Team ID is a placeholder. It exists to
 * keep the gap legible and to fail the moment somebody writes something
 * that is neither the placeholder nor a valid ten-character Team ID.
 */
test("the Apple Team ID is either the known placeholder or a real one", () => {
  const aasa = readFileSync(
    resolve(REPO_ROOT, "apps/web/public/.well-known/apple-app-site-association"),
    "utf8",
  );
  const appIds = [...aasa.matchAll(/"([^"]+).com.jalalattar29.proovra"/g)].map(
    (m) => m[1],
  );
  assert.ok(appIds.length > 0, "the AASA file claims no app ID");
  for (const id of appIds) {
    const real = /^[A-Z0-9]{10}$/.test(id);
    const placeholder = id === "<APPLE_TEAM_ID>";
    assert.ok(
      real || placeholder,
      `${id} is neither a ten-character Apple Team ID nor the recorded ` +
        "placeholder. Universal Links verification fails silently on anything else.",
    );
  }
});

test("every claimed path is one the mobile app documents", () => {
  const documented = readFileSync(
    resolve(REPO_ROOT, "apps/mobile/docs/universal-links.md"),
    "utf8",
  );
  for (const path of iosClaims().paths) {
    assert.ok(
      documented.includes(path),
      `${path} is claimed as a universal link and appears nowhere in ` +
        `apps/mobile/docs/universal-links.md — the table is what a person ` +
        `reads to answer "which links open the app".`,
    );
  }
});
