/**
 * UC-PROV-004 — the Direct Web Capture disclosures say what the code does.
 *
 * The capture happens in the browser FIRST; the session opens afterwards; the
 * server only receives and re-hashes the bytes (CAPTURE_CLIENT_ATTESTED). The
 * legal page, the generated legal corpus, the in-app capture card and the
 * extension popup used to say the session opened "before the capture begins",
 * that PROOVRA "participates"/"takes part" in the capture and "produces the
 * bytes", and that the server "establishes the authoritative time".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const SURFACES = {
  "legal page": read("apps/web/content/legal/en/direct-web-capture.md"),
  "capture card": read("apps/web/app/(app)/capture/_lib/CaptureDirectWebCaptureCard.tsx"),
  "extension popup": read("apps/extension/public/popup.html"),
  "extension manifest": read("apps/extension/public/manifest.json"),
};

const BANNED = [
  /before the capture begins/i,
  /participates in the capture/i,
  /takes part in(\s|\n)+the capture/i,
  /capture adapter produces the bytes/i,
  /server[- ]issued in advance/i,
  /server establishes the authoritative time/i,
  /full(-| )page archive/i,
  /complete archive of the (page|site)(?! or)/i,
];

for (const [name, text] of Object.entries(SURFACES)) {
  test(`${name}: no claim that PROOVRA takes part in or times the capture`, () => {
    const flat = text.replace(/\s+/g, " ");
    for (const re of BANNED) assert.equal(re.test(flat), false, `${name} still says ${re}`);
  });
}

test("the legal page states the capture is client-attested and that the time is server receipt", () => {
  const md = SURFACES["legal page"].replace(/\s+/g, " ");
  assert.match(md, /client-attested/);
  assert.match(md, /time PROOVRA received the capture \(server time\)/);
  assert.match(md, /not a complete archive of the page or the website/);
});

test("the generated legal corpus carries the corrected page (regenerated, not hand-edited)", () => {
  const corpus = read("packages/shared/src/legal/corpus.generated.ts");
  const start = corpus.indexOf('"direct-web-capture": {');
  assert.ok(start > 0, "direct-web-capture is in the corpus");
  const entry = corpus.slice(start, start + 20000);
  assert.equal(/participates in the capture|before the capture begins/.test(entry), false);
  assert.match(entry, /client-attested/);
});
