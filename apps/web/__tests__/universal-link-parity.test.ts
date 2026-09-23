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
