import fs from "node:fs";
import path from "node:path";

const copyFolder = (src, dest, label) => {
  if (!fs.existsSync(src)) {
    console.warn(`⚠️ Assets source folder not found, skipped: ${src}`);
    return;
  }

  fs.mkdirSync(dest, { recursive: true });

  for (const file of fs.readdirSync(src)) {
    const from = path.join(src, file);
    const to = path.join(dest, file);

    if (fs.statSync(from).isFile()) {
      fs.copyFileSync(from, to);
    }
  }

  console.log(`✅ Copied ${label} assets to ${dest}`);
};

copyFolder(
  path.resolve(process.cwd(), "src/pdf/assets"),
  path.resolve(process.cwd(), "dist/pdf/assets"),
  "legacy PDF"
);

copyFolder(
  path.resolve(process.cwd(), "src/report-v2/assets"),
  path.resolve(process.cwd(), "dist/report-v2/assets"),
  "report-v2"
);