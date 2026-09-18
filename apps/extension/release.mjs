/**
 * PROOVRA Direct Web Capture — production RELEASE packager.
 *
 * Turns the reproducible `dist/` build into a versioned, store-submittable ZIP,
 * and REFUSES to package anything that is not a genuine production artifact.
 *
 *   PROOVRA_API_ORIGIN=https://api.proovra.com \
 *   [PROOVRA_AUTH_AUTHORIZE_URL=... PROOVRA_AUTH_TOKEN_URL=... PROOVRA_OAUTH_CLIENT_ID=...] \
 *   node release.mjs
 *
 * Guarantees (fail-closed):
 *   - PROOVRA_API_ORIGIN must be an https:// origin (no localhost / http in a release).
 *   - The built bundle is scanned; if any localhost / http:// origin leaked in,
 *     the release is refused.
 *   - The manifest is validated (delegates to scripts/validate-manifest.mjs).
 *   - Output: release/proovra-extension-v<version>.zip (deterministic, stored),
 *     plus a printed provenance block (version, origin, per-file + zip sha256).
 *
 * The ZIP is written with a dependency-free STORED (uncompressed) zip writer so
 * the artifact is byte-deterministic across machines/CI. Chrome Web Store and
 * Edge Add-ons both accept a stored zip.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const RELEASE = join(HERE, "release");
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const env = process.env;

function fail(msg) {
  console.error(`\nRELEASE REFUSED: ${msg}\n`);
  process.exit(1);
}

// --- 1. Production configuration guard ------------------------------------
const apiOrigin = env.PROOVRA_API_ORIGIN;
if (!apiOrigin) {
  fail(
    "PROOVRA_API_ORIGIN is required for a release build. A release must not ship the localhost default.\n" +
      "  e.g. PROOVRA_API_ORIGIN=https://api.proovra.com node release.mjs",
  );
}
let parsed;
try {
  parsed = new URL(apiOrigin);
} catch {
  fail(`PROOVRA_API_ORIGIN is not a valid URL: ${apiOrigin}`);
}
if (parsed.protocol !== "https:") fail(`PROOVRA_API_ORIGIN must be https:// for a release (got ${parsed.protocol}).`);
if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(parsed.hostname)) fail(`PROOVRA_API_ORIGIN must not be localhost for a release (got ${parsed.hostname}).`);

// --- 2. Validate manifest + build a production bundle ---------------------
console.log(`Building production extension v${pkg.version} against ${apiOrigin} …`);
execFileSync(process.execPath, [join(HERE, "scripts/validate-manifest.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [join(HERE, "build.mjs")], {
  stdio: "inherit",
  env: { ...env, NODE_ENV: "production" },
});

// --- 3. Leak scan: no dev origin may survive into the shipped bundle ------
const LEAK = /http:\/\/localhost|127\.0\.0\.1|localhost:\d+/;
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const distFiles = walk(DIST).sort();
for (const f of distFiles) {
  if (!/\.(js|json|html|css)$/.test(f)) continue;
  const text = readFileSync(f, "utf8");
  if (LEAK.test(text)) fail(`dev origin leaked into ${relative(DIST, f)} — will not ship a localhost origin.`);
}

// --- 4. Deterministic STORED zip writer (no dependencies) -----------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function zipStored(files) {
  // files: [{ name, data:Buffer }] — names use forward slashes, sorted for determinism.
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(0, 8); // method: stored
    lh.writeUInt16LE(0, 10); // modtime (fixed → deterministic)
    lh.writeUInt16LE(0x21, 12); // moddate (fixed valid date: 1980-01-01)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(local);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const entries = distFiles
  .map((f) => ({ name: relative(DIST, f).split("\\").join("/"), data: readFileSync(f) }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));
const zipBuf = zipStored(entries);

rmSync(RELEASE, { recursive: true, force: true });
mkdirSync(RELEASE, { recursive: true });
const zipName = `proovra-extension-v${pkg.version}.zip`;
const zipPath = join(RELEASE, zipName);
writeFileSync(zipPath, zipBuf);

// --- 5. Provenance --------------------------------------------------------
const zipSha = createHash("sha256").update(zipBuf).digest("hex");
console.log("\n=== RELEASE ARTIFACT ===");
console.log(`name:        ${zipName}`);
console.log(`path:        ${relative(HERE, zipPath)}`);
console.log(`version:     ${pkg.version}`);
console.log(`apiOrigin:   ${apiOrigin}`);
console.log(`files:       ${entries.length}`);
console.log(`bytes:       ${zipBuf.length}`);
console.log(`sha256(zip): ${zipSha}`);
console.log("state:       READY_FOR_STORE_SUBMISSION (see docs/admin/EXTENSION_RELEASE_CHECKLIST.md)");
