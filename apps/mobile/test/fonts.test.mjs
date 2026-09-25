/**
 * T-04 / RC-04 — the application faces must be REGISTERED, and the families the
 * app asks for must be ones it actually loads.
 *
 * THE DEFECT THIS TEST WOULD HAVE CAUGHT
 * --------------------------------------
 * `apps/mobile` shipped with no `expo-font` dependency, no `useFonts` call and
 * zero font files, while `locale-context.tsx` asked for the family `"Inter"`.
 * React Native resolves an unregistered family by silently falling back to the
 * platform face, so every text element on all 64 routes rendered in San
 * Francisco / Roboto. Nothing threw and nothing logged.
 *
 * Every assertion below fails against that original state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const pkg = JSON.parse(readFileSync(resolve(MOBILE, "package.json"), "utf8"));

test("expo-font is a real dependency, not a transitive accident", () => {
  assert.ok(
    pkg.dependencies["expo-font"],
    "expo-font is not a direct dependency. Without it nothing can register a " +
      "font family, and every fontFamily string silently resolves to the " +
      "platform system face.",
  );
});

test("the font packages that carry the actual faces are installed", () => {
  for (const name of [
    "@expo-google-fonts/plus-jakarta-sans",
    "@expo-google-fonts/noto-sans-arabic",
  ]) {
    assert.ok(pkg.dependencies[name], `${name} is not a dependency`);
  }
});

test("the faces exist on disk as .ttf files React Native can load", () => {
  // .woff2 (what the web build emits) is NOT loadable by React Native. If these
  // ever become woff2 the app silently reverts to the system face.
  const faces = [
    "@expo-google-fonts/plus-jakarta-sans/400Regular/PlusJakartaSans_400Regular.ttf",
    "@expo-google-fonts/plus-jakarta-sans/700Bold/PlusJakartaSans_700Bold.ttf",
    "@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf",
  ];
  for (const rel of faces) {
    const p = resolve(MOBILE, "node_modules", rel);
    assert.ok(existsSync(p), `${rel} is missing — the face cannot be registered`);
  }
});

test("the root layout holds first paint until the faces are registered", () => {
  const layout = readFileSync(resolve(MOBILE, "app/_layout.tsx"), "utf8");
  assert.match(
    layout,
    /useAppFonts\s*\(/,
    "the root layout does not load fonts. It is the ONE ancestor of every " +
      "route; if it does not load them, nothing does.",
  );
  assert.match(
    layout,
    /if\s*\(\s*!fontsLoaded[^)]*\)\s*return null/,
    "the root layout renders before the faces are registered, which produces a " +
      "first frame in the system face that then reflows.",
  );
});

test("locale-context asks for a family the app actually registers", () => {
  const src = readFileSync(resolve(MOBILE, "src/locale-context.tsx"), "utf8");
  const fonts = readFileSync(resolve(MOBILE, "src/theme/fonts.ts"), "utf8");

  // The exact original defect: a bare "Inter" literal nothing had registered.
  assert.doesNotMatch(
    src,
    /fontFamily\s*=\s*isRTL\s*\?\s*"Noto Sans Arabic"\s*:\s*"Inter"/,
    'locale-context still hardcodes the unregistered families "Inter" / ' +
      '"Noto Sans Arabic". Neither is registered, so both resolve to the ' +
      "platform face.",
  );
  assert.match(src, /familyFor\(/, "locale-context does not resolve families through src/theme/fonts.ts");

  // Every family name the resolver can return must be a key of the load map.
  const registered = [...fonts.matchAll(/^\s{2}(PlusJakartaSans_\w+|NotoSansArabic_\w+),$/gm)].map((m) => m[1]);
  assert.ok(registered.length >= 8, `expected the load map to register the faces, found ${registered.length}`);
  const referenced = [...fonts.matchAll(/"(PlusJakartaSans_\w+|NotoSansArabic_\w+)"/g)].map((m) => m[1]);
  assert.ok(referenced.length > 0, "the weight maps reference no faces at all");
  for (const fam of new Set(referenced)) {
    assert.ok(
      registered.includes(fam),
      `familyFor() can return "${fam}", which APP_FONT_MAP does not register. ` +
        "React Native would silently fall back to the system face.",
    );
  }
});

test("the canonical families match the design tokens and the web reference", () => {
  const fonts = readFileSync(resolve(MOBILE, "src/theme/fonts.ts"), "utf8");
  // apps/web/app/fonts.google.ts loads Plus Jakarta Sans (body) + Noto Sans Arabic.
  assert.match(fonts, /latin:\s*"Plus Jakarta Sans"/);
  assert.match(fonts, /arabic:\s*"Noto Sans Arabic"/);

  const web = readFileSync(resolve(MOBILE, "../web/app/fonts.google.ts"), "utf8");
  assert.match(web, /Plus_Jakarta_Sans/, "the web reference no longer uses Plus Jakarta Sans — native must follow it");
  assert.match(web, /Noto_Sans_Arabic/, "the web reference no longer uses Noto Sans Arabic");
});
