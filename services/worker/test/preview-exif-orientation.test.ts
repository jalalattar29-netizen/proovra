/**
 * PRO-W1C-07 (RG-18) — a report image preview honours the EXIF orientation.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { extractPreviewForAsset } from "../src/preview/extract.js";

describe("report image preview — EXIF orientation (PRO-W1C-07)", () => {
  it("a landscape-stored JPEG with Orientation=6 previews as portrait", async () => {
    const stored = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 10, b: 10 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await extractPreviewForAsset({ kind: "image", mimeType: "image/jpeg", buffer: stored } as never);
    expect(out.previewDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    const bytes = Buffer.from(String(out.previewDataUrl).split(",")[1]!, "base64");
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
  });
});
