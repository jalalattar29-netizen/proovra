import { defineConfig, env } from "prisma/config";
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
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
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

const shadowUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: env("DATABASE_URL"),
    shadowDatabaseUrl: shadowUrl ? env("SHADOW_DATABASE_URL") : undefined,
  },
});
