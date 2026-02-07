import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "./db.js";
import { loadPemFromPathEnv } from "./crypto.js";

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

async function main() {
  const keyId = process.env.SIGNING_KEY_ID ?? "proovra_ed25519";
  const versionRaw = process.env.SIGNING_KEY_VERSION ?? "1";
  const version = Number.parseInt(versionRaw, 10);
  if (!Number.isFinite(version)) {
    throw new Error("SIGNING_KEY_VERSION must be an integer");
  }
  const publicKeyPem = loadPemFromPathEnv("SIGNING_PUBLIC_KEY_PATH");

  await prisma.signingKey.upsert({
    where: { keyId_version: { keyId, version } },
    update: { publicKeyPem },
    create: { keyId, version, publicKeyPem },
  });

  console.log(`✅ SigningKey upserted: ${keyId} v${version}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
