#!/usr/bin/env node
/**
 * Generate the PWA icon set from the canonical brand mark
 * (public/assets/branding/proovra-mark.png) — UC-LCH-004.
 *
 *   public/icons/icon-192.png            purpose "any"      (mark at 84% on white)
 *   public/icons/icon-512.png            purpose "any"
 *   public/icons/icon-maskable-192.png   purpose "maskable" (mark inside the 80% safe zone)
 *   public/icons/icon-maskable-512.png   purpose "maskable"
 *
 * Deterministic: same input → same bytes (no timestamps in the PNGs). The
 * outputs are committed; re-run after the brand mark changes:
 *   node apps/web/scripts/generate-pwa-icons.mjs
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(WEB, "public/assets/branding/proovra-mark.png");
const OUT = join(WEB, "public/icons");
const BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };

async function icon(size, markFraction, file) {
  const inner = Math.round(size * markFraction);
  const mark = await sharp(SOURCE)
    .resize(inner, inner, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } })
    .composite([{ input: mark, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .withMetadata({})
    .toFile(join(OUT, file));
}

mkdirSync(OUT, { recursive: true });
await icon(192, 0.84, "icon-192.png");
await icon(512, 0.84, "icon-512.png");
// Maskable: the platform may crop to a circle of 80% diameter; keep the mark
// well inside it.
await icon(192, 0.6, "icon-maskable-192.png");
await icon(512, 0.6, "icon-maskable-512.png");
console.log("PWA icons written to", OUT);
