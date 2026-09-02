import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(appRoot, "..", "..");
const testsRoot = join(appRoot, "__tests__");
const filters = process.argv
  .slice(2)
  .filter((value) => value !== "--")
  .map((value) => value.toLowerCase());

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    // .test.mjs COUNTS TOO.
    //
    // This collected only .test.ts, so four .test.mjs files sat in __tests__
    // passing when run by hand and never once running as a gate — including
    // one added two sessions earlier that everybody, including its author,
    // believed was protecting the KMS redaction.
    //
    // A test that is not collected is not a test. Widening the filter is the
    // fix; renaming the files would have worked once and left the next .mjs
    // test in exactly the same silent hole.
    if (/\.test\.(ts|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function findTsxLoader() {
  const pnpmRoot = join(workspaceRoot, "node_modules", ".pnpm");
  const match = readdirSync(pnpmRoot)
    .filter((name) => name.startsWith("tsx@"))
    .sort()
    .pop();

  if (!match) {
    throw new Error("Unable to locate tsx in node_modules/.pnpm");
  }

  const loaderPath = join(
    pnpmRoot,
    match,
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );

  if (!statSync(loaderPath).isFile()) {
    throw new Error(`TSX loader not found at ${loaderPath}`);
  }

  return pathToFileURL(loaderPath).href;
}

const testFiles = walk(testsRoot).filter((file) => {
  if (filters.length === 0) return true;
  const haystack = file.toLowerCase();
  return filters.every((filter) => haystack.includes(filter));
});

if (testFiles.length === 0) {
  console.error(
    `No apps/web tests matched filters: ${filters.length ? filters.join(", ") : "(none)"}`,
  );
  process.exit(1);
}

const loaderUrl = findTsxLoader();
const result = spawnSync(
  process.execPath,
  ["--import", loaderUrl, "--test", ...testFiles],
  {
    cwd: workspaceRoot,
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
