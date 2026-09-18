/**
 * PERMANENT GUARD F (audit §19) — Android service ↔ manifest declaration contract.
 *
 * F6 was: `ContinuousScreenCaptureService` existed in Kotlin and was started by
 * the module, but was NOT declared in the module's AndroidManifest, so Android
 * refused to start the UC-3 foreground service.
 *
 * This guard discovers every `*Service` class in the native module's Kotlin
 * sources and fails if any is not declared in the module AndroidManifest with a
 * `mediaProjection` foreground-service type. It reads sources as text (no build).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(HERE, "../modules/proovra-screen-capture");
const KOTLIN_DIR = resolve(MODULE_DIR, "android/src/main/java/com/proovra/screencapture");
const manifest = readFileSync(resolve(MODULE_DIR, "android/src/main/AndroidManifest.xml"), "utf8");

function discoverServiceClasses() {
  const names = new Set();
  for (const f of readdirSync(KOTLIN_DIR).filter((n) => n.endsWith(".kt"))) {
    const src = readFileSync(join(KOTLIN_DIR, f), "utf8");
    // A service is a class that extends an Android *Service base.
    for (const m of src.matchAll(/class\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*[^{]*\bService\b/g)) {
      names.add(m[1]);
    }
  }
  return [...names];
}

const serviceClasses = discoverServiceClasses();

test("both known screen-capture services are discovered from Kotlin", () => {
  assert.ok(serviceClasses.includes("ScreenCaptureService"), `found: ${serviceClasses.join(",")}`);
  assert.ok(
    serviceClasses.includes("ContinuousScreenCaptureService"),
    `found: ${serviceClasses.join(",")}`,
  );
});

test("every Kotlin *Service class is declared in the module AndroidManifest (F6)", () => {
  for (const name of serviceClasses) {
    const fqcn = `com.proovra.screencapture.${name}`;
    assert.ok(
      manifest.includes(`android:name="${fqcn}"`),
      `${name} is not declared in AndroidManifest (expected android:name="${fqcn}")`,
    );
  }
});

test("MediaProjection services are declared as internal + foregroundServiceType mediaProjection", () => {
  // Each declared <service> block for our classes must carry the right type and
  // must not be exported.
  for (const name of serviceClasses) {
    const fqcn = `com.proovra.screencapture.${name}`;
    const block = manifest.slice(
      manifest.indexOf(`android:name="${fqcn}"`),
      manifest.indexOf(`android:name="${fqcn}"`) + 220,
    );
    assert.match(block, /android:foregroundServiceType="mediaProjection"/, `${name} missing type`);
    assert.match(block, /android:exported="false"/, `${name} must not be exported`);
  }
});

test("the manifest requests the MediaProjection foreground-service permissions", () => {
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE(?!_)/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_MEDIA_PROJECTION/);
});
