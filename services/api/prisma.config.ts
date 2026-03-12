import { defineConfig } from "prisma/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const idx = line.indexOf("=");
    if (idx <= 0) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (!key) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const cwdEnv = resolve(process.cwd(), ".env");
const serviceEnv = resolve(process.cwd(), "services/api/.env");

loadEnvFile(cwdEnv);
if (serviceEnv !== cwdEnv) {
  loadEnvFile(serviceEnv);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
const shadowUrl = process.env.SHADOW_DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Prisma config could not find it in process.env, .env, or services/api/.env"
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: databaseUrl,
    shadowDatabaseUrl: shadowUrl || undefined,
  },
});