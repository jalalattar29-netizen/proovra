// D:\digital-witness\services\worker\scripts\copy-assets.mjs
import fs from "node:fs";
import path from "node:path";

const src = path.resolve(process.cwd(), "src/pdf/assets");
const dest = path.resolve(process.cwd(), "dist/pdf/assets");

if (!fs.existsSync(src)) {
  console.error(`❌ Assets source folder not found: ${src}`);
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });

for (const file of fs.readdirSync(src)) {
  const from = path.join(src, file);
  const to = path.join(dest, file);
  fs.copyFileSync(from, to);
}

console.log("✅ Copied PDF assets to dist/pdf/assets");