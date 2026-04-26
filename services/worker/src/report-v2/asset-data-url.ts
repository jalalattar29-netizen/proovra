// D:\digital-witness\services\worker\src\report-v2\asset-data-url.ts
import fs from "node:fs";
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export function resolveReportAssetPath(fileName: string): string {
  const distPath = path.resolve(process.cwd(), "dist/report-v2/assets", fileName);
  const srcPath = path.resolve(process.cwd(), "src/report-v2/assets", fileName);

  if (fs.existsSync(distPath)) return distPath;
  if (fs.existsSync(srcPath)) return srcPath;

  throw new Error(`[report-v2] Asset not found: ${fileName}`);
}

export function reportAssetDataUrl(fileName: string): string {
  const filePath = resolveReportAssetPath(fileName);
  const ext = path.extname(fileName).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const base64 = fs.readFileSync(filePath).toString("base64");

  return `data:${mime};base64,${base64}`;
}