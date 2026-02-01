import "dotenv/config";
import { prisma } from "./db";
import { loadPemFromPathEnv } from "./crypto";

async function main() {
  const keyId = process.env.SIGNING_KEY_ID ?? "dw_ed25519";
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
